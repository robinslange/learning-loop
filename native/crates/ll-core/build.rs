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
const MAX_ATTEMPTS: u32 = 6;
// Seconds before retry N+1. HF 429 windows outlive short exponential backoff
// (run 27312423423: five 429s in ~30s); later waits are deliberately long.
const BACKOFF_SECS: [u64; 5] = [2, 5, 15, 45, 90];

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
            let backoff = Duration::from_secs(BACKOFF_SECS[(attempt - 1) as usize]);
            eprintln!("  curl exited {}; retrying in {:?}", status, backoff);
            sleep(backoff);
        }
    }
    panic!(
        "Failed to download {} after {} attempts (last error likely HTTP 429 / network).",
        url, MAX_ATTEMPTS
    );
}

// LL_MODEL_CACHE_DIR is a durable CI cache outside the eviction-prone cargo cache:
// files land there, then ALWAYS copy to OUT_DIR for include_bytes! — a conditional
// copy could embed a stale OUT_DIR file from a restored target/ after a URL bump.
fn fetch(url: &str, filename: &str, out_path: &Path) {
    match env::var("LL_MODEL_CACHE_DIR") {
        Ok(dir) if !dir.is_empty() => {
            let cache_dir = PathBuf::from(dir);
            std::fs::create_dir_all(&cache_dir).expect("create LL_MODEL_CACHE_DIR");
            let cached = cache_dir.join(filename);
            download(url, &cached);
            std::fs::copy(&cached, out_path)
                .unwrap_or_else(|e| panic!("copy {} -> {}: {}", cached.display(), out_path.display(), e));
        }
        _ => download(url, out_path),
    }
}

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    let reranker_model_path = out_dir.join("reranker.onnx");
    let reranker_tokenizer_path = out_dir.join("reranker_tokenizer.json");

    fetch(RERANKER_MODEL_URL, "reranker.onnx", &reranker_model_path);
    fetch(RERANKER_TOKENIZER_URL, "reranker_tokenizer.json", &reranker_tokenizer_path);

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=LL_MODEL_CACHE_DIR");
}
