//! `federation/sync-state.json` is written by the wrapper around a sync
//! cycle, on every cycle.
//!
//! Both halves have to be here. A cycle that dies before it reaches the hub
//! must leave a record — that is the outage nobody saw for two months. And a
//! cycle that works must leave a *different* record, or an implementation
//! that always writes `outcome: "error"` would pass the first half alone.
//!
//! The mock hub is inline and speaks v5. `tests/common/mod.rs` still speaks
//! v4 and cannot complete this handshake.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use ll_search::sync::client::sync_all_async;
use ll_search::sync::error::SyncError;
use ll_search::sync::config::{
    export_db_path, FederationConfig, HubEndpoint, Identity, VisibilityConfig,
};
use ll_search::sync::grant::{canonical_bytes, GrantKind, GrantStatement};
use ll_search::sync::key_id::KeyId;
use ll_search::sync::grant::RevocationStatement;
use ll_search::sync::protocol_v5::{
    hub_challenge_message, ClientMsg, GrantWire, HeldIndex, HubMsg, RevocationWire, VaultState,
    PROTOCOL_VERSION,
};
use ll_search::sync::state::{read_readable_vaults, read_state, HubHolds, OUTCOME_ERROR, OUTCOME_OK};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type WsServer = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// The vault as this client knows it, and the count the hub reports for it.
/// They are deliberately different numbers: the state file records the hub's.
const LOCAL_NOTE_COUNT: i64 = 7;
const HUB_NOTE_COUNT: i64 = 3578;

/// An index the client never sent, for the hub to acknowledge instead.
const WRONG_SHA: &str = "beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef";

fn test_env() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // A plain ws:// hop to 127.0.0.1 is exactly the local test harness
        // this escape hatch exists for; nothing else in this binary touches
        // the variable. The encrypted seed backend keeps the generated
        // identity in the tempdir instead of the system keychain.
        std::env::set_var("LL_ALLOW_INSECURE_WS", "1");
        std::env::set_var("LL_SEED_BACKEND", "encrypted");
    });
}

fn hub_key() -> SigningKey {
    SigningKey::from_bytes(&[3u8; 32])
}

