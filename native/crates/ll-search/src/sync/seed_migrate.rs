//! One-shot idempotent migration of the plaintext federation seed to a secure backend.
//!
//! # Fail-closed guarantee
//!
//! The plaintext `.seed` file is deleted **only after**:
//! 1. The new copy has been written to the target backend.
//! 2. The written copy has been read back and verified byte-for-byte.
//! 3. The `.seed-meta.json` sidecar has been updated.
//!
//! Any failure before step 3 leaves the plaintext file intact.
//!
//! # Rollback
//!
//! Pass `rollback: true` to reverse a completed migration - reads the seed back
//! from keyring/encrypted, writes it to the legacy plaintext path, then deletes
//! the secure-backend copy. This preserves the signing key bytes so federation
//! peers continue to trust the identity.

use std::path::Path;
use anyhow::Context as _;

use super::config::{encrypted_seed_path, seed_meta_path, seed_path};
use super::seed_store::{
    delete_keyring, read_encrypted, read_keyring, read_plaintext_legacy, write_encrypted,
    write_keyring, write_seed_meta, SeedBackend,
};

/// Result of a [`migrate`] call.
pub struct MigrateResult {
    /// The backend the seed was migrated from.
    pub from: SeedBackend,
    /// The backend the seed was migrated to.
    pub to: SeedBackend,
    /// True if the plaintext file was removed.
    pub plaintext_removed: bool,
    /// True if migration was a no-op (already up to date).
    pub already_migrated: bool,
}

/// Migrate the federation signing seed from plaintext-legacy to the best available backend.
///
/// Idempotent: returns `already_migrated: true` if no plaintext seed exists and the current
/// backend is already keyring or encrypted.
pub fn migrate(config_dir: &Path) -> anyhow::Result<MigrateResult> {
    let plaintext = seed_path(config_dir);
    let meta_path = seed_meta_path(config_dir);

    // Check if already migrated
    if !plaintext.exists() {
        let meta_backend = read_meta_backend(&meta_path);
        if meta_backend != Some("plaintext-legacy".to_string()) {
            return Ok(MigrateResult {
                from: SeedBackend::PlaintextLegacy,
                to: SeedBackend::PlaintextLegacy,
                plaintext_removed: false,
                already_migrated: true,
            });
        }
        // Meta says plaintext-legacy but file is gone - inconsistent state
        anyhow::bail!("migration state inconsistent: .seed-meta.json records plaintext-legacy but no .seed file exists");
    }

    // Read the plaintext seed
    let seed = read_plaintext_legacy(config_dir)?
        .ok_or_else(|| anyhow::anyhow!("expected plaintext seed at {} but file is absent", plaintext.display()))?;

    // Determine target backend via env override or probe
    let force = std::env::var("LL_SEED_BACKEND").ok();
    let (target_backend, write_result) = if force.as_deref() == Some("encrypted") {
        let res = write_to_encrypted(config_dir, &seed);
        (SeedBackend::Encrypted, res)
    } else {
        // Try keyring first
        match write_to_keyring(&seed) {
            Ok(()) => (SeedBackend::Keyring, Ok(())),
            Err(_) => {
                let res = write_to_encrypted(config_dir, &seed);
                (SeedBackend::Encrypted, res)
            }
        }
    };

    // Propagate any write error - plaintext survives
    write_result.context("failed to write seed to new backend; plaintext seed preserved")?;

    // Round-trip verification
    verify_roundtrip(config_dir, &seed, target_backend)
        .context("round-trip verification failed; plaintext seed preserved")?;

    // Update meta file (must succeed before we delete plaintext)
    write_seed_meta(config_dir, target_backend, true)
        .context("failed to update seed-meta; plaintext seed preserved")?;

    // ONLY NOW: delete the plaintext seed
    std::fs::remove_file(&plaintext)
        .with_context(|| format!("failed to remove plaintext seed at {}", plaintext.display()))?;

    // Fsync parent directory on Unix for durability
    #[cfg(unix)]
    {
        if let Some(parent) = plaintext.parent() {
            if let Ok(dir) = std::fs::File::open(parent) {
                let _ = dir.sync_all();
            }
        }
    }

    Ok(MigrateResult {
        from: SeedBackend::PlaintextLegacy,
        to: target_backend,
        plaintext_removed: true,
        already_migrated: false,
    })
}

