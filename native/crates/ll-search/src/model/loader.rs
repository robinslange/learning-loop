use std::fs;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_model_urls_use_pinned_revision() {
        assert!(BGE_SMALL_MODEL_URL.contains(BGE_SMALL_REVISION));
        assert!(BGE_SMALL_TOKENIZER_URL.contains(BGE_SMALL_REVISION));
        assert!(!BGE_SMALL_MODEL_URL.contains("/main/"), "model fetch must not track a moving revision");
    }
}

fn models_dir() -> PathBuf {
    let dir = dirs_next::home_dir()
        .expect("could not determine home directory")
        .join(".learning-loop")
        .join("models");
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

fn download(url: &str, dest: &Path) -> Result<()> {
    if dest.exists() {
        return Ok(());
    }
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
    fs::rename(&tmp, dest).context("failed to move downloaded file into place")?;
    Ok(())
}

pub fn ensure_model(model: &KnownModel) -> Result<(PathBuf, PathBuf)> {
    let dir = model_dir(model);
    match model {
        KnownModel::BgeSmallEnV15 => {
            let model_path = dir.join("model_quantized.onnx");
            let tokenizer_path = dir.join("tokenizer.json");
            download(BGE_SMALL_MODEL_URL, &model_path)?;
            download(BGE_SMALL_TOKENIZER_URL, &tokenizer_path)?;
            Ok((model_path, tokenizer_path))
        }
    }
}

pub fn load_provider(model: &KnownModel) -> Result<Box<dyn EmbeddingProvider>> {
    let (model_path, tokenizer_path) = ensure_model(model)?;
    match model {
        KnownModel::BgeSmallEnV15 => {
            let provider = bge_small::BgeSmallProvider::from_files(&model_path, &tokenizer_path)?;
            Ok(Box::new(provider))
        }
    }
}
