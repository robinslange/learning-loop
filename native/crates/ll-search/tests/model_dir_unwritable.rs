//! A models directory that cannot be created is the user's to fix, not a
//! crash: every embedding command reports it on stderr and exits 1. It used
//! to panic inside the loader with exit 101, before `init_provider`'s error
//! path was ever reached.

use std::process::Command;

#[test]
fn embed_reports_an_uncreatable_models_dir_and_exits_1() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let blocker = tmp.path().join("not-a-dir");
    std::fs::write(&blocker, b"a file, so nothing can be created beneath it").unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_ll-search"))
        .args(["embed", "some text"])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", tmp.path())
        .env("USERPROFILE", tmp.path())
        .env("LL_MODELS_DIR", blocker.join("models"))
        // Any existing file satisfies the runtime check, which runs first, so
        // nothing is downloaded. The runtime is never loaded, because the model
        // directory fails before any session is built.
        .env("ORT_DYLIB_PATH", &blocker)
        .output()
        .expect("spawn ll-search");

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(1), "stderr: {stderr}");
    assert!(!stderr.contains("panicked at"), "stderr: {stderr}");
    assert!(
        stderr.contains("failed to create model directory"),
        "stderr: {stderr}"
    );
}