/// Reverse a completed migration: read seed from secure backend, write to plaintext, remove secure copy.
///
/// Fails closed: plaintext is written only if the secure-backend read succeeds.
/// This restores the ability to use pre-2K code with the same signing key.
pub fn migrate_rollback(config_dir: &Path) -> anyhow::Result<MigrateResult> {
    let plaintext = seed_path(config_dir);

    if plaintext.exists() {
        anyhow::bail!("plaintext seed already exists; rollback not needed");
    }

    // Try keyring first, then encrypted
    let (seed, from_backend) = if let Some(s) = read_keyring()? {
        (s, SeedBackend::Keyring)
    } else if let Some(s) = read_encrypted(config_dir)? {
        (s, SeedBackend::Encrypted)
    } else {
        anyhow::bail!("no seed found in keyring or encrypted store; cannot roll back");
    };

    // Write plaintext (atomic)
    if let Some(parent) = plaintext.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = plaintext.with_extension("seed.tmp");
    std::fs::write(&tmp, seed)
        .context("failed to write plaintext seed during rollback")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, &plaintext)
        .context("failed to rename plaintext seed during rollback")?;

    // Update meta
    write_seed_meta(config_dir, SeedBackend::PlaintextLegacy, false)?;

    // Remove the secure-backend copy
    match from_backend {
        SeedBackend::Keyring => {
            let _ = delete_keyring();
        }
        SeedBackend::Encrypted => {
            let enc = encrypted_seed_path(config_dir);
            if enc.exists() {
                std::fs::remove_file(&enc)
                    .context("failed to remove encrypted seed during rollback")?;
            }
        }
        SeedBackend::PlaintextLegacy => {}
    }

    Ok(MigrateResult {
        from: from_backend,
        to: SeedBackend::PlaintextLegacy,
        plaintext_removed: false,
        already_migrated: false,
    })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn write_to_keyring(seed: &[u8; 32]) -> anyhow::Result<()> {
    write_keyring(seed)
}

fn write_to_encrypted(config_dir: &Path, seed: &[u8; 32]) -> anyhow::Result<()> {
    write_encrypted(config_dir, seed)
}

fn verify_roundtrip(config_dir: &Path, original: &[u8; 32], backend: SeedBackend) -> anyhow::Result<()> {
    let read_back = match backend {
        SeedBackend::Keyring => read_keyring()?
            .ok_or_else(|| anyhow::anyhow!("keyring read-back returned None"))?,
        SeedBackend::Encrypted => read_encrypted(config_dir)?
            .ok_or_else(|| anyhow::anyhow!("encrypted read-back returned None"))?,
        SeedBackend::PlaintextLegacy => {
            anyhow::bail!("cannot verify roundtrip for plaintext-legacy backend");
        }
    };
    if read_back != *original {
        anyhow::bail!("round-trip verification failed: stored bytes differ from original");
    }
    Ok(())
}

