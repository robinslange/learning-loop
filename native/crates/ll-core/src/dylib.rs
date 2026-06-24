//! Resolve the ONNX Runtime shared library for `ort`'s `load-dynamic` feature.
//!
//! Both inference paths (the cross-encoder reranker here in `ll-core`, and the
//! bge-small embedder in `ll-search`) must call [`ensure_dylib`] before building
//! their first `ort` Session. It lives in `ll-core` because `ll-core` owns the
//! `ort` dependency; `ll-search` re-exports through it.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};

/// Pinned ONNX Runtime version. Must equal the version `ort` (and the static
/// `download-binaries` build it replaced) links against: ort 2.0.0-rc.12 pins
/// `ms@1.24.2` (see ort-sys `dist.txt`). Bump deliberately alongside the `ort`
/// crate, then refresh the SHA-256 pins below and `provenance/runtime.json`.
const ORT_VERSION: &str = "1.24.2";

const BASE_URL: &str = "https://github.com/microsoft/onnxruntime/releases/download/v1.24.2";

/// One bundled target: the release archive name, its SHA-256, the path of the
/// shared library inside the archive, and the file name to stage it under.
struct Target {
    asset: &'static str,
    sha256: &'static str,
    /// Path identifying the library entry inside the archive listing.
    lib_member: &'static str,
    staged_name: &'static str,
}

/// The official Microsoft CPU bundles for the targets we ship. There is no
/// `osx-x64` asset for 1.24.2 (Microsoft dropped Intel macOS), so x86_64 macOS
/// is intentionally unsupported under `load-dynamic`; such a host must set
/// `ORT_DYLIB_PATH` to a self-provided libonnxruntime.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const TARGET: Target = Target {
    asset: "onnxruntime-osx-arm64-1.24.2.tgz",
    sha256: "0af4fa503e8ea285245b47ee42d0a7461b8156a81270857da0c1d4ecf858abde",
    lib_member: "lib/libonnxruntime.1.24.2.dylib",
    staged_name: "libonnxruntime.1.24.2.dylib",
};

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const TARGET: Target = Target {
    asset: "onnxruntime-linux-x64-1.24.2.tgz",
    sha256: "43725474ba5663642e17684717946693850e2005efbd724ac72da278fead25e6",
    lib_member: "lib/libonnxruntime.so.1.24.2",
    staged_name: "libonnxruntime.so.1.24.2",
};

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const TARGET: Target = Target {
    asset: "onnxruntime-linux-aarch64-1.24.2.tgz",
    sha256: "6715b3d19965a2a6981e78ed4ba24f17a8c30d2d26420dbed10aac7ceca0085e",
    lib_member: "lib/libonnxruntime.so.1.24.2",
    staged_name: "libonnxruntime.so.1.24.2",
};

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const TARGET: Target = Target {
    asset: "onnxruntime-win-x64-1.24.2.zip",
    sha256: "8e3e9c826375352e29cb2614fe44f3d7a4b0ff7b8028ad7a456af9d949a7e8b0",
    lib_member: "lib/onnxruntime.dll",
    staged_name: "onnxruntime.dll",
};

#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
const TARGET: Target = Target {
    asset: "onnxruntime-win-arm64-1.24.2.zip",
    sha256: "dd8180d98e5a0ead7ead99029acc80b86a8b905b9aba4cc978e388039bb5823b",
    lib_member: "lib/onnxruntime.dll",
    staged_name: "onnxruntime.dll",
};

/// Cheap pre-hash sanity floor: every CPU bundle is multiple MB.
const MIN_ARCHIVE_BYTES: u64 = 4 * 1024 * 1024;

