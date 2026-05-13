use std::env;
use std::fs;
use std::path::{Path, PathBuf};

// MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli, exported as int8 ONNX by Xenova.
// Used by the contradiction-check hook (edge-infer.mjs -> ll-search nli-batch).
// Only downloaded when the `nli` cargo feature is enabled.
const NLI_MODEL_URL: &str = "https://huggingface.co/Xenova/DeBERTa-v3-base-mnli-fever-anli/resolve/main/onnx/model_quantized.onnx";
const NLI_TOKENIZER_URL: &str = "https://huggingface.co/Xenova/DeBERTa-v3-base-mnli-fever-anli/resolve/main/tokenizer.json";

// Minimum sizes for the downloaded files. Below these the file is treated as
// truncated/corrupt and re-downloaded. Values are conservative lower bounds
// (model is ~233MB; tokenizer is ~8MB).
const MIN_MODEL_BYTES: u64 = 200 * 1024 * 1024;
const MIN_TOKENIZER_BYTES: u64 = 4 * 1024 * 1024;

fn download(url: &str, dest: &Path, min_bytes: u64) {
    if let Ok(meta) = fs::metadata(dest) {
        if meta.len() >= min_bytes {
            return;
        }
        eprintln!(
            "cargo:warning=re-downloading {} (cached file {} bytes < expected min {})",
            dest.display(),
            meta.len(),
            min_bytes
        );
        let _ = fs::remove_file(dest);
    }

    let tmp = dest.with_extension("download.tmp");
    let _ = fs::remove_file(&tmp);

    eprintln!("Downloading {} ...", url);
    let output = std::process::Command::new("curl")
        .args(["-fsSL", "-o"])
        .arg(&tmp)
        .arg(url)
        .output()
        .expect("curl spawn failed (is `curl` on PATH?)");
    if !output.status.success() {
        let _ = fs::remove_file(&tmp);
        panic!(
            "curl failed to download {} (exit {:?}): {}",
            url,
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let downloaded_bytes = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if downloaded_bytes < min_bytes {
        let _ = fs::remove_file(&tmp);
        panic!(
            "downloaded file from {} is {} bytes, expected at least {} (truncated upstream?)",
            url, downloaded_bytes, min_bytes
        );
    }

    fs::rename(&tmp, dest).expect("atomic rename of downloaded model failed");
}

fn main() {
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_NLI");
    if env::var("CARGO_FEATURE_NLI").is_ok() {
        let model_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("model");
        fs::create_dir_all(&model_dir).unwrap();

        let nli_model_path = model_dir.join("nli_model_quantized.onnx");
        let nli_tokenizer_path = model_dir.join("nli_tokenizer.json");

        download(NLI_MODEL_URL, &nli_model_path, MIN_MODEL_BYTES);
        download(NLI_TOKENIZER_URL, &nli_tokenizer_path, MIN_TOKENIZER_BYTES);

        println!("cargo:rerun-if-changed=model/nli_model_quantized.onnx");
        println!("cargo:rerun-if-changed=model/nli_tokenizer.json");
    }
}
