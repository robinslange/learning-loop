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

use crate::b64;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use super::grant::{GrantKind, GrantStatement};
use super::handshake::random_nonce;
use super::key_id::KeyId;
use super::protocol_v5::{
    hub_challenge_message, ClientMsg, GrantWire, HeldIndex, HubMsg, VaultState, PROTOCOL_VERSION,
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

// ---------------------------------------------------------------------------
// What the hub answers `SyncReady.vault_state` from
// ---------------------------------------------------------------------------

/// The hub's `vaults` table as a mock holds it: who owns which vault, and the
/// latest index the hub has for each.
///
/// Empty is the ordinary case — a client that owns everything it declared and
/// is reached by nothing else. Seed it when the scenario needs a vault this
/// client does NOT own: one another key already claimed, or one a grant
/// reaches.
#[derive(Clone, Default)]
pub struct HubVaults {
    /// `vault_id` -> owner, for vaults that exist before this client connects.
    owners: Vec<(String, KeyId)>,
    /// The index bytes the hub holds, per vault. A vault with no entry holds
    /// nothing and reports `None`.
    indices: Vec<(String, Vec<u8>)>,
}

impl HubVaults {
    pub fn new() -> Self {
        Self::default()
    }

    /// A vault `owner` already owns. A `ClientHello` from any other key
    /// declaring this id is dropped, because `put_vault` is
    /// first-authenticated-claim-wins and the row is already taken.
    pub fn owned_by(mut self, vault_id: &str, owner: &KeyId) -> Self {
        self.owners.push((vault_id.to_string(), owner.clone()));
        self
    }

    /// The index the hub holds for `vault_id`. Bytes rather than a
    /// `HeldIndex`, because `store_index` hashes what it was given before
    /// storing it — the sha256 a hub declares is always the sha256 of the
    /// frame it sends. A hub whose header disagrees with its frame is a
    /// distinct fixture ([`FetchAnswer::IndexUnderADifferentSha`]), not
    /// something to be able to say here by accident.
    pub fn holding(mut self, vault_id: &str, index: &[u8]) -> Self {
        self.indices.push((vault_id.to_string(), index.to_vec()));
        self
    }

    fn index_for(&self, vault_id: &str) -> Option<&[u8]> {
        self.indices.iter().find(|(v, _)| v == vault_id).map(|(_, b)| b.as_slice())
    }

    /// `v5::indices::held`.
    fn holds_for(&self, vault_id: &str) -> Option<HeldIndex> {
        use sha2::{Digest, Sha256};
        Some(HeldIndex {
            sha256: hex::encode(Sha256::digest(self.index_for(vault_id)?)),
            note_count: FETCH_NOTE_COUNT,
            uploaded_at: 1,
        })
    }
}

/// Whether an edge of this kind authorises a read. The hub's `authz::matching`
/// with `want_authority = false`.
fn permits_read(kind: GrantKind) -> bool {
    kind.transfers_authority() || matches!(kind, GrantKind::Follow | GrantKind::Peer)
}

/// The grants a hub's `active_grants_to(reader, now)` would return out of the
/// ones this mock is serving: addressed to `reader`, `active`, unexpired.
///
/// Parsed but not signature-checked. A hub only ever stores a grant whose
/// signature verified, so a row it reads back needs no re-check — and a mock
/// deliberately serving an unsigned grant is modelling a hostile hub, whose
/// `vault_state` claim is its own to make. What cannot be honoured is a
/// statement that does not parse: no hub could have a row for it.
fn active_grants_to(grants: &[GrantWire], reader: &KeyId, now: i64) -> Vec<GrantStatement> {
    grants
        .iter()
        .filter(|w| w.state == "active")
        .filter_map(|w| {
                        serde_json::from_slice::<GrantStatement>(&b64::decode(&w.statement_b64).ok()?).ok()
        })
        .filter(|st| &st.to == reader && st.expires_at > now)
        .collect()
}

/// `v5::authz::read_authority`'s bool, over a mock's ownership table.
fn may_read(
    owners: &[(String, KeyId)],
    held: &[GrantStatement],
    reader: &KeyId,
    vault_id: &str,
) -> bool {
    let Some(owner) = owners.iter().find(|(v, _)| v == vault_id).map(|(_, o)| o) else {
        return false;
    };
    if owner == reader {
        return true;
    }
    held.iter().any(|st| {
        &st.from == owner
            && st.scope.as_deref().is_none_or(|s| s == vault_id)
            && permits_read(st.kind)
    })
}

/// `SyncReady.vault_state`, computed the way the hub computes it:
/// `v5::authz::readable_vaults` over the registered vaults and the grants this
/// connection carries, then `v5::indices::vault_state_for`.
/// (`<HUB>/src/handler.rs:944-999`, `<HUB>/src/v5/authz.rs`.)
///
/// **This is not the ids the client declared, and the difference runs both
/// ways.** The declaration is registered first (`put_vault`, first
/// authenticated claim wins) and then plays no further part: an id another key
/// already owns DROPS OUT, because `put_vault` refused it and the reader has
/// no authority over it; and a vault the reader never named is ADDED when a
/// grant reaches it — which is the whole reason `SyncReady` carries a list at
/// all, since an unscoped `link` means "any vault this issuer owns" and only
/// the hub holds the ownership table.
///
/// A mock that echoed the declaration could express neither, so the case
/// `link` exists for — a peer vault reached through an unscoped grant — could
/// not be written against these mocks at all.
fn vault_state_for(
    world: &HubVaults,
    reader: &KeyId,
    declared: &[String],
    grants: &[GrantWire],
    now: i64,
) -> Vec<VaultState> {
    let mut owners = world.owners.clone();
    for vault_id in declared {
        if !owners.iter().any(|(v, _)| v == vault_id) {
            owners.push((vault_id.clone(), reader.clone()));
        }
    }
    let held = active_grants_to(grants, reader, now);

    let owned_by = |key: &KeyId| -> Vec<String> {
        owners.iter().filter(|(_, o)| o == key).map(|(v, _)| v.clone()).collect()
    };
    let mut candidates = owned_by(reader);
    for st in &held {
        match &st.scope {
            Some(vault_id) => candidates.push(vault_id.clone()),
            None => candidates.extend(owned_by(&st.from)),
        }
    }

    let mut out: Vec<VaultState> = Vec::new();
    for vault_id in candidates {
        if out.iter().any(|v| v.vault_id == vault_id) {
            continue;
        }
        if may_read(&owners, &held, reader, &vault_id) {
            out.push(VaultState { holds: world.holds_for(&vault_id), vault_id });
        }
    }
    out
}

/// The clock a mock decides grant expiry against, matching the hub's
/// `now_unix()`.
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
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
    let Ok(nonce_c) = b64::decode(nonce_c_b64) else { return false };
    let nonce_h = random_nonce();
    let exporter = [0u8; 32];
    let sig_h = signer.sign(&hub_challenge_message(&nonce_h, &nonce_c, &exporter));
    send_hub_msg(ws, &HubMsg::HubChallenge {
        nonce_h: b64::encode(&nonce_h),
        hub_key_id: KeyId::from_pubkey(&signer.verifying_key()).as_str().to_string(),
        sig_h: b64::encode(&sig_h.to_bytes()),
    })
    .await
}