fn hub_key_id() -> String {
    KeyId::from_pubkey(&hub_key().verifying_key()).as_str().to_string()
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// `None` rather than a panic on undecodable input: the only caller runs
/// inside the spawned mock, where a panic is invisible to the test.
fn unb64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

/// The next JSON text frame, or `None` if the connection ended or carried
/// something that is not one.
///
/// Untyped, because the upload half's first message is read before the mock
/// knows whether the client decided to upload at all.
///
/// Fallible rather than panicking for the reason the whole mock is: it runs
/// inside `tokio::spawn`, and a panic there does not fail the test that
/// spawned it — it unwinds the hub and reaches the client as an ordinary
/// transport error.
async fn recv_json(ws: &mut WsServer) -> Option<serde_json::Value> {
    loop {
        match ws.next().await?.ok()? {
            Message::Text(t) => return serde_json::from_str(t.as_str()).ok(),
            Message::Ping(d) => {
                ws.send(Message::Pong(d)).await.ok()?;
            }
            _ => return None,
        }
    }
}

/// How the hub answers a `FetchIndex` for one vault.
#[derive(Clone)]
enum Fetch {
    Serve(Vec<u8>),
    Refuse,
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// `false` when the client has hung up, which is not the mock's complaint to
/// make — it just stops.
async fn send_hub(ws: &mut WsServer, msg: &HubMsg) -> bool {
    let text = serde_json::to_string(msg).expect("HubMsg is always serialisable");
    ws.send(Message::text(text)).await.is_ok()
}

/// Whether the mock accepts the upload it is offered.
#[derive(Clone, Copy)]
enum OnUpload {
    Ack,
    Reject,
    /// Acknowledge an index other than the one that was sent.
    AckWrongSha,
}

/// Whether the mock accepts the grants it is offered. A refusal is the hub's
/// decision and the cycle must survive it; only a broken connection ends one.
#[derive(Clone, Copy)]
enum OnGrant {
    Ack,
    Reject(&'static str),
}

/// A hub that completes the v5 handshake advertising `holds` for vault `v1`,
/// takes an upload if one is offered, acknowledges any grant it is handed,
/// and lists no vault but `v1` — so the client has nothing it may read and
/// must close without asking for anything.
///
/// The listing is what decides that, not the grants: since the client takes
/// its read list from `SyncReady.vault_state`, a hub that lists only the
/// client's own vault is asked for nothing whatever grants it carries.
async fn spawn_hub(holds: Option<HeldIndex>, on_upload: OnUpload) -> SocketAddr {
    spawn_hub_with(holds, on_upload, OnGrant::Ack, vec![], vec![]).await.0
}

/// The same, plus the revocations the handshake serves.
///
/// A separate entry point rather than a sixth positional argument on
/// `spawn_hub_with`: every existing caller passes no revocations, and a
/// parameter eighteen call sites have to spell `vec![]` is a parameter that
/// gets copied rather than read.
async fn spawn_hub_revoking(
    holds: Option<HeldIndex>,
    grants: Vec<GrantWire>,
    revocations: Vec<RevocationWire>,
) -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    spawn_hub_full(holds, OnUpload::Ack, OnGrant::Ack, grants, revocations, vec![]).await
}

/// The same, with `grants` in the `SyncReady`, a scripted answer for each
/// `FetchIndex` the client is expected to send as a result, and the record of
/// everything the hub saw and everything it wants to complain about.
///
/// `vault_state` is `v1` — the client's own — plus exactly the vaults
/// `fetches` scripts, because that is what a real hub does: it lists what it
/// will authorise and answers for what it listed, both out of the same
/// matcher. The client's read list comes from that listing and from nothing
/// else, so a hub that served a vault it had not listed would be testing an
/// arrangement that cannot occur.
///
/// **This mock never panics.** It runs inside `tokio::spawn`, where a panic
/// does not fail the test that spawned it: it unwinds the hub, drops the
/// socket, and reaches the client as a transport error that looks like an
/// ordinary failed read. Every complaint goes into the record instead, and a
/// test that asserts on the record sees it. Nothing is exempt — not an
/// assertion, not an unscripted lookup, not a setup failure, and not a
/// helper it calls: `unb64` returns `None` here for the same reason.
async fn spawn_hub_with(
    holds: Option<HeldIndex>,
    on_upload: OnUpload,
    on_grant: OnGrant,
    grants: Vec<GrantWire>,
    fetches: Vec<(String, Fetch)>,
) -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    spawn_hub_full(holds, on_upload, on_grant, grants, vec![], fetches).await
}

/// The same with `revocations` in the `SyncReady` as well.
///
/// This field carried `vec![]` unconditionally until now, so no test could
/// serve a revocation through a cycle at all — the client's whole revocation
/// path was unreachable from here. That is a mock bounding what could be
/// expressed rather than what was asserted, which is a worse failure than a
/// test that runs and passes wrongly: nothing about it looks like a gap.
#[allow(clippy::too_many_arguments)]
async fn spawn_hub_full(
    holds: Option<HeldIndex>,
    on_upload: OnUpload,
    on_grant: OnGrant,
    grants: Vec<GrantWire>,
    revocations: Vec<RevocationWire>,
    fetches: Vec<(String, Fetch)>,
) -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let asked: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&asked);
    tokio::spawn(async move {
        let note = |what: String| recorder.lock().unwrap().push(what);
        let Ok((stream, _)) = listener.accept().await else {
            return note("accept failed".into());
        };
        let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
            return note("websocket upgrade failed".into());
        };

        let Some(hello) = recv_json(&mut ws).await else {
            return note("no client-hello".into());
        };
        let Ok(ClientMsg::ClientHello { nonce_c, .. }) = serde_json::from_value(hello) else {
            return note("first message was not a client-hello".into());
        };
        let nonce_h: [u8; 32] = rand::random();
        let Some(nonce_c_raw) = unb64(&nonce_c) else {
            return note("client-hello carried an undecodable nonce_c".into());
        };
        let sig_h = hub_key().sign(&hub_challenge_message(&nonce_h, &nonce_c_raw, &[0u8; 32]));
        if !send_hub(&mut ws, &HubMsg::HubChallenge {
            nonce_h: b64(&nonce_h),
            hub_key_id: hub_key_id(),
            sig_h: b64(&sig_h.to_bytes()),
        })
        .await
        {
            return;
        }

        if recv_json(&mut ws).await.is_none() {
            return note("no client-auth".into());
        }
        let vault_state = std::iter::once(VaultState { vault_id: "v1".into(), holds })
            .chain(
                fetches
                    .iter()
                    .map(|(id, _)| VaultState { vault_id: id.clone(), holds: None }),
            )
            .collect();
        if !send_hub(&mut ws, &HubMsg::SyncReady {
            protocol_version: PROTOCOL_VERSION,
            vault_state,
            grants,
            revocations,
        })
        .await
        {
            return;
        }

        // Everything after `SyncReady`, in one loop. A cycle settles its link
        // grants first, uploads or skips depending on what this hub just said
        // it holds, and then reads — and which of the three arrives when is
        // the client's decision, not the mock's to assume. Assuming it is how
        // a mock ends up deciding the outcome it is measuring.
        loop {
            let msg = match ws.next().await {
                Some(Ok(Message::Text(t))) => match serde_json::from_str::<serde_json::Value>(t.as_str()) {
                    Ok(v) => v,
                    Err(e) => return note(format!("unparseable:{e}")),
                },
                Some(Ok(Message::Ping(d))) => {
                    if ws.send(Message::Pong(d)).await.is_err() {
                        return;
                    }
                    continue;
                }
                Some(Ok(Message::Close(_))) | None => return,
                Some(Ok(other)) => return note(format!("unexpected-frame:{other:?}")),
                Some(Err(e)) => return note(format!("ws-error:{e}")),
            };
            let tag = msg["type"].as_str().unwrap_or("?").to_string();
            let parsed: ClientMsg = match serde_json::from_value(msg) {
                Ok(m) => m,
                Err(e) => return note(format!("unparseable:{tag}:{e}")),
            };
            match parsed {
                ClientMsg::PutGrant { statement_b64, .. } => {
                    use sha2::Digest;
                    let Some(statement) = unb64(&statement_b64) else {
                        return note("put-grant carried an undecodable statement".into());
                    };
                    note(format!("put-grant:{statement_b64}"));
                    let reply = match on_grant {
                        OnGrant::Ack => HubMsg::GrantAck {
                            grant_id: hex::encode(sha2::Sha256::digest(&statement)),
                        },
                        OnGrant::Reject(reason) => HubMsg::Reject { reason: reason.into() },
                    };
                    if !send_hub(&mut ws, &reply).await {
                        return;
                    }
                }
                ClientMsg::UploadIndex { vault_id, sha256, .. } => {
                    if ws.next().await.is_none() {
                        return note("upload-index with no frame behind it".into());
                    }
                    let ack = match on_upload {
                        OnUpload::Reject => {
                            let _ = send_hub(&mut ws, &HubMsg::Reject {
                                reason: "not authorized to write this vault".into(),
                            })
                            .await;
                            return;
                        }
                        OnUpload::Ack => HubMsg::UploadAck { vault_id, sha256 },
                        OnUpload::AckWrongSha => {
                            let _ = send_hub(&mut ws, &HubMsg::UploadAck {
                                vault_id,
                                sha256: WRONG_SHA.into(),
                            })
                            .await;
                            return;
                        }
                    };
                    if !send_hub(&mut ws, &ack).await {
                        return;
                    }
                }
                // The read half. The client asks for exactly the vaults the
                // hub listed in `SyncReady.vault_state` and no others, so a
                // hub that listed only `v1` must see the connection close
                // rather than a request for anything.
                ClientMsg::FetchIndex { vault_id } => {
                    note(vault_id.clone());
                    let Some((_, answer)) = fetches.iter().find(|(id, _)| *id == vault_id) else {
                        return note(format!("unscripted:{vault_id}"));
                    };
                    let (header, frame) = match answer {
                        Fetch::Serve(bytes) => {
                            use sha2::Digest;
                            let header = HubMsg::IndexHeader {
                                vault_id,
                                holds: Some(HeldIndex {
                                    sha256: hex::encode(sha2::Sha256::digest(bytes)),
                                    note_count: 3,
                                    uploaded_at: 1,
                                }),
                            };
                            (header, Some(bytes.clone()))
                        }
                        Fetch::Refuse => (
                            HubMsg::Reject { reason: "not authorized to read this vault".into() },
                            None,
                        ),
                    };
                    if !send_hub(&mut ws, &header).await {
                        return;
                    }
                    if let Some(bytes) = frame {
                        if ws.send(Message::binary(bytes)).await.is_err() {
                            return;
                        }
                    }
                }
                _ => return note(format!("unexpected:{tag}")),
            }
        }
    });
    (addr, asked)
}

