use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use anyhow::Context;
use ed25519_dalek::SigningKey;

use super::auth;

pub fn download_release(
    hub_base_url: &str,
    version: &str,
    artifact: &str,
    signing_key: &SigningKey,
    peer_id: &str,
    dest: &Path,
) -> anyhow::Result<()> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs();

    let sig = auth::sign_download(signing_key, peer_id, timestamp);
    let auth_header = format!("Ed25519 {peer_id}:{timestamp}:{sig}");

    let http_base = hub_base_url
        .replace("ws://", "http://")
        .replace("wss://", "https://")
        .trim_end_matches("/ws")
        .trim_end_matches('/')
        .to_string();
    let url = format!("{http_base}/releases/{version}/{artifact}");

    eprintln!("Downloading {url}...");

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let dest_str = dest.to_str().context("invalid destination path")?;

    let output = std::process::Command::new("curl")
        .args([
            "-fSL",
            "-H", &format!("Authorization: {auth_header}"),
            "-o", dest_str,
            &url,
        ])
        .output()
        .context("curl not found - install curl to download binaries")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("download failed: {stderr}");
    }

    eprintln!("Downloaded to {}", dest.display());
    Ok(())
}

pub fn detect_artifact() -> String {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    match (os, arch) {
        ("macos", "aarch64") => "ll-search-darwin-arm64.tar.gz".into(),
        ("linux", "x86_64") => "ll-search-linux-x64.tar.gz".into(),
        ("windows", "x86_64") => "ll-search-windows-x64.zip".into(),
        _ => format!("ll-search-{os}-{arch}.tar.gz"),
    }
}
