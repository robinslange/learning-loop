use std::env;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

const RERANKER_MODEL_URL: &str = "https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/onnx/model_quantized.onnx";
const RERANKER_TOKENIZER_URL: &str = "https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/tokenizer.json";

// HuggingFace rate-limits (HTTP 429) under concurrent CI builds, and `curl -f`
// surfaces that as a non-zero exit. A single attempt makes the whole release
// build flaky, so retry with exponential backoff. Downloads to a temp path and
// renames on success, so an interrupted attempt never leaves a truncated file
// that the `dest.exists()` short-circuit would treat as complete.
const MAX_ATTEMPTS: u32 = 5;

fn download(url: &str, dest: &Path) {
    if dest.exists() {
        return;
    }
    let tmp = dest.with_extension("partial");
    for attempt in 1..=MAX_ATTEMPTS {
        eprintln!("Downloading {} (attempt {}/{}) ...", url, attempt, MAX_ATTEMPTS);
        let status = std::process::Command::new("curl")
            .args(["-fsSL", "-o", tmp.to_str().unwrap(), url])
            .status()
            .expect("curl failed to launch");
        if status.success() {
            std::fs::rename(&tmp, dest)
                .unwrap_or_else(|e| panic!("Failed to move {} into place: {}", tmp.display(), e));
            return;
        }
        let _ = std::fs::remove_file(&tmp);
        if attempt < MAX_ATTEMPTS {
            let backoff = Duration::from_secs(2u64.pow(attempt));
            eprintln!("  curl exited {}; retrying in {:?}", status, backoff);
            sleep(backoff);
        }
    }
    panic!(
        "Failed to download {} after {} attempts (last error likely HTTP 429 / network).",
        url, MAX_ATTEMPTS
    );
}

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    let reranker_model_path = out_dir.join("reranker.onnx");
    let reranker_tokenizer_path = out_dir.join("reranker_tokenizer.json");

    download(RERANKER_MODEL_URL, &reranker_model_path);
    download(RERANKER_TOKENIZER_URL, &reranker_tokenizer_path);

    println!("cargo:rerun-if-changed=build.rs");
}
