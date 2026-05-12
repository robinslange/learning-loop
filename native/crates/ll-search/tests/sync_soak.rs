//! Soak: drive sync_all_async repeatedly against a mock hub that churns
//! mid-flow disconnects. Should produce only `SyncError::RecvTimeout`-class /
//! `ClosedUnexpected` errors and zero panics.
//!
//! `#[ignore]` so it runs only via `cargo test --test sync_soak -- --ignored`.
//! Production budget per the 2J plan is 1 hour; for CI we run a shorter
//! synthetic burst (60 iterations) gated behind the ignore flag.

#[path = "common/mod.rs"]
mod common;

use std::time::{Duration, Instant};

use common::{spawn_hub, HubBehaviour};

const ITERATIONS: usize = 60;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn churn_hub_produces_only_typed_errors() {
    // Shorten the recv timeout so iterations don't each take 30 s.
    unsafe {
        std::env::set_var("LL_SYNC_RECV_TIMEOUT_MS", "500");
    }

    let started = Instant::now();
    let mut churn_count = 0;
    let mut success_count = 0;

    for i in 0..ITERATIONS {
        let (hub_addr, _obs, _h) = spawn_hub(HubBehaviour::Churn {
            advertise_protocol_version: Some(2),
        })
        .await;

        let dir = common::setup_config_dir(hub_addr, "alice");
        let source_db = common::setup_source_db(dir.path());
        let vault = tempfile::tempdir().unwrap();

        let config = ll_search::sync::config::load_config(dir.path()).expect("load_config");

        let result = ll_search::sync::client::sync_all_async(
            &source_db,
            vault.path(),
            dir.path(),
            &config,
        )
        .await;
        match result {
            Ok(_) => success_count += 1,
            Err(e) => {
                let chain: String = e.chain().map(|x| x.to_string()).collect::<Vec<_>>().join(" | ");
                assert!(
                    chain.contains("recv timed out")
                        || chain.contains("websocket closed")
                        || chain.contains("expected peer-list")
                        || chain.contains("expected sync-ack"),
                    "iteration {i} produced unexpected error class: {chain}",
                );
                churn_count += 1;
            }
        }
    }

    eprintln!(
        "soak: {ITERATIONS} iterations in {:?} (successes={success_count}, churn-class errors={churn_count})",
        started.elapsed()
    );
    assert!(started.elapsed() < Duration::from_secs(120), "soak ran too long");
}
