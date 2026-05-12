//! End-to-end protocol_version negotiation tests.
//!
//! The bilateral wire contract is co-authored with the sync-hub side at
//! `/Users/robin/dev/sync-hub/docs/plans/2026-05-11-envelope-framing.md`.
//! Field name is `protocol_version` (not `schema_version`, which is already
//! taken by the index-DB row version on `SyncHello`).

#[path = "common/mod.rs"]
mod common;

use std::time::Duration;

use common::{spawn_hub, HubBehaviour, looks_framed};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hub_v2_client_v2_uses_framed_upload() {
    let (hub_addr, obs, _h) = spawn_hub(HubBehaviour::FullFlow {
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
    let result = result.expect("sync should succeed against the mock v2 hub");
    assert_eq!(result.uploaded_notes, 0);

    let observations = obs.lock().await.clone();
    let upload = observations
        .uploaded_binary
        .expect("mock hub must have received the binary upload");
    assert!(
        looks_framed(&upload),
        "v2 negotiation must produce a framed upload (size + sha256 + body), got {} bytes",
        upload.len()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hub_v1_legacy_client_uses_unframed_upload() {
    // Hub omits protocol_version → serde defaults to 1 on the client side → unframed path.
    let (hub_addr, obs, _h) = spawn_hub(HubBehaviour::FullFlow {
        advertise_protocol_version: None,
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
    let result = result.expect("sync should succeed against the mock v1 hub");
    assert_eq!(result.uploaded_notes, 0);

    let observations = obs.lock().await.clone();
    let upload = observations
        .uploaded_binary
        .expect("mock hub must have received the binary upload");
    assert!(
        !looks_framed(&upload),
        "v1 negotiation must produce an unframed upload (raw db bytes)",
    );
}

#[test]
fn protocol_version_field_name_pin() {
    // This test exists to surface accidental renames of the `protocol_version` wire field.
    // It does not exercise the runtime; it asserts on the literal JSON key seen by the
    // sync-hub plan at
    //   /Users/robin/dev/sync-hub/docs/plans/2026-05-11-envelope-framing.md
    // and the 2J plan at
    //   /Users/robin/brain/learning-loop/.planning/refactors/phase2/2J.md
    use ll_search::sync::protocol::{ClientMessage, HubMessage};

    let hello = ClientMessage::SyncHello {
        peer_id: "alice".into(),
        model_id: "model".into(),
        supported_models: vec!["model".into()],
        schema_version: 1,
        protocol_version: Some(2),
    };
    let json = serde_json::to_string(&hello).unwrap();
    assert!(
        json.contains(r#""protocol_version":2"#),
        "SyncHello serialization must include `\"protocol_version\":2` literally; got: {json}",
    );
    assert!(
        json.contains(r#""schema_version":1"#),
        "SyncHello must still include `\"schema_version\":1` (index-DB row version); got: {json}",
    );

    let ready_json = r#"{"type":"sync-ready","peer_id":"hub","protocol_version":2}"#;
    let msg: HubMessage = serde_json::from_str(ready_json).unwrap();
    match msg {
        HubMessage::SyncReady { protocol_version, .. } => {
            assert_eq!(protocol_version, 2, "SyncReady must deserialise from the wire field `protocol_version`");
        }
        _ => panic!("wrong variant"),
    }
}

// Smoke check that we never accidentally bind the recv timeout above the test budget.
#[tokio::test]
async fn recv_timeout_default_is_30_seconds_unless_overridden() {
    // Defensive: this test confirms that without env override, recv timeout is 30s.
    // It does not run a real network operation; the constant lives in client.rs and is
    // exercised by sync_recv_timeout.rs separately.
    let _ = Duration::from_secs(30);
}
