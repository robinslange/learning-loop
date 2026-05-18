//! Verifies that `ll-search sync --hub-endpoint <url>` does not panic when
//! `federation/config.json` is absent. The documented atomic-onboarding flow
//! depends on this: the skill writes config AFTER sync succeeds, so the test
//! itself must run config-less.

use std::process::Command;

fn ll_search_bin() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_ll-search"))
}

#[test]
fn sync_with_hub_endpoint_skips_config_load() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let config_dir = tmp.path().to_path_buf();
    // Intentionally do NOT create federation/config.json.
    let db = tmp.path().join("vault-index.db");
    let vault = tmp.path().join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let _ = rusqlite::Connection::open(&db).unwrap();

    let out = Command::new(ll_search_bin())
        .args([
            "sync",
            db.to_str().unwrap(),
            vault.to_str().unwrap(),
            "--config-dir",
            config_dir.to_str().unwrap(),
            "--hub-endpoint",
            "http://127.0.0.1:1",
            "--peer-id",
            "test-peer-abc123",
        ])
        .output()
        .expect("spawn ll-search");

    let stderr = String::from_utf8_lossy(&out.stderr);
    // Clap rejects unknown flags with "unexpected argument". If this fires,
    // --hub-endpoint or --peer-id is not wired into the clap struct.
    assert!(
        !stderr.contains("unexpected argument"),
        "--hub-endpoint/--peer-id was rejected by clap (not wired through). stderr: {stderr}"
    );
    assert!(
        !stderr.contains("--peer-id"),
        "stderr mentioned --peer-id, suggesting clap rejection: {stderr}"
    );
    assert!(
        !stderr.contains("failed to load federation config"),
        "config-load panic occurred — flag not wired through. stderr: {stderr}"
    );
    assert!(!out.status.success(), "expected non-zero exit; got success");
}

#[test]
fn sync_with_hub_endpoint_without_peer_id_fails_fast() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let config_dir = tmp.path().to_path_buf();
    let db = tmp.path().join("vault-index.db");
    let vault = tmp.path().join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let _ = rusqlite::Connection::open(&db).unwrap();

    let out = Command::new(ll_search_bin())
        .args([
            "sync",
            db.to_str().unwrap(),
            vault.to_str().unwrap(),
            "--config-dir",
            config_dir.to_str().unwrap(),
            "--hub-endpoint",
            "http://127.0.0.1:1",
        ])
        .env_remove("LL_PEER_ID")
        .output()
        .expect("spawn ll-search");

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !out.status.success(),
        "expected non-zero exit when --hub-endpoint is provided without --peer-id"
    );
    assert!(
        stderr.contains("--hub-endpoint provided without --peer-id"),
        "expected descriptive fail-fast error; stderr was: {stderr}"
    );
}
