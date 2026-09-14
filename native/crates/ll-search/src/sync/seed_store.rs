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

use ed25519_dalek::SigningKey;
use rand::RngCore;
use zeroize::Zeroizing;

use super::config::seed_meta_path;

mod encrypted;
mod keyring;
mod plaintext;

pub use encrypted::{read_encrypted, write_encrypted};
pub use keyring::{delete_keyring, probe_keyring, read_keyring, write_keyring};
pub use plaintext::read_plaintext_legacy;

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

/// Load the seed from any available backend without creating one.
///
/// Returns `Ok(Some(...))` if a seed exists; `Ok(None)` if not. Callers that
/// run during routine operation (sync, watch) MUST use this rather than
/// [`load_or_create`] — silently minting a fresh identity on a missing seed
/// breaks trust with every peer that has the previous pubkey allowlisted.
///
/// Honours `LL_SEED_BACKEND` the same way `load_or_create` does, but never
/// generates a new seed or writes to any backend.
pub fn load_only(config_dir: &Path) -> anyhow::Result<Option<LoadResult>> {
    let force = std::env::var("LL_SEED_BACKEND").ok();

    if let Some(ref f) = force {
        match f.as_str() {
            "" => {}
            "mock" | "encrypted" => {
                if let Some(seed) = read_encrypted(config_dir)? {
                    return Ok(Some(LoadResult {
                        signing_key: SigningKey::from_bytes(&seed),
                        backend: SeedBackend::Encrypted,
                        created: false,
                    }));
                }
                return Ok(None);
            }
            "keyring" => {
                if let Some(seed) = read_keyring(config_dir)? {
                    return Ok(Some(LoadResult {
                        signing_key: SigningKey::from_bytes(&seed),
                        backend: SeedBackend::Keyring,
                        created: false,
                    }));
                }
                return Ok(None);
            }
            other => {
                anyhow::bail!("unknown LL_SEED_BACKEND value: '{}'; use keyring, encrypted, or mock", other);
            }
        }
    }

    if let Some(seed) = read_keyring(config_dir)? {
        return Ok(Some(LoadResult {
            signing_key: SigningKey::from_bytes(&seed),
            backend: SeedBackend::Keyring,
            created: false,
        }));
    }
    if let Some(seed) = read_encrypted(config_dir)? {
        return Ok(Some(LoadResult {
            signing_key: SigningKey::from_bytes(&seed),
            backend: SeedBackend::Encrypted,
            created: false,
        }));
    }
    if let Some(seed) = read_plaintext_legacy(config_dir)? {
        eprintln!("learning-loop: legacy plaintext seed detected; run `ll-search migrate-seed` to upgrade");
        return Ok(Some(LoadResult {
            signing_key: SigningKey::from_bytes(&seed),
            backend: SeedBackend::PlaintextLegacy,
            created: false,
        }));
    }
    Ok(None)
}

/// Load the seed from the best available backend, or generate and store a new one.
///
/// **Only call this from intentional identity-creation paths** — the federation
/// setup skill, the `ll-search identity` command, the `migrate-seed` command.
/// Routine operations (sync, watch) must use [`load_only`] instead.
///
/// Backend selection:
/// 1. If `LL_SEED_BACKEND` is set to `"keyring"`, `"encrypted"`, or `"mock"`, force that backend.
/// 2. Try keyring.
/// 3. Try encrypted-at-rest.
/// 4. Try plaintext-legacy (logs an upgrade hint).
/// 5. Generate new seed; probe keyring, fall back to encrypted.
pub fn load_or_create(config_dir: &Path) -> anyhow::Result<LoadResult> {
    let force = std::env::var("LL_SEED_BACKEND").ok();

    if let Some(result) = auto_migrate_plaintext(config_dir)? {
        return Ok(result);
    }

    refuse_second_identity(config_dir)?;

    if let Some(ref f) = force {
        match f.as_str() {
            "" => {}
            "mock" => return encrypted::load_or_create_mock(config_dir),
            "encrypted" => return encrypted::load_or_create_seed(config_dir),
            "keyring" => return keyring::load_or_create_seed(config_dir),
            other => {
                anyhow::bail!("unknown LL_SEED_BACKEND value: '{}'; use keyring, encrypted, or mock", other);
            }
        }
    }

    if let Some(seed) = read_keyring(config_dir)? {
        let key = SigningKey::from_bytes(&seed);
        return Ok(LoadResult { signing_key: key, backend: SeedBackend::Keyring, created: false });
    }
    if let Some(seed) = read_encrypted(config_dir)? {
        let key = SigningKey::from_bytes(&seed);
        return Ok(LoadResult { signing_key: key, backend: SeedBackend::Encrypted, created: false });
    }

    let mut raw = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(raw.as_mut());

    if probe_keyring().is_ok() {
        write_keyring(config_dir, &raw)?;
        let key = SigningKey::from_bytes(&raw);
        write_seed_meta(config_dir, SeedBackend::Keyring, false)?;
        return Ok(LoadResult { signing_key: key, backend: SeedBackend::Keyring, created: true });
    }

    write_encrypted(config_dir, &raw)?;
    let key = SigningKey::from_bytes(&raw);
    write_seed_meta(config_dir, SeedBackend::Encrypted, false)?;
    Ok(LoadResult { signing_key: key, backend: SeedBackend::Encrypted, created: true })
}

