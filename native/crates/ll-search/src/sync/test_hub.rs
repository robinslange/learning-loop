//! The v5 mock hub, shared by every client-side test that needs one.
//!
//! One listener serves both halves of what a real hub offers a joining
//! client: `GET /.well-known/ll-hub` over plain HTTP, and the WebSocket
//! handshake. Which one a connection wants is decided by peeking at its
//! first bytes rather than by running two listeners, because `ll join`
//! derives both URLs from a single endpoint and they must share a port.
//!
//! The shared v4 mock in `tests/common/mod.rs` is a different thing and is
//! not v5-aware; nothing here replaces it.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use super::handshake::{b64, random_nonce, unb64};
use super::key_id::KeyId;
use super::protocol_v5::{
    hub_challenge_message, ClientMsg, HeldIndex, HubMsg, VaultState, PROTOCOL_VERSION,
};

/// The identity every mock hub signs with unless a test says otherwise.
pub fn hub_signing_key() -> SigningKey {
    SigningKey::from_bytes(&[3u8; 32])
}

pub fn hub_key_id_str() -> String {
    KeyId::from_pubkey(&hub_signing_key().verifying_key()).as_str().to_string()
}

/// Tests that read or write process-wide environment variables take this
/// first. A test binary is one process, so an unguarded `set_var` is visible
/// to every other test mid-run. Poison-recovering: a panicking test that held
/// it must not wedge the rest of the suite.
pub fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|e| e.into_inner())
}

/// Pin `LL_SEED_BACKEND=encrypted` for the whole test binary, so no test ever
/// reaches the OS keyring. Set once and never cleared — clearing it mid-run
/// is what sends a parallel test to the keyring branch.
pub fn force_encrypted_seed_backend() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| std::env::set_var("LL_SEED_BACKEND", "encrypted"));
}

pub struct MockHub {
    pub addr: SocketAddr,
    /// The `hub_key_id` this hub publishes at `/.well-known/ll-hub`.
    pub key_id: String,
    /// Every `ClientHello` the hub received, in order.
    pub hellos: Arc<Mutex<Vec<ClientMsg>>>,
}

impl MockHub {
    /// The endpoint a client is given. `ll join` derives both the well-known
    /// URL and the WebSocket URL from this one string.
    pub fn ws_url(&self) -> String {
        format!("ws://{}", self.addr)
    }

    pub fn last_hello(&self) -> Option<ClientMsg> {
        self.hellos.lock().unwrap().last().cloned()
    }
}

pub type WsServer = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// Spawn a hub publishing the genuine [`hub_key_id_str`] and this client's
/// protocol version, whose one WebSocket connection is served by `handler`.
pub async fn spawn_mock_hub<F, Fut>(handler: F) -> MockHub
where
    F: FnOnce(WsServer) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    spawn_mock_hub_publishing(&hub_key_id_str(), PROTOCOL_VERSION, handler).await
}

/// Spawn a hub that publishes `published_key_id` and `protocol_version` at
/// `/.well-known/ll-hub`, whatever the WebSocket handler goes on to sign
/// with. Divergence between the two is exactly what a pin check must catch.
pub async fn spawn_mock_hub_publishing<F, Fut>(
    published_key_id: &str,
    protocol_version: u32,
    handler: F,
) -> MockHub
where
    F: FnOnce(WsServer) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let key_id = published_key_id.to_string();
    let announced = key_id.clone();

    tokio::spawn(async move {
        let mut handler = Some(handler);
        while let Ok((stream, _)) = listener.accept().await {
            if peek_is_well_known(&stream).await {
                serve_well_known(stream, &announced, protocol_version).await;
                continue;
            }
            let Some(handler) = handler.take() else { break };
            if let Ok(ws) = accept_async(stream).await {
                handler(ws).await;
            }
            break;
        }
    });

    MockHub { addr, key_id, hellos: Arc::new(Mutex::new(Vec::new())) }
}

/// A hub that answers `/.well-known/ll-hub` and nothing else.
pub async fn spawn_well_known_only(published_key_id: &str, protocol_version: u32) -> MockHub {
    spawn_mock_hub_publishing(published_key_id, protocol_version, |_ws| async {}).await
}

/// A listener that replies to any request with `response`, verbatim. For the
/// shapes a real hub never produces and a wrong endpoint does.
pub async fn spawn_raw_http(response: &str) -> MockHub {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let response = response.to_string();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf).await;
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
    });
    MockHub { addr, key_id: String::new(), hellos: Arc::new(Mutex::new(Vec::new())) }
}

async fn peek_is_well_known(stream: &tokio::net::TcpStream) -> bool {
    let mut buf = [0u8; 64];
    match stream.peek(&mut buf).await {
        Ok(n) => buf[..n].starts_with(b"GET /.well-known/"),
        Err(_) => false,
    }
}

async fn serve_well_known(
    mut stream: tokio::net::TcpStream,
    key_id: &str,
    protocol_version: u32,
) {
    let mut buf = [0u8; 1024];
    let _ = stream.read(&mut buf).await;
    let body = serde_json::json!({
        "hub_key_id": key_id,
        "protocol_version": protocol_version,
    })
    .to_string();
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

pub async fn recv_client_msg(ws: &mut WsServer) -> ClientMsg {
    loop {
        match ws.next().await.expect("connection closed early").expect("ws error") {
            Message::Text(t) => {
                return serde_json::from_str(t.as_str()).expect("valid ClientMsg json")
            }
            Message::Ping(d) => {
                let _ = ws.send(Message::Pong(d)).await;
            }
            _ => continue,
        }
    }
}

pub async fn send_hub_msg(ws: &mut WsServer, msg: &HubMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap())).await.unwrap();
}

