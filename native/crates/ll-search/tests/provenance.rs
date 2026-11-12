//! `provenance/runtime.json` must claim only the ONNX Runtime hashes that ll-core actually verifies.
//! ll-core lives on crates.io now, so its `dylib.rs` is found through `cargo metadata`, wherever
//! cargo resolved the crate. A missing file is a failure, never a skip.

use std::path::{Path, PathBuf};
use std::process::Command;

fn native_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn ll_core_dir() -> PathBuf {
    let out = Command::new(env!("CARGO"))
        .args(["metadata", "--format-version", "1", "--manifest-path"])
        .arg(native_dir().join("Cargo.toml"))
        .output()
        .expect("cargo metadata runs");
    assert!(
        out.status.success(),
        "cargo metadata failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let meta: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("cargo metadata prints JSON");
    let manifest = meta["packages"]
        .as_array()
        .expect("packages")
        .iter()
        .find(|p| p["name"] == "ll-core")
        .expect("ll-core is a dependency")["manifest_path"]
        .as_str()
        .expect("manifest_path")
        .to_owned();
    Path::new(&manifest)
        .parent()
        .expect("crate dir")
        .to_path_buf()
}

#[test]
fn runtime_manifest_hashes_are_the_ones_ll_core_verifies() {
    let dylib = std::fs::read_to_string(ll_core_dir().join("src/dylib.rs"))
        .expect("ll-core's src/dylib.rs");
    let manifest_path = native_dir().join("../provenance/runtime.json");
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&manifest_path).expect("provenance/runtime.json"),
    )
    .expect("runtime.json is JSON");
    let targets = manifest["runtime"]["targets"]
        .as_object()
        .expect("runtime.targets");
    assert!(!targets.is_empty(), "runtime.json lists no targets");
    for (triple, entry) in targets {
        for key in ["archive_sha256", "lib_sha256"] {
            let sha = entry[key]
                .as_str()
                .unwrap_or_else(|| panic!("{triple} has no {key}"));
            assert!(
                dylib.contains(sha),
                "runtime.json {triple} {key} {sha} is not pinned in ll-core's dylib.rs"
            );
        }
    }
}
