use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

// HuggingFace rate-limits (HTTP 429) under concurrent CI builds; a single curl
// attempt makes the release build flaky. Retry with exponential backoff.
const MAX_ATTEMPTS: u32 = 5;

// MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli, exported as int8 ONNX by Xenova.
// Used by the contradiction-check hook (edge-infer.mjs -> ll-search nli-batch).
// Only downloaded when the `nli` cargo feature is enabled.
const NLI_MODEL_URL: &str = "https://huggingface.co/Xenova/DeBERTa-v3-base-mnli-fever-anli/resolve/main/onnx/model_quantized.onnx";
const NLI_TOKENIZER_URL: &str = "https://huggingface.co/Xenova/DeBERTa-v3-base-mnli-fever-anli/resolve/main/tokenizer.json";

// SHA-256 pins of the exact artifacts that are know-good for the current
// classifier head (label argmax in nli.rs assumes the MoritzLaurer ordering
// and the spike eval validated 86% precision against these specific bytes).
//
// To upgrade the pinned model/tokenizer:
//   1. download the new file
//   2. run `shasum -a 256 <file>` and paste the digest here
//   3. re-run the spike eval (native/crates/ll-search/spikes/nli-eval/) to
//      confirm precision holds
//   4. re-run the binary smoke test (Earth/Sun contradiction)
//
// Pinning catches: corrupted partial downloads that beat the size floor,
// CDN tampering, accidental upstream re-quants that change behavior, and
// stale cached model files in `model/` that no longer match `build.rs`.
const NLI_MODEL_SHA256: &str = "ab9da76bb06054ea6b921560c1ecf5683a9e4d96f0ea73d78d3b4a8990aea882";
const NLI_TOKENIZER_SHA256: &str = "a86f883318afa11c8c10466f1bf4efaeb6ded28a52cbe57217a8fa0d0a2a87df";

// Minimum sizes are a cheap pre-hash sanity check — catches truncated files
// before we pay the cost of hashing 233MB.
const MIN_MODEL_BYTES: u64 = 200 * 1024 * 1024;
const MIN_TOKENIZER_BYTES: u64 = 4 * 1024 * 1024;

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

fn download(url: &str, dest: &Path, min_bytes: u64, expected_sha256: &str) {
    if let Ok(meta) = fs::metadata(dest) {
        if meta.len() >= min_bytes {
            match sha256_hex(dest) {
                Ok(actual) if actual == expected_sha256 => return,
                Ok(actual) => {
                    eprintln!(
                        "cargo:warning=re-downloading {}: hash mismatch (have {}, expected {})",
                        dest.display(),
                        actual,
                        expected_sha256
                    );
                }
                Err(e) => {
                    eprintln!(
                        "cargo:warning=re-downloading {}: failed to hash existing file: {}",
                        dest.display(),
                        e
                    );
                }
            }
        } else {
            eprintln!(
                "cargo:warning=re-downloading {}: cached file {} bytes < expected min {}",
                dest.display(),
                meta.len(),
                min_bytes
            );
        }
        let _ = fs::remove_file(dest);
    }

    let tmp = dest.with_extension("download.tmp");
    let _ = fs::remove_file(&tmp);

    let mut last_err = String::new();
    let mut downloaded = false;
    for attempt in 1..=MAX_ATTEMPTS {
        eprintln!("Downloading {} (attempt {}/{}) ...", url, attempt, MAX_ATTEMPTS);
        let output = std::process::Command::new("curl")
            .args(["-fsSL", "-o"])
            .arg(&tmp)
            .arg(url)
            .output()
            .expect("curl spawn failed (is `curl` on PATH?)");
        if output.status.success() {
            downloaded = true;
            break;
        }
        last_err = format!(
            "exit {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
        let _ = fs::remove_file(&tmp);
        if attempt < MAX_ATTEMPTS {
            let backoff = Duration::from_secs(2u64.pow(attempt));
            eprintln!("  curl failed ({}); retrying in {:?}", last_err, backoff);
            sleep(backoff);
        }
    }
    if !downloaded {
        panic!(
            "curl failed to download {} after {} attempts (last error {}; likely HTTP 429 / network)",
            url, MAX_ATTEMPTS, last_err
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

    let actual_sha256 = sha256_hex(&tmp).expect("hash downloaded file");
    if actual_sha256 != expected_sha256 {
        let _ = fs::remove_file(&tmp);
        panic!(
            "downloaded file from {} has SHA-256 {}, expected {} — upstream changed or CDN compromise; refusing to embed.\n\
             If you intend to upgrade the model, see the comment block above NLI_MODEL_SHA256 / NLI_TOKENIZER_SHA256 in build.rs for the upgrade procedure (re-run the spike eval to verify quality, then paste the new digest).",
            url, actual_sha256, expected_sha256
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

        download(NLI_MODEL_URL, &nli_model_path, MIN_MODEL_BYTES, NLI_MODEL_SHA256);
        download(NLI_TOKENIZER_URL, &nli_tokenizer_path, MIN_TOKENIZER_BYTES, NLI_TOKENIZER_SHA256);

        println!("cargo:rerun-if-changed=model/nli_model_quantized.onnx");
        println!("cargo:rerun-if-changed=model/nli_tokenizer.json");
    }
}