/// Sign and send a genuine `HubChallenge` for the `nonce_c` a client offered.
/// `exporter` is `[0u8; 32]` for every non-TLS mock, matching the client's
/// `LL_ALLOW_INSECURE_WS` fallback.
pub async fn send_signed_challenge(ws: &mut WsServer, signer: &SigningKey, nonce_c_b64: &str) {
    let nonce_c = unb64(nonce_c_b64).unwrap();
    let nonce_h = random_nonce();
    let exporter = [0u8; 32];
    let sig_h = signer.sign(&hub_challenge_message(&nonce_h, &nonce_c, &exporter));
    send_hub_msg(ws, &HubMsg::HubChallenge {
        nonce_h: b64(&nonce_h),
        hub_key_id: KeyId::from_pubkey(&signer.verifying_key()).as_str().to_string(),
        sig_h: b64(&sig_h.to_bytes()),
    })
    .await;
}

/// The full happy path: challenge, verify nothing, reply `SyncReady` with
/// `vaults`. Records the `ClientHello` so a test can assert what the client
/// declared — under v5 the hello IS the vault registration.
pub async fn fake_hub_happy_path(vaults: Vec<(&'static str, Option<HeldIndex>)>) -> MockHub {
    fake_hub_happy_path_signed_by(hub_signing_key(), &hub_key_id_str(), vaults).await
}

/// A happy path whose WebSocket identity is `signer` while `/.well-known`
/// announces `published_key_id`. Passing two different keys models a hub that
/// presents an identity it never published.
pub async fn fake_hub_happy_path_signed_by(
    signer: SigningKey,
    published_key_id: &str,
    vaults: Vec<(&'static str, Option<HeldIndex>)>,
) -> MockHub {
    let hellos = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&hellos);
    let mut hub = spawn_mock_hub_publishing(published_key_id, PROTOCOL_VERSION, move |mut ws| async move {
        let hello = recv_client_msg(&mut ws).await;
        let ClientMsg::ClientHello { ref nonce_c, ref vault_ids, .. } = hello else {
            panic!("expected client-hello")
        };
        let nonce_c = nonce_c.clone();
        let declared = vault_ids.clone();
        recorder.lock().unwrap().push(hello);
        send_signed_challenge(&mut ws, &signer, &nonce_c).await;

        let _auth = recv_client_msg(&mut ws).await;

        // The real hub registers every vault the hello declared and reports
        // each one back, holding nothing until an upload arrives. A mock that
        // answered with an empty `vault_state` would model a hub that admits
        // the key and silently drops the registration — which is precisely
        // the failure the client now refuses to write a config for, so the
        // mock has to do what the hub does or the two disagree about what
        // success looks like.
        let mut state: Vec<VaultState> = declared
            .into_iter()
            .map(|vault_id| VaultState { vault_id, holds: None })
            .collect();
        for (id, holds) in vaults {
            match state.iter_mut().find(|v| v.vault_id == id) {
                Some(existing) => existing.holds = holds,
                None => state.push(VaultState { vault_id: id.to_string(), holds }),
            }
        }

        send_hub_msg(&mut ws, &HubMsg::SyncReady {
            protocol_version: PROTOCOL_VERSION,
            vault_state: state,
            grants: vec![],
            revocations: vec![],
        })
        .await;
    })
    .await;
    hub.hellos = hellos;
    hub
}

/// A hub that authenticates the key and then reports no vaults at all — the
/// registration silently dropped. Reachable in production if the hub's
/// `put_vault` fails in a way its handler swallows, or if a future hub stops
/// registering from the hello; either way the client must not write a config
/// for a vault that will refuse its first upload.
pub async fn fake_hub_that_forgets_the_vault() -> MockHub {
    let signer = hub_signing_key();
    spawn_mock_hub_publishing(&hub_key_id_str(), PROTOCOL_VERSION, move |mut ws| async move {
        let hello = recv_client_msg(&mut ws).await;
        let ClientMsg::ClientHello { nonce_c, .. } = hello else {
            panic!("expected client-hello")
        };
        send_signed_challenge(&mut ws, &signer, &nonce_c).await;
        let _auth = recv_client_msg(&mut ws).await;
        send_hub_msg(&mut ws, &HubMsg::SyncReady {
            protocol_version: PROTOCOL_VERSION,
            vault_state: vec![],
            grants: vec![],
            revocations: vec![],
        })
        .await;
    })
    .await
}

/// A hub that rejects the invite. The real hub redeems the code while
/// handling `ClientHello` — before it signs anything — so the rejection
/// arrives in place of the challenge, not after `ClientAuth`.
pub async fn fake_hub_that_rejects_the_invite() -> MockHub {
    let hellos = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&hellos);
    let mut hub = spawn_mock_hub(move |mut ws| async move {
        let hello = recv_client_msg(&mut ws).await;
        recorder.lock().unwrap().push(hello);
        send_hub_msg(&mut ws, &HubMsg::Reject { reason: "invite redemption failed".into() }).await;
    })
    .await;
    hub.hellos = hellos;
    hub
}
