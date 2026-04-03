use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};

use super::{bge_small, EmbeddingProvider, KnownModel};

const BGE_SMALL_MODEL_URL: &str =
    "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx";
const BGE_SMALL_TOKENIZER_URL: &str =
    "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/tokenizer.json";

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