/// Store `seed` as this config dir's signing seed, replacing whatever is
/// already there, and report which backend now holds it.
///
/// The backend is the one [`load_only`] already reads, when a seed is there to
/// read. That is not a preference — it is the whole postcondition. `load_only`
/// tries keyring, then encrypted, then plaintext, so writing into a *later*
/// backend than the one currently answering leaves the old seed loading and
/// the caller believing it replaced an identity it did not.
///
/// Two cases have no such backend to match, and both take the same selection
/// [`load_or_create`] uses for a brand new seed:
///
/// - Nothing is stored, so there is nothing to shadow.
/// - A plaintext-legacy seed is answering. Plaintext is a migration source and
///   never a write target; both other backends outrank it in the read order,
///   so either choice wins. **The legacy file is left where it is** — shredding
///   it belongs to `seed_migrate`, which verifies before it destroys — so a
///   caller replacing an identity here leaves the previous seed readable on
///   disk until that migration runs.
pub fn store_seed(config_dir: &Path, seed: &[u8; 32]) -> anyhow::Result<SeedBackend> {
    let backend = match load_only(config_dir)?.map(|r| r.backend) {
        Some(b @ (SeedBackend::Keyring | SeedBackend::Encrypted)) => b,
        Some(SeedBackend::PlaintextLegacy) | None => {
            match std::env::var("LL_SEED_BACKEND").ok().as_deref() {
                Some("keyring") => SeedBackend::Keyring,
                Some("mock" | "encrypted") => SeedBackend::Encrypted,
                None | Some("") => {
                    if probe_keyring().is_ok() {
                        SeedBackend::Keyring
                    } else {
                        SeedBackend::Encrypted
                    }
                }
                Some(other) => anyhow::bail!(
                    "unknown LL_SEED_BACKEND value: '{}'; use keyring, encrypted, or mock",
                    other
                ),
            }
        }
    };

    match backend {
        SeedBackend::Keyring => write_keyring(config_dir, seed)?,
        _ => write_encrypted(config_dir, seed)?,
    }
    write_seed_meta(config_dir, backend, false)?;
    Ok(backend)
}

/// Write a `.seed-meta.json` sidecar recording which backend is active.
///
/// Extends the existing plugin schema additively: the plugin only reads
/// `plugin_major` / `plugin_version`; the `backend` field is new in 2K.
/// Refuse to mint when this machine has already recorded an identity.
///
/// "Nothing is there" and "I cannot see what is there" are different states,
/// and only the first may mint. Every backend read maps a store it cannot
/// reach to `Ok(None)` — `read_keyring` does it explicitly for an unavailable
/// Secret Service (no dbus, no gnome-keyring, no kwallet) — which is right for
/// a machine that has no keyring and wrong for one whose keyring is down. The
/// fall-through then MINTS A SECOND IDENTITY, and everything after that looks
/// like it worked: `ll link code` prints a pairing code for the new key, the
/// peer grants to it, the store recovers, every `load_only` path prefers the
/// original, and the link is dead with no error anywhere.
///
/// `.seed-meta.json` is this machine's own record that a seed was created. It
/// is written for every backend at creation and at migration, so if it names
/// one and `load_only` comes back empty, that is a failure to report rather
/// than a machine to re-enrol.
///
/// One call site, before the backend dispatch, rather than one beside each
/// mint. Guarding each mint left the keyring branch uncovered — the test
/// binary pins `LL_SEED_BACKEND=encrypted` globally (a per-test override
/// races, and the production keyring entry is globally namespaced), so a
/// mutation deleting that branch's guard reddened nothing.
pub(super) fn refuse_second_identity(config_dir: &Path) -> anyhow::Result<()> {
    let Some(recorded) = recorded_backend(config_dir) else { return Ok(()) };
    if load_only(config_dir)?.is_some() {
        return Ok(());
    }
    anyhow::bail!(
        "this machine's identity is recorded in the {recorded} store and that store did \
         not return it. Refusing to create a second identity: the new key would look like \
         a working enrolment while every grant naming the old one stayed signed and \
         unreachable. Restore access to the {recorded} store and retry — on Linux this is \
         usually an unavailable Secret Service (dbus, gnome-keyring, kwallet). If the \
         identity is genuinely gone, `ll-search recover` restores it from the 24 words."
    )
}

