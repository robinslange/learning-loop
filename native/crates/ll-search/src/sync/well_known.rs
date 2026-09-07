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

use super::client::HubUrl;

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
///
/// The endpoint is read by [`HubUrl`](super::client::HubUrl), the same parse the WebSocket
/// dialer performs, so the host whose fingerprint an operator confirms here is
/// the host the dial reaches. It used to be split by hand, and the two
/// readings could name different machines.
///
/// Whether `ws://` is permitted at all is [`check_hub_scheme`](super::client::check_hub_scheme)'s decision, not
/// this function's; `ll join` and `ll link` both ask it before they get here.
pub async fn fetch(endpoint: &str) -> anyhow::Result<HubIdentity> {
    let origin = HubUrl::parse(endpoint)?;
    tokio::time::timeout(FETCH_TIMEOUT, get(&origin))
        .await
        .map_err(|_| {
            anyhow::anyhow!("timed out fetching {WELL_KNOWN_PATH} from {}", origin.authority)
        })?
}

async fn get(origin: &HubUrl) -> anyhow::Result<HubIdentity> {
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
    origin: &HubUrl,
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

    // A TLS peer that closes TCP without sending `close_notify` surfaces here
    // as `UnexpectedEof`, even when the whole response arrived. Treat that as
    // end-of-body once we have a complete header, and let `parse_response`
    // judge what came back: this is the one fetch that gates enrolment, and
    // failing it on a protocol nicety would look to the user like the hub was
    // unreachable. A truncated body still fails, in the parse, where the
    // error can say what was wrong with it.
    let mut buf = Vec::new();
    match stream.take(MAX_RESPONSE).read_to_end(&mut buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof && has_header(&buf) => {}
        Err(e) => return Err(e.into()),
    }
    Ok(buf)
}

fn has_header(buf: &[u8]) -> bool {
    buf.windows(4).any(|w| w == b"\r\n\r\n")
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

    /// rustls panics rather than erroring when no crypto provider is
    /// installed, and `tokio-tungstenite` pulls it with default features off,
    /// which selects none. Naming rustls in this crate's manifest with `ring`
    /// is the only thing installing one — drop that feature and every `wss://`
    /// connection this client makes aborts before the socket, which is how it
    /// shipped until it was caught by hand.
    ///
    /// This builds the same `ClientConfig` the production path builds, so the
    /// panic surfaces here instead of at a user's first `ll join`. It needs no
    /// server, no certificate and no socket: the failure is a property of the
    /// crate graph, not of any connection.
    #[test]
    fn a_crypto_provider_is_installed_so_tls_configs_can_be_built() {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let _config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
    }

    /// The scheme mapping and the authority split now live in `HubUrl`, with
    /// `client.rs`'s tests on them. What is this module's own is that the
    /// `Host:` header carries the authority the connection was made to, byte
    /// for byte.
    #[tokio::test]
    async fn the_host_header_is_the_authority_the_request_went_to() {
        let hub = test_hub::spawn_raw_http("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n").await;
        let origin = HubUrl::parse(&hub.ws_url()).unwrap();
        let expected = format!("Host: {}\r\n", origin.authority);
        assert!(origin.authority.contains(':'),
            "precondition: this mock is on an ephemeral port, so the port has to \
             survive into the header or the request reaches the wrong vhost",
        );

        let (client, mut server) = tokio::io::duplex(4096);
        let seen = tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            let n = server.read(&mut buf).await.unwrap();
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        let _ = exchange(client, &origin).await;
        let request = seen.await.unwrap();

        assert!(request.contains(&expected), "{request}");
        assert_eq!(request.lines().filter(|l| l.starts_with("Host:")).count(), 1,
            "one Host line: an endpoint that could smuggle a second one is refused \
             by the parse, not tidied up here",
        );
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
