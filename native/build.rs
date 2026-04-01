use std::env;
use std::fs;
use std::path::PathBuf;

const MODEL_URL: &str = "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx";
const TOKENIZER_URL: &str = "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/tokenizer.json";
const RERANKER_MODEL_URL: &str = "https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/onnx/model_quantized.onnx";
const RERANKER_TOKENIZER_URL: &str = "https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/tokenizer.json";

fn download(url: &str, dest: &PathBuf) {
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
    let model_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("model");
    fs::create_dir_all(&model_dir).unwrap();

    let model_path = model_dir.join("model_quantized.onnx");
    let tokenizer_path = model_dir.join("tokenizer.json");

    download(MODEL_URL, &model_path);
    download(TOKENIZER_URL, &tokenizer_path);

    let reranker_model_path = model_dir.join("reranker.onnx");
    let reranker_tokenizer_path = model_dir.join("reranker_tokenizer.json");

    download(RERANKER_MODEL_URL, &reranker_model_path);
    download(RERANKER_TOKENIZER_URL, &reranker_tokenizer_path);

    println!("cargo:rerun-if-changed=model/model_quantized.onnx");
    println!("cargo:rerun-if-changed=model/tokenizer.json");
    println!("cargo:rerun-if-changed=model/reranker.onnx");
    println!("cargo:rerun-if-changed=model/reranker_tokenizer.json");
}