/// A signed, active `follow` from a fresh key to `to`, scoped to `vault_id` —
/// the wire shape the handshake delivers.
fn follow_grant(to: &KeyId, vault_id: &str) -> GrantWire {
    let issuer = SigningKey::from_bytes(&[19u8; 32]);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let statement = GrantStatement {
        v: 5,
        kind: GrantKind::Follow,
        from: KeyId::from_pubkey(&issuer.verifying_key()),
        to: to.clone(),
        scope: Some(vault_id.to_string()),
        issued_at: now - 1,
        expires_at: now + 86_400,
        nonce: "ZmFrZS1ub25jZQ".into(),
    };
    let bytes = canonical_bytes(&statement);
    let sig = issuer.sign(&bytes);
    GrantWire {
        statement_b64: b64(&bytes),
        signature_b64: b64(&sig.to_bytes()),
        state: "active".into(),
    }
}

/// A signed, active, unscoped `link` from a fresh key to `to` — what an
/// established machine lodges when it admits a new one.
fn link_grant(to: &KeyId) -> (SigningKey, GrantWire) {
    let issuer = SigningKey::from_bytes(&[29u8; 32]);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let statement = GrantStatement {
        v: 5,
        kind: GrantKind::Link,
        from: KeyId::from_pubkey(&issuer.verifying_key()),
        to: to.clone(),
        scope: None,
        issued_at: now - 1,
        expires_at: now + 86_400,
        nonce: "ZmFrZS1saW5r".into(),
    };
    let bytes = canonical_bytes(&statement);
    let sig = issuer.sign(&bytes);
    (
        issuer,
        GrantWire {
            statement_b64: b64(&bytes),
            signature_b64: b64(&sig.to_bytes()),
            state: "active".into(),
        },
    )
}

/// A `follow` from `issuer` to `to`, scoped to one vault — the shape whose
/// withdrawal names a cache to delete. Returned with the wire form and the
/// grant id, because a revocation names the id and the test has to hold it.
fn scoped_follow(issuer: &SigningKey, to: &KeyId, vault_id: &str) -> (GrantWire, String) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let statement = GrantStatement {
        v: 5,
        kind: GrantKind::Follow,
        from: KeyId::from_pubkey(&issuer.verifying_key()),
        to: to.clone(),
        scope: Some(vault_id.into()),
        issued_at: now - 1,
        expires_at: now + 86_400,
        nonce: "ZmFrZS1mb2xsb3c".into(),
    };
    let bytes = canonical_bytes(&statement);
    let sig = issuer.sign(&bytes);
    (
        GrantWire {
            statement_b64: b64(&bytes),
            signature_b64: b64(&sig.to_bytes()),
            state: "active".into(),
        },
        ll_search::sync::grant::grant_id(&bytes),
    )
}

/// That grant's withdrawal, signed by its issuer and carrying its scope.
fn revocation_of(issuer: &SigningKey, grant_id: &str, scope: Option<&str>) -> RevocationWire {
    let statement = canonical_bytes(&RevocationStatement {
        v: 5,
        kind: "revoke",
        grant_id: grant_id.to_string(),
        by: KeyId::from_pubkey(&issuer.verifying_key()),
        scope: scope.map(str::to_string),
        at: 2,
    });
    let sig = issuer.sign(&statement);
    RevocationWire { statement_b64: b64(&statement), signature_b64: b64(&sig.to_bytes()) }
}

/// This client's own key id, from the seed `config_for` generated.
fn client_key_id(config_dir: &Path) -> KeyId {
    let seed = ll_search::sync::seed_store::load_or_create(config_dir).expect("seed");
    KeyId::from_pubkey(&seed.signing_key.verifying_key())
}

fn config_for(config_dir: &Path, addr: SocketAddr) -> FederationConfig {
    std::fs::create_dir_all(config_dir.join("federation")).unwrap();
    let seed = ll_search::sync::seed_store::load_or_create(config_dir).expect("generate a seed");
    FederationConfig {
        identity: Identity {
            display_name: "test-peer".into(),
            pubkey: format!("ed25519:{}", ll_search::sync::auth::pubkey_b64(&seed.signing_key)),
        },
        visibility: VisibilityConfig { default: "private".into(), rules: vec![] },
        hub: HubEndpoint { endpoint: format!("ws://{addr}"), key_id: Some(hub_key_id()) },
        vault_id: Some("v1".into()),
        vault_path: None,
        recovery_key_id: None,
    }
}

/// Put an export where `prepare_export` will reuse it, so the cycle needs no
/// source index. Its `meta` contract is pinned by the lib tests in
/// `sync::client`; duplicating the source schema here would be free to drift.
fn place_export(config_dir: &Path) {
    let path = export_db_path(config_dir);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(&format!(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
         INSERT INTO meta VALUES ('note_count', '{LOCAL_NOTE_COUNT}'),
                                 ('schema_version', '2'), ('model_id', 'test-model');"
    ))
    .unwrap();
}

/// The sha the client will declare for the export just placed: the hub acks
/// exactly this, and on the skip path it is what the hub must already hold.
fn export_sha(config_dir: &Path) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(std::fs::read(export_db_path(config_dir)).unwrap()))
}

