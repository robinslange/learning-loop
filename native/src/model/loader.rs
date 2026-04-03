use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};

use super::{bge_small, embeddinggemma, EmbeddingProvider, KnownModel};

const BGE_SMALL_MODEL_URL: &str =
    "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx";
const BGE_SMALL_TOKENIZER_URL: &str =
    "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/tokenizer.json";
const GEMMA_MODEL_URL: &str = "https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX/resolve/main/onnx/model_quantized.onnx";
const GEMMA_MODEL_DATA_URL: &str = "https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX/resolve/main/onnx/model_quantized.onnx_data";
const GEMMA_TOKENIZER_URL: &str =
    "https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX/resolve/main/tokenizer.json";

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
        KnownModel::EmbeddingGemma300m => "embeddinggemma-300m",
    };
    let dir = models_dir().join(name);
    fs::create_dir_all(&dir).expect("failed to create model directory");
    dir
}

fn download(url: &str, dest: &Path) -> Result<()> {
    if dest.exists() {
        return Ok(());
    }
    eprintln!("Downloading {} ...", url);
    let status = Command::new("curl")
        .args(["-fSL", "--progress-bar", "-o"])
        .arg(dest)
        .arg(url)
        .status()
        .context("failed to run curl")?;
    if !status.success() {
        anyhow::bail!("curl failed with status {}", status);
    }
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
        KnownModel::EmbeddingGemma300m => {
            let model_path = dir.join("model_quantized.onnx");
            let model_data_path = dir.join("model_quantized.onnx_data");
            let tokenizer_path = dir.join("tokenizer.json");
            download(GEMMA_MODEL_URL, &model_path)?;
            download(GEMMA_MODEL_DATA_URL, &model_data_path)?;
            download(GEMMA_TOKENIZER_URL, &tokenizer_path)?;
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
        KnownModel::EmbeddingGemma300m => {
            let provider =
                embeddinggemma::EmbeddingGemmaProvider::from_files(&model_path, &tokenizer_path)?;
            Ok(Box::new(provider))
        }
    }
}