/// The backend `.seed-meta.json` records, if it records one.
///
/// It is written every time a seed is created or migrated, so its presence is
/// this machine's own statement that an identity EXISTS — which is a different
/// question from whether the store holding it can be read right now.
pub fn recorded_backend(config_dir: &Path) -> Option<String> {
    let txt = std::fs::read_to_string(seed_meta_path(config_dir)).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&txt).ok()?;
    doc.get("backend")?.as_str().map(str::to_string)
}

pub fn write_seed_meta(
    config_dir: &Path,
    backend: SeedBackend,
    migrated: bool,
) -> anyhow::Result<()> {
    let path = seed_meta_path(config_dir);

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
        meta["migrated_at"] = serde_json::Value::String(crate::db::chrono_iso_now());
    }

    crate::sync::atomic_file::write_private_bytes(&path, meta.to_string().as_bytes())
}

/// Auto-migrate a legacy plaintext seed off cleartext disk before any other
/// backend selection. Reuses [`super::seed_migrate::migrate`]'s fail-closed
/// migrate-verify-shred logic; the migration target backend is chosen there
/// (keyring first, encrypted fallback, or forced by `LL_SEED_BACKEND`).
///
/// Returns `Ok(Some(..))` when a plaintext seed was found and handled — either
/// migrated to a strong backend, or (if no strong backend is available) left in
/// place with a warning and its mode repaired to 0600. Returns `Ok(None)` when
/// no plaintext seed exists.
fn auto_migrate_plaintext(config_dir: &Path) -> anyhow::Result<Option<LoadResult>> {
    let Some(seed) = read_plaintext_legacy(config_dir)? else {
        return Ok(None);
    };
    match super::seed_migrate::migrate(config_dir) {
        Ok(res) => {
            eprintln!("learning-loop: auto-migrated legacy plaintext seed to {} backend", res.to);
            Ok(Some(LoadResult {
                signing_key: SigningKey::from_bytes(&seed),
                backend: res.to,
                created: false,
            }))
        }
        Err(e) => {
            eprintln!("learning-loop: legacy plaintext seed detected but auto-migration failed ({e}); run `ll-search migrate-seed` to upgrade");
            repair_plaintext_mode(config_dir);
            Ok(Some(LoadResult {
                signing_key: SigningKey::from_bytes(&seed),
                backend: SeedBackend::PlaintextLegacy,
                created: false,
            }))
        }
    }
}