fn stale() -> Option<HeldIndex> {
    Some(HeldIndex {
        sha256: "0000000000000000000000000000000000000000000000000000000000000000".into(),
        note_count: HUB_NOTE_COUNT,
        uploaded_at: 1,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_that_dies_before_the_hub_still_writes_state() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    // No hub is ever contacted: there is no export to reuse and no source
    // index to build one from, so the cycle dies in `prepare_export`.
    let config = config_for(dir.path(), "127.0.0.1:1".parse().unwrap());

    let err = sync_all_async(
        &dir.path().join("no-such-source.db"),
        vault.path(),
        dir.path(),
        &config,
    )
    .await
    .expect_err("precondition: this cycle cannot succeed");

    let state = read_state(dir.path()).unwrap().expect("a failed cycle still records");
    assert_eq!(state.outcome, OUTCOME_ERROR);
    assert_eq!(state.detail.as_deref(), Some(err.to_string().as_str()),
        "the recorded detail is the cycle's own error, not a placeholder");
    assert_eq!(state.hub_holds, None, "the cycle never got far enough to ask the hub");
    assert!(state.last_attempt_at > 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_successful_cycle_writes_a_different_state() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let addr = spawn_hub(stale(), OnUpload::Ack).await;
    let config = config_for(dir.path(), addr);
    place_export(dir.path());

    let result = sync_all_async(
        &dir.path().join("no-such-source.db"),
        vault.path(),
        dir.path(),
        &config,
    )
    .await
    .expect("the cycle completes against the mock hub");
    assert_eq!(result.uploaded_notes, LOCAL_NOTE_COUNT);

    let state = read_state(dir.path()).unwrap().expect("a successful cycle records too");
    assert_eq!(state.outcome, OUTCOME_OK);
    assert_eq!(state.detail, None);
    assert_eq!(state.last_success_at, Some(state.last_attempt_at));
    assert_eq!(
        state.hub_holds,
        Some(HubHolds::Index {
            sha256: export_sha(dir.path()),
            note_count: LOCAL_NOTE_COUNT,
        }),
        "the upload was acked, so the hub now holds the index we just sent — not the \
         stale one it reported at the handshake",
    );
}

/// The false alarm this cost a round to get right. A hub that held nothing,
/// then accepted the upload, holds something; recording the handshake's
/// `Nothing` would print the outage warning immediately after the cycle that
/// fixed the outage, and a warning that cries wolf is how the real one went
/// unread for two months.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cold_hub_that_accepted_the_upload_is_not_recorded_as_holding_nothing() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let addr = spawn_hub(None, OnUpload::Ack).await;
    let config = config_for(dir.path(), addr);
    place_export(dir.path());

    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect("the cycle completes");

    let holds = read_state(dir.path()).unwrap().unwrap().hub_holds;
    assert_ne!(holds, Some(HubHolds::Nothing),
        "the hub acked the upload in this very cycle");
    assert_eq!(
        holds,
        Some(HubHolds::Index { sha256: export_sha(dir.path()), note_count: LOCAL_NOTE_COUNT }),
    );
}

/// The skip path is the one where the count in the file is the hub's own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_skipped_upload_records_what_the_hub_reported() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let held = HeldIndex {
        sha256: export_sha(dir.path()),
        note_count: HUB_NOTE_COUNT,
        uploaded_at: 1,
    };
    let addr = spawn_hub(Some(held.clone()), OnUpload::Ack).await;
    let config = config_for(dir.path(), addr);

    let result =
        sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
            .await
            .expect("the cycle completes");
    assert!(result.skipped_upload, "precondition: the hub holds this exact index");

    assert_eq!(
        read_state(dir.path()).unwrap().unwrap().hub_holds,
        Some(HubHolds::Index { sha256: held.sha256, note_count: HUB_NOTE_COUNT }),
        "nothing was uploaded, so the record is the hub's own report — including \
         its count, which is not this client's {LOCAL_NOTE_COUNT}",
    );
}

/// A cycle that authenticated and then died still knows what the hub said.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_that_fails_after_the_handshake_records_what_the_hub_reported() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let addr = spawn_hub(stale(), OnUpload::Reject).await;
    let config = config_for(dir.path(), addr);
    place_export(dir.path());

    let err =
        sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
            .await
            .expect_err("the hub rejects the upload");
    assert!(err.to_string().contains("not authorized"), "{err}");

    let state = read_state(dir.path()).unwrap().unwrap();
    assert_eq!(state.outcome, OUTCOME_ERROR);
    assert_eq!(
        state.hub_holds,
        Some(HubHolds::Index {
            sha256: "0000000000000000000000000000000000000000000000000000000000000000".into(),
            note_count: HUB_NOTE_COUNT,
        }),
        "the rejected upload must not be recorded as held, and the handshake's \
         report must not be thrown away either",
    );
}

/// A failure must not erase when this vault last synced. How long the outage
/// has been running is the question the file is read for.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_after_a_success_keeps_the_last_success_time() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let addr = spawn_hub(stale(), OnUpload::Ack).await;
    let config = config_for(dir.path(), addr);
    place_export(dir.path());

    let source = dir.path().join("no-such-source.db");
    sync_all_async(&source, vault.path(), dir.path(), &config).await.expect("first cycle");
    let succeeded_at = read_state(dir.path()).unwrap().unwrap().last_success_at;
    assert!(succeeded_at.is_some(), "precondition: the first cycle succeeded");

    // Take the export away; the next cycle dies in `prepare_export`.
    std::fs::remove_file(export_db_path(dir.path())).unwrap();
    sync_all_async(&source, vault.path(), dir.path(), &config).await.unwrap_err();

    let state = read_state(dir.path()).unwrap().unwrap();
    assert_eq!(state.outcome, OUTCOME_ERROR);
    assert_eq!(state.last_success_at, succeeded_at);
}

