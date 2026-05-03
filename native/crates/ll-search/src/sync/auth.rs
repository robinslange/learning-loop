use std::path::Path;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{SigningKey, Signer};
use rand::RngCore;
use sha2::{Sha256, Digest};

pub fn load_seed(seed_path: &Path) -> anyhow::Result<SigningKey> {
    let bytes = std::fs::read(seed_path)?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("seed file must be exactly 32 bytes"))?;
    Ok(SigningKey::from_bytes(&seed))
}

pub struct LoadOrCreate {
    pub signing_key: SigningKey,
    pub created: bool,
}

pub fn load_or_create_seed(seed_path: &Path) -> anyhow::Result<LoadOrCreate> {
    if seed_path.exists() {
        return Ok(LoadOrCreate {
            signing_key: load_seed(seed_path)?,
            created: false,
        });
    }

    if let Some(parent) = seed_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut seed = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut seed);

    let tmp_path = seed_path.with_extension("seed.tmp");
    std::fs::write(&tmp_path, seed)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600))?;
    }

    std::fs::rename(&tmp_path, seed_path)?;

    Ok(LoadOrCreate {
        signing_key: SigningKey::from_bytes(&seed),
        created: true,
    })
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
