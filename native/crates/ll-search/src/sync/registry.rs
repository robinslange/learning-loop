//! Vault profiles: one config dir per vault, plus a registry naming them.
//!
//! A vault profile is a config dir shaped exactly like a pre-v5 install, plus
//! an entry in the registry naming it. Reading NEVER writes. A pre-v5 install
//! has no `vaults.json` and must keep working untouched - the registry
//! appears only when a second vault is added.

use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

const REGISTRY: &str = "vaults.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultProfile {
    pub id: String,
    pub config_dir: PathBuf,
    pub vault_path: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct RegistryDoc {
    vaults: Vec<VaultProfile>,
}

pub fn load(plugin_data: &Path) -> anyhow::Result<Vec<VaultProfile>> {
    let reg = plugin_data.join(REGISTRY);
    if reg.exists() {
        let doc: RegistryDoc = serde_json::from_str(&std::fs::read_to_string(&reg)?)?;
        return Ok(doc.vaults);
    }
    // Legacy: a single unnamed profile rooted at plugin_data itself.
    let legacy_config = plugin_data.join("federation").join("config.json");
    if !legacy_config.exists() {
        return Ok(Vec::new());
    }
    let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&legacy_config)?)?;
    let vault_path = raw.get("vault_path").and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!(
            "legacy config has no vault_path; run `ll vault add <path>` to register it"))?;
    Ok(vec![VaultProfile {
        id: raw.get("vault_id").and_then(|v| v.as_str()).unwrap_or("default").to_string(),
        config_dir: plugin_data.to_path_buf(),
        vault_path: PathBuf::from(vault_path),
    }])
}

pub fn add(plugin_data: &Path, profile: VaultProfile) -> anyhow::Result<()> {
    let mut existing = load(plugin_data)?;
    if existing.iter().any(|p| p.config_dir == profile.config_dir) {
        anyhow::bail!(
            "config_dir {} is already used by another profile; each vault needs \
             its own so their seeds and sync state stay isolated",
            profile.config_dir.display()
        );
    }
    if existing.iter().any(|p| p.id == profile.id) {
        anyhow::bail!("vault id {} is already registered", profile.id);
    }
    if existing.iter().any(|p| p.vault_path == profile.vault_path) {
        anyhow::bail!(
            "vault_path {} is already registered under another profile; \
             resolve_by_vault_path would not know which one to return",
            profile.vault_path.display()
        );
    }
    existing.push(profile);
    let doc = RegistryDoc { vaults: existing };
    std::fs::write(plugin_data.join(REGISTRY), serde_json::to_string_pretty(&doc)?)?;
    Ok(())
}