/// We hashed the bytes, so a hub acknowledging a different index is
/// contradicting the side that knows. The cycle fails, and — the part that
/// matters here — the hub's claim never reaches our own state file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_index_the_hub_acked_but_we_never_sent_is_not_recorded() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let addr = spawn_hub(stale(), OnUpload::AckWrongSha).await;
    let config = config_for(dir.path(), addr);
    place_export(dir.path());

    let err =
        sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
            .await
            .expect_err("an unaccountable ack fails the cycle");
    assert!(err.to_string().contains(&export_sha(dir.path())), "names what we sent: {err}");
    assert!(err.to_string().contains(WRONG_SHA), "names what the hub acked: {err}");

    let holds = read_state(dir.path()).unwrap().unwrap().hub_holds;
    assert_ne!(
        holds,
        Some(HubHolds::Index { sha256: WRONG_SHA.into(), note_count: LOCAL_NOTE_COUNT }),
        "the hub's claim must not become our record of what it holds",
    );
    assert_eq!(
        holds,
        Some(HubHolds::Index {
            sha256: "0000000000000000000000000000000000000000000000000000000000000000".into(),
            note_count: HUB_NOTE_COUNT,
        }),
        "what stands is the handshake report, unchanged by a failed upload",
    );
}

/// R-D, end to end. One followed vault the hub refuses, one it serves. The
/// refusal must not cost the other vault its fetch, and the count must reach
/// the state file — a read half that quietly fetched nothing is the shape of
/// the outage this project exists to undo.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_that_could_not_read_a_followed_vault_records_how_many() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let me = client_key_id(dir.path());
    let served = b"pretend-this-is-a-peer-index".to_vec();
    let (addr, asked) = spawn_hub_with(
        stale(),
        OnUpload::Ack, OnGrant::Ack,
        vec![follow_grant(&me, "v-refused"), follow_grant(&me, "v-served")],
        vec![
            ("v-refused".to_string(), Fetch::Refuse),
            ("v-served".to_string(), Fetch::Serve(served.clone())),
        ],
    )
    .await;
    let config = config_for(dir.path(), addr);

    let result =
        sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
            .await
            .expect("one refused read does not fail the cycle");

    assert_eq!(result.skipped_fetches, vec!["v-refused".to_string()]);
    assert_eq!(result.fetched.len(), 1, "the second vault was still fetched");
    assert_eq!(
        std::fs::read(dir.path().join("federation/data/peers/v-served/index.db")).unwrap(),
        served,
    );

    assert_eq!(*asked.lock().unwrap(), vec!["v-refused".to_string(), "v-served".to_string()],
        "the refusal did not stop the client asking for the next one");

    let state = read_state(dir.path()).unwrap().unwrap();
    assert_eq!(state.outcome, OUTCOME_OK);
    assert_eq!(state.skipped_fetches, Some(1),
        "a partial read failure is recorded, not swallowed");
}

/// The other side of it. `Some(1)` above only means something if a cycle that
/// read everything records `Some(0)` rather than the same number.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_that_read_everything_records_no_skips() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let me = client_key_id(dir.path());
    let (addr, asked) = spawn_hub_with(
        stale(),
        OnUpload::Ack, OnGrant::Ack,
        vec![follow_grant(&me, "v-served")],
        vec![("v-served".to_string(), Fetch::Serve(b"peer-index".to_vec()))],
    )
    .await;
    let config = config_for(dir.path(), addr);

    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect("the cycle completes");

    assert_eq!(*asked.lock().unwrap(), vec!["v-served".to_string()]);
    assert_eq!(read_state(dir.path()).unwrap().unwrap().skipped_fetches, Some(0));
}

/// Plan 7 end to end: link a second machine and see the first one's notes.
///
/// The only grant this machine holds is the unscoped `link` that joined it,
/// and an unscoped grant names no vault — the hub's `vault_state` is the only
/// thing here that says which vault to read. Every unit test of the read half
/// drives `fetch_all` directly, so a `run_cycle` that handed it anything but
/// the hub's own listing would leave all of them green. This is the test that
/// notices.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_linked_machine_reads_the_vault_the_hub_listed_for_it() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let me = client_key_id(dir.path());
    let (_approver, inbound) = link_grant(&me);
    let served = b"pretend-this-is-the-other-machines-index".to_vec();
    let (addr, seen) = spawn_hub_with(
        stale(),
        OnUpload::Ack, OnGrant::Ack,
        vec![inbound],
        vec![("v-other-machine".to_string(), Fetch::Serve(served.clone()))],
    )
    .await;
    let config = config_for(dir.path(), addr);

    let result =
        sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
            .await
            .expect("the cycle completes");

    assert_eq!(result.fetched.len(), 1, "the vault the hub listed was read");
    assert_eq!(
        std::fs::read(dir.path().join("federation/data/peers/v-other-machine/index.db")).unwrap(),
        served,
    );
    let fetched: Vec<String> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|line| !line.starts_with("put-grant:"))
        .cloned()
        .collect();
    assert_eq!(fetched, vec!["v-other-machine".to_string()],
        "exactly the listing, less this machine's own vault");
}

/// A real peer index, as bytes a hub can serve. `model_id` matches what
/// `discover_peer_dbs` is asked for, so a cache written from these bytes is
/// one the search path will actually open.
fn peer_index_bytes() -> Vec<u8> {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("index.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
         INSERT INTO meta (key, value) VALUES ('model_id', 'test-model');",
    )
    .unwrap();
    drop(conn);
    std::fs::read(&path).unwrap()
}

