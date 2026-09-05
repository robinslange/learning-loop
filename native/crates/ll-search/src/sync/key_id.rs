//! The identity type. A principal IS its public key — there is no registry to
//! consult, no name to allocate, and therefore no namespace to collide in when
//! a second organisation appears.
//!
//! Deliberately duplicated from `sync-hub/src/v5/key.rs` rather than shared
//! across a workspace dependency — the two repos have independent release
//! cycles. The pinned vector test below guards against silent divergence;
//! change both sides together.

use ed25519_dalek::{Signature, VerifyingKey};

/// Multicodec prefix for an ed25519 public key (0xed 0x01), so the encoding is
/// self-describing and a future key type does not need a new format.
const ED25519_MULTICODEC: [u8; 2] = [0xed, 0x01];

/// Multicodec prefix + the 32-byte ed25519 public key it tags.
const KEY_ID_LEN: usize = ED25519_MULTICODEC.len() + 32;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct KeyId(String);

/// Strip the multibase prefix, base58-decode, and check the multicodec tag
/// and length. Shared by `parse` (which additionally checks the result is a
/// valid curve point) and `verifying_key` (decoding a `KeyId` known-valid).
fn decode(s: &str) -> anyhow::Result<[u8; 32]> {
    let body = s
        .strip_prefix('z')
        .ok_or_else(|| anyhow::anyhow!("key_id must use the multibase base58btc prefix 'z'"))?;
    let bytes = bs58::decode(body)
        .into_vec()
        .map_err(|_| anyhow::anyhow!("key_id is not valid base58btc"))?;
    if bytes.len() != KEY_ID_LEN || bytes[..2] != ED25519_MULTICODEC {
        anyhow::bail!("key_id is not a 32-byte ed25519 public key");
    }
    Ok(bytes[2..].try_into().expect("length checked above"))
}

impl KeyId {
    pub fn from_pubkey(vk: &VerifyingKey) -> Self {
        let mut bytes = Vec::with_capacity(KEY_ID_LEN);
        bytes.extend_from_slice(&ED25519_MULTICODEC);
        bytes.extend_from_slice(vk.as_bytes());
        KeyId(format!("z{}", bs58::encode(bytes).into_string()))
    }

    pub fn parse(s: &str) -> anyhow::Result<Self> {
        let arr = decode(s)?;
        // Reject a well-formed encoding of a point that is not a valid key.
        VerifyingKey::from_bytes(&arr)?;
        Ok(KeyId(s.to_string()))
    }

    pub fn verifying_key(&self) -> anyhow::Result<VerifyingKey> {
        let arr = decode(&self.0)?;
        Ok(VerifyingKey::from_bytes(&arr)?)
    }

    /// Verify a signature against this key. Uses `verify_strict` (not
    /// `verify`) — it rejects small-order/malleable-point signatures that
    /// plain `verify` accepts, which matters here because this is the exact
    /// check a hostile hub's forged or replayed `sig_h`/`sig_c` must fail.
    pub fn verify(&self, message: &[u8], signature: &[u8]) -> anyhow::Result<()> {
        let sig = Signature::from_slice(signature)?;
        self.verifying_key()?.verify_strict(message, &sig)?;
        Ok(())
    }

    pub fn as_str(&self) -> &str { &self.0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn key() -> SigningKey { SigningKey::generate(&mut rand::thread_rng()) }

    #[test]
    fn matches_the_hub_encoding_for_a_known_key() {
        // Pinned vector. If this changes, every deployed client's pin breaks
        // and the failure surfaces as an auth error, not an encoding error.
        // Must match the identical literal in sync-hub/src/v5/key.rs.
        //
        // To regenerate after a deliberate encoding change: run
        // `KeyId::from_pubkey(&SigningKey::from_bytes(&[7u8; 32]).verifying_key())`
        // and print `.as_str()` — update the literal on both sides together.
        let seed = [7u8; 32];
        let sk = SigningKey::from_bytes(&seed);
        let id = KeyId::from_pubkey(&sk.verifying_key());
        assert!(id.as_str().starts_with('z'));
        assert_eq!(id.as_str(), "z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z");
        assert_eq!(KeyId::parse(id.as_str()).unwrap(), id);
    }

    #[test]
    fn round_trips_through_parse() {
        let sk = key();
        let id = KeyId::from_pubkey(&sk.verifying_key());
        assert_eq!(KeyId::parse(id.as_str()).unwrap().verifying_key().unwrap(),
                   sk.verifying_key());
    }

    #[test]
    fn rejects_malformed_input() {
        assert!(KeyId::parse("nope").is_err());
        assert!(KeyId::parse("z!!!!").is_err());
    }

    #[test]
    fn rejects_a_wrong_length_payload() {
        // 31 bytes rather than the 34 a prefixed ed25519 key needs.
        let short = format!("z{}", bs58::encode(&[7u8; 31]).into_string());
        assert!(KeyId::parse(&short).is_err());
    }

    #[test]
    fn rejects_a_well_formed_payload_with_the_wrong_multicodec_prefix() {
        // A genuinely valid ed25519 public key, right length (34 bytes total),
        // but tagged with the wrong 2-byte multicodec — so this can only be
        // caught by the tag check, not by length or by curve-point validation.
        let vk = key().verifying_key();
        let mut bytes = vec![0x00u8, 0x00u8];
        bytes.extend_from_slice(vk.as_bytes());
        let wrong_prefix = format!("z{}", bs58::encode(&bytes).into_string());
        assert!(KeyId::parse(&wrong_prefix).is_err());
    }

    #[test]
    fn distinct_keys_never_collide() {
        let a = KeyId::from_pubkey(&key().verifying_key());
        let b = KeyId::from_pubkey(&key().verifying_key());
        assert_ne!(a, b);
    }

    #[test]
    fn verifies_a_signature_made_by_the_matching_key() {
        let sk = key();
        let id = KeyId::from_pubkey(&sk.verifying_key());
        let sig = sk.sign(b"payload");
        assert!(id.verify(b"payload", &sig.to_bytes()).is_ok());
        assert!(id.verify(b"tampered", &sig.to_bytes()).is_err());
    }

    #[test]
    fn rejects_a_signature_made_by_a_different_key() {
        // A real, well-formed signature — just over the right bytes with the
        // wrong key. Distinguishes "checks the signature" from "checks that
        // some signature-shaped bytes were supplied".
        let signer = key();
        let other_id = KeyId::from_pubkey(&key().verifying_key());
        let sig = signer.sign(b"payload");
        assert!(other_id.verify(b"payload", &sig.to_bytes()).is_err());
    }
}