/// The full happy path: challenge, verify nothing, reply `SyncReady` computed
/// from `world` by [`vault_state_for`]. Records the `ClientHello` so a test can
/// assert what the client declared — under v5 the hello IS the vault
/// registration.
///
/// `HubVaults::new()` is the ordinary case: the client owns everything it
/// declared, and the hub reports each one holding nothing until an upload
/// arrives. A mock that answered with an empty `vault_state` there would model
/// a hub that admits the key and silently drops the registration — precisely
/// the failure the client refuses to write a config for.
pub async fn fake_hub_happy_path(world: HubVaults) -> MockHub {
    fake_hub_happy_path_signed_by(hub_signing_key(), &hub_key_id_str(), world).await
}

/// A happy path whose WebSocket identity is `signer` while `/.well-known`
/// announces `published_key_id`. Passing two different keys models a hub that
/// presents an identity it never published.
pub async fn fake_hub_happy_path_signed_by(
    signer: SigningKey,
    published_key_id: &str,
    world: HubVaults,
) -> MockHub {
    let hellos = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&hellos);
    let mut hub = spawn_mock_hub_publishing(published_key_id, PROTOCOL_VERSION, move |mut ws| async move {
        let Some(hello) = recv_client_msg(&mut ws).await else { return };
        let ClientMsg::ClientHello { ref key_id, ref nonce_c, ref vault_ids, .. } = hello else {
            return
        };
        let Ok(reader) = KeyId::parse(key_id) else { return };
        let nonce_c = nonce_c.clone();
        let declared = vault_ids.clone();
        recorder.lock().unwrap().push(hello);
        send_signed_challenge(&mut ws, &signer, &nonce_c).await;

        let _auth = recv_client_msg(&mut ws).await;

        send_hub_msg(&mut ws, &HubMsg::SyncReady {
            chunked_upload: None,
            protocol_version: PROTOCOL_VERSION,
            vault_state: vault_state_for(&world, &reader, &declared, &[], now_unix()),
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
            chunked_upload: None,
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

/// The id of the grant a revocation statement withdraws, read the way a hub
/// reads it: out of the statement's own `grant_id`, which is what the
/// signature covers and what the ack must name.
fn revoked_grant_id(statement: &[u8]) -> Option<String> {
    Some(
        serde_json::from_slice::<serde_json::Value>(statement)
            .ok()?
            .get("grant_id")?
            .as_str()?
            .to_string(),
    )
}

/// How a [`spawn_grant_hub`] answers one `PutGrant` or `RevokeGrant`.
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
    serve: Vec<GrantWire>,
    answers: Vec<GrantAnswer>,
) -> (MockHub, Arc<Mutex<Vec<GrantWire>>>) {
    spawn_grant_hub_over(HubVaults::new(), serve, answers).await
}

/// The same, over a hub that already knows about some vaults — the form
/// needed to serve a grant AND list the vault that grant reaches, which is
/// what `link` is for and what an empty `HubVaults` cannot express.
pub async fn spawn_grant_hub_over(
    world: HubVaults,
    serve: Vec<GrantWire>,
    answers: Vec<GrantAnswer>,
) -> (MockHub, Arc<Mutex<Vec<GrantWire>>>) {
        use sha2::{Digest, Sha256};

    let lodged: Arc<Mutex<Vec<GrantWire>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&lodged);
    let signer = hub_signing_key();
    let hub = spawn_mock_hub(move |mut ws| async move {
        let mut answers = answers.into_iter();
        let note = |wire: GrantWire| recorder.lock().unwrap().push(wire);

        let Some(hello) = recv_client_msg(&mut ws).await else { return };
        let ClientMsg::ClientHello { key_id, nonce_c, vault_ids, .. } = hello else {
            return note(complaint("unexpected:not-a-hello"));
        };
        let Ok(reader) = KeyId::parse(&key_id) else {
            return note(complaint("unexpected:client-hello-key_id-is-not-a-key-id"));
        };
        send_signed_challenge(&mut ws, &signer, &nonce_c).await;
        let _auth = recv_client_msg(&mut ws).await;
        let state = vault_state_for(&world, &reader, &vault_ids, &serve, now_unix());
        if !send_hub_msg(&mut ws, &HubMsg::SyncReady {
            chunked_upload: None,
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
            // A hub answers `FetchIndex` out of the same table it listed
            // from — `handle_v5_fetch_index` and `readable_vaults` share a
            // matcher, so a vault named in `SyncReady` can always be fetched.
            // A mock that listed a vault and then complained about being asked
            // for it would be modelling a hub that cannot exist.
            if let ClientMsg::FetchIndex { vault_id } = &msg {
                let header = HubMsg::IndexHeader {
                    vault_id: vault_id.clone(),
                    holds: world.holds_for(vault_id),
                };
                if !send_hub_msg(&mut ws, &header).await {
                    return;
                }
                if let Some(bytes) = world.index_for(vault_id) {
                    if ws.send(Message::binary(bytes.to_vec())).await.is_err() {
                        return;
                    }
                }
                continue;
            }
            // `PutGrant` and `RevokeGrant` are answered from one table and
            // with one `GrantAck`, the way the real hub answers them. The
            // only difference is which id the ack carries: a grant is
            // acknowledged by the hash of its own bytes, a revocation by the
            // id of the grant it withdraws — which is a field inside the
            // statement and is emphatically not the hash of it. A mock that
            // hashed both would ack every revocation with an id no client
            // ever asked about, and the client's own check would be the only
            // thing left saying so.
            let decode = |b64: &str| b64::decode(b64).ok();
            let (statement_b64, signature_b64, acked, state) = match msg {
                ClientMsg::PutGrant { statement_b64, signature_b64 } => {
                    let Some(bytes) = decode(&statement_b64) else {
                        return note(complaint("unparseable:statement-not-base64"));
                    };
                    let id = hex::encode(Sha256::digest(&bytes));
                    (statement_b64, signature_b64, id, "active")
                }
                ClientMsg::RevokeGrant { statement_b64, signature_b64 } => {
                    let Some(bytes) = decode(&statement_b64) else {
                        return note(complaint("unparseable:statement-not-base64"));
                    };
                    let Some(id) = revoked_grant_id(&bytes) else {
                        return note(complaint("unparseable:revocation-names-no-grant-id"));
                    };
                    (statement_b64, signature_b64, id, "revoked")
                }
                other => return note(complaint(&format!("unexpected:{other:?}"))),
            };
            note(super::protocol_v5::GrantWire {
                statement_b64,
                signature_b64,
                state: state.into(),
            });
            let reply = match answers.next().unwrap_or(GrantAnswer::Ack) {
                GrantAnswer::Ack => HubMsg::GrantAck { grant_id: acked },
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
