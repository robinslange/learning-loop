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

/// One bundled target: the release archive name, the SHA-256 of the archive
/// (verified on download) and of the extracted library (verified on every load,
/// so a swapped or truncated staged file is caught), the path of the shared
/// library inside the archive, and the file name to stage it under.
struct Target {
    asset: &'static str,
    archive_sha256: &'static str,
    lib_sha256: &'static str,
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
    archive_sha256: "0af4fa503e8ea285245b47ee42d0a7461b8156a81270857da0c1d4ecf858abde",
    lib_sha256: "87df6f94dd559ea958748adc80fd4c46d91c52bc025771f513291d155539590a",
    lib_member: "lib/libonnxruntime.1.24.2.dylib",
    staged_name: "libonnxruntime.1.24.2.dylib",
};

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const TARGET: Target = Target {
    asset: "onnxruntime-linux-x64-1.24.2.tgz",
    archive_sha256: "43725474ba5663642e17684717946693850e2005efbd724ac72da278fead25e6",
    lib_sha256: "ffc84d48e845cf0b562ba4ea5ca32aaafc0d4069019fef4f63095b307d0270ad",
    lib_member: "lib/libonnxruntime.so.1.24.2",
    staged_name: "libonnxruntime.so.1.24.2",
};

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const TARGET: Target = Target {
    asset: "onnxruntime-linux-aarch64-1.24.2.tgz",
    archive_sha256: "6715b3d19965a2a6981e78ed4ba24f17a8c30d2d26420dbed10aac7ceca0085e",
    lib_sha256: "e18fe095919d8613ead3a31ff78212bde4fad929418a9b48f49d61c829ed5c82",
    lib_member: "lib/libonnxruntime.so.1.24.2",
    staged_name: "libonnxruntime.so.1.24.2",
};

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const TARGET: Target = Target {
    asset: "onnxruntime-win-x64-1.24.2.zip",
    archive_sha256: "8e3e9c826375352e29cb2614fe44f3d7a4b0ff7b8028ad7a456af9d949a7e8b0",
    lib_sha256: "114947d633e6844ce3c4b51ef6678f776628571d08a5763859c61642c8dcca9c",
    lib_member: "lib/onnxruntime.dll",
    staged_name: "onnxruntime.dll",
};

#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
const TARGET: Target = Target {
    asset: "onnxruntime-win-arm64-1.24.2.zip",
    archive_sha256: "dd8180d98e5a0ead7ead99029acc80b86a8b905b9aba4cc978e388039bb5823b",
    lib_sha256: "d4c4d939c8bd1e93a86bc5a45b37a1fdd08dce34d8231db014a7e4a023923f5a",
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
    // Verify on every run, not just first stage: a pre-staged file (LL_ORT_DIR
    // air-gap path) has never been hashed, and a previously-staged file may have
    // been swapped or truncated. Trust the file's bytes, not its presence —
    // mirrors the model loader's `verified()`. Only re-download when missing or
    // failing; a passing hash skips the network.
    if !verified(&lib_path, TARGET.lib_sha256) {
        if lib_path.exists() {
            anyhow::bail!(
                "{} failed its expected SHA-256 ({}); refusing to load a tampered \
                 or mismatched ONNX Runtime. Remove it to re-fetch the pinned \
                 library, or point ORT_DYLIB_PATH at a known-good one",
                lib_path.display(),
                TARGET.lib_sha256
            );
        }
        stage_bundle(&dir, &lib_path)?;
    }
    std::env::set_var("ORT_DYLIB_PATH", &lib_path);
    Ok(lib_path)
}

