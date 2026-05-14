//! Encrypted-at-rest backend using ChaCha20Poly1305 AEAD with an HKDF-derived
//! key from the machine-id. Same threat model as the parent module: protects
//! against naive backups and over-the-shoulder readers, not against root.

use std::path::Path;

use anyhow::Context as _;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::sync::config::encrypted_seed_path;
use super::{atomic_write, LoadResult, SeedBackend};

/// Encrypted file layout v1:
///
/// ```text
/// offset  bytes  meaning
/// 0       4      magic = b"LLS1"
/// 4       12     nonce (random per write)
/// 16      48     ciphertext (32-byte seed + 16-byte poly1305 tag)
/// total: 64 bytes
/// ```
const ENC_MAGIC: &[u8; 4] = b"LLS1";
const ENC_NONCE_LEN: usize = 12;
const ENC_TOTAL_LEN: usize = 64;

/// Derive the AEAD key from the machine ID using HKDF-SHA256.
fn derive_enc_key() -> anyhow::Result<[u8; 32]> {
    let machine_id = machine_uid::get()
        .map_err(|e| anyhow::anyhow!("failed to read machine-id: {e}"))?;
    let hk = Hkdf::<Sha256>::new(Some(b"ll-search-seed-v1"), machine_id.as_bytes());
    let mut prk = [0u8; 32];
    hk.expand(b"federation-signing-seed", &mut prk)
        .map_err(|_| anyhow::anyhow!("HKDF expand failed"))?;
    Ok(prk)
}

/// Read and decrypt the seed from the encrypted-at-rest file. Returns `None` if absent.
pub fn read_encrypted(config_dir: &Path) -> anyhow::Result<Option<[u8; 32]>> {
    let path = encrypted_seed_path(config_dir);
    if !path.exists() {
        return Ok(None);
    }

    let data = std::fs::read(&path)
        .with_context(|| format!("failed to read {}", path.display()))?;

    if data.len() != ENC_TOTAL_LEN {
        anyhow::bail!("encrypted seed file has unexpected length {}", data.len());
    }
    if &data[..4] != ENC_MAGIC {
        anyhow::bail!("encrypted seed file has unknown magic bytes");
    }

    let nonce_bytes = &data[4..4 + ENC_NONCE_LEN];
    let ciphertext = &data[4 + ENC_NONCE_LEN..];

    let enc_key = derive_enc_key()?;
    let cipher = ChaCha20Poly1305::new_from_slice(&enc_key)
        .map_err(|e| anyhow::anyhow!("cipher init failed: {e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| anyhow::anyhow!("encrypted seed decryption failed (corrupt file or wrong machine-id)"))?;

    let seed: [u8; 32] = plaintext
        .try_into()
        .map_err(|_| anyhow::anyhow!("decrypted seed must be exactly 32 bytes"))?;

    Ok(Some(seed))
}

/// Encrypt and write the seed to the encrypted-at-rest file (atomic tmp + rename).
pub fn write_encrypted(config_dir: &Path, seed: &[u8; 32]) -> anyhow::Result<()> {
    let path = encrypted_seed_path(config_dir);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory {}", parent.display()))?;
    }

    let enc_key = derive_enc_key()?;
    let cipher = ChaCha20Poly1305::new_from_slice(&enc_key)
        .map_err(|e| anyhow::anyhow!("cipher init failed: {e}"))?;

    let mut nonce_bytes = [0u8; ENC_NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, seed.as_ref())
        .map_err(|e| anyhow::anyhow!("encryption failed: {e}"))?;

    let mut file_data = Vec::with_capacity(ENC_TOTAL_LEN);
    file_data.extend_from_slice(ENC_MAGIC);
    file_data.extend_from_slice(&nonce_bytes);
    file_data.extend_from_slice(&ciphertext);

    debug_assert_eq!(file_data.len(), ENC_TOTAL_LEN, "encrypted file must be exactly 64 bytes");

    let tmp = path.with_extension("enc.tmp");
    atomic_write(&tmp, &path, &file_data)?;

    Ok(())
}

pub(super) fn load_or_create_seed(config_dir: &Path) -> anyhow::Result<LoadResult> {
    if let Some(seed) = read_encrypted(config_dir)? {
        return Ok(LoadResult {
            signing_key: SigningKey::from_bytes(&seed),
            backend: SeedBackend::Encrypted,
            created: false,
        });
    }
    let mut raw = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(raw.as_mut());
    write_encrypted(config_dir, &raw)?;
    super::write_seed_meta(config_dir, SeedBackend::Encrypted, false)?;
    Ok(LoadResult {
        signing_key: SigningKey::from_bytes(&raw),
        backend: SeedBackend::Encrypted,
        created: true,
    })
}

/// In-process mock store backed by the same on-disk file; only used in tests
/// via `LL_SEED_BACKEND=mock`. Skips the seed-meta sidecar write that
/// `load_or_create_seed` does.
pub(super) fn load_or_create_mock(config_dir: &Path) -> anyhow::Result<LoadResult> {
    let path = encrypted_seed_path(config_dir);
    if path.exists() {
        if let Some(seed) = read_encrypted(config_dir)? {
            return Ok(LoadResult {
                signing_key: SigningKey::from_bytes(&seed),
                backend: SeedBackend::Encrypted,
                created: false,
            });
        }
    }
    let mut raw = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(raw.as_mut());
    write_encrypted(config_dir, &raw)?;
    Ok(LoadResult {
        signing_key: SigningKey::from_bytes(&raw),
        backend: SeedBackend::Encrypted,
        created: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn encrypted_roundtrip_returns_same_seed() {
        let tmp = tempdir().unwrap();
        let seed = [42u8; 32];
        write_encrypted(tmp.path(), &seed).unwrap();
        let read = read_encrypted(tmp.path()).unwrap().unwrap();
        assert_eq!(read, seed);
    }

    #[test]
    fn encrypted_file_layout_v1_magic() {
        let tmp = tempdir().unwrap();
        write_encrypted(tmp.path(), &[7u8; 32]).unwrap();
        let data = std::fs::read(encrypted_seed_path(tmp.path())).unwrap();
        assert_eq!(data.len(), ENC_TOTAL_LEN, "total file length must be 64 bytes");
        assert_eq!(&data[..4], ENC_MAGIC, "first 4 bytes must be LLS1 magic");
    }

    #[test]
    fn encrypted_tampered_ciphertext_fails_decrypt() {
        let tmp = tempdir().unwrap();
        write_encrypted(tmp.path(), &[9u8; 32]).unwrap();
        let path = encrypted_seed_path(tmp.path());
        let mut data = std::fs::read(&path).unwrap();
        data[20] ^= 0xFF;
        std::fs::write(&path, &data).unwrap();
        assert!(read_encrypted(tmp.path()).is_err(), "tampered ciphertext must fail decryption");
    }
}
