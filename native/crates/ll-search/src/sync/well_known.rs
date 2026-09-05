//! `GET /.well-known/ll-hub` — the hub's identity, fetched before anything
//! else in `ll join`.
//!
//! This is the only HTTP request the client makes; every other exchange is
//! the WebSocket protocol. It exists so the operator can compare the hub's
//! six-word fingerprint BEFORE the invite code leaves the machine: the hub
//! redeems an invite while handling `ClientHello`, ahead of the challenge it
//! signs, so a code offered to an impostor is a code already burned.
//!
//! Hand-rolled rather than pulled from an HTTP client crate. One request,
//! one fixed path, no redirects, no cookies, no keep-alive — `Connection:
//! close` means the body is "everything until EOF" and there is no
//! chunked-transfer case to decode. A response that arrives chunked anyway
//! (some proxy in the middle) fails the JSON parse with the endpoint named,
//! which is the right outcome for a fetch whose whole job is establishing
//! trust.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

const WELL_KNOWN_PATH: &str = "/.well-known/ll-hub";

/// The real answer is a few dozen bytes. Anything past this is the wrong
/// endpoint or a hostile one, and either way is not worth buffering.
const MAX_RESPONSE: u64 = 64 * 1024;

const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// What the hub publishes about itself. Unauthenticated by design — pinning
/// a public key needs no prior trust, and the fingerprint confirmation is
/// what turns "some key" into "the key".
#[derive(Debug, Clone, serde::Deserialize)]
pub struct HubIdentity {
    pub hub_key_id: String,
    pub protocol_version: u32,
}

/// Fetch the hub identity for a hub named by its WebSocket endpoint. The
/// scheme maps across (`wss://` → `https://`, `ws://` → `http://`) and any
/// path is dropped, so `wss://hub.example/ws` is asked at
/// `https://hub.example/.well-known/ll-hub`.
pub async fn fetch(endpoint: &str) -> anyhow::Result<HubIdentity> {
    let origin = Origin::parse(endpoint)?;
    tokio::time::timeout(FETCH_TIMEOUT, get(&origin))
        .await
        .map_err(|_| {
            anyhow::anyhow!("timed out fetching {WELL_KNOWN_PATH} from {}", origin.authority)
        })?
}

struct Origin {
    tls: bool,
    host: String,
    port: u16,
    /// The authority exactly as written, for the `Host` header.
    authority: String,
}

impl Origin {
    fn parse(endpoint: &str) -> anyhow::Result<Self> {
        let trimmed = endpoint.trim();
        let (tls, rest) = if let Some(r) = trimmed.strip_prefix("wss://") {
            (true, r)
        } else if let Some(r) = trimmed.strip_prefix("ws://") {
            (false, r)
        } else if let Some(r) = trimmed.strip_prefix("https://") {
            (true, r)
        } else if let Some(r) = trimmed.strip_prefix("http://") {
            (false, r)
        } else {
            anyhow::bail!("hub endpoint {endpoint:?} has no wss:// or ws:// scheme");
        };

        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        let (host, explicit_port) = if let Some(after_bracket) = authority.strip_prefix('[') {
            let (host, tail) = after_bracket
                .split_once(']')
                .ok_or_else(|| anyhow::anyhow!("hub endpoint {endpoint:?} has an unclosed [ipv6]"))?;
            (host, tail.strip_prefix(':'))
        } else {
            match authority.split_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (authority, None),
            }
        };
        if host.is_empty() {
            anyhow::bail!("hub endpoint {endpoint:?} names no host");
        }
        let port = match explicit_port {
            Some(p) => p
                .parse()
                .with_context(|| format!("hub endpoint {endpoint:?} has a non-numeric port"))?,
            None if tls => 443,
            None => 80,
        };

        Ok(Origin { tls, host: host.to_string(), port, authority: authority.to_string() })
    }
}

async fn get(origin: &Origin) -> anyhow::Result<HubIdentity> {
    let tcp = TcpStream::connect((origin.host.as_str(), origin.port))
        .await
        .with_context(|| format!("failed to connect to {}", origin.authority))?;

    let raw = if origin.tls {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let server_name = rustls::pki_types::ServerName::try_from(origin.host.clone())
            .map_err(|_| anyhow::anyhow!("{} is not a valid TLS server name", origin.host))?;
        let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(server_name, tcp)
            .await
            .with_context(|| format!("TLS handshake with {} failed", origin.authority))?;
        exchange(tls, origin).await?
    } else {
        exchange(tcp, origin).await?
    };

    parse_response(&raw)
}