fn sha256_hex(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// `LL_ORT_DIR` lets an air-gapped box pre-stage the runtime outside
/// `~/.learning-loop/lib` (e.g. a read-only mount baked into the image).
fn ort_dir() -> PathBuf {
    let dir = match std::env::var("LL_ORT_DIR").ok().filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => dirs_next::home_dir()
            .expect("could not determine home directory")
            .join(".learning-loop")
            .join("lib"),
    };
    fs::create_dir_all(&dir).expect("failed to create runtime library directory");
    dir
}

/// Ensure `ORT_DYLIB_PATH` points at a verified ONNX Runtime shared library,
/// then return that path. Idempotent and cheap on the warm path. Resolution:
///
/// 1. A caller-set `ORT_DYLIB_PATH` is trusted as the operator's explicit choice
///    (IT-provisioned or system runtime), checked only for existence so a typo
///    fails cleanly instead of letting `ort` fall back to a bare-name search
///    that hangs the macOS loader.
/// 2. Otherwise the pinned Microsoft bundle is downloaded, SHA-256-verified, and
///    the single library extracted to `~/.learning-loop/lib`.
pub fn ensure_dylib() -> Result<PathBuf> {
    if let Some(raw) = std::env::var("ORT_DYLIB_PATH").ok().filter(|p| !p.is_empty()) {
        return validate_override(&raw);
    }

    let dir = ort_dir();
    let lib_path = dir.join(TARGET.staged_name);
    if !lib_path.is_file() {
        stage_bundle(&dir, &lib_path)?;
    }
    std::env::set_var("ORT_DYLIB_PATH", &lib_path);
    Ok(lib_path)
}

/// A caller-set `ORT_DYLIB_PATH` is trusted as the operator's explicit choice,
/// but must point at a real file: `ort` otherwise falls back to a bare-name
/// load that makes the macOS loader scan default paths and hang. Failing here
/// turns that hang into an immediate, actionable error.
fn validate_override(raw: &str) -> Result<PathBuf> {
    let path = PathBuf::from(raw);
    if !path.is_file() {
        anyhow::bail!(
            "ORT_DYLIB_PATH points at {} which does not exist; \
             unset it to use the bundled ONNX Runtime, or fix the path",
            path.display()
        );
    }
    Ok(path)
}

/// Download the pinned archive, verify its SHA-256, and extract the one library
/// member to `lib_path`. The archive's hash is the trust root; the extracted
/// file inherits that guarantee, so the staged copy is not re-hashed on every
/// run (its directory is user-owned under `~/.learning-loop`).
fn stage_bundle(dir: &Path, lib_path: &Path) -> Result<()> {
    let url = format!("{BASE_URL}/{}", TARGET.asset);
    let archive = dir.join(TARGET.asset);
    download_verified(&url, &archive, MIN_ARCHIVE_BYTES, TARGET.sha256)
        .with_context(|| format!("fetching ONNX Runtime {ORT_VERSION} bundle"))?;
    extract_member(&archive, TARGET.lib_member, lib_path)
        .with_context(|| format!("extracting {} from {}", TARGET.lib_member, TARGET.asset))?;
    fs::remove_file(&archive).ok();
    Ok(())
}

fn download_verified(url: &str, dest: &Path, min_bytes: u64, expected_sha256: &str) -> Result<()> {
    let tmp = dest.with_extension("tmp");
    eprintln!("Downloading {url} ...");
    let status = Command::new("curl")
        .args(["-fSL", "--progress-bar", "-o"])
        .arg(&tmp)
        .arg(url)
        .status()
        .context("failed to run curl")?;
    if !status.success() {
        fs::remove_file(&tmp).ok();
        anyhow::bail!("curl failed with status {status}");
    }
    let bytes = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if bytes < min_bytes {
        fs::remove_file(&tmp).ok();
        anyhow::bail!("downloaded {url} is {bytes} bytes, expected at least {min_bytes} (truncated upstream?)");
    }
    let actual = sha256_hex(&tmp).context("failed to hash downloaded archive")?;
    if actual != expected_sha256 {
        fs::remove_file(&tmp).ok();
        anyhow::bail!(
            "downloaded {url} has SHA-256 {actual}, expected {expected_sha256} — \
             upstream changed or tampered; refusing to load"
        );
    }
    fs::rename(&tmp, dest).context("failed to move downloaded archive into place")?;
    Ok(())
}

