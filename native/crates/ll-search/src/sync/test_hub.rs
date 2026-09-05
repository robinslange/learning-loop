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

/// The two process-wide variables a test that opens a WebSocket to one of
/// these mocks depends on: `LL_SEED_BACKEND`, so no test reaches the OS
/// keyring, and `LL_ALLOW_INSECURE_WS`, which `connect_and_authenticate`
/// needs before it will derive an exporter for a non-TLS connection.
///
/// Both writes happen under the guard, in this order. Calling
/// [`force_encrypted_seed_backend`] before taking the lock would put the one
/// env write the lock exists for outside the lock.
pub fn insecure_ws_env() -> InsecureWsEnv {
    let guard = env_lock();
    force_encrypted_seed_backend();
    std::env::set_var("LL_ALLOW_INSECURE_WS", "1");
    InsecureWsEnv { _guard: guard }
}

/// Clears `LL_ALLOW_INSECURE_WS` when the lock is released, so a later test
/// in this binary sees the environment it expects rather than the one the
/// last connecting test happened to leave.
pub struct InsecureWsEnv {
    _guard: MutexGuard<'static, ()>,
}

impl Drop for InsecureWsEnv {
    fn drop(&mut self) {
        std::env::remove_var("LL_ALLOW_INSECURE_WS");
    }
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

/// `None` when nothing more is coming, or when what came was not a message
/// this mock can read.
///
/// It returns rather than panicking for the same reason `send_hub_msg` does:
/// **a panic cannot be a mock's error channel.** These run inside
/// `tokio::spawn`, and a panic in a spawned task does not fail the test that
/// spawned it — the test sees a closed socket or a timeout and its assertions
/// are then satisfied by any failure, including the mock never having started.
/// A handler that stops here leaves the connection to close, and the test's
/// own assertions catch it.
pub async fn recv_client_msg(ws: &mut WsServer) -> Option<ClientMsg> {
    loop {
        match ws.next().await?.ok()? {
            Message::Text(t) => return serde_json::from_str(t.as_str()).ok(),
            Message::Ping(d) => {
                let _ = ws.send(Message::Pong(d)).await;
            }
            _ => continue,
        }
    }
}

/// `false` when the send failed, which only happens because the client hung
/// up. Deliberately not a panic: this runs inside a spawned task, where a
/// panic unwinds the hub and the client sees an ordinary transport error, so
/// the loudest thing a mock can do about a dead socket is stop.
pub async fn send_hub_msg(ws: &mut WsServer, msg: &HubMsg) -> bool {
    // The one panic left in this file, and the only one that can be defended:
    // `HubMsg` is a plain enum of owned strings and integers, so serialising
    // it cannot fail. Every other complaint a mock has goes into a record,
    // because a panic in a spawned task is invisible to the test that spawned
    // it — see `recv_client_msg`.
    let text = serde_json::to_string(msg).expect("HubMsg is always serialisable");
    ws.send(Message::text(text)).await.is_ok()
}

/// Sign and send a genuine `HubChallenge` for the `nonce_c` a client offered.
/// `exporter` is `[0u8; 32]` for every non-TLS mock, matching the client's
/// `LL_ALLOW_INSECURE_WS` fallback.
///
/// `false` when the nonce did not decode or the send failed. Both are the
/// client's doing, and neither is a panic: this runs inside `tokio::spawn`,
/// where a panic does not fail the test that spawned it — see
/// [`recv_client_msg`].
pub async fn send_signed_challenge(
    ws: &mut WsServer,
    signer: &SigningKey,
    nonce_c_b64: &str,
) -> bool {
    let Ok(nonce_c) = unb64(nonce_c_b64) else { return false };
    let nonce_h = random_nonce();
    let exporter = [0u8; 32];
    let sig_h = signer.sign(&hub_challenge_message(&nonce_h, &nonce_c, &exporter));
    send_hub_msg(ws, &HubMsg::HubChallenge {
        nonce_h: b64(&nonce_h),
        hub_key_id: KeyId::from_pubkey(&signer.verifying_key()).as_str().to_string(),
        sig_h: b64(&sig_h.to_bytes()),
    })
    .await
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
        let Some(hello) = recv_client_msg(&mut ws).await else { return };
        let ClientMsg::ClientHello { ref nonce_c, ref vault_ids, .. } = hello else {
            return
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
        let Some(hello) = recv_client_msg(&mut ws).await else { return };
        let ClientMsg::ClientHello { nonce_c, .. } = hello else { return };
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
        let Some(hello) = recv_client_msg(&mut ws).await else { return };
        recorder.lock().unwrap().push(hello);
        send_hub_msg(&mut ws, &HubMsg::Reject { reason: "invite redemption failed".into() }).await;
    })
    .await;
    hub.hellos = hellos;
    hub
}

