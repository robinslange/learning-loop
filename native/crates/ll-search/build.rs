use std::env;
use std::fs;
use std::path::{Path, PathBuf};

// MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli, exported as int8 ONNX by Xenova.
// Used by the contradiction-check hook (edge-infer.mjs -> ll-search nli-batch).
// Only downloaded when the `nli` cargo feature is enabled.
const NLI_MODEL_URL: &str = "https://huggingface.co/Xenova/DeBERTa-v3-base-mnli-fever-anli/resolve/main/onnx/model_quantized.onnx";
const NLI_TOKENIZER_URL: &str = "https://huggingface.co/Xenova/DeBERTa-v3-base-mnli-fever-anli/resolve/main/tokenizer.json";

fn download(url: &str, dest: &Path) {
    if dest.exists() {
        return;
    }
    eprintln!("Downloading {} ...", url);
    let output = std::process::Command::new("curl")
        .args(["-fsSL", "-o", dest.to_str().unwrap(), url])
        .status()
        .expect("curl failed");
    assert!(output.success(), "Failed to download {}", url);
}

fn main() {
    if env::var("CARGO_FEATURE_NLI").is_ok() {
        let model_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("model");
        fs::create_dir_all(&model_dir).unwrap();

        let nli_model_path = model_dir.join("nli_model_quantized.onnx");
        let nli_tokenizer_path = model_dir.join("nli_tokenizer.json");

        download(NLI_MODEL_URL, &nli_model_path);
        download(NLI_TOKENIZER_URL, &nli_tokenizer_path);

        println!("cargo:rerun-if-changed=model/nli_model_quantized.onnx");
        println!("cargo:rerun-if-changed=model/nli_tokenizer.json");
    }
}
