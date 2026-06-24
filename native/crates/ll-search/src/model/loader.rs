use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};

use super::{bge_small, EmbeddingProvider, KnownModel};

/// Pinned revision (commit hash) of the Xenova/bge-small-en-v1.5 HF repo.
///
/// Fetching `resolve/main` would let an upstream re-export silently change
/// the model bytes between machines: the dev box that saved
/// bench/baselines/quality.json keeps its cached copy forever while every
/// ephemeral CI runner downloads whatever `main` currently serves. Pinning
/// keeps all machines on identical bytes. Bump deliberately, then regenerate
/// the quality baseline (the revision is recorded in its provenance block).
pub const BGE_SMALL_REVISION: &str = "ea104dacec62c0de699686887e3f920caeb4f3e3";

const BGE_SMALL_MODEL_URL: &str =
    "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/ea104dacec62c0de699686887e3f920caeb4f3e3/onnx/model_quantized.onnx";
const BGE_SMALL_TOKENIZER_URL: &str =
    "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/ea104dacec62c0de699686887e3f920caeb4f3e3/tokenizer.json";

/// SHA-256 pins of the exact artifacts served by BGE_SMALL_REVISION.
///
/// A bare `dest.exists()` cache check trusts whatever is on disk forever — a
/// truncated download or a locally-tampered file would be loaded silently.
/// Re-hashing on every load catches both, at the cost of one SHA-256 pass over
/// ~33MB at startup.
///
/// To upgrade the pinned model/tokenizer:
///   1. bump BGE_SMALL_REVISION + both URLs to the new commit
///   2. download the new files and run `shasum -a 256 <file>`, paste digests here
///   3. regenerate the quality baseline (bench/baselines/quality.json)
const BGE_SMALL_MODEL_SHA256: &str =
    "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4";
const BGE_SMALL_TOKENIZER_SHA256: &str =
    "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66";

// Cheap pre-hash sanity check — catches truncated files before hashing.
const MIN_MODEL_BYTES: u64 = 20 * 1024 * 1024;
const MIN_TOKENIZER_BYTES: u64 = 500 * 1024;

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

/// True when `path` exists, clears the size floor, and matches `expected_sha256`.
fn verified(path: &Path, min_bytes: u64, expected_sha256: &str) -> bool {
    match fs::metadata(path) {
        Ok(meta) if meta.len() >= min_bytes => {
            matches!(sha256_hex(path), Ok(actual) if actual == expected_sha256)
        }
        _ => false,
    }
}

/// LL_MODELS_DIR lets an air-gapped box pre-stage model files outside
/// `~/.learning-loop/models` (e.g. a read-only mount baked into the image).
fn resolve_models_dir(override_dir: Option<&str>) -> PathBuf {
    match override_dir.filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => dirs_next::home_dir()
            .expect("could not determine home directory")
            .join(".learning-loop")
            .join("models"),
    }
}

fn models_dir() -> PathBuf {
    let dir = resolve_models_dir(std::env::var("LL_MODELS_DIR").ok().as_deref());
    fs::create_dir_all(&dir).expect("failed to create models directory");
    dir
}

fn model_dir(model: &KnownModel) -> PathBuf {
    let name = match model {
        KnownModel::BgeSmallEnV15 => "bge-small-en-v1.5",
    };
    let dir = models_dir().join(name);
    fs::create_dir_all(&dir).expect("failed to create model directory");
    dir
}

fn download(url: &str, dest: &Path, min_bytes: u64, expected_sha256: &str) -> Result<()> {
    if verified(dest, min_bytes, expected_sha256) {
        return Ok(());
    }
    fs::remove_file(dest).ok();
    let tmp = dest.with_extension("tmp");
    eprintln!("Downloading {} ...", url);
    let status = Command::new("curl")
        .args(["-fSL", "--progress-bar", "-o"])
        .arg(&tmp)
        .arg(url)
        .status()
        .context("failed to run curl")?;
    if !status.success() {
        fs::remove_file(&tmp).ok();
        anyhow::bail!("curl failed with status {}", status);
    }
    let downloaded_bytes = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if downloaded_bytes < min_bytes {
        fs::remove_file(&tmp).ok();
        anyhow::bail!(
            "downloaded {} is {} bytes, expected at least {} (truncated upstream?)",
            url,
            downloaded_bytes,
            min_bytes
        );
    }
    let actual_sha256 = sha256_hex(&tmp).context("failed to hash downloaded file")?;
    if actual_sha256 != expected_sha256 {
        fs::remove_file(&tmp).ok();
        anyhow::bail!(
            "downloaded {} has SHA-256 {}, expected {} — upstream changed or tampered; refusing to load",
            url,
            actual_sha256,
            expected_sha256
        );
    }
    fs::rename(&tmp, dest).context("failed to move downloaded file into place")?;
    Ok(())
}

