//! OS-keyring backend (macOS Keychain / Linux Secret Service).

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
        Ok(hex_str) => return Ok(Some(decode_seed_hex(&hex_str)?)),
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
    let hex_str = hex::encode(seed);
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
    use base64::Engine as _;
    let legacy = ::keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_LEGACY)
        .context("failed to create legacy keyring entry")?;
    let hex_str = match legacy.get_password() {
        Ok(s) => s,
        Err(::keyring::Error::NoEntry) => return Ok(None),
        Err(e) if is_platform_unavailable(&e) => return Ok(None),
        Err(e) => return Err(anyhow::anyhow!("legacy keyring read error: {e}")),
    };

    let seed = decode_seed_hex(&hex_str)?;

    let expected_pubkey = match read_federation_pubkey(config_dir) {
        Some(pk) => pk,
        None => return Ok(None),
    };
    let derived_pubkey = SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    let expected_bytes = match base64::engine::general_purpose::STANDARD.decode(
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

fn is_platform_unavailable(e: &::keyring::Error) -> bool {
    let msg = e.to_string().to_lowercase();
    msg.contains("dbus") || msg.contains("no secret service") || msg.contains("platform")
        || msg.contains("gnome-keyring") || msg.contains("kwallet")
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