/// The count every [`spawn_fetch_hub`] index header declares. Arbitrary, and
/// deliberately not the length of anything, so a test asserting on it is
/// reading the hub's claim rather than recomputing it.
pub const FETCH_NOTE_COUNT: i64 = 42;

/// How a [`spawn_fetch_hub`] answers one `FetchIndex`.
pub enum FetchAnswer {
    /// `IndexHeader` declaring the sha256 of these bytes, then the bytes as
    /// one binary frame — what a healthy hub does.
    Index(Vec<u8>),
    /// The same, with a header declaring a sha256 that is not these bytes'.
    /// The frame still follows, because that is what the header promised.
    IndexUnderADifferentSha(Vec<u8>),
    /// A header for a vault other than the one asked for, honestly hashed,
    /// with its frame. A hub that answers the wrong question.
    HeaderFor(&'static str, Vec<u8>),
    /// `IndexHeader { holds: None }` and no frame: the hub has nothing for
    /// this vault yet.
    Nothing,
    Reject(&'static str),
}

fn index_header(vault_id: &str, sha256: String) -> HubMsg {
    HubMsg::IndexHeader {
        vault_id: vault_id.to_string(),
        holds: Some(HeldIndex { sha256, note_count: FETCH_NOTE_COUNT, uploaded_at: 1 }),
    }
}

/// A hub that answers `FetchIndex` from a scripted table, and the record of
/// everything it was asked, in order.
///
/// The record is the point twice over. `assoc` grants no authority and the
/// invariant is that the client does not ASK, which a hub that merely refused
/// would leave untested — refusing everything looks identical from the
/// outside. And this runs inside `tokio::spawn`, where a panic does not fail
/// the test that spawned it: it unwinds the hub, drops the socket, and
/// reaches the client as a transport error indistinguishable from an ordinary
/// refused read. So the mock never panics. Anything it wants to complain
/// about — an unparseable message, a message that is not `FetchIndex`, a
/// `vault_id` the table does not name — goes into the record as
/// `unparseable:` / `unexpected:` / `unscripted:` and the hub stops. A test
/// that asserts on the record sees the complaint; one that does not, would
/// not have seen a panic either.
pub async fn spawn_fetch_hub(
    answers: Vec<(&'static str, FetchAnswer)>,
) -> (MockHub, Arc<Mutex<Vec<String>>>) {
    use sha2::{Digest, Sha256};

    let asked: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&asked);
    let hub = spawn_mock_hub(move |mut ws| async move {
        let mut answers = answers;
        let note = |what: String| recorder.lock().unwrap().push(what);
        loop {
            let text = match ws.next().await {
                Some(Ok(Message::Text(t))) => t,
                Some(Ok(Message::Ping(d))) => {
                    let _ = ws.send(Message::Pong(d)).await;
                    continue;
                }
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => return,
            };
            let msg: ClientMsg = match serde_json::from_str(text.as_str()) {
                Ok(msg) => msg,
                Err(e) => return note(format!("unparseable:{e}")),
            };
            let ClientMsg::FetchIndex { vault_id } = msg else {
                return note(format!("unexpected:{msg:?}"));
            };
            note(vault_id.clone());

            let Some(position) = answers.iter().position(|(id, _)| *id == vault_id) else {
                return note(format!("unscripted:{vault_id}"));
            };
            let (_, answer) = answers.remove(position);
            let (header, frame) = match answer {
                FetchAnswer::Index(bytes) => {
                    let sha = hex::encode(Sha256::digest(&bytes));
                    (index_header(&vault_id, sha), Some(bytes))
                }
                FetchAnswer::IndexUnderADifferentSha(bytes) => {
                    (index_header(&vault_id, "be".repeat(32)), Some(bytes))
                }
                FetchAnswer::HeaderFor(other, bytes) => {
                    let sha = hex::encode(Sha256::digest(&bytes));
                    (index_header(other, sha), Some(bytes))
                }
                FetchAnswer::Nothing => {
                    (HubMsg::IndexHeader { vault_id: vault_id.clone(), holds: None }, None)
                }
                FetchAnswer::Reject(reason) => {
                    (HubMsg::Reject { reason: reason.into() }, None)
                }
            };
            if !send_hub_msg(&mut ws, &header).await {
                return;
            }
            if let Some(bytes) = frame {
                if ws.send(Message::binary(bytes)).await.is_err() {
                    return;
                }
            }
        }
    })
    .await;
    (hub, asked)
}

/// How a [`spawn_grant_hub`] answers one `PutGrant`.
pub enum GrantAnswer {
    /// `GrantAck` carrying the sha256 of the statement — what the real hub
    /// replies, and the id the client recomputes for itself.
    Ack,
    Reject(&'static str),
    /// An ack naming a different grant than the one submitted. A hub that
    /// stored something other than what it was sent looks exactly like a
    /// healthy one from the outside unless the client checks the id.
    AckWrongId,
}

/// A hub that completes the v5 handshake, reports `serve` as the grants it
/// holds for this key, and then answers `PutGrant` from a scripted table —
/// `Ack` once the table runs out. The record is every grant it was handed, in
/// order.
///
/// Like [`spawn_fetch_hub`], nothing here panics: this runs inside
/// `tokio::spawn`, where a panic unwinds the hub and reaches the test as an
/// ordinary transport error indistinguishable from a refused connection.
/// Complaints go into the record as `unexpected:` / `unparseable:` and the
/// hub stops.
pub async fn spawn_grant_hub(
    serve: Vec<super::protocol_v5::GrantWire>,
    answers: Vec<GrantAnswer>,
) -> (MockHub, Arc<Mutex<Vec<super::protocol_v5::GrantWire>>>) {
    use base64::Engine;
    use sha2::{Digest, Sha256};

    let lodged: Arc<Mutex<Vec<super::protocol_v5::GrantWire>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&lodged);
    let signer = hub_signing_key();
    let hub = spawn_mock_hub(move |mut ws| async move {
        let mut answers = answers.into_iter();
        let note = |wire: super::protocol_v5::GrantWire| recorder.lock().unwrap().push(wire);

        let Some(hello) = recv_client_msg(&mut ws).await else { return };
        let ClientMsg::ClientHello { nonce_c, vault_ids, .. } = hello else {
            return note(complaint("unexpected:not-a-hello"));
        };
        send_signed_challenge(&mut ws, &signer, &nonce_c).await;
        let _auth = recv_client_msg(&mut ws).await;
        let state: Vec<VaultState> = vault_ids
            .into_iter()
            .map(|vault_id| VaultState { vault_id, holds: None })
            .collect();
        if !send_hub_msg(&mut ws, &HubMsg::SyncReady {
            protocol_version: PROTOCOL_VERSION,
            vault_state: state,
            grants: serve,
            revocations: vec![],
        })
        .await
        {
            return;
        }

        loop {
            let Some(msg) = recv_client_msg(&mut ws).await else { return };
            let ClientMsg::PutGrant { statement_b64, signature_b64 } = msg else {
                return note(complaint(&format!("unexpected:{msg:?}")));
            };
            let Ok(statement) = base64::engine::general_purpose::STANDARD.decode(&statement_b64)
            else {
                return note(complaint("unparseable:statement-not-base64"));
            };
            note(super::protocol_v5::GrantWire {
                statement_b64: statement_b64.clone(),
                signature_b64,
                state: "active".into(),
            });
            let reply = match answers.next().unwrap_or(GrantAnswer::Ack) {
                GrantAnswer::Ack => HubMsg::GrantAck {
                    grant_id: hex::encode(Sha256::digest(&statement)),
                },
                GrantAnswer::AckWrongId => HubMsg::GrantAck { grant_id: "00".repeat(32) },
                GrantAnswer::Reject(reason) => HubMsg::Reject { reason: reason.into() },
            };
            if !send_hub_msg(&mut ws, &reply).await {
                return;
            }
        }
    })
    .await;
    (hub, lodged)
}

/// A complaint, in the one shape the record can carry. `statement_b64` holds
/// the text and the state says it is not a grant, so a test that decodes the
/// record sees the complaint rather than a base64 error.
fn complaint(what: &str) -> super::protocol_v5::GrantWire {
    super::protocol_v5::GrantWire {
        statement_b64: what.to_string(),
        signature_b64: String::new(),
        state: "complaint".into(),
    }
}