pub fn resolve_by_vault_path(plugin_data: &Path, vault: &Path) -> anyhow::Result<VaultProfile> {
    let profiles = load(plugin_data)?;
    profiles.iter().find(|p| p.vault_path == vault).cloned().ok_or_else(|| {
        let known: Vec<String> =
            profiles.iter().map(|p| p.vault_path.display().to_string()).collect();
        anyhow::anyhow!(
            "no vault profile for {}. Known vaults: {}",
            vault.display(),
            if known.is_empty() { "(none registered)".into() } else { known.join(", ") }
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A pre-v5 install: federation/config.json present, no vaults.json.
    fn legacy(plugin_data: &Path, vault: &str) {
        fs::create_dir_all(plugin_data.join("federation")).unwrap();
        fs::write(
            plugin_data.join("federation/config.json"),
            serde_json::json!({
                "identity": {"displayName": "robin", "pubkey": "ed25519:AAAA"},
                "visibility": {"default": "private", "rules": []},
                "hub": {"endpoint": "wss://h.example/ws"},
                "vault_path": vault
            }).to_string(),
        ).unwrap();
    }

    #[test]
    fn a_legacy_install_resolves_with_no_registry_and_no_migration() {
        let d = tempfile::tempdir().unwrap();
        legacy(d.path(), "/home/r/brain");

        let profiles = load(d.path()).unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].config_dir, d.path());
        assert!(!d.path().join("vaults.json").exists(),
            "reading must not create the registry — a single-vault user \
             experiences zero migration");
    }

    #[test]
    fn adding_a_second_vault_writes_a_registry_containing_both() {
        let d = tempfile::tempdir().unwrap();
        legacy(d.path(), "/home/r/brain");

        add(d.path(), VaultProfile {
            id: "work".into(),
            config_dir: d.path().join("work"),
            vault_path: "/home/r/work-vault".into(),
        }).unwrap();

        let profiles = load(d.path()).unwrap();
        assert_eq!(profiles.len(), 2);
        assert!(profiles.iter().any(|p| p.vault_path == Path::new("/home/r/brain")),
            "the pre-existing vault is carried into the registry, not lost");
    }

    #[test]
    fn resolves_from_a_vault_path() {
        let d = tempfile::tempdir().unwrap();
        legacy(d.path(), "/home/r/brain");
        let p = resolve_by_vault_path(d.path(), Path::new("/home/r/brain")).unwrap();
        assert_eq!(p.config_dir, d.path());
    }

    #[test]
    fn an_unknown_vault_path_errors_with_the_known_ones_listed() {
        let d = tempfile::tempdir().unwrap();
        legacy(d.path(), "/home/r/brain");
        let err = resolve_by_vault_path(d.path(), Path::new("/nope")).unwrap_err();
        assert!(err.to_string().contains("/home/r/brain"),
            "an agent that guessed wrong must be told what the options are");
    }

    #[test]
    fn profiles_never_share_a_config_dir() {
        let d = tempfile::tempdir().unwrap();
        legacy(d.path(), "/home/r/brain");
        let err = add(d.path(), VaultProfile {
            id: "clash".into(),
            config_dir: d.path().to_path_buf(),
            vault_path: "/home/r/other".into(),
        }).unwrap_err();
        assert!(err.to_string().contains("config_dir"),
            "sharing a config dir means sharing last-export-hash and the seed \
             entry — two vaults would silently clobber each other");
    }

    #[test]
    fn a_registry_with_no_legacy_config_is_fine() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("vaults.json"), serde_json::json!({
            "vaults": [{"id":"a","config_dir":"/x/a","vault_path":"/v/a"}]
        }).to_string()).unwrap();
        assert_eq!(load(d.path()).unwrap().len(), 1);
    }

    #[test]
    fn profiles_never_share_a_vault_path() {
        let d = tempfile::tempdir().unwrap();
        legacy(d.path(), "/home/r/brain");
        let err = add(d.path(), VaultProfile {
            id: "duplicate".into(),
            config_dir: d.path().join("duplicate"),
            vault_path: "/home/r/brain".into(),
        }).unwrap_err();
        assert!(err.to_string().contains("vault_path"),
            "two profiles pointing at the same vault_path make resolve_by_vault_path \
             ambiguous — it would silently return whichever one comes first");
    }

    #[test]
    fn a_legacy_config_missing_vault_path_errors_naming_the_fix() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("federation")).unwrap();
        fs::write(
            d.path().join("federation/config.json"),
            serde_json::json!({
                "identity": {"displayName": "robin", "pubkey": "ed25519:AAAA"},
                "visibility": {"default": "private", "rules": []},
                "hub": {"endpoint": "wss://h.example/ws"}
            }).to_string(),
        ).unwrap();

        let err = load(d.path()).unwrap_err();
        assert!(err.to_string().contains("ll vault add"),
            "an operator hitting this needs to be told the command that fixes it");
    }

    #[test]
    fn a_corrupt_registry_errors_instead_of_looking_empty() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("vaults.json"), "{not valid json").unwrap();
        assert!(load(d.path()).is_err(),
            "a corrupt registry must not be silently read as zero vaults — that \
             looks exactly like a fresh install");
    }
}
