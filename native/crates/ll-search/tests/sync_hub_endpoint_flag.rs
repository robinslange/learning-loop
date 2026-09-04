//! Verifies `ll-search sync --hub-endpoint <url>` overrides `hub.endpoint`
//! on top of an on-disk config, rather than synthesising a config-less
//! identity the way the removed v4 onboarding hack did. In v5, `ll join`
//! (Plan 6) writes `federation/config.json` after a successful round-trip,
//! so sync always has a config to read.

use std::process::Command;

fn ll_search_bin() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_ll-search"))
}

#[test]
fn sync_with_hub_endpoint_still_requires_config_on_disk() {
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
        ])
        .output()
        .expect("spawn ll-search");

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !stderr.contains("unexpected argument"),
        "--hub-endpoint was rejected by clap (not wired through). stderr: {stderr}"
    );
    assert!(!out.status.success(), "expected non-zero exit; got success");
    assert!(
        stderr.contains("failed to load federation config"),
        "expected a config-load failure since v5 has no config-less sync path; stderr: {stderr}"
    );
}

/// Proves `--hub-endpoint` actually overrides `hub.endpoint` on a config
/// that *does* exist on disk, rather than only being accepted by clap. The
/// on-disk endpoint is a valid `wss://` one; the override is not, so if
/// `validate()` reports the overridden value we know the override reached
/// it — and if the on-disk value leaked through instead, the override was
/// silently dropped somewhere between load and validate.
#[test]
fn hub_endpoint_override_reaches_validation() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let config_dir = tmp.path().to_path_buf();
    let fed = config_dir.join("federation");
    std::fs::create_dir_all(&fed).unwrap();
    let config = serde_json::json!({
        "identity": {"displayName": "test", "pubkey": "ed25519:AAAA"},
        "visibility": {"default": "private", "rules": []},
        "hub": {"endpoint": "wss://on-disk.example/ws", "key_id": "zAbc"},
    });
    std::fs::write(fed.join("config.json"), serde_json::to_string(&config).unwrap()).unwrap();

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
            "http://overridden.example/ws",
        ])
        .env_remove("LL_ALLOW_INSECURE_WS")
        .output()
        .expect("spawn ll-search");

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "expected non-zero exit; got success. stderr: {stderr}");
    assert!(
        stderr.contains("http://overridden.example/ws"),
        "expected validate() to reject the overridden endpoint; stderr: {stderr}"
    );
    assert!(
        !stderr.contains("on-disk.example"),
        "on-disk endpoint surfaced instead of the override — override was not applied; stderr: {stderr}"
    );
}