/// The read filter, end to end, on the machine where the grant store alone
/// cannot help.
///
/// The only grant here is the unscoped `link` that joined this machine, and
/// an unscoped grant covers **every** vault — so `grants::covers` says yes to
/// both caches below and the orphan would be served. The hub's listing is the
/// only thing on this disk that distinguishes them, and this is the cycle
/// that writes it down.
///
/// Every unit test of the filter plants `readable-vaults.json` by hand, so
/// deleting the `write_readable_vaults` call in `run_cycle` leaves all of them
/// green — the same hazard `a_cycle_deletes_the_peer_cache_a_revocation_withdraws`
/// exists for. This is the test that notices.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_records_the_hubs_listing_and_the_reader_serves_only_what_is_on_it() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let me = client_key_id(dir.path());
    let (_approver, inbound) = link_grant(&me);

    // A cache for a vault this hub does not list — four months old, nothing
    // on this machine names it, and nothing can delete it: an unscoped
    // withdrawal names no cache, and there is no withdrawal here anyway.
    let orphan = ll_search::sync::config::peer_dir(dir.path(), "v-thomas-kirk");
    std::fs::create_dir_all(&orphan).unwrap();
    std::fs::write(orphan.join("index.db"), peer_index_bytes()).unwrap();

    let (addr, _seen) = spawn_hub_with(
        stale(),
        OnUpload::Ack, OnGrant::Ack,
        vec![inbound],
        vec![("v-other-machine".to_string(), Fetch::Serve(peer_index_bytes()))],
    )
    .await;
    let config = config_for(dir.path(), addr);

    let before = unix_seconds();
    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect("the cycle completes");
    let after = unix_seconds();

    let listed = read_readable_vaults(dir.path()).unwrap()
        .expect("the cycle records what the hub listed");
    assert!(listed.contains("v-other-machine"));
    // `at` is the whole of the staleness answer `ll status` renders and the
    // only thing bounding how old an answer this machine will serve on. It
    // has to be when the hub said it, not a constant: `at: 0` renders as a
    // permanent "read authority 20335 days old" on a machine that just
    // synced, and a false alarm on that warning is most of how the original
    // outage stayed invisible for two months.
    assert!((before..=after).contains(&listed.at),
        "the cycle stamped {} and it ran between {before} and {after}", listed.at);
    assert!(!listed.contains("v-thomas-kirk"),
        "the hub did not list it, so nothing may put it on the record");
    assert!(!listed.contains("v1"),
        "this machine's own vault is not a peer cache and never was");

    let served: Vec<String> =
        ll_search::search::discover_peer_dbs(dir.path(), "test-model", listed.at)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
    assert_eq!(served, vec!["v-other-machine".to_string()],
        "the unscoped link covers both caches; only one of them is a vault the hub listed");
    assert!(orphan.join("index.db").exists(),
        "and the orphan is hidden without being deleted — deletion is disk hygiene now");
}

/// The v4 download half opened with `list-peers` on every cycle, listing or
/// no listing. v5 asks for the vaults the hub named and nothing else, so a
/// hub that named only this client's own must see the connection close
/// without a word.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_whose_hub_lists_only_this_vault_asks_for_nothing() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let (addr, asked) = spawn_hub_with(stale(), OnUpload::Ack, OnGrant::Ack, vec![], vec![]).await;
    let config = config_for(dir.path(), addr);

    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect("the cycle completes");

    assert!(asked.lock().unwrap().is_empty(),
        "nothing was said after the upload: {:?}", asked.lock().unwrap());
    assert_eq!(read_state(dir.path()).unwrap().unwrap().skipped_fetches, Some(0));
}

/// A cycle that never reached the read half must not report "none failed".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_that_died_before_the_read_half_records_nothing_about_it() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let config = config_for(dir.path(), "127.0.0.1:1".parse().unwrap());

    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect_err("precondition: this cycle cannot succeed");

    assert_eq!(read_state(dir.path()).unwrap().unwrap().skipped_fetches, None,
        "unknown is a different report from zero and must not be rendered as one");
}

/// The `link` half of a cycle, at the wire.
///
/// A machine that was admitted a minute ago owes the other half of that link,
/// and a sync cycle is the only place a normal day produces one. Every unit
/// test of that behaviour drives `reconcile` directly, so deleting the one
/// line in `run_cycle` that calls it leaves all of them green — this is the
/// test that notices.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_answers_an_inbound_link_with_its_own_half() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let me = client_key_id(dir.path());
    let (approver, inbound) = link_grant(&me);
    let held = HeldIndex {
        sha256: export_sha(dir.path()),
        note_count: HUB_NOTE_COUNT,
        uploaded_at: 1,
    };
    let (addr, seen) = spawn_hub_with(Some(held), OnUpload::Ack, OnGrant::Ack, vec![inbound], vec![]).await;
    let config = config_for(dir.path(), addr);

    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect("the cycle completes");

    let lodged: Vec<GrantStatement> = seen
        .lock()
        .unwrap()
        .iter()
        .filter_map(|line| line.strip_prefix("put-grant:"))
        .map(|b| serde_json::from_slice(&unb64(b).expect("base64")).expect("a grant statement"))
        .collect();
    assert_eq!(lodged.len(), 1, "the cycle owed exactly one grant: {:?}", seen.lock().unwrap());
    assert_eq!(lodged[0].kind, GrantKind::Link);
    assert_eq!(lodged[0].from, me, "each key signs only its own sentence");
    assert_eq!(lodged[0].to, KeyId::from_pubkey(&approver.verifying_key()));
    assert!(lodged[0].scope.is_none(), "a device link is unscoped");
}

/// The other side of that boundary: a cycle with nothing owed sends no
/// `PutGrant` at all. An implementation that lodged on every connection would
/// satisfy the test above and put a fresh row on the hub every five minutes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_with_nothing_owed_lodges_nothing() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let held = HeldIndex {
        sha256: export_sha(dir.path()),
        note_count: HUB_NOTE_COUNT,
        uploaded_at: 1,
    };
    let (addr, seen) = spawn_hub_with(Some(held), OnUpload::Ack, OnGrant::Ack, vec![], vec![]).await;
    let config = config_for(dir.path(), addr);

    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect("the cycle completes");

    assert!(
        seen.lock().unwrap().iter().all(|line| !line.starts_with("put-grant:")),
        "{:?}",
        seen.lock().unwrap()
    );
}