pub fn ensure_model(model: &KnownModel) -> Result<(PathBuf, PathBuf)> {
    let dir = model_dir(model);
    match model {
        KnownModel::BgeSmallEnV15 => {
            let model_path = dir.join("model_quantized.onnx");
            let tokenizer_path = dir.join("tokenizer.json");
            download(BGE_SMALL_MODEL_URL, &model_path, MIN_MODEL_BYTES, BGE_SMALL_MODEL_SHA256)?;
            download(
                BGE_SMALL_TOKENIZER_URL,
                &tokenizer_path,
                MIN_TOKENIZER_BYTES,
                BGE_SMALL_TOKENIZER_SHA256,
            )?;
            Ok((model_path, tokenizer_path))
        }
    }
}

pub fn load_provider(model: &KnownModel) -> Result<Box<dyn EmbeddingProvider>> {
    ll_core::dylib::ensure_dylib().context("locating ONNX Runtime")?;
    let (model_path, tokenizer_path) = ensure_model(model)?;
    match model {
        KnownModel::BgeSmallEnV15 => {
            let provider = bge_small::BgeSmallProvider::from_files(&model_path, &tokenizer_path)?;
            Ok(Box::new(provider))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_model_urls_use_pinned_revision() {
        assert!(BGE_SMALL_MODEL_URL.contains(BGE_SMALL_REVISION));
        assert!(BGE_SMALL_TOKENIZER_URL.contains(BGE_SMALL_REVISION));
        assert!(!BGE_SMALL_MODEL_URL.contains("/main/"), "model fetch must not track a moving revision");
    }

    fn write_bytes(path: &Path, n: usize) -> String {
        let mut f = fs::File::create(path).unwrap();
        let data = vec![0xABu8; n];
        f.write_all(&data).unwrap();
        sha256_hex(path).unwrap()
    }

    #[test]
    fn test_verified_accepts_correct_hash_and_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.bin");
        let hash = write_bytes(&path, 1024);
        assert!(verified(&path, 512, &hash));
    }

    #[test]
    fn test_verified_rejects_wrong_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.bin");
        write_bytes(&path, 1024);
        let wrong = "0".repeat(64);
        assert!(!verified(&path, 512, &wrong));
    }

    #[test]
    fn test_verified_rejects_undersized_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.bin");
        let hash = write_bytes(&path, 100);
        assert!(!verified(&path, 512, &hash));
    }

    #[test]
    fn test_verified_rejects_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope.bin");
        assert!(!verified(&path, 1, &"0".repeat(64)));
    }

    #[test]
    fn test_download_rejects_wrong_hash_cache_hit() {
        // A locally-tampered file that beats the size floor but has the wrong
        // hash must NOT short-circuit as a cache hit. With no network the
        // curl re-fetch fails, so download() returns Err rather than trusting
        // the bad bytes.
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model_quantized.onnx");
        write_bytes(&dest, 64 * 1024);
        let result = download(
            "https://example.invalid/nonexistent",
            &dest,
            32 * 1024,
            &"f".repeat(64),
        );
        assert!(result.is_err(), "tampered cache file must not be accepted");
    }

    #[test]
    fn test_download_accepts_valid_cache_hit_without_network() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model_quantized.onnx");
        let hash = write_bytes(&dest, 64 * 1024);
        let result = download("https://example.invalid/nonexistent", &dest, 32 * 1024, &hash);
        assert!(result.is_ok(), "a verified cache file must be a hit (no network)");
    }

    #[test]
    fn test_models_dir_honors_override() {
        let target = "/some/staged/models";
        assert_eq!(resolve_models_dir(Some(target)), PathBuf::from(target));
    }

    #[test]
    fn test_models_dir_empty_override_falls_back_to_home() {
        let resolved = resolve_models_dir(Some(""));
        assert!(resolved.ends_with(".learning-loop/models"));
        let none = resolve_models_dir(None);
        assert!(none.ends_with(".learning-loop/models"));
    }
}