/// Ensure the legacy plaintext seed file is at least 0600 when no strong
/// backend is available to migrate it to. Best-effort; never fails the load.
fn repair_plaintext_mode(config_dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = super::config::seed_path(config_dir);
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.permissions().mode() & 0o777 != 0o600 {
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = config_dir;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;
    use tempfile::tempdir;

    // Pin LL_SEED_BACKEND=encrypted for the entire test binary. Earlier per-test
    // `set_var` + Drop-guard `remove_var` raced under parallel test threads:
    // a guard's `remove_var` could land mid-`load_or_create` on another thread,
    // sending it to the keyring branch and stomping the globally-namespaced
    // production keyring entry. See
    // `0-inbox/global-namespaced-system-stores-need-test-backend-override.md`.
    static INIT: Once = Once::new();
    fn init_test_backend() {
        INIT.call_once(|| {
            std::env::set_var("LL_SEED_BACKEND", "encrypted");
        });
    }

    #[test]
    fn env_force_encrypted_skips_keyring() {
        init_test_backend();
        let tmp = tempdir().unwrap();
        let result = load_or_create(tmp.path()).unwrap();
        assert_eq!(result.backend, SeedBackend::Encrypted);
    }

    /// A store that cannot return a seed it is recorded as holding must not
    /// be treated as a machine that has none.
    ///
    /// The scenario, reachable without a keyring: the seed file is gone and
    /// `.seed-meta.json` still names its backend — a half-restored backup, or
    /// a keyring reset. Every backend read maps an unreachable store to
    /// `Ok(None)`, so without this the next call mints a second identity and
    /// reports success.
    #[test]
    fn a_recorded_identity_that_cannot_be_read_is_an_error_not_a_new_one() {
        init_test_backend();
        let tmp = tempdir().unwrap();
        let first = load_or_create(tmp.path()).unwrap();
        assert!(first.created, "precondition: an identity exists and was recorded");
        assert!(recorded_backend(tmp.path()).is_some(), "precondition: the record is on disk");
        std::fs::remove_file(super::super::config::encrypted_seed_path(tmp.path())).unwrap();

        // Matched rather than `unwrap_err`: `LoadResult` has no `Debug`, and it
        // holds a signing key, so it should not grow one for a test's sake.
        let err = match load_or_create(tmp.path()) {
            Ok(_) => panic!("minted a second identity over a recorded one"),
            Err(e) => e.to_string(),
        };

        assert!(err.contains("Refusing to create a second identity"), "got: {err}");
        assert!(err.contains("recover"), "and names the way back: {err}");
    }

    /// The other side. A machine that has genuinely never had an identity has
    /// no record either, and must still be able to make one — Door 3 links a
    /// brand-new offline machine, which cannot run `join` to get one.
    #[test]
    fn a_machine_with_no_record_at_all_still_mints_its_first_identity() {
        init_test_backend();
        let tmp = tempdir().unwrap();
        assert!(recorded_backend(tmp.path()).is_none(), "precondition: nothing recorded");

        let result = load_or_create(tmp.path()).unwrap();

        assert!(result.created, "a first identity is not a second one");
    }

    #[test]
    fn env_force_encrypted_roundtrips_consistently() {
        init_test_backend();
        let tmp = tempdir().unwrap();

        let r1 = load_or_create(tmp.path()).unwrap();
        assert!(r1.created);

        let r2 = load_or_create(tmp.path()).unwrap();
        assert!(!r2.created);

        let pk1 = super::super::auth::pubkey_b64(&r1.signing_key);
        let pk2 = super::super::auth::pubkey_b64(&r2.signing_key);
        assert_eq!(pk1, pk2, "same key must be returned on second load");
    }

    #[test]
    fn load_or_create_auto_migrates_plaintext_and_shreds_it() {
        init_test_backend();
        let tmp = tempdir().unwrap();
        let fed = tmp.path().join("federation");
        std::fs::create_dir_all(&fed).unwrap();
        let legacy_path = fed.join(".seed");
        std::fs::write(&legacy_path, [13u8; 32]).unwrap();

        let result = load_or_create(tmp.path()).unwrap();

        assert_ne!(result.backend, SeedBackend::PlaintextLegacy,
            "auto-migrate must move off the plaintext backend");
        assert!(!legacy_path.exists(), "plaintext seed must be shredded after auto-migrate");

        use ed25519_dalek::Signer;
        let migrated = SigningKey::from_bytes(&[13u8; 32]);
        let msg = b"auto-migrate identity check";
        assert_eq!(
            result.signing_key.sign(msg).to_bytes(),
            migrated.sign(msg).to_bytes(),
            "auto-migrate must preserve the signing identity",
        );
    }

    #[test]
    fn store_seed_is_what_load_only_then_reads() {
        init_test_backend();
        let tmp = tempdir().unwrap();
        assert_eq!(store_seed(tmp.path(), &[23u8; 32]).unwrap(), SeedBackend::Encrypted);
        let loaded = load_only(tmp.path()).unwrap().unwrap();
        assert_eq!(loaded.signing_key.to_bytes(), [23u8; 32]);
        assert_eq!(loaded.backend, SeedBackend::Encrypted);
    }

    #[test]
    fn store_seed_replaces_the_seed_already_there() {
        init_test_backend();
        let tmp = tempdir().unwrap();
        write_encrypted(tmp.path(), &[1u8; 32]).unwrap();
        store_seed(tmp.path(), &[2u8; 32]).unwrap();
        assert_eq!(
            load_only(tmp.path()).unwrap().unwrap().signing_key.to_bytes(),
            [2u8; 32],
            "a stored seed that does not become the loaded seed is a silent no-op",
        );
    }

    /// Storing over a machine still on the pre-2K plaintext file leaves that
    /// file where it is — shredding belongs to `seed_migrate`, which verifies
    /// before it destroys. The consequence is real and deliberate: the
    /// *previous* private key stays readable on disk until `migrate-seed`
    /// runs, so pin it here rather than leave it to be discovered.
    #[test]
    fn store_seed_outranks_a_legacy_plaintext_seed_without_deleting_it() {
        init_test_backend();
        let tmp = tempdir().unwrap();
        let legacy = tmp.path().join("federation").join(".seed");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, [9u8; 32]).unwrap();

        store_seed(tmp.path(), &[5u8; 32]).unwrap();

        assert_eq!(load_only(tmp.path()).unwrap().unwrap().signing_key.to_bytes(), [5u8; 32]);
        assert_eq!(std::fs::read(&legacy).unwrap(), [9u8; 32],
            "still there, and still the old key: `migrate-seed` shreds it, `store_seed` does not");
    }

    // NOTE: `keyring_roundtrip_when_available` removed. It wrote `[11u8; 32]`
    // to the globally-namespaced production keyring service+account, then
    // deleted it. `#[ignore]` was insufficient: `cargo test --ignored` or
    // explicit invocation would silently overwrite the developer's real
    // federation seed mid-test. Restoring this safely requires namespacing
    // `KEYRING_SERVICE` by `config_dir`, which is a separate change.
}
