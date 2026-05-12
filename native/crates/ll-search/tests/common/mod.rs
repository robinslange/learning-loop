//! Shared in-process mock hub for sync integration tests.
//!
//! Each test binary that needs the hub does:
//! ```ignore
//! #[path = "common/mod.rs"]
//! mod common;
//! ```
//!
//! The mock does *not* verify ed25519 signatures (it cannot — the client peer
//! keypair lives in a per-test tempdir). It only echoes the negotiated
//! `protocol_version` and observes the binary upload payload for framing checks.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Once};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

static FORCE_ENCRYPTED_BACKEND: Once = Once::new();

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

/// Captured side-effects on the mock hub.
#[derive(Debug, Default, Clone)]
pub struct HubObservations {
    pub uploaded_binary: Option<Vec<u8>>,
    pub last_hello: Option<serde_json::Value>,
    pub completed_handshake: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum HubBehaviour {
    /// Accept the upgrade, read SyncHello, then sleep forever. Triggers RecvTimeout on the client.
    SilentAfterHello,
    /// Full handshake + advertise the given protocol_version in SyncReady; accept the upload
    /// + send SyncAck; accept ListPeers + send empty PeerList; close.
    FullFlow { advertise_protocol_version: Option<u32> },
    /// Like FullFlow but disconnect after the first sync to simulate churn.
    Churn { advertise_protocol_version: Option<u32> },
}

pub async fn spawn_hub(
    behaviour: HubBehaviour,
) -> (SocketAddr, Arc<Mutex<HubObservations>>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let obs: Arc<Mutex<HubObservations>> = Arc::new(Mutex::new(HubObservations::default()));
    let obs_for_task = Arc::clone(&obs);

    let handle = tokio::spawn(async move {
        loop {
            let Ok((stream, _peer_addr)) = listener.accept().await else {
                return;
            };
            let obs_clone = Arc::clone(&obs_for_task);
            tokio::spawn(async move {
                let Ok(mut ws) = accept_async(stream).await else { return };
                run_session(&mut ws, behaviour, obs_clone).await;
            });

            if matches!(behaviour, HubBehaviour::SilentAfterHello) {
                // Don't accept further connections for the silent test.
                return;
            }
        }
    });

    (addr, obs, handle)
}

type WsServer = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

async fn run_session(ws: &mut WsServer, behaviour: HubBehaviour, obs: Arc<Mutex<HubObservations>>) {
    let Some(hello) = recv_text_json(ws).await else { return };
    {
        let mut o = obs.lock().await;
        o.last_hello = Some(hello.clone());
    }

    if matches!(behaviour, HubBehaviour::SilentAfterHello) {
        // Stay open without responding. Forever-pending future.
        std::future::pending::<()>().await;
        return;
    }

    let advertise = match behaviour {
        HubBehaviour::FullFlow { advertise_protocol_version } => advertise_protocol_version,
        HubBehaviour::Churn { advertise_protocol_version } => advertise_protocol_version,
        HubBehaviour::SilentAfterHello => unreachable!(),
    };

    // AuthChallenge with random nonce + arbitrary pubkey string. Client signs it but we never
    // verify — we're a mock.
    let nonce = rand::random::<[u8; 32]>();
    let nonce_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, nonce);
    let challenge = serde_json::json!({
        "type": "auth-challenge",
        "nonce": nonce_b64,
        "hub_pubkey": "mock-hub-pubkey",
    });
    if ws.send(Message::text(challenge.to_string())).await.is_err() {
        return;
    }

    let Some(_auth_response) = recv_text_json(ws).await else { return };

    // SyncReady — either with or without protocol_version.
    let mut ready = serde_json::json!({
        "type": "sync-ready",
        "peer_id": "mock-hub",
    });
    if let Some(v) = advertise {
        ready["protocol_version"] = serde_json::json!(v);
    }
    if ws.send(Message::text(ready.to_string())).await.is_err() {
        return;
    }