async fn exchange<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    origin: &Origin,
) -> anyhow::Result<Vec<u8>> {
    let request = format!(
        "GET {WELL_KNOWN_PATH} HTTP/1.1\r\n\
         Host: {}\r\n\
         User-Agent: ll-search/{}\r\n\
         Accept: application/json\r\n\
         Connection: close\r\n\r\n",
        origin.authority,
        env!("CARGO_PKG_VERSION"),
    );
    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;

    let mut buf = Vec::new();
    stream.take(MAX_RESPONSE).read_to_end(&mut buf).await?;
    Ok(buf)
}

fn parse_response(raw: &[u8]) -> anyhow::Result<HubIdentity> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| anyhow::anyhow!("{WELL_KNOWN_PATH} sent no HTTP response header"))?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status = head.lines().next().unwrap_or("").trim();
    let code = status.split_whitespace().nth(1).unwrap_or("");
    if code != "200" {
        anyhow::bail!(
            "{WELL_KNOWN_PATH} answered {:?}, not 200 — is this a learning-loop hub?",
            status
        );
    }

    serde_json::from_slice(&raw[split + 4..])
        .with_context(|| format!("{WELL_KNOWN_PATH} did not return the expected JSON"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::test_hub;

    #[test]
    fn wss_maps_to_https_on_443_and_ws_to_http_on_80() {
        let secure = Origin::parse("wss://hub.example/ws").unwrap();
        assert!(secure.tls);
        assert_eq!((secure.host.as_str(), secure.port), ("hub.example", 443));

        let plain = Origin::parse("ws://hub.example/ws").unwrap();
        assert!(!plain.tls, "a ws:// endpoint must not be fetched over TLS");
        assert_eq!((plain.host.as_str(), plain.port), ("hub.example", 80));
    }

    #[test]
    fn an_explicit_port_survives_and_reaches_the_host_header() {
        let o = Origin::parse("ws://127.0.0.1:9123/ws").unwrap();
        assert_eq!((o.host.as_str(), o.port), ("127.0.0.1", 9123));
        assert_eq!(o.authority, "127.0.0.1:9123",
            "the Host header must carry the port, or a hub on a non-default port \
             routes the request to the wrong vhost");
    }

    #[test]
    fn a_bracketed_ipv6_authority_splits_at_the_bracket_not_the_last_colon() {
        let o = Origin::parse("wss://[::1]:8443/ws").unwrap();
        assert_eq!((o.host.as_str(), o.port), ("::1", 8443));
        let default_port = Origin::parse("wss://[::1]/ws").unwrap();
        assert_eq!((default_port.host.as_str(), default_port.port), ("::1", 443));
    }

    #[test]
    fn an_endpoint_with_no_scheme_is_rejected() {
        assert!(Origin::parse("hub.example/ws").is_err());
        assert!(Origin::parse("wss://hub.example").is_ok(),
            "a scheme with no path is a valid endpoint and must not be caught by \
             the same check");
    }

    #[tokio::test]
    async fn fetches_the_hub_key_id_a_hub_publishes() {
        let hub = test_hub::spawn_well_known_only(&test_hub::hub_key_id_str(), 5).await;
        let identity = fetch(&hub.ws_url()).await.unwrap();
        assert_eq!(identity.hub_key_id, test_hub::hub_key_id_str());
        assert_eq!(identity.protocol_version, 5);
    }

    #[tokio::test]
    async fn a_non_200_answer_names_the_status_instead_of_parsing_the_body() {
        let hub = test_hub::spawn_raw_http("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n").await;
        let err = fetch(&hub.ws_url()).await.unwrap_err();
        assert!(err.to_string().contains("404"), "{err}");
    }

    #[tokio::test]
    async fn a_200_that_is_not_the_expected_json_is_an_error_not_a_default() {
        let body = "<html>hello</html>";
        let hub = test_hub::spawn_raw_http(&format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        ))
        .await;
        let err = fetch(&hub.ws_url()).await.unwrap_err();
        assert!(err.to_string().contains(WELL_KNOWN_PATH), "{err}");
    }
}
