//! bge-small-en-v1.5 embeddings: pinned download, SHA-256 verification and an
//! ONNX Runtime [`EmbeddingProvider`].
//!
//! Enabled by the `bge` feature. [`load`] is the entry point.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use anyhow::{Context, Result};
use ort::{ep, session::Session, value::Tensor};
use tokenizers::Tokenizer;

use crate::embed::{EmbeddingProvider, ModelConfig};

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
fn resolve_models_dir(override_dir: Option<&str>) -> Result<PathBuf> {
    match override_dir.filter(|d| !d.is_empty()) {
        Some(d) => Ok(PathBuf::from(d)),
        None => Ok(dirs_next::home_dir()
            .context("could not determine home directory; set LL_MODELS_DIR")?
            .join(".learning-loop")
            .join("models")),
    }
}

fn model_dir() -> Result<PathBuf> {
    let dir = resolve_models_dir(std::env::var("LL_MODELS_DIR").ok().as_deref())?
        .join("bge-small-en-v1.5");
    fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create model directory {}", dir.display()))?;
    Ok(dir)
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

/// Download (or verify the cached copy of) the pinned model and tokenizer.
///
/// Returns `(model_path, tokenizer_path)` inside the models directory
/// (`$LL_MODELS_DIR/bge-small-en-v1.5`, defaulting to
/// `~/.learning-loop/models/bge-small-en-v1.5`). Every file is SHA-256
/// verified, on cache hits as well as fresh downloads. Shells out to `curl`.
pub fn ensure_model() -> Result<(PathBuf, PathBuf)> {
    let dir = model_dir()?;
    let model_path = dir.join("model_quantized.onnx");
    let tokenizer_path = dir.join("tokenizer.json");
    download(
        BGE_SMALL_MODEL_URL,
        &model_path,
        MIN_MODEL_BYTES,
        BGE_SMALL_MODEL_SHA256,
    )?;
    download(
        BGE_SMALL_TOKENIZER_URL,
        &tokenizer_path,
        MIN_TOKENIZER_BYTES,
        BGE_SMALL_TOKENIZER_SHA256,
    )?;
    Ok((model_path, tokenizer_path))
}

/// Locate ONNX Runtime, fetch the pinned bge-small files if needed, and load
/// the embedding provider.
pub fn load() -> Result<Box<dyn EmbeddingProvider>> {
    crate::dylib::ensure_dylib().context("locating ONNX Runtime")?;
    let (model_path, tokenizer_path) = ensure_model()?;
    let provider = BgeSmallProvider::from_files(&model_path, &tokenizer_path)?;
    Ok(Box::new(provider))
}

/// Model configuration for bge-small-en-v1.5 (384-d, 512-token window, CLS-free mean pooling).
pub fn config() -> ModelConfig {
    ModelConfig {
        model_id: MODEL_ID.to_string(),
        dim: DIM,
        max_tokens: MAX_TOKENS,
        query_prefix: Some(QUERY_PREFIX.to_string()),
        passage_prefix: None,
        needs_token_type_ids: true,
        needs_external_pooling: true,
        normalize_embeddings: true,
        output_tensor_name: None,
    }
}

/// ONNX Runtime embedding provider for bge-small-en-v1.5.
pub struct BgeSmallProvider {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    config: ModelConfig,
}

impl BgeSmallProvider {
    /// Build a provider from an ONNX model file and a `tokenizer.json`.
    ///
    /// Does not locate ONNX Runtime; call [`load`] (or
    /// [`crate::dylib::ensure_dylib`]) first when using this directly.
    pub fn from_files(model_path: &Path, tokenizer_path: &Path) -> Result<Self> {
        let session = Session::builder()
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .with_execution_providers([ep::CPU::default().build()])
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .commit_from_file(model_path)
            .map_err(|e| anyhow::anyhow!("{}", e))?;

        let mut tokenizer =
            Tokenizer::from_file(tokenizer_path).map_err(|e| anyhow::anyhow!("{}", e))?;
        tokenizer
            .with_truncation(Some(tokenizers::TruncationParams {
                max_length: MAX_TOKENS,
                ..Default::default()
            }))
            .map_err(|e| anyhow::anyhow!("{}", e))?;
        tokenizer.with_padding(None);

        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
            config: config(),
        })
    }
}