/// A refused grant must not wedge the cycle.
///
/// `link::reconcile` runs before the upload and the read half. When it
/// propagated the hub's first `Reject`, one grant the hub was never going to
/// accept stopped every subsequent cycle — no upload, no fetch, permanently,
/// and the owed row was never cleared so it happened again next time. The read
/// half in this same cycle has always tolerated a refused fetch; this pins the
/// grant half behaving the same way, end to end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_grant_does_not_stop_the_upload_or_the_read_half() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let me = client_key_id(dir.path());
    let (_approver, inbound) = link_grant(&me);
    let (addr, seen) = spawn_hub_with(
        stale(),
        OnUpload::Ack,
        OnGrant::Reject("not a member"),
        vec![inbound],
        vec![],
    )
    .await;
    let config = config_for(dir.path(), addr);

    let result =
        sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
            .await
            .expect("a hub that answers is a hub the rest of the cycle can still use");

    assert!(!result.skipped_upload,
        "the hub holds a stale index, so the upload had to happen — and it comes AFTER \
         the grant half, which is the whole point");
    assert_eq!(result.refused_grants.len(), 1);

    let record = seen.lock().unwrap().clone();
    assert!(record.iter().any(|l| l.starts_with("put-grant:")), "{record:?}");

    let state = read_state(dir.path()).unwrap().unwrap();
    assert_eq!(state.outcome, OUTCOME_OK, "the cycle succeeded; one grant did not");
    assert_eq!(state.refused_grants, Some(1),
        "and `ll status` can say so, rather than the user meeting it as a machine that \
         never finishes linking");
    assert_eq!(state.skipped_fetches, Some(0), "the read half ran");
}

/// The other side: a cycle whose grants were all accepted records zero, not
/// `None` and not one. An implementation that always recorded a refusal would
/// satisfy the test above on its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_whose_grants_were_accepted_records_no_refusals() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let me = client_key_id(dir.path());
    let (_approver, inbound) = link_grant(&me);
    let (addr, _seen) =
        spawn_hub_with(stale(), OnUpload::Ack, OnGrant::Ack, vec![inbound], vec![]).await;
    let config = config_for(dir.path(), addr);

    let result =
        sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
            .await
            .unwrap();

    assert!(result.refused_grants.is_empty());
    assert_eq!(read_state(dir.path()).unwrap().unwrap().refused_grants, Some(0));
}

/// **D-8's call site.** The two boundary tests in `sync::client` pin
/// `upload_fits`; this pins the line that calls it. Disabling the pre-flight
/// left the whole suite green, and what it costs is the difference between a
/// named error and a hub that closes the connection mid-frame.
///
/// It needs no hub: the pre-flight runs before the seed is loaded and long
/// before anything is dialled, which is the whole point of a pre-flight.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_export_too_big_for_one_frame_is_refused_before_the_hub_is_dialled() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_oversize_export(dir.path());

    // Nothing listens here, so a cycle that got past the pre-flight would fail
    // on the connection instead and say so.
    let config = config_for(dir.path(), "127.0.0.1:1".parse().unwrap());
    let err = sync_all_async(
        &dir.path().join("no-such-source.db"),
        vault.path(),
        dir.path(),
        &config,
    )
    .await
    .expect_err("an export this size cannot be sent");

    assert!(
        matches!(err.downcast_ref::<SyncError>(), Some(SyncError::EnvelopeOversize { .. })),
        "the size rule is what refused it, not a failed connection: {err}",
    );
}

/// An export one byte past what a single frame can carry. `zeroblob` grows
/// the file without this test materialising the bytes.
fn place_oversize_export(config_dir: &Path) {
    const CAP: usize = 50 * 1024 * 1024;
    let path = export_db_path(config_dir);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(&format!(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
         INSERT INTO meta VALUES ('note_count', '{LOCAL_NOTE_COUNT}'),
                                 ('schema_version', '2'), ('model_id', 'test-model');
         CREATE TABLE pad (b BLOB);
         INSERT INTO pad VALUES (zeroblob({CAP}));"
    ))
    .unwrap();
    drop(conn);
    assert!(std::fs::metadata(&path).unwrap().len() as usize > CAP,
        "precondition: the export has to actually exceed the cap");
}

/// **Before the upload, not after.** `run_cycle` writes the hub's listing
/// down before it offers the index, and the comment beside that call says why:
/// a cycle that dies uploading must still have stopped serving what the hub no
/// longer lists. Moving the call to sit beside `fetch_all` — where it reads as
/// tidier, next to the half that uses the list — left all 680 tests green.
///
/// Two cycles, and the second one fails on purpose. The hub lists
/// `v-other-machine` and takes the upload; then it stops listing it and
/// rejects the upload. The rejection is the point: it aborts the cycle after
/// the handshake and before `fetch_all`, so the only thing that can have
/// rewritten the list is a write that happens before the upload.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_that_dies_uploading_has_already_stopped_serving_what_the_hub_dropped() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let me = client_key_id(dir.path());
    let (_approver, inbound) = link_grant(&me);

    let (addr, _seen) = spawn_hub_with(
        stale(),
        OnUpload::Ack, OnGrant::Ack,
        vec![inbound],
        vec![("v-other-machine".to_string(), Fetch::Serve(peer_index_bytes()))],
    )
    .await;
    let config = config_for(dir.path(), addr);
    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect("the first cycle completes");

    let listed = read_readable_vaults(dir.path()).unwrap().expect("the first cycle recorded");
    assert!(listed.contains("v-other-machine"),
        "precondition: there is something on the list for the second cycle to remove");
    assert!(served_vaults(dir.path()).contains(&"v-other-machine".to_string()),
        "precondition: and the reader is serving it");

    // The same hub, listing nothing but this client's own vault, refusing the
    // upload it is offered.
    let (addr, _seen) = spawn_hub_with(stale(), OnUpload::Reject, OnGrant::Ack, vec![], vec![]).await;
    let config = config_for(dir.path(), addr);
    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect_err("precondition: the second cycle dies on the rejected upload");

    let listed = read_readable_vaults(dir.path()).unwrap()
        .expect("a cycle that reached the hub still wrote the list");
    assert!(!listed.contains("v-other-machine"),
        "the hub stopped listing it, so this machine stopped serving it — a failed \
         upload is not a reason to go on serving what the hub dropped");
    assert_eq!(served_vaults(dir.path()), Vec::<String>::new(),
        "and the reader agrees, which is where it would have been noticed");
}