/// True when `path` exists and its contents hash to `expected_sha256`.
fn verified(path: &Path, expected_sha256: &str) -> bool {
    path.is_file() && matches!(sha256_hex(path), Ok(actual) if actual == expected_sha256)
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
    download_verified(&url, &archive, MIN_ARCHIVE_BYTES, TARGET.archive_sha256)
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

/// Extract the library at `member` (a `<top>/lib/<file>` path inside the
/// archive) to `dest`. The whole archive is unpacked into a staging dir, then
/// the file whose path ends with `member` is taken — member globbing on the
/// command line is not portable (BSD tar rejects `--wildcards`, GNU tar needs
/// it), so we avoid it and match by path suffix instead, which also rejects the
/// same-named file inside the `.dSYM` debug bundle.
fn extract_member(archive: &Path, member: &str, dest: &Path) -> Result<()> {
    let staging = dest.with_extension("unpack");
    fs::remove_dir_all(&staging).ok();
    fs::create_dir_all(&staging).context("creating extraction staging dir")?;

    let is_zip = archive
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"));
    let status = if is_zip {
        Command::new("unzip")
            .args(["-oq"])
            .arg(archive)
            .arg("-d")
            .arg(&staging)
            .status()
            .context("failed to run unzip")?
    } else {
        Command::new("tar")
            .args(["xzf"])
            .arg(archive)
            .arg("-C")
            .arg(&staging)
            .status()
            .context("failed to run tar")?
    };
    if !status.success() {
        anyhow::bail!("archive extraction failed with status {status}");
    }

    let extracted = find_member(&staging, member)
        .with_context(|| format!("archive did not contain a */{member} entry"))?;
    fs::rename(&extracted, dest).context("failed to move extracted library into place")?;
    fs::remove_dir_all(&staging).ok();
    Ok(())
}

/// Find the single file under `root` whose path ends with `/{member}`. Matching
/// the full `lib/<file>` suffix (not just the basename) skips the identically
/// named file inside macOS `.dSYM` debug bundles.
fn find_member(root: &Path, member: &str) -> Result<PathBuf> {
    let suffix = format!("/{member}");
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).with_context(|| format!("reading {}", dir.display()))? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.to_string_lossy().ends_with(&suffix) {
                return Ok(path);
            }
        }
    }
    anyhow::bail!("no entry ending in {suffix} under {}", root.display())
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
    fn verified_rejects_wrong_contents_and_accepts_right_ones() {
        use std::io::Write;
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(b"not the real library").unwrap();
        f.flush().unwrap();
        // empty-string SHA never matches → a staged file with the wrong bytes is
        // rejected, which is what stops a swapped/truncated dylib from loading.
        assert!(!verified(f.path(), TARGET.lib_sha256));
        // the file's actual hash is accepted, so a good staged file skips re-fetch.
        let actual = sha256_hex(f.path()).unwrap();
        assert!(verified(f.path(), &actual));
        // a path that does not exist is not "verified".
        assert!(!verified(std::path::Path::new("/no/such/lib"), &actual));
    }

    /// `find_member` must match the full `lib/<file>` suffix, so the identically
    /// named file inside a macOS `.dSYM` debug bundle is NOT picked. Build the
    /// exact tree the real osx-arm64 archive unpacks to and prove the right one
    /// wins regardless of which directory the walk visits first.
    #[test]
    fn find_member_skips_dsym_decoy() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let top = root.path().join("onnxruntime-osx-arm64-1.24.2");
        let lib_dir = top.join("lib");
        let dsym = lib_dir.join("libonnxruntime.1.24.2.dylib.dSYM/Contents/Resources/DWARF");
        fs::create_dir_all(&dsym).unwrap();

        // The decoy (debug symbols) shares the basename but lives under .dSYM.
        let mut decoy = fs::File::create(dsym.join("libonnxruntime.1.24.2.dylib")).unwrap();
        decoy.write_all(b"DEBUG SYMBOLS, not the library").unwrap();
        // The real library, at <top>/lib/<file>.
        let real = lib_dir.join("libonnxruntime.1.24.2.dylib");
        fs::File::create(&real).unwrap().write_all(b"REAL LIBRARY").unwrap();

        let found = find_member(root.path(), "lib/libonnxruntime.1.24.2.dylib").unwrap();
        assert_eq!(
            fs::read(&found).unwrap(),
            b"REAL LIBRARY",
            "find_member picked the .dSYM decoy instead of the real library"
        );
    }

    #[test]
    fn find_member_errors_when_absent() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("some/dir")).unwrap();
        let err = find_member(root.path(), "lib/libonnxruntime.so.1.24.2").unwrap_err();
        assert!(err.to_string().contains("no entry ending in"), "{err}");
    }

    /// End-to-end of the portable extraction: a real `.tar.gz` with a
    /// version-named top directory and a `.dSYM` decoy unpacks and yields the
    /// correct library. This is the path that BSD-tar-only `*/member` globbing
    /// silently broke on GNU tar; extracting the whole archive works on both.
    #[test]
    fn extract_member_tar_roundtrip() {
        use std::io::Write;
        let work = tempfile::tempdir().unwrap();
        let src = work.path().join("onnxruntime-osx-arm64-1.24.2");
        let dsym = src.join("lib/libonnxruntime.1.24.2.dylib.dSYM/Contents/Resources/DWARF");
        fs::create_dir_all(&dsym).unwrap();
        fs::File::create(dsym.join("libonnxruntime.1.24.2.dylib"))
            .unwrap()
            .write_all(b"decoy")
            .unwrap();
        fs::File::create(src.join("lib/libonnxruntime.1.24.2.dylib"))
            .unwrap()
            .write_all(b"the real bytes")
            .unwrap();

        let archive = work.path().join("bundle.tgz");
        let status = Command::new("tar")
            .arg("czf")
            .arg(&archive)
            .arg("-C")
            .arg(work.path())
            .arg("onnxruntime-osx-arm64-1.24.2")
            .status()
            .unwrap();
        assert!(status.success(), "building the test archive failed");

        let dest = work.path().join("staged.dylib");
        extract_member(&archive, "lib/libonnxruntime.1.24.2.dylib", &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"the real bytes");
        assert!(
            !dest.with_extension("unpack").exists(),
            "staging dir should be cleaned up"
        );
    }

    /// The Windows path: extraction now dispatches on the archive's own
    /// extension, so the `.zip`/`unzip` branch is exercisable on any host that
    /// has `unzip` (CI does). Skips cleanly where the tool is absent.
    #[test]
    fn extract_member_zip_roundtrip() {
        use std::io::Write;
        if Command::new("zip").arg("-v").output().is_err() {
            eprintln!("skipping: `zip` not available");
            return;
        }
        let work = tempfile::tempdir().unwrap();
        let src = work.path().join("onnxruntime-win-x64-1.24.2");
        fs::create_dir_all(src.join("lib")).unwrap();
        fs::File::create(src.join("lib/onnxruntime.dll"))
            .unwrap()
            .write_all(b"windows lib bytes")
            .unwrap();

        let archive = work.path().join("bundle.zip");
        // zip stores paths relative to its cwd; run it from the work dir.
        let status = Command::new("zip")
            .args(["-rq"])
            .arg(&archive)
            .arg("onnxruntime-win-x64-1.24.2")
            .current_dir(work.path())
            .status()
            .unwrap();
        assert!(status.success(), "building the test zip failed");

        let dest = work.path().join("staged.dll");
        extract_member(&archive, "lib/onnxruntime.dll", &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"windows lib bytes");
    }

    #[test]
    fn target_url_and_pin_agree_on_version() {
        assert!(BASE_URL.ends_with(&format!("v{ORT_VERSION}")));
        assert!(TARGET.asset.contains(ORT_VERSION));
        assert!(TARGET.staged_name.starts_with("lib") || TARGET.staged_name.ends_with(".dll"));
    }

    /// Both SHA-256 hashes the binary enforces for THIS build target — the
    /// archive (download) and the library (every load) — must match the
    /// provenance manifest, so the published provenance can never claim a hash
    /// the code does not actually verify.
    #[test]
    fn target_sha_matches_provenance_manifest() {
        let triple = current_target_triple();
        // The manifest lives at the workspace root, outside this crate, so it is
        // absent when ll-core is consumed as a packaged crates.io crate. Skip
        // there rather than fail — the check is a workspace-repo invariant.
        let manifest_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../provenance/runtime.json");
        let Ok(manifest) = std::fs::read_to_string(manifest_path) else {
            eprintln!("skipping: {manifest_path} not present (packaged crate)");
            return;
        };
        let block = manifest
            .split(&format!("\"{triple}\""))
            .nth(1)
            .unwrap_or_else(|| panic!("runtime.json has no entry for {triple}"));
        for (key, expected) in [
            ("archive_sha256", TARGET.archive_sha256),
            ("lib_sha256", TARGET.lib_sha256),
        ] {
            let line = block
                .lines()
                .find(|l| l.contains(&format!("\"{key}\"")))
                .unwrap_or_else(|| panic!("{triple} block has no {key}"));
            assert!(
                line.contains(expected),
                "runtime.json {key} for {triple} ({line:?}) != dylib.rs ({expected})"
            );
        }
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
