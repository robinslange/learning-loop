//! OS-keyring backend (macOS Keychain / Linux Secret Service).

use crate::b64;
use std::path::Path;

use anyhow::Context as _;
use ed25519_dalek::SigningKey;
use rand::RngCore;
use zeroize::Zeroizing;

use crate::sync::config::{keyring_user, KEYRING_SERVICE, KEYRING_USER_LEGACY};
use super::{LoadResult, SeedBackend};

/// Attempt to read the seed from the OS keyring under the per-`config_dir`
/// namespaced account. Returns `None` if not found.
///
/// Legacy-fallback: if the namespaced account is empty but the un-namespaced
/// `KEYRING_USER_LEGACY` account holds a seed whose derived pubkey matches
/// `federation/config.json::identity.pubkey` for this `config_dir`, the seed
/// is auto-migrated (rewritten under the namespaced account, legacy deleted)
/// and returned. The pubkey check is the safety guard: without it we'd hand
/// any leaked legacy entry to any config_dir that asks, recreating the
/// global-namespace stomping problem in reverse.
pub fn read_keyring(config_dir: &Path) -> anyhow::Result<Option<[u8; 32]>> {
    let user = keyring_user(config_dir);
    let entry = ::keyring::Entry::new(KEYRING_SERVICE, &user)
        .context("failed to create keyring entry")?;
    match entry.get_password() {
        Ok(hex_str) => return Ok(Some(decode_seed_hex(&Zeroizing::new(hex_str))?)),
        Err(::keyring::Error::NoEntry) => {}
        Err(e) => {
            if is_platform_unavailable(&e) {
                return Ok(None);
            }
            return Err(anyhow::anyhow!("keyring read error: {e}"));
        }
    }

    if let Some(seed) = try_legacy_migration(config_dir, &user)? {
        return Ok(Some(seed));
    }
    Ok(None)
}

/// Write the seed to the OS keyring under the per-`config_dir` account.
pub fn write_keyring(config_dir: &Path, seed: &[u8; 32]) -> anyhow::Result<()> {
    let user = keyring_user(config_dir);
    let entry = ::keyring::Entry::new(KEYRING_SERVICE, &user)
        .context("failed to create keyring entry")?;
    let hex_str = Zeroizing::new(hex::encode(seed));
    entry.set_password(&hex_str).context("failed to write seed to keyring")
}

/// Delete the seed from the OS keyring (used by `--rollback`).
pub fn delete_keyring(config_dir: &Path) -> anyhow::Result<()> {
    let user = keyring_user(config_dir);
    let entry = ::keyring::Entry::new(KEYRING_SERVICE, &user)
        .context("failed to create keyring entry")?;
    entry.delete_credential().context("failed to delete seed from keyring")
}

/// Probe keyring support by writing and reading a sentinel value.
///
/// Returns `Ok(())` if the keyring is available. Does not persist anything meaningful.
pub fn probe_keyring() -> anyhow::Result<()> {
    let sentinel_user = "probe-sentinel-2K";
    let entry = ::keyring::Entry::new(KEYRING_SERVICE, sentinel_user)
        .context("failed to create probe keyring entry")?;
    entry.set_password("probe").context("keyring probe write failed")?;
    let _ = entry.get_password();
    let _ = entry.delete_credential();
    Ok(())
}

fn decode_seed_hex(hex_str: &str) -> anyhow::Result<[u8; 32]> {
    let bytes = hex::decode(hex_str.trim())
        .context("keyring seed is not valid hex")?;
    bytes.try_into()
        .map_err(|_| anyhow::anyhow!("keyring seed must be exactly 32 bytes"))
}

/// If a legacy un-namespaced keyring entry exists AND its derived pubkey
/// matches the federation/config.json pubkey for this config_dir, migrate it
/// to the namespaced account and return the seed. Otherwise return None.
///
/// Without the pubkey match we would hand any legacy entry to any config_dir
/// that happens to call `read_keyring`, including leaked test/dev watchers —
/// re-introducing the same global-namespace stomping the migration is meant
/// to prevent.
fn try_legacy_migration(config_dir: &Path, namespaced_user: &str) -> anyhow::Result<Option<[u8; 32]>> {
        let legacy = ::keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_LEGACY)
        .context("failed to create legacy keyring entry")?;
    let hex_str = Zeroizing::new(match legacy.get_password() {
        Ok(s) => s,
        Err(::keyring::Error::NoEntry) => return Ok(None),
        Err(e) if is_platform_unavailable(&e) => return Ok(None),
        Err(e) => return Err(anyhow::anyhow!("legacy keyring read error: {e}")),
    });

    let seed = decode_seed_hex(&hex_str)?;

    let expected_pubkey = match read_federation_pubkey(config_dir) {
        Some(pk) => pk,
        None => return Ok(None),
    };
    let derived_pubkey = SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    let expected_bytes = match b64::decode(
        expected_pubkey.strip_prefix("ed25519:").unwrap_or(&expected_pubkey),
    ) {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    if derived_pubkey.as_slice() != expected_bytes.as_slice() {
        return Ok(None);
    }

    let namespaced = ::keyring::Entry::new(KEYRING_SERVICE, namespaced_user)
        .context("failed to create namespaced keyring entry")?;
    namespaced.set_password(&hex_str).context("failed to write seed to namespaced keyring entry")?;
    let _ = legacy.delete_credential();
    eprintln!("learning-loop: migrated keyring entry from legacy un-namespaced account to {namespaced_user}");
    Ok(Some(seed))
}