fn read_meta_backend(meta_path: &Path) -> Option<String> {
    if !meta_path.exists() {
        return None;
    }
    let txt = std::fs::read_to_string(meta_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    v["backend"].as_str().map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;
    use tempfile::tempdir;

    // Pin LL_SEED_BACKEND=encrypted for the entire test binary. Earlier per-test
    // `set_var` + Drop-guard `remove_var` raced under parallel test threads:
    // thread A's guard could unset the var mid-call while thread B's `migrate`
    // had already passed the env-check at the top of `migrate()` but still had
    // to write the seed. With the var unset, B's `write_to_keyring(&seed)` ran
    // against the globally-namespaced `ai.learning-loop.federation`
    // `signing-seed-v1` keyring entry, stomping the developer's real federation
    // seed. See `0-inbox/global-namespaced-system-stores-need-test-backend-override.md`.
    static INIT: Once = Once::new();
    fn init_test_backend() {
        INIT.call_once(|| {
            std::env::set_var("LL_SEED_BACKEND", "encrypted");
        });
    }

    fn write_plaintext_seed(config_dir: &Path, seed: [u8; 32]) {
        let fed = config_dir.join("federation");
        std::fs::create_dir_all(&fed).unwrap();
        std::fs::write(fed.join(".seed"), seed).unwrap();
    }

    #[test]
    fn migration_legacy_to_encrypted_removes_plaintext() {
        init_test_backend();
        let tmp = tempdir().unwrap();
        write_plaintext_seed(tmp.path(), [3u8; 32]);
        let result = migrate(tmp.path()).unwrap();

        assert!(!result.already_migrated);
        assert!(result.plaintext_removed);
        assert_eq!(result.to, SeedBackend::Encrypted);

        let plaintext = seed_path(tmp.path());
        assert!(!plaintext.exists(), "plaintext must be gone after migration");

        let enc = encrypted_seed_path(tmp.path());
        assert!(enc.exists(), "encrypted file must exist after migration");
    }

    #[test]
    fn migration_idempotent_second_run_no_op() {
        init_test_backend();
        let tmp = tempdir().unwrap();
        write_plaintext_seed(tmp.path(), [4u8; 32]);

        let r1 = migrate(tmp.path()).unwrap();
        assert!(!r1.already_migrated);

        let r2 = migrate(tmp.path()).unwrap();
        assert!(r2.already_migrated, "second run must be a no-op");
    }

    #[test]
    fn migration_meta_file_records_backend_and_timestamp() {
        init_test_backend();
        let tmp = tempdir().unwrap();
        write_plaintext_seed(tmp.path(), [6u8; 32]);
        migrate(tmp.path()).unwrap();

        let meta_path = seed_meta_path(tmp.path());
        assert!(meta_path.exists());
        let txt = std::fs::read_to_string(&meta_path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&txt).unwrap();
        assert_eq!(v["backend"].as_str(), Some("encrypted"));
        assert!(v["migrated_at"].as_str().is_some(), "migrated_at must be present");
    }

    #[test]
    fn migration_signing_key_unchanged_across_migration() {
        init_test_backend();
        let tmp = tempdir().unwrap();
        let original_seed = [5u8; 32];
        write_plaintext_seed(tmp.path(), original_seed);

        use ed25519_dalek::{Signer, SigningKey};
        let original_key = SigningKey::from_bytes(&original_seed);
        let message = b"test message for 2K migration";
        let original_sig = original_key.sign(message);

        migrate(tmp.path()).unwrap();

        let result = super::super::seed_store::load_or_create(tmp.path()).unwrap();

        let migrated_sig = result.signing_key.sign(message);
        assert_eq!(original_sig.to_bytes(), migrated_sig.to_bytes(),
            "signing key must produce identical signatures before and after migration");
    }

    #[test]
    fn migration_rollback_restores_plaintext() {
        init_test_backend();
        let tmp = tempdir().unwrap();
        write_plaintext_seed(tmp.path(), [8u8; 32]);
        migrate(tmp.path()).unwrap();

        assert!(!seed_path(tmp.path()).exists());

        migrate_rollback(tmp.path()).unwrap();

        assert!(seed_path(tmp.path()).exists(), "plaintext must be restored after rollback");
        let bytes = std::fs::read(seed_path(tmp.path())).unwrap();
        assert_eq!(bytes, [8u8; 32]);
    }

    // NOTE: `migration_legacy_to_keyring_when_available` removed. Earlier
    // version unset LL_SEED_BACKEND and called `migrate(tmp.path())`, which
    // writes to the globally-namespaced production keyring service+account.
    // `#[ignore]` is insufficient protection — `cargo test --ignored` or
    // `cargo test migration_legacy_to_keyring` would silently overwrite the
    // developer's real federation seed. Restoring this test safely requires
    // namespacing `KEYRING_SERVICE` by `config_dir`, which is a separate
    // change.
}