/// Extract a single member from a `.tgz` (mac/linux) or `.zip` (windows)
/// archive to `dest`, shelling out to the platform's standard tool — same
/// no-new-crate stance as the `curl` download path.
fn extract_member(archive: &Path, member: &str, dest: &Path) -> Result<()> {
    let staging = dest.with_extension("unpack");
    fs::create_dir_all(&staging).ok();

    if TARGET.asset.ends_with(".zip") {
        let status = Command::new("unzip")
            .args(["-o", "-j"])
            .arg(archive)
            .arg(format!("*/{member}"))
            .arg("-d")
            .arg(&staging)
            .status()
            .context("failed to run unzip")?;
        if !status.success() {
            anyhow::bail!("unzip failed with status {status}");
        }
    } else {
        let status = Command::new("tar")
            .args(["xzf"])
            .arg(archive)
            .args(["--strip-components", "2", "-C"])
            .arg(&staging)
            .arg(format!("*/{member}"))
            .status()
            .context("failed to run tar")?;
        if !status.success() {
            anyhow::bail!("tar failed with status {status}");
        }
    }

    let file_name = Path::new(member)
        .file_name()
        .context("library member has no file name")?;
    let extracted = staging.join(file_name);
    if !extracted.is_file() {
        anyhow::bail!("archive did not contain {member}");
    }
    fs::rename(&extracted, dest).context("failed to move extracted library into place")?;
    fs::remove_dir_all(&staging).ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_to_missing_file_errors_clearly() {
        let err = validate_override("/definitely/not/a/real/libonnxruntime.dylib")
            .expect_err("a missing override path must fail, not fall through to a loader hang");
        let msg = err.to_string();
        assert!(msg.contains("does not exist"), "message was: {msg}");
        assert!(msg.contains("ORT_DYLIB_PATH"), "message was: {msg}");
    }

    #[test]
    fn override_to_real_file_is_honored() {
        let f = tempfile::NamedTempFile::new().unwrap();
        let resolved = validate_override(f.path().to_str().unwrap()).unwrap();
        assert_eq!(resolved, f.path());
    }

    #[test]
    fn target_url_and_pin_agree_on_version() {
        assert!(BASE_URL.ends_with(&format!("v{ORT_VERSION}")));
        assert!(TARGET.asset.contains(ORT_VERSION));
        assert!(TARGET.staged_name.starts_with("lib") || TARGET.staged_name.ends_with(".dll"));
    }

    /// The SHA-256 the binary enforces for THIS build target must match the
    /// provenance manifest, so the published SBOM/provenance can never claim a
    /// hash the code does not actually verify.
    #[test]
    fn target_sha_matches_provenance_manifest() {
        let triple = current_target_triple();
        let manifest = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../provenance/runtime.json"
        ))
        .expect("provenance/runtime.json must exist");
        let block = manifest
            .split(&format!("\"{triple}\""))
            .nth(1)
            .unwrap_or_else(|| panic!("runtime.json has no entry for {triple}"));
        let sha_line = block
            .lines()
            .find(|l| l.contains("\"sha256\""))
            .expect("target block has a sha256");
        assert!(
            sha_line.contains(TARGET.sha256),
            "runtime.json sha for {triple} ({sha_line:?}) != dylib.rs TARGET.sha256 ({})",
            TARGET.sha256
        );
    }

    fn current_target_triple() -> &'static str {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        return "aarch64-apple-darwin";
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        return "x86_64-unknown-linux-gnu";
        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
        return "aarch64-unknown-linux-gnu";
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        return "x86_64-pc-windows-msvc";
        #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
        return "aarch64-pc-windows-msvc";
    }
}