impl EmbeddingProvider for BgeSmallProvider {
    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let batch_size = texts.len();

        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| anyhow::anyhow!("{}", e))?;

        let max_len = encodings
            .iter()
            .map(|e| e.get_ids().len())
            .max()
            .unwrap_or(0);

        let mut input_ids_flat: Vec<i64> = Vec::with_capacity(batch_size * max_len);
        let mut attention_mask_flat: Vec<i64> = Vec::with_capacity(batch_size * max_len);
        let mut token_type_ids_flat: Vec<i64> = Vec::with_capacity(batch_size * max_len);

        for enc in &encodings {
            let ids = enc.get_ids();
            let mask = enc.get_attention_mask();
            let type_ids = enc.get_type_ids();
            let seq_len = ids.len();

            for j in 0..max_len {
                if j < seq_len {
                    input_ids_flat.push(ids[j] as i64);
                    attention_mask_flat.push(mask[j] as i64);
                    token_type_ids_flat.push(type_ids[j] as i64);
                } else {
                    input_ids_flat.push(0);
                    attention_mask_flat.push(0);
                    token_type_ids_flat.push(0);
                }
            }
        }

        let shape = vec![batch_size as i64, max_len as i64];

        let input_ids_tensor =
            Tensor::from_array((shape.clone(), input_ids_flat.into_boxed_slice()))?;
        let attention_mask_tensor =
            Tensor::from_array((shape.clone(), attention_mask_flat.into_boxed_slice()))?;
        let token_type_ids_tensor =
            Tensor::from_array((shape, token_type_ids_flat.into_boxed_slice()))?;

        let inputs = ort::inputs! {
            "input_ids" => input_ids_tensor,
            "attention_mask" => attention_mask_tensor,
            "token_type_ids" => token_type_ids_tensor,
        };

        // Return the error rather than panicking, in both directions. The
        // provider is a process-wide OnceLock shared by search, reindex and the
        // UDS duplicate scanner, so a panic taken while this lock is held
        // poisons it for the daemon's remaining life and every later embed call
        // panics at the same line, with nothing that can recover it. One
        // malformed output shape -- a 2-D pooled tensor from an execution
        // provider change, a model swap, a file that was corrupted but still
        // matched its hash -- was enough to do that. rerank.rs already takes
        // this shape.
        let mut session = self
            .session
            .lock()
            .map_err(|_| anyhow::anyhow!("embedding session mutex poisoned"))?;
        let outputs = session.run(inputs)?;

        let output = outputs
            .iter()
            .next()
            .map(|(_, v)| v)
            .ok_or_else(|| anyhow::anyhow!("the embedding session returned no outputs"))?;
        let (out_shape, out_data) = output.try_extract_tensor::<f32>()?;

        let out_dims: Vec<usize> = out_shape.iter().map(|&d| d as usize).collect();
        let hidden_dim = *out_dims.get(2).ok_or_else(|| {
            anyhow::anyhow!(
                "expected a 3-D [batch, tokens, hidden] embedding output, got shape {out_dims:?}"
            )
        })?;

        let mut results = Vec::with_capacity(batch_size);

        for (i, enc) in encodings.iter().enumerate() {
            let seq_len = enc.get_attention_mask().iter().filter(|&&v| v == 1).count();

            let mut pooled = vec![0.0f32; hidden_dim];
            for j in 0..seq_len {
                let offset = i * max_len * hidden_dim + j * hidden_dim;
                for (d, val) in pooled.iter_mut().enumerate() {
                    *val += out_data[offset + d];
                }
            }

            let denom = seq_len as f32;
            for val in &mut pooled {
                *val /= denom;
            }

            let norm: f32 = pooled.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 0.0 {
                for val in &mut pooled {
                    *val /= norm;
                }
            }

            results.push(pooled);
        }

        Ok(results)
    }

    fn config(&self) -> &ModelConfig {
        &self.config
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
        assert!(
            !BGE_SMALL_MODEL_URL.contains("/main/"),
            "model fetch must not track a moving revision"
        );
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
        let result = download(
            "https://example.invalid/nonexistent",
            &dest,
            32 * 1024,
            &hash,
        );
        assert!(
            result.is_ok(),
            "a verified cache file must be a hit (no network)"
        );
    }

    #[test]
    fn test_models_dir_honors_override() {
        let target = "/some/staged/models";
        assert_eq!(
            resolve_models_dir(Some(target)).unwrap(),
            PathBuf::from(target)
        );
    }

    #[test]
    fn test_models_dir_empty_override_falls_back_to_home() {
        let resolved = resolve_models_dir(Some("")).unwrap();
        assert!(resolved.ends_with(".learning-loop/models"));
        let none = resolve_models_dir(None).unwrap();
        assert!(none.ends_with(".learning-loop/models"));
    }
}

const MODEL_ID: &str = "Xenova/bge-small-en-v1.5";
const DIM: usize = 384;
const MAX_TOKENS: usize = 512;
const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";
