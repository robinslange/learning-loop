//! Soak: drive sync_all_async repeatedly against a mock hub that churns
//! mid-flow disconnects. Should produce only `SyncError::RecvTimeout`-class /
//! `ClosedUnexpected` errors and zero panics.
//!
//! `#[ignore]` so it runs only via `cargo test --test sync_soak -- --ignored`.
//! Production budget per the 2J plan is 1 hour; for CI we run a shorter
//! synthetic burst (60 iterations) gated behind the ignore flag.
//!
//! KNOWN BROKEN as of the v5 handshake (federation-v5 Plan 6 Task 2):
//! `LL_ALLOW_INSECURE_WS=1` below gets the client past the new TLS-exporter
//! gate, but `HubBehaviour::Churn`'s mock hub (shared `tests/common/mod.rs`)
//! still speaks the full v4 wire protocol end-to-end — it sends
//! `{"type":"auth-challenge",...}`, which the v5 client can no longer parse
//! at all (`unknown variant "auth-challenge"`). This is not a config gap
//! like `sync_recv_timeout.rs` had (that hub never responds, so it never
//! reaches any message-shape code); this one actively speaks the wrong
//! protocol. Fixing it for real means teaching the shared mock hub to speak
//! v5 (challenge/sign/verify, with a churn-disconnect worked into that
//! flow) — a v5 integration harness, deliberately out of scope for Task 2
//! (ruling 4) and tracked as its own outstanding gap rather than fixed here.

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
        // This mock hub is exactly the "local test harness" LL_ALLOW_INSECURE_WS
        // exists for: a plain ws:// connection to 127.0.0.1 with no TLS.
        std::env::set_var("LL_ALLOW_INSECURE_WS", "1");
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
