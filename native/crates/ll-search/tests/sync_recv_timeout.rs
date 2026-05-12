//! Validates the recv-side timeout (Risk R1 in the 2J plan).
//!
//! A silent hub triggers `SyncError::RecvTimeout` within the configured
//! `LL_SYNC_RECV_TIMEOUT_MS` window. The cancel-safety contract on
//! `tokio_tungstenite::StreamExt::next` is documented at the frame boundary;
//! this test exercises the simple "no frames at all" case.

#[path = "common/mod.rs"]
mod common;

use std::time::{Duration, Instant};

use common::{spawn_hub, HubBehaviour};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn silent_hub_triggers_recv_timeout() {
    // SAFETY: each integration test binary is its own process so this env var does not
    // leak into other tests. Within this binary, only one test runs.
    // SAFETY (Rust 2024): set_var requires unsafe because env modification is a global side effect.
    unsafe {
        std::env::set_var("LL_SYNC_RECV_TIMEOUT_MS", "1000");
    }

    let (hub_addr, _obs, _h) = spawn_hub(HubBehaviour::SilentAfterHello).await;

    let dir = common::setup_config_dir(hub_addr, "alice");
    let source_db = common::setup_source_db(dir.path());
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