/// What `ll search` would serve out of the peer caches right now, judged
/// against the recorded list.
fn served_vaults(config_dir: &Path) -> Vec<String> {
    let Some(listed) = read_readable_vaults(config_dir).unwrap() else { return Vec::new() };
    ll_search::search::discover_peer_dbs(config_dir, "test-model", listed.at)
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

/// The read half's mirror: a cycle must act on the revocations the handshake
/// served, and deleting the local copy is what revocation MEANS here.
///
/// Every unit test of that behaviour drives `grants::apply_revocations`
/// directly, so removing the line in `run_cycle` that calls it leaves all of
/// them green — exactly as `a_cycle_answers_an_inbound_link_with_its_own_half`
/// exists for the link half. This is the test that notices.
///
/// It could not be written at all until `SyncReady.revocations` stopped being
/// hardcoded `vec![]` in this mock.
///
/// **The first cycle fetches `v-other` rather than the test planting it.** A
/// peer cache exists only because the hub listed that vault and served its
/// index — this mock's own rule, and `withdraw` now reads the same listing
/// before it deletes anything. A hand-planted cache for a vault this hub had
/// never listed was an arrangement that cannot occur, and the deletion would
/// have been refused for that reason rather than tested.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_deletes_the_peer_cache_a_revocation_withdraws() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let me = client_key_id(dir.path());
    let issuer = SigningKey::from_bytes(&[31u8; 32]);
    let (granted, grant_id) = scoped_follow(&issuer, &me, "v-other");

    // The cache the grant justified, and one nothing in this cycle names.
    let cache = ll_search::sync::config::peer_dir(dir.path(), "v-other");
    let untouched = ll_search::sync::config::peer_dir(dir.path(), "v-unrelated");
    std::fs::create_dir_all(&untouched).unwrap();
    std::fs::write(untouched.join("index.db"), b"peer data").unwrap();

    let held = HeldIndex {
        sha256: export_sha(dir.path()),
        note_count: HUB_NOTE_COUNT,
        uploaded_at: 1,
    };

    // First cycle: the hub serves the grant, and the client stores it. This
    // is the step the whole rule depends on — a revoked grant never comes
    // back in `grants`, so a client that had not already kept it has nothing
    // to resolve the revocation against.
    let (addr, _) = spawn_hub_full(
        Some(held.clone()),
        OnUpload::Ack,
        OnGrant::Ack,
        vec![granted],
        vec![],
        vec![("v-other".to_string(), Fetch::Serve(peer_index_bytes()))],
    )
    .await;
    let config = config_for(dir.path(), addr);
    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect("the first cycle completes");
    assert!(cache.join("index.db").exists(), "precondition: an active grant keeps its cache");

    // Second cycle: the grant is gone from `grants` and present only as a
    // signed revocation, which is how a real hub serves one.
    let (addr, _) =
        spawn_hub_revoking(Some(held), vec![], vec![revocation_of(&issuer, &grant_id, Some("v-other"))])
            .await;
    let config = config_for(dir.path(), addr);
    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect("the second cycle completes");

    assert!(!cache.exists(),
        "data already read cannot be recalled, but continuing to serve it is not revocation");
    assert!(untouched.join("index.db").exists(),
        "no grant named it, so no revocation may remove it");
}

/// The sibling rule, and the one the listing test above was written beside.
/// `apply_revocations` runs before the upload for the same reason the listing
/// write does — and moving it after `upload_index` left every test green,
/// including the revocation test above, because that one drives a cycle whose
/// upload succeeds.
///
/// Same two cycles as that test, with the second cycle's upload rejected.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_that_dies_uploading_has_already_dropped_what_a_revocation_withdrew() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let me = client_key_id(dir.path());
    let issuer = SigningKey::from_bytes(&[31u8; 32]);
    let (granted, grant_id) = scoped_follow(&issuer, &me, "v-other");

    // The cache arrives the way a real one does — the hub lists `v-other` and
    // serves it. Planting it by hand would describe a hub that lists nothing
    // and answers for it anyway, which `spawn_hub_full` says cannot occur.
    let cache = ll_search::sync::config::peer_dir(dir.path(), "v-other");
    let (addr, _) = spawn_hub_full(
        stale(),
        OnUpload::Ack,
        OnGrant::Ack,
        vec![granted],
        vec![],
        vec![("v-other".to_string(), Fetch::Serve(peer_index_bytes()))],
    )
    .await;
    let config = config_for(dir.path(), addr);
    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect("the first cycle completes");
    assert!(cache.join("index.db").exists(),
        "precondition: the hub listed it, served it, and the grant justifies keeping it");

    let (addr, _) = spawn_hub_full(
        stale(),
        OnUpload::Reject,
        OnGrant::Ack,
        vec![],
        vec![revocation_of(&issuer, &grant_id, Some("v-other"))],
        vec![],
    )
    .await;
    let config = config_for(dir.path(), addr);
    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect_err("precondition: the second cycle dies on the rejected upload");

    assert!(!cache.exists(),
        "the revocation arrived and was acted on before the upload was offered; a \
         failed upload is not a reason to go on serving a withdrawn grant");
}

/// The same cycle, with the revocation signed by someone who never issued the
/// grant. The hub is not trusted to have checked: it carries revocations, it
/// does not vouch for them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cycle_ignores_a_revocation_the_grants_issuer_did_not_sign() {
    test_env();
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    place_export(dir.path());
    let me = client_key_id(dir.path());
    let issuer = SigningKey::from_bytes(&[31u8; 32]);
    let stranger = SigningKey::from_bytes(&[32u8; 32]);
    let (granted, grant_id) = scoped_follow(&issuer, &me, "v-other");

    let cache = ll_search::sync::config::peer_dir(dir.path(), "v-other");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(cache.join("index.db"), b"peer data").unwrap();

    let held = HeldIndex {
        sha256: export_sha(dir.path()),
        note_count: HUB_NOTE_COUNT,
        uploaded_at: 1,
    };
    let (addr, _) = spawn_hub_revoking(Some(held.clone()), vec![granted], vec![]).await;
    let config = config_for(dir.path(), addr);
    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect("the first cycle completes");

    let (addr, _) = spawn_hub_revoking(
        Some(held),
        vec![],
        vec![revocation_of(&stranger, &grant_id, Some("v-other"))],
    )
    .await;
    let config = config_for(dir.path(), addr);
    sync_all_async(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
        .await
        .expect("the cycle completes: a revocation it will not act on is not an error");

    assert!(cache.join("index.db").exists(),
        "a signature proves someone signed those bytes, not that the right someone did");
}
