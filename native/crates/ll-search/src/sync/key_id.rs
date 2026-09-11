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

/// The longest base58btc body a `KEY_ID_LEN`-byte value can encode to:
/// `floor(KEY_ID_LEN * log(256)/log(58)) + 1`.
///
/// Not a guess and not slack — `the_bound_is_tight_for_the_largest_key_id`
/// pins it against the encoder itself, so a change to `KEY_ID_LEN` that makes
/// this wrong fails the suite rather than silently rejecting valid keys.
/// Must match the hub's `MAX_KEY_ID_BODY_LEN`.
const MAX_KEY_ID_BODY_LEN: usize = 47;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct KeyId(String);

/// Strip the multibase prefix, base58-decode, and check the multicodec tag
/// and length. Shared by `parse` (which additionally checks the result is a
/// valid curve point) and `verifying_key` (decoding a `KeyId` known-valid).
fn decode(s: &str) -> anyhow::Result<[u8; 32]> {
    let body = s
        .strip_prefix('z')
        .ok_or_else(|| anyhow::anyhow!("key_id must use the multibase base58btc prefix 'z'"))?;
    // Bound the input BEFORE decoding it. base58 is a base conversion, not a
    // block transform: bs58's `into_vec` is O(n²) in the length of the string,
    // and a key_id arrives from the hub inside every grant statement, where
    // serde calls `KeyId::parse` during deserialisation. A hostile or
    // compromised hub could otherwise hang this client on one message —
    // measured on the hub's identical copy, a 200 KB body takes 56 s.
    //
    // Length alone settles it: a longer string cannot encode a KEY_ID_LEN-byte
    // value, so this rejects exactly what the length check below would have
    // rejected anyway, without doing the work first.
    if body.len() > MAX_KEY_ID_BODY_LEN {
        anyhow::bail!("key_id is not a 32-byte ed25519 public key");
    }
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

impl serde::Serialize for KeyId {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl<'de> serde::Deserialize<'de> for KeyId {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        KeyId::parse(&s).map_err(serde::de::Error::custom)
    }
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

    /// Tight against the encoder, not a comfortable guess: too low silently
    /// rejects real keys, too high leaves the quadratic decode reachable.
    /// Must stay identical to the hub's test of the same name.
    #[test]
    fn the_bound_is_tight_for_the_largest_key_id() {
        let mut biggest = [0xffu8; KEY_ID_LEN];
        biggest[..2].copy_from_slice(&ED25519_MULTICODEC);
        let mut smallest = [0x00u8; KEY_ID_LEN];
        smallest[..2].copy_from_slice(&ED25519_MULTICODEC);

        let big = bs58::encode(biggest).into_string();
        let small = bs58::encode(smallest).into_string();
        assert!(big.len() <= MAX_KEY_ID_BODY_LEN, "bound too low: {}", big.len());
        assert!(small.len() <= MAX_KEY_ID_BODY_LEN, "bound too low: {}", small.len());
        assert_eq!(
            big.len(),
            MAX_KEY_ID_BODY_LEN,
            "bound is looser than the encoder needs; tighten it to KEY_ID_LEN's real maximum"
        );
    }

    #[test]
    fn a_real_key_is_within_the_bound() {
        use ed25519_dalek::SigningKey;
        for seed in 0u8..32 {
            let sk = SigningKey::from_bytes(&[seed; 32]);
            let id = KeyId::from_pubkey(&sk.verifying_key());
            let body = id.as_str().strip_prefix('z').unwrap();
            assert!(body.len() <= MAX_KEY_ID_BODY_LEN, "{} chars", body.len());
            assert!(KeyId::parse(id.as_str()).is_ok());
        }
    }

    /// A hostile hub puts an over-long key_id in a grant statement. It must be
    /// refused on length, before the quadratic decode runs.
    ///
    /// 'z' is base58's HIGHEST digit, not '1', which is its zero: bs58 counts
    /// leading zeros rather than multiplying through them, so a string of '1's
    /// decodes in linear time and would pass against an unbounded decoder.
    #[test]
    fn an_over_long_body_is_rejected_before_it_is_decoded() {
        let huge = format!("z{}", "z".repeat(200_000));
        let started = std::time::Instant::now();
        assert!(KeyId::parse(&huge).is_err());
        assert!(
            started.elapsed() < std::time::Duration::from_millis(250),
            "rejection took {:?} — the decode ran instead of being refused on length",
            started.elapsed()
        );
    }
}
