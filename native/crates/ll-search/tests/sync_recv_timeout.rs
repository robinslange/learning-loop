//! Validates the recv-side timeout (Risk R1 in the 2J plan).
//!
//! A silent hub triggers `SyncError::RecvTimeout` within the configured
//! `LL_SYNC_RECV_TIMEOUT_MS` window. The cancel-safety contract on
//! `tokio_tungstenite::StreamExt::next` is documented at the frame boundary;
//! this test exercises the simple "no frames at all" case.
//!
//! The recv timeout is resolved once per process, so this test lives in its
//! own binary rather than beside the lib's `test_hub`: a 1-second override
//! there would apply to every other sync test in that binary.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tokio::net::TcpListener;

/// Accept one upgrade, read one frame, then hold the socket open without ever
/// replying.
async fn spawn_silent_hub() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else { return };
        let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { return };
        let _ = ws.next().await;
        std::future::pending::<()>().await;
    });
    addr
}

/// A config dir with `federation/config.json` and a generated seed. Sync
/// never mints an identity itself, so the seed has to exist beforehand.
fn setup_config_dir(hub_addr: SocketAddr) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let fed = dir.path().join("federation");
    std::fs::create_dir_all(&fed).unwrap();

    let seed = ll_search::sync::seed_store::load_or_create(dir.path())
        .expect("test setup must generate a seed");
    let pubkey = ll_search::sync::key_id::pubkey_b64(&seed.signing_key);

    let config = serde_json::json!({
        "identity": { "displayName": "alice", "pubkey": format!("ed25519:{pubkey}") },
        "visibility": { "default": "private", "rules": [] },
        "hub": { "endpoint": format!("ws://{hub_addr}") },
    });
    std::fs::write(fed.join("config.json"), config.to_string()).unwrap();
    dir
}

/// A source index with the migrations applied and a model_id row, enough for
/// `prepare_export` to build an export from.
fn setup_source_db(dir: &Path) -> PathBuf {
    let db_path = dir.join("source.db");
    let conn = ll_search::db::open_or_create_db(&db_path.to_string_lossy()).expect("open_or_create_db");
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('model_id', ?1)",
        ["Xenova/bge-small-en-v1.5"],
    )
    .unwrap();
    db_path
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn silent_hub_triggers_recv_timeout() {
    // SAFETY: each integration test binary is its own process, and this is the
    // only test in this one, so nothing else reads the environment concurrently.
    unsafe {
        std::env::set_var("LL_SYNC_RECV_TIMEOUT_MS", "1000");
        // This mock hub is exactly the "local test harness" LL_ALLOW_INSECURE_WS
        // exists for: a plain ws:// connection to 127.0.0.1 with no TLS. The
        // hub never responds, so the handshake never reaches the pin/verify
        // checks either way — this only needs to get past the transport gate.
        std::env::set_var("LL_ALLOW_INSECURE_WS", "1");
        // Keep the generated seed in the tempdir instead of the system keychain.
        std::env::set_var("LL_SEED_BACKEND", "encrypted");
    }

    let hub_addr = spawn_silent_hub().await;

    let dir = setup_config_dir(hub_addr);
    let source_db = setup_source_db(dir.path());
    let vault = tempfile::tempdir().unwrap();

    let config = ll_search::sync::config::load_config(dir.path()).expect("load_config");

    let started = Instant::now();
    let result = ll_search::sync::client::sync_all_async(
        &source_db,
        vault.path(),
        dir.path(),
        &config,
    )
    .await;
    let elapsed = started.elapsed();

    let err = result.expect_err("silent hub must produce a timeout error");
    let chain: String = err.chain().map(|e| e.to_string()).collect::<Vec<_>>().join(" | ");
    assert!(
        chain.contains("recv timed out"),
        "expected recv timeout in error chain, got: {chain}",
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "timeout fired too slowly: {elapsed:?} (override LL_SYNC_RECV_TIMEOUT_MS=1000)",
    );
}
