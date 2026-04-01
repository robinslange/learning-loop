use std::path::Path;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{SigningKey, Signer};
use sha2::{Sha256, Digest};

pub fn load_seed(seed_path: &Path) -> anyhow::Result<SigningKey> {
    let bytes = std::fs::read(seed_path)?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("seed file must be exactly 32 bytes"))?;
    Ok(SigningKey::from_bytes(&seed))
}

pub fn sign_challenge(
    signing_key: &SigningKey,
    nonce_b64: &str,
    peer_id: &str,
    hub_pubkey: &str,
) -> anyhow::Result<String> {
    let nonce = B64.decode(nonce_b64)?;
    let mut message = Vec::with_capacity(nonce.len() + peer_id.len() + hub_pubkey.len());
    message.extend_from_slice(&nonce);
    message.extend_from_slice(peer_id.as_bytes());
    message.extend_from_slice(hub_pubkey.as_bytes());
    let sig = signing_key.sign(&message);
    Ok(B64.encode(sig.to_bytes()))
}

pub fn sign_download(
    signing_key: &SigningKey,
    peer_id: &str,
    timestamp: u64,
) -> String {
    let message = format!("download:{peer_id}:{timestamp}");
    let sig = signing_key.sign(message.as_bytes());
    B64.encode(sig.to_bytes())
}

pub fn create_envelope(
    signing_key: &SigningKey,
    index_bytes: &[u8],
    peer_id: &str,
) -> serde_json::Value {
    let hash = Sha256::digest(index_bytes);
    let sig = signing_key.sign(&hash);
    let pubkey = signing_key.verifying_key();

    serde_json::json!({
        "peer_id": peer_id,
        "sha256": hex::encode(hash),
        "signature": B64.encode(sig.to_bytes()),
        "pub_key": B64.encode(pubkey.as_bytes()),
        "signed_at": crate::db::chrono_iso_now(),
    })
}
