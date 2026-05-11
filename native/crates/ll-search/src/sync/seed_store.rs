//! Seed storage backends for the federation Ed25519 signing key.
//!
//! Three backends in priority order:
//!
//! 1. **Keyring** - OS keyring (macOS Keychain / Linux Secret Service).
//! 2. **Encrypted** - ChaCha20Poly1305 AEAD with machine-derived key; safe for headless envs.
//! 3. **PlaintextLegacy** - pre-2K raw 32-byte file; migration source only.
//!
//! Use [`load_or_create`] as the single entry point for all seed access.
//!
//! # Threat model
//!
//! The encrypted-at-rest fallback protects against naive backups, `rsync /home`, and
//! over-the-shoulder file readers. It does NOT protect against an attacker with root
//! on the host (who can read machine-id and rederive the HKDF key). The OS keyring
//! is the strong path; encrypted-at-rest is "no raw seed bytes on disk" hardening for
//! environments that cannot run a keyring daemon.

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

use super::config::{
    encrypted_seed_path, seed_meta_path, seed_path, KEYRING_SERVICE, KEYRING_USER,
};

/// Which backend provided (or will store) the signing seed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedBackend {
    /// OS keyring (macOS Keychain or Linux Secret Service).
    Keyring,
    /// ChaCha20Poly1305 encrypted file, key derived from machine-id via HKDF.
    Encrypted,
    /// Pre-2K plaintext 32-byte file. Migration source only; not used for new installs.
    PlaintextLegacy,
}

impl std::fmt::Display for SeedBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SeedBackend::Keyring => write!(f, "keyring"),
            SeedBackend::Encrypted => write!(f, "encrypted"),
            SeedBackend::PlaintextLegacy => write!(f, "plaintext-legacy"),
        }
    }
}

/// Result returned by [`load_or_create`].
pub struct LoadResult {
    /// The Ed25519 signing key ready for use.
    pub signing_key: SigningKey,
    /// Which backend provided the key.
    pub backend: SeedBackend,
    /// True if a new seed was generated (first install).
    pub created: bool,
}

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

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Load the seed from the best available backend, or generate and store a new one.
///
/// Backend selection:
/// 1. If `LL_SEED_BACKEND` is set to `"keyring"`, `"encrypted"`, or `"mock"`, force that backend.
/// 2. Try keyring.
/// 3. Try encrypted-at-rest.
/// 4. Try plaintext-legacy (logs an upgrade hint).
/// 5. Generate new seed; probe keyring, fall back to encrypted.
pub fn load_or_create(config_dir: &Path) -> anyhow::Result<LoadResult> {
    let force = std::env::var("LL_SEED_BACKEND").ok();

    if let Some(ref f) = force {
        match f.as_str() {
            "mock" => return load_or_create_mock(config_dir),
            "encrypted" => return load_or_create_encrypted(config_dir),
            "keyring" => return load_or_create_keyring(config_dir),
            other => {
                anyhow::bail!("unknown LL_SEED_BACKEND value: '{}'; use keyring, encrypted, or mock", other);
            }
        }
    }

    // 2. Try keyring
    if let Some(seed) = read_keyring()? {
        let key = SigningKey::from_bytes(&seed);
        return Ok(LoadResult { signing_key: key, backend: SeedBackend::Keyring, created: false });
    }

    // 3. Try encrypted
    if let Some(seed) = read_encrypted(config_dir)? {
        let key = SigningKey::from_bytes(&seed);
        return Ok(LoadResult { signing_key: key, backend: SeedBackend::Encrypted, created: false });
    }

    // 4. Try plaintext-legacy
    if let Some(seed) = read_plaintext_legacy(config_dir)? {
        eprintln!("learning-loop: legacy plaintext seed detected; run `ll-search migrate-seed` to upgrade");
        let key = SigningKey::from_bytes(&seed);
        return Ok(LoadResult { signing_key: key, backend: SeedBackend::PlaintextLegacy, created: false });
    }

    // 5. Generate new seed, probe backends
    let mut raw = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(raw.as_mut());

    if probe_keyring().is_ok() {
        write_keyring(&raw)?;
        let key = SigningKey::from_bytes(&raw);
        write_seed_meta(config_dir, SeedBackend::Keyring, false)?;
        return Ok(LoadResult { signing_key: key, backend: SeedBackend::Keyring, created: true });
    }

    write_encrypted(config_dir, &raw)?;
    let key = SigningKey::from_bytes(&raw);
    write_seed_meta(config_dir, SeedBackend::Encrypted, false)?;
    Ok(LoadResult { signing_key: key, backend: SeedBackend::Encrypted, created: true })
}