    // Expect UploadEnvelope (or SyncSkipUpload). For our test the cache should always be cold so
    // the client uploads.
    let Some(upload_envelope) = recv_text_json(ws).await else { return };
    let upload_type = upload_envelope.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if upload_type == "sync-skip-upload" {
        // No upload; ack the skip and continue to ListPeers.
        let _ = ws.send(Message::text(r#"{"type":"sync-skip-ack"}"#.to_string())).await;
    } else if upload_type == "upload-envelope" {
        // Next message must be binary.
        let Some(binary) = recv_binary(ws).await else { return };
        {
            let mut o = obs.lock().await;
            o.uploaded_binary = Some(binary);
        }
        let ack = serde_json::json!({ "type": "sync-ack", "note_count": 0 });
        if ws.send(Message::text(ack.to_string())).await.is_err() {
            return;
        }
    } else {
        return;
    }

    if matches!(behaviour, HubBehaviour::Churn { .. }) {
        // Disconnect mid-flow.
        let _ = ws.close(None).await;
        return;
    }

    // ListPeers -> empty PeerList.
    let Some(list_req) = recv_text_json(ws).await else { return };
    if list_req.get("type").and_then(|v| v.as_str()) == Some("list-peers") {
        let resp = serde_json::json!({ "type": "peer-list", "peers": [] });
        if ws.send(Message::text(resp.to_string())).await.is_err() {
            return;
        }
    }

    {
        let mut o = obs.lock().await;
        o.completed_handshake = true;
    }

    let _ = ws.close(None).await;
}

async fn recv_text_json(ws: &mut WsServer) -> Option<serde_json::Value> {
    loop {
        let msg = ws.next().await?.ok()?;
        match msg {
            Message::Text(text) => return serde_json::from_str(text.as_str()).ok(),
            Message::Ping(data) => {
                if ws.send(Message::Pong(data)).await.is_err() {
                    return None;
                }
            }
            Message::Close(_) => return None,
            _ => continue,
        }
    }
}

async fn recv_binary(ws: &mut WsServer) -> Option<Vec<u8>> {
    loop {
        let msg = ws.next().await?.ok()?;
        match msg {
            Message::Binary(data) => return Some(data.into()),
            Message::Ping(data) => {
                if ws.send(Message::Pong(data)).await.is_err() {
                    return None;
                }
            }
            Message::Close(_) => return None,
            _ => continue,
        }
    }
}

/// Build a minimal config_dir tree with federation/config.json + a generated seed.
/// Returns the tempdir guard (keep it alive for the test's lifetime).
///
/// Side effect: sets `LL_SEED_BACKEND=encrypted` in the process environment so the
/// generated seed lands in `<config_dir>/federation/.seed.enc` rather than the
/// system Keychain. Required for test isolation: the production keyring entry is
/// globally namespaced (`KEYRING_SERVICE = ai.learning-loop.federation`,
/// `KEYRING_USER = signing-seed-v1`), so parallel integration tests would otherwise
/// stomp on the same key and break the seed-migration lib tests that read it back.
pub fn setup_config_dir(hub_addr: SocketAddr, peer_id: &str) -> tempfile::TempDir {
    // Force the encrypted seed backend exactly once per test process. Without the
    // `Once` guard, parallel `#[tokio::test]` cases in the same binary all race to
    // call `set_var`, which on Rust 2024 is `unsafe` precisely because libc
    // `setenv` is not thread-safe against concurrent `getenv`. The value here is
    // constant so a single set is sufficient.
    FORCE_ENCRYPTED_BACKEND.call_once(|| {
        // SAFETY: serialised via `Once`; this runs exactly once per process before
        // any test reads LL_SEED_BACKEND.
        unsafe {
            std::env::set_var("LL_SEED_BACKEND", "encrypted");
        }
    });

    let dir = tempfile::tempdir().unwrap();
    let fed = dir.path().join("federation");
    std::fs::create_dir_all(&fed).unwrap();

    let config = serde_json::json!({
        "identity": {
            "displayName": peer_id,
            "pubkey": "placeholder",
        },
        "visibility": {
            "default": "private",
            "rules": [],
        },
        "hub": { "endpoint": format!("ws://{hub_addr}") },
        "graph": false,
    });
    std::fs::write(fed.join("config.json"), serde_json::to_string_pretty(&config).unwrap())
        .unwrap();

    // Force seed_store to create a fresh seed on first sync.
    dir
}

/// Build a minimal source_db with the right migrations applied and a model_id row.
pub fn setup_source_db(dir: &Path) -> std::path::PathBuf {
    let db_path = dir.join("source.db");
    let conn = ll_search::db::open_db(&db_path.to_string_lossy()).expect("open_db");
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('model_id', ?1)",
        ["Xenova/bge-small-en-v1.5"],
    )
    .unwrap();
    drop(conn);
    db_path
}

/// Inspect a binary blob; return true if it looks framed (size + sha256 + body matches).
pub fn looks_framed(data: &[u8]) -> bool {
    use sha2::{Digest, Sha256};
    if data.len() < 36 {
        return false;
    }
    let size = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
    let declared = 36 + size as usize;
    if data.len() != declared {
        return false;
    }
    let body = &data[36..];
    let computed: [u8; 32] = Sha256::digest(body).into();
    computed[..] == data[4..36]
}