fn read_federation_pubkey(config_dir: &Path) -> Option<String> {
    let path = config_dir.join("federation").join("config.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("identity")?.get("pubkey")?.as_str().map(|s| s.to_string())
}

/// Whether this machine has no keyring backend AT ALL — as distinct from
/// having one that would not answer.
///
/// That difference decides whether the caller may fall through to `.seed.enc`,
/// and falling through when the keyring merely refused is what shadows an
/// identity: the real key stays in the keychain, a second one is written to
/// disk, and the next run with an unlocked keychain signs with the first.
/// `recover` then reports success for a key the machine will not sign with,
/// because `existing` read as `None` and its `--force` guard never fired.
///
/// `"platform"` used to be one of these needles, and it matched both failure
/// variants rather than any absence. keyring 3.6.3 renders `PlatformFailure`
/// as "Platform secure storage failure: …" and `NoStorageAccess` as "Couldn't
/// access platform secure storage: …" — and `NoStorageAccess`'s own
/// documentation says it is "typically because of access rules in the
/// platform; for example, it might be that the credential store is locked."
/// A locked keychain, a denied prompt and a cancelled prompt were all read as
/// "there is no keyring here".
///
/// What remains names Linux backends that are genuinely absent on a headless
/// box, which is the case this fallback exists for. Everything else is an
/// error, and an error is what the caller must see.
fn is_platform_unavailable(e: &::keyring::Error) -> bool {
    let msg = e.to_string().to_lowercase();
    msg.contains("dbus")
        || msg.contains("no secret service")
        || msg.contains("gnome-keyring")
        || msg.contains("kwallet")
}

pub(super) fn load_or_create_seed(config_dir: &Path) -> anyhow::Result<LoadResult> {
    if let Some(seed) = read_keyring(config_dir)? {
        return Ok(LoadResult {
            signing_key: SigningKey::from_bytes(&seed),
            backend: SeedBackend::Keyring,
            created: false,
        });
    }
    let mut raw = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(raw.as_mut());
    write_keyring(config_dir, &raw)?;
    super::write_seed_meta(config_dir, SeedBackend::Keyring, false)?;
    Ok(LoadResult {
        signing_key: SigningKey::from_bytes(&raw),
        backend: SeedBackend::Keyring,
        created: true,
    })
}

#[cfg(test)]
mod tests {
    use super::is_platform_unavailable;

    /// A keyring that refuses is not a machine without one.
    ///
    /// Treating it as absent let `load_only` fall through to `.seed.enc` while
    /// the real key sat in the keychain — so `store_seed` wrote a second
    /// identity, and `recover` saw `existing = None`, skipped its `--force`
    /// guard, deleted `readable-vaults.json`, and reported "Recovered z6Mk…"
    /// for a key the machine will not sign with.
    #[test]
    fn a_keyring_that_refuses_is_not_a_machine_without_one() {
        // Exactly how keyring 3.6.3 renders these on macOS.
        for e in [
            ::keyring::Error::PlatformFailure(
                "User interaction is not allowed. (-25308)".into(),
            ),
            ::keyring::Error::PlatformFailure("The user name or passphrase you entered is not correct. (-25293)".into()),
            ::keyring::Error::NoStorageAccess("the keychain is locked".into()),
        ] {
            assert!(
                !is_platform_unavailable(&e),
                "`{e}` must reach the caller as an error, not as an absent seed"
            );
        }
    }

    /// The case the fallback exists for: a headless Linux box with no secret
    /// service running. This must keep working, or the fix trades one broken
    /// machine for another.
    #[test]
    fn a_box_with_no_secret_service_still_falls_back() {
        for e in [
            ::keyring::Error::PlatformFailure(
                "org.freedesktop.DBus.Error.ServiceUnknown: no such service".into(),
            ),
            ::keyring::Error::PlatformFailure("no secret service available".into()),
            ::keyring::Error::PlatformFailure("gnome-keyring is not running".into()),
            ::keyring::Error::PlatformFailure("kwallet is unavailable".into()),
        ] {
            assert!(
                is_platform_unavailable(&e),
                "`{e}` means there is no keyring on this machine; the encrypted file is right"
            );
        }
    }
}