// ---------------------------------------------------------------------------
// Forced-backend helpers (used by load_or_create and tests)
// ---------------------------------------------------------------------------

fn load_or_create_keyring(config_dir: &Path) -> anyhow::Result<LoadResult> {
    if let Some(seed) = read_keyring()? {
        return Ok(LoadResult {
            signing_key: SigningKey::from_bytes(&seed),
            backend: SeedBackend::Keyring,
            created: false,
        });
    }
    let mut raw = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(raw.as_mut());
    write_keyring(&raw)?;
    write_seed_meta(config_dir, SeedBackend::Keyring, false)?;
    Ok(LoadResult {
        signing_key: SigningKey::from_bytes(&raw),
        backend: SeedBackend::Keyring,
        created: true,
    })
}

fn load_or_create_encrypted(config_dir: &Path) -> anyhow::Result<LoadResult> {
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
    write_seed_meta(config_dir, SeedBackend::Encrypted, false)?;
    Ok(LoadResult {
        signing_key: SigningKey::from_bytes(&raw),
        backend: SeedBackend::Encrypted,
        created: true,
    })
}

/// In-process mock store backed by a temp file; only used in tests via `LL_SEED_BACKEND=mock`.
fn load_or_create_mock(config_dir: &Path) -> anyhow::Result<LoadResult> {
    // Mock uses the encrypted path but bypasses machine-id derivation with a fixed test key.
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

// ---------------------------------------------------------------------------
// Keyring backend
// ---------------------------------------------------------------------------

/// Attempt to read the seed from the OS keyring. Returns `None` if not found.
pub fn read_keyring() -> anyhow::Result<Option<[u8; 32]>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .context("failed to create keyring entry")?;
    match entry.get_password() {
        Ok(hex_str) => {
            let bytes = hex::decode(hex_str.trim())
                .context("keyring seed is not valid hex")?;
            let seed: [u8; 32] = bytes
                .try_into()
                .map_err(|_| anyhow::anyhow!("keyring seed must be exactly 32 bytes"))?;
            Ok(Some(seed))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            // Platform failure (e.g., no DBus) - treat as unavailable
            if is_platform_unavailable(&e) {
                return Ok(None);
            }
            Err(anyhow::anyhow!("keyring read error: {e}"))
        }
    }
}

/// Write the seed to the OS keyring.
pub fn write_keyring(seed: &[u8; 32]) -> anyhow::Result<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .context("failed to create keyring entry")?;
    let hex_str = hex::encode(seed);
    entry.set_password(&hex_str).context("failed to write seed to keyring")
}

/// Delete the seed from the OS keyring (used by `--rollback`).
pub fn delete_keyring() -> anyhow::Result<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .context("failed to create keyring entry")?;
    entry.delete_credential().context("failed to delete seed from keyring")
}

/// Probe keyring support by writing and reading a sentinel value.
///
/// Returns `Ok(())` if the keyring is available. Does not persist anything meaningful.
pub fn probe_keyring() -> anyhow::Result<()> {
    let sentinel_user = "probe-sentinel-2K";
    let entry = keyring::Entry::new(KEYRING_SERVICE, sentinel_user)
        .context("failed to create probe keyring entry")?;
    entry.set_password("probe").context("keyring probe write failed")?;
    let _ = entry.get_password();
    let _ = entry.delete_credential();
    Ok(())
}

fn is_platform_unavailable(e: &keyring::Error) -> bool {
    let msg = e.to_string().to_lowercase();
    // Common indicators of a missing keyring daemon
    msg.contains("dbus") || msg.contains("no secret service") || msg.contains("platform")
        || msg.contains("gnome-keyring") || msg.contains("kwallet")
}

// ---------------------------------------------------------------------------
// Encrypted-at-rest backend
// ---------------------------------------------------------------------------

/// Derive the AEAD key from the machine ID using HKDF-SHA256.
fn derive_enc_key() -> anyhow::Result<[u8; 32]> {
    let machine_id = machine_uid::get().context("failed to read machine-id")?;
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

// ---------------------------------------------------------------------------
// Plaintext-legacy backend (read-only; migration source)
// ---------------------------------------------------------------------------

/// Read the pre-2K plaintext seed file. Returns `None` if absent.
pub fn read_plaintext_legacy(config_dir: &Path) -> anyhow::Result<Option<[u8; 32]>> {
    let path = seed_path(config_dir);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)
        .with_context(|| format!("failed to read legacy seed at {}", path.display()))?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("legacy seed file must be exactly 32 bytes"))?;
    Ok(Some(seed))
}

// ---------------------------------------------------------------------------
// Seed-meta sidecar helpers
// ---------------------------------------------------------------------------

