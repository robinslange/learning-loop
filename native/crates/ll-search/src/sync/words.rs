//! The ONE wordlist. Fingerprints and recovery phrases both use BIP-39
//! English: a recovery phrase needs a wordlist regardless, and shipping a
//! second one for fingerprints buys nothing.
//!
//! Fingerprints are compared, not typed, so BIP-39's unique-four-letter-prefix
//! property is a bonus rather than a requirement. Six words over sha256 is
//! 66 bits — far past what a side-by-side comparison needs.

use crate::sync::key_id::KeyId;
use sha2::{Digest, Sha256};

/// Six BIP-39 words, hyphen-joined, derived from `sha256(key_id)` — the
/// multibase string, not the raw public key bytes. Hashing the string rather
/// than the key means this must match byte-for-byte what the other side of
/// the connection prints from the same `KeyId`, or a human comparing the two
/// screens sees a false mismatch (or worse, a false match).
pub fn fingerprint(key_id: &KeyId) -> String {
    let digest = Sha256::digest(key_id.as_str().as_bytes());
    let list = bip39::Language::English.word_list();
    let mut words = Vec::with_capacity(6);
    for i in 0..6 {
        // 11 bits per word, read from a fresh byte window each time.
        let hi = digest[i * 2] as usize;
        let lo = digest[i * 2 + 1] as usize;
        words.push(list[((hi << 3) | (lo >> 5)) % list.len()]);
    }
    words.join("-")
}

/// A 24-word BIP-39 recovery phrase encoding `seed` as its entropy.
pub fn recovery_phrase(seed: &[u8; 32]) -> anyhow::Result<String> {
    let mnemonic = bip39::Mnemonic::from_entropy(seed)?;
    Ok(mnemonic.to_string())
}

/// Recover the 32-byte seed from a recovery phrase. Rejects an unknown word
/// or a bad checksum rather than repairing it — a phrase that silently
/// restored a *different* identity would be worse than one that fails,
/// because the user would believe they have their identity back while every
/// grant pointing at the real one stays unreachable.
pub fn seed_from_phrase(phrase: &str) -> anyhow::Result<[u8; 32]> {
    let mnemonic = bip39::Mnemonic::parse(phrase)?;
    let entropy = mnemonic.to_entropy();
    entropy
        .try_into()
        .map_err(|_| anyhow::anyhow!("recovery phrase did not encode a 32-byte seed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn key_id_from_seed(seed: [u8; 32]) -> KeyId {
        let sk = SigningKey::from_bytes(&seed);
        KeyId::from_pubkey(&sk.verifying_key())
    }

    fn test_key_id() -> KeyId {
        key_id_from_seed([7u8; 32])
    }

    fn key_a() -> KeyId {
        key_id_from_seed([1u8; 32])
    }

    fn key_b() -> KeyId {
        key_id_from_seed([2u8; 32])
    }

    #[test]
    fn fingerprint_is_six_words_and_deterministic() {
        let id = test_key_id();
        let a = fingerprint(&id);
        assert_eq!(a.split('-').count(), 6);
        assert_eq!(a, fingerprint(&id));
    }

    #[test]
    fn different_keys_give_different_fingerprints() {
        assert_ne!(fingerprint(&key_a()), fingerprint(&key_b()));
    }

    #[test]
    fn fingerprint_words_all_come_from_the_bip39_list() {
        let fp = fingerprint(&test_key_id());
        for w in fp.split('-') {
            assert!(bip39::Language::English.word_list().contains(&w),
                "{w} is not a BIP-39 word — a second wordlist is a maintenance \
                 and confusion cost for no gain");
        }
    }

    #[test]
    fn fingerprint_matches_a_pinned_literal_for_a_known_key_id() {
        // Pinned vector, not a property: the entire purpose of a fingerprint
        // is that a human reads it off two independently-computed screens and
        // they agree, so a divergence between implementations must fail here
        // rather than surface as a confused user reading two different
        // phrases aloud over the phone.
        //
        // The key_id is the same seed-[7u8;32] vector KeyId pins, so a break
        // in either encoding is visible from this test too. Regenerate by
        // printing `fingerprint(&test_key_id())` after a deliberate change.
        let id = test_key_id();
        assert_eq!(id.as_str(), "z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z");
        assert_eq!(fingerprint(&id), "rapid-party-illegal-theme-blossom-assume");
    }

    #[test]
    fn recovery_phrase_round_trips() {
        let seed = [42u8; 32];
        let phrase = recovery_phrase(&seed).unwrap();
        assert_eq!(phrase.split_whitespace().count(), 24);
        assert_eq!(seed_from_phrase(&phrase).unwrap(), seed);
    }

    #[test]
    fn a_phrase_with_a_typo_is_rejected_not_silently_wrong() {
        let phrase = recovery_phrase(&[42u8; 32]).unwrap();
        let broken = phrase.replacen(' ', " zzzz ", 1);
        assert!(seed_from_phrase(&broken).is_err(),
            "a wrong phrase must fail loudly, not restore a different identity");
    }

    #[test]
    fn a_phrase_with_a_bad_checksum_is_rejected() {
        // Swap one word for another valid BIP-39 word without changing the
        // word count, so this can only be caught by the checksum check —
        // distinct from the typo test above, which trips the word-count
        // check before the checksum is ever consulted.
        let phrase = recovery_phrase(&[42u8; 32]).unwrap();
        let mut words: Vec<&str> = phrase.split_whitespace().collect();
        let list = bip39::Language::English.word_list();
        let replacement = if words[0] == list[0] { list[1] } else { list[0] };
        words[0] = replacement;
        let broken = words.join(" ");
        assert_ne!(broken, phrase);
        assert!(seed_from_phrase(&broken).is_err());
    }

    #[test]
    fn a_phrase_with_a_word_not_in_the_list_is_rejected() {
        // "zzzz" is not a BIP-39 word. Keep the word count at 24 so this is
        // caught by the unknown-word check, not the word-count check.
        let phrase = recovery_phrase(&[42u8; 32]).unwrap();
        let mut words: Vec<&str> = phrase.split_whitespace().collect();
        words[0] = "zzzz";
        let broken = words.join(" ");
        assert!(seed_from_phrase(&broken).is_err());
    }
}
