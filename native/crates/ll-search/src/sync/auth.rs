use std::path::Path;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{SigningKey, Signer};
use sha2::{Sha256, Digest};

/// Load the signing seed for sync/watch.
///
/// Errors with a clear message if no seed is present — sync and watch must
/// never silently mint a new identity, because that breaks trust with every
/// peer that has the old pubkey allowlisted. Use [`load_or_create_seed`] only
/// from intentional identity-creation paths (federation setup, identity
/// command, migrate-seed command).
pub fn load_seed(seed_path: &Path) -> anyhow::Result<SigningKey> {
    let config_dir = seed_path
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| anyhow::anyhow!("invalid seed_path: missing federation/ ancestor"))?;
    match super::seed_store::load_only(config_dir)? {
        Some(r) => Ok(r.signing_key),
        None => anyhow::bail!(
            "no federation seed found at {}; run `/learning-loop:federation` to set up an identity",
            config_dir.display()
        ),
    }
}

/// Outcome of a [`load_or_create_seed`] call.
pub struct LoadOrCreate {
    /// The Ed25519 signing key.
    pub signing_key: SigningKey,
    /// True if a new seed was generated on this call.
    pub created: bool,
}

/// Load or create the signing seed, delegating to `seed_store::load_or_create`.
///
/// Retained for compatibility; `seed_path` is used only to derive `config_dir`.
pub fn load_or_create_seed(seed_path: &Path) -> anyhow::Result<LoadOrCreate> {
    let config_dir = seed_path
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| anyhow::anyhow!("invalid seed_path: missing federation/ ancestor"))?;
    let r = super::seed_store::load_or_create(config_dir)?;
    Ok(LoadOrCreate { signing_key: r.signing_key, created: r.created })
}

pub fn pubkey_b64(signing_key: &SigningKey) -> String {
    B64.encode(signing_key.verifying_key().as_bytes())
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
    graph: bool,
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
        "graph": graph,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Verifier, VerifyingKey, Signature};

    fn fixed_key() -> SigningKey {
        SigningKey::from_bytes(&[1u8; 32])
    }

    #[test]
    fn pubkey_b64_roundtrip() {
        let key = fixed_key();
        let encoded = pubkey_b64(&key);
        let decoded = B64.decode(&encoded).expect("valid base64");
        let bytes: [u8; 32] = decoded.try_into().expect("32 bytes");
        let recovered = VerifyingKey::from_bytes(&bytes).expect("valid key");
        assert_eq!(recovered.as_bytes(), key.verifying_key().as_bytes());
    }

    #[test]
    fn sign_challenge_produces_valid_signature() {
        let key = fixed_key();
        let nonce_bytes = b"testnonce123";
        let nonce_b64 = B64.encode(nonce_bytes);
        let peer_id = "peer-abc";
        let hub_pubkey = "hubkey-xyz";

        let sig_b64 = sign_challenge(&key, &nonce_b64, peer_id, hub_pubkey)
            .expect("sign_challenge succeeds");

        let sig_bytes = B64.decode(&sig_b64).expect("valid base64");
        let sig = Signature::try_from(sig_bytes.as_slice()).expect("valid signature bytes");

        let mut message = Vec::new();
        message.extend_from_slice(nonce_bytes);
        message.extend_from_slice(peer_id.as_bytes());
        message.extend_from_slice(hub_pubkey.as_bytes());

        key.verifying_key().verify(&message, &sig).expect("signature verifies");
    }

    #[test]
    fn sign_challenge_wrong_nonce_fails_verification() {
        let key = fixed_key();
        let nonce_b64 = B64.encode(b"originalnonce");
        let sig_b64 = sign_challenge(&key, &nonce_b64, "peer", "hub")
            .expect("sign_challenge succeeds");

        let sig_bytes = B64.decode(&sig_b64).expect("valid base64");
        let sig = Signature::try_from(sig_bytes.as_slice()).expect("valid signature bytes");

        let mut tampered = Vec::new();
        tampered.extend_from_slice(b"WRONGNONCE!!");
        tampered.extend_from_slice(b"peer");
        tampered.extend_from_slice(b"hub");

        assert!(key.verifying_key().verify(&tampered, &sig).is_err());
    }

    #[test]
    fn create_envelope_contains_required_fields() {
        let key = fixed_key();
        let data = b"index content";
        let env = create_envelope(&key, data, "my-peer", false);

        assert_eq!(env["peer_id"].as_str(), Some("my-peer"));
        assert_eq!(env["graph"].as_bool(), Some(false));
        assert!(env["sha256"].as_str().is_some());
        assert!(env["signature"].as_str().is_some());
        assert!(env["pub_key"].as_str().is_some());
        assert!(env["signed_at"].as_str().is_some());
    }

    #[test]
    fn create_envelope_sha256_matches_data() {
        use sha2::{Sha256, Digest};
        let key = fixed_key();
        let data = b"known bytes";
        let env = create_envelope(&key, data, "p", false);
        let expected = hex::encode(Sha256::digest(data));
        assert_eq!(env["sha256"].as_str(), Some(expected.as_str()));
    }

    #[test]
    fn create_envelope_signature_verifies_against_hash() {
        use sha2::{Sha256, Digest};
        let key = fixed_key();
        let data = b"payload data";
        let env = create_envelope(&key, data, "p", false);

        let sig_bytes = B64.decode(env["signature"].as_str().unwrap()).unwrap();
        let sig = Signature::try_from(sig_bytes.as_slice()).unwrap();

        let hash = Sha256::digest(data);
        key.verifying_key().verify(&hash, &sig).expect("envelope signature verifies");
    }

    #[test]
    fn create_envelope_tampered_data_fails_verification() {
        use sha2::{Sha256, Digest};
        let key = fixed_key();
        let data = b"original";
        let env = create_envelope(&key, data, "p", false);

        let sig_bytes = B64.decode(env["signature"].as_str().unwrap()).unwrap();
        let sig = Signature::try_from(sig_bytes.as_slice()).unwrap();

        let tampered_hash = Sha256::digest(b"tampered");
        assert!(key.verifying_key().verify(&tampered_hash, &sig).is_err());
    }

    #[test]
    fn sign_download_is_base64_encoded_signature() {
        let key = fixed_key();
        let sig_b64 = sign_download(&key, "peer-1", 1000000);
        let decoded = B64.decode(&sig_b64).expect("valid base64");
        assert_eq!(decoded.len(), 64, "Ed25519 signature is 64 bytes");
    }

    #[test]
    fn sign_download_different_timestamps_differ() {
        let key = fixed_key();
        let s1 = sign_download(&key, "peer-1", 1000);
        let s2 = sign_download(&key, "peer-1", 1001);
        assert_ne!(s1, s2, "different timestamps produce different signatures");
    }
}
