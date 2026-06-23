use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

// Pinned to an immutable commit of Xenova/ms-marco-MiniLM-L-6-v2 rather than the
// moving `resolve/main` ref: `main` can be re-exported upstream and silently
// change the bytes baked into the binary via include_bytes!. Pinning keeps every
// build machine on identical model weights. Current pin: commit a09144355.
const RERANKER_MODEL_URL: &str = "https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/a09144355adeed5f58c8ed011d209bf8ee5a1fec/onnx/model_quantized.onnx";
const RERANKER_TOKENIZER_URL: &str = "https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/a09144355adeed5f58c8ed011d209bf8ee5a1fec/tokenizer.json";

// SHA-256 pins of the exact artifacts served by RERANKER_REVISION.
//
// To upgrade the pinned model/tokenizer:
//   1. resolve the new commit (`curl -s https://huggingface.co/api/models/Xenova/ms-marco-MiniLM-L-6-v2/revision/main`)
//      and update both URLs
//   2. download the new files and run `shasum -a 256 <file>`, paste digests here
//   3. re-run the binary reranker smoke test to confirm behavior holds
//
// Pinning catches: corrupted partial downloads that beat the size floor, CDN
// tampering, accidental upstream re-quants, and stale cached files in OUT_DIR /
// LL_MODEL_CACHE_DIR that no longer match build.rs.
const RERANKER_MODEL_SHA256: &str =
    "e9d8ebf845c413e981c175bfe49a3bfa9b3dcce2a3ba54875ee5df5a58639fbe";
const RERANKER_TOKENIZER_SHA256: &str =
    "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66";

// Minimum sizes are a cheap pre-hash sanity check — catches truncated files
// before we pay the cost of hashing.
const MIN_MODEL_BYTES: u64 = 20 * 1024 * 1024;
const MIN_TOKENIZER_BYTES: u64 = 500 * 1024;

// HuggingFace rate-limits (HTTP 429) under concurrent CI builds, and `curl -f`
// surfaces that as a non-zero exit. A single attempt makes the whole release
// build flaky, so retry with capped backoff. Downloads to a temp path and
// renames on success, so an interrupted attempt never leaves a truncated file
// that a cache-hit check would treat as complete.
const MAX_ATTEMPTS: u32 = 6;
// Seconds before retry N+1. HF 429 windows outlive short exponential backoff
// (run 27312423423: five 429s in ~30s); later waits are deliberately long.
const BACKOFF_SECS: [u64; 5] = [2, 5, 15, 45, 90];

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
            let backoff = Duration::from_secs(BACKOFF_SECS[(attempt - 1) as usize]);
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
             If you intend to upgrade the model, see the comment block above RERANKER_MODEL_SHA256 / RERANKER_TOKENIZER_SHA256 in build.rs for the upgrade procedure.",
            url, actual_sha256, expected_sha256
        );
    }

    fs::rename(&tmp, dest).expect("atomic rename of downloaded model failed");
}

// Air-gapped from-source builds: when an explicit local path is provided the
// operator chose those bytes, so a hash pin would only get in their way. We
// still enforce the size floor (catches an empty/truncated file) and log which
// path was used so the provenance is auditable in the build log.
fn copy_local(env_path: &str, dest: &Path, min_bytes: u64) {
    let src = PathBuf::from(env_path);
    let meta = fs::metadata(&src).unwrap_or_else(|e| {
        panic!("local model path {} is not readable: {}", src.display(), e)
    });
    if meta.len() < min_bytes {
        panic!(
            "local model file {} is {} bytes, expected at least {} (truncated?)",
            src.display(),
            meta.len(),
            min_bytes
        );
    }
    fs::copy(&src, dest)
        .unwrap_or_else(|e| panic!("copy {} -> {}: {}", src.display(), dest.display(), e));
    eprintln!("Using local model from {} (LL_RERANKER override)", src.display());
}

// LL_MODEL_CACHE_DIR is a durable CI cache outside the eviction-prone cargo cache:
// files land there, then ALWAYS copy to OUT_DIR for include_bytes! — a conditional
// copy could embed a stale OUT_DIR file from a restored target/ after a URL bump.
fn fetch(
    url: &str,
    filename: &str,
    out_path: &Path,
    min_bytes: u64,
    expected_sha256: &str,
    local_override: Option<String>,
) {
    if let Some(path) = local_override.filter(|p| !p.is_empty()) {
        copy_local(&path, out_path, min_bytes);
        return;
    }
    match env::var("LL_MODEL_CACHE_DIR") {
        Ok(dir) if !dir.is_empty() => {
            let cache_dir = PathBuf::from(dir);
            std::fs::create_dir_all(&cache_dir).expect("create LL_MODEL_CACHE_DIR");
            let cached = cache_dir.join(filename);
            download(url, &cached, min_bytes, expected_sha256);
            std::fs::copy(&cached, out_path)
                .unwrap_or_else(|e| panic!("copy {} -> {}: {}", cached.display(), out_path.display(), e));
        }
        _ => download(url, out_path, min_bytes, expected_sha256),
    }
}

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    let reranker_model_path = out_dir.join("reranker.onnx");
    let reranker_tokenizer_path = out_dir.join("reranker_tokenizer.json");

    fetch(
        RERANKER_MODEL_URL,
        "reranker.onnx",
        &reranker_model_path,
        MIN_MODEL_BYTES,
        RERANKER_MODEL_SHA256,
        env::var("LL_RERANKER_MODEL_PATH").ok(),
    );
    fetch(
        RERANKER_TOKENIZER_URL,
        "reranker_tokenizer.json",
        &reranker_tokenizer_path,
        MIN_TOKENIZER_BYTES,
        RERANKER_TOKENIZER_SHA256,
        env::var("LL_RERANKER_TOKENIZER_PATH").ok(),
    );

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=LL_MODEL_CACHE_DIR");
    println!("cargo:rerun-if-env-changed=LL_RERANKER_MODEL_PATH");
    println!("cargo:rerun-if-env-changed=LL_RERANKER_TOKENIZER_PATH");
}
