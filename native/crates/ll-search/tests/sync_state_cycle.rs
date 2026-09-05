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

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use ll_search::sync::client::sync_all_async;
use ll_search::sync::config::{
    export_db_path, FederationConfig, HubEndpoint, Identity, VisibilityConfig,
};
use ll_search::sync::key_id::KeyId;
use ll_search::sync::protocol_v5::{
    hub_challenge_message, ClientMsg, HeldIndex, HubMsg, VaultState, PROTOCOL_VERSION,
};
use ll_search::sync::state::{read_state, HubHolds, OUTCOME_ERROR, OUTCOME_OK};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type WsServer = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// The vault as this client knows it, and the count the hub reports for it.
/// They are deliberately different numbers: the state file records the hub's.
const LOCAL_NOTE_COUNT: i64 = 7;
const HUB_NOTE_COUNT: i64 = 3578;

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

fn unb64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

async fn recv_client(ws: &mut WsServer) -> ClientMsg {
    serde_json::from_value(recv_json(ws).await).expect("valid ClientMsg")
}

/// Untyped, because the download half still speaks v4 and its messages are
/// not `ClientMsg` variants.
async fn recv_json(ws: &mut WsServer) -> serde_json::Value {
    loop {
        match ws.next().await.expect("connection closed early").expect("ws error") {
            Message::Text(t) => return serde_json::from_str(t.as_str()).expect("valid json"),
            Message::Ping(d) => {
                let _ = ws.send(Message::Pong(d)).await;
            }
            other => panic!("expected a JSON client message, got {other:?}"),
        }
    }
}

async fn send_hub(ws: &mut WsServer, msg: &HubMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap())).await.unwrap();
}

/// Whether the mock accepts the upload it is offered.
#[derive(Clone, Copy)]
enum OnUpload {
    Ack,
    Reject,
}

/// A hub that completes the v5 handshake advertising `holds` for vault `v1`,
/// takes an upload if one is offered, and reports no peers.
async fn spawn_hub(holds: Option<HeldIndex>, on_upload: OnUpload) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();

        let ClientMsg::ClientHello { nonce_c, .. } = recv_client(&mut ws).await else {
            panic!("expected client-hello")
        };
        let nonce_h: [u8; 32] = rand::random();
        let sig_h = hub_key().sign(&hub_challenge_message(&nonce_h, &unb64(&nonce_c), &[0u8; 32]));
        send_hub(&mut ws, &HubMsg::HubChallenge {
            nonce_h: b64(&nonce_h),
            hub_key_id: hub_key_id(),
            sig_h: b64(&sig_h.to_bytes()),
        })
        .await;

        let _auth = recv_client(&mut ws).await;
        send_hub(&mut ws, &HubMsg::SyncReady {
            protocol_version: PROTOCOL_VERSION,
            vault_state: vec![VaultState { vault_id: "v1".into(), holds }],
            grants: vec![],
            revocations: vec![],
        })
        .await;

        // The client uploads or goes straight to the download half depending
        // on what this hub just said it holds; the mock does not get to
        // assume which, or it would decide the outcome it is measuring.
        let next = recv_json(&mut ws).await;
        let next = if next["type"] == "upload-index" {
            let ClientMsg::UploadIndex { vault_id, sha256, .. } =
                serde_json::from_value(next).expect("valid upload-index")
            else {
                unreachable!("matched on the tag")
            };
            let _frame = ws.next().await.unwrap().unwrap();
            match on_upload {
                OnUpload::Reject => {
                    send_hub(&mut ws, &HubMsg::Reject {
                        reason: "not authorized to write this vault".into(),
                    })
                    .await;
                    return;
                }
                OnUpload::Ack => send_hub(&mut ws, &HubMsg::UploadAck { vault_id, sha256 }).await,
            }
            recv_json(&mut ws).await
        } else {
            next
        };

        // The download half is still v4 on the wire and untouched here.
        assert_eq!(next["type"], "list-peers", "unexpected message after the upload half");
        let _ = ws.send(Message::text(r#"{"type":"peer-list","peers":[]}"#)).await;
    });
    addr
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
        graph: false,
        vault_id: Some("v1".into()),
        vault_path: None,
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