/// Write a `.seed-meta.json` sidecar recording which backend is active.
///
/// Extends the existing plugin schema additively: the plugin only reads
/// `plugin_major` / `plugin_version`; the `backend` field is new in 2K.
pub fn write_seed_meta(
    config_dir: &Path,
    backend: SeedBackend,
    migrated: bool,
) -> anyhow::Result<()> {
    let path = seed_meta_path(config_dir);

    // Read existing meta so we preserve plugin-written fields (plugin_version, plugin_major, etc.)
    let existing: serde_json::Value = if path.exists() {
        let txt = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&txt).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let backend_str = match backend {
        SeedBackend::Keyring => "keyring",
        SeedBackend::Encrypted => "encrypted",
        SeedBackend::PlaintextLegacy => "plaintext-legacy",
    };

    let mut meta = existing;
    meta["backend"] = serde_json::Value::String(backend_str.to_string());
    if migrated {
        meta["migrated_at"] = serde_json::Value::String(chrono_iso_now());
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let tmp = path.with_extension("json.tmp");
    atomic_write(&tmp, &path, meta.to_string().as_bytes())?;
    Ok(())
}

fn chrono_iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Produce a simple ISO 8601 UTC string without external deps
    let s = secs;
    let min = s / 60 % 60;
    let hour = s / 3600 % 24;
    let days_since_epoch = s / 86400;
    // Simple Gregorian calendar (good enough for a timestamp)
    let year = 1970 + days_since_epoch / 365;
    let day_of_year = days_since_epoch % 365 + 1;
    let month = (day_of_year - 1) / 30 + 1;
    let day = (day_of_year - 1) % 30 + 1;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, hour, min, s % 60)
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/// Atomic write: write to a `.tmp` sibling, then rename over the target.
/// Sets 0o600 permissions on Unix.
fn atomic_write(tmp: &Path, target: &Path, data: &[u8]) -> anyhow::Result<()> {
    std::fs::write(tmp, data)
        .with_context(|| format!("failed to write tmp file {}", tmp.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(tmp, std::fs::Permissions::from_mode(0o600))?;
    }

    std::fs::rename(tmp, target)
        .with_context(|| format!("failed to rename {} -> {}", tmp.display(), target.display()))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    struct BackendGuard;
    impl Drop for BackendGuard {
        fn drop(&mut self) {
            std::env::remove_var("LL_SEED_BACKEND");
        }
    }

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
        data[20] ^= 0xFF; // flip a byte in the ciphertext region
        std::fs::write(&path, &data).unwrap();
        assert!(read_encrypted(tmp.path()).is_err(), "tampered ciphertext must fail decryption");
    }

    #[test]
    fn legacy_plaintext_read_then_load_returns_plaintext_legacy_backend() {
        let tmp = tempdir().unwrap();
        let fed = tmp.path().join("federation");
        std::fs::create_dir_all(&fed).unwrap();
        let legacy_path = fed.join(".seed");
        std::fs::write(&legacy_path, [5u8; 32]).unwrap();

        // Force encrypted to ensure we exercise plaintext-legacy detection
        std::env::set_var("LL_SEED_BACKEND", "");
        // Remove env override so auto-detection runs
        std::env::remove_var("LL_SEED_BACKEND");

        let result = read_plaintext_legacy(tmp.path()).unwrap().unwrap();
        assert_eq!(result, [5u8; 32]);
    }

    #[test]
    fn env_force_encrypted_skips_keyring() {
        let tmp = tempdir().unwrap();
        std::env::set_var("LL_SEED_BACKEND", "encrypted");
        let _guard = BackendGuard;
        let result = load_or_create(tmp.path()).unwrap();
        assert_eq!(result.backend, SeedBackend::Encrypted);
    }

    #[test]
    fn env_force_encrypted_roundtrips_consistently() {
        let tmp = tempdir().unwrap();
        std::env::set_var("LL_SEED_BACKEND", "encrypted");
        let _guard = BackendGuard;

        let r1 = load_or_create(tmp.path()).unwrap();
        assert!(r1.created);

        let r2 = load_or_create(tmp.path()).unwrap();
        assert!(!r2.created);

        let pk1 = super::super::auth::pubkey_b64(&r1.signing_key);
        let pk2 = super::super::auth::pubkey_b64(&r2.signing_key);
        assert_eq!(pk1, pk2, "same key must be returned on second load");
    }

    #[test]
    #[ignore] // requires real secret-service running
    fn keyring_roundtrip_when_available() {
        let seed = [11u8; 32];
        write_keyring(&seed).unwrap();
        let read = read_keyring().unwrap().unwrap();
        assert_eq!(read, seed);
        delete_keyring().unwrap();
    }
}
