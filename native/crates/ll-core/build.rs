use std::env;
use std::path::PathBuf;

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
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    let reranker_model_path = out_dir.join("reranker.onnx");
    let reranker_tokenizer_path = out_dir.join("reranker_tokenizer.json");

    download(RERANKER_MODEL_URL, &reranker_model_path);
    download(RERANKER_TOKENIZER_URL, &reranker_tokenizer_path);

    println!("cargo:rerun-if-changed=build.rs");
}
