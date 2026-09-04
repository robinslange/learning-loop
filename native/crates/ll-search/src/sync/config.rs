use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
pub struct FederationConfig {
    pub identity: Identity,
    pub visibility: VisibilityConfig,
    pub hub: HubEndpoint,
    #[serde(default)]
    pub graph: bool,
    #[serde(default)]
    pub vault_id: Option<String>,
    #[serde(default)]
    pub vault_path: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Identity {
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub pubkey: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct VisibilityConfig {
    pub default: String,
    #[serde(default)]
    pub rules: Vec<VisibilityRule>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct VisibilityRule {
    pub pattern: String,
    pub tier: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct HubEndpoint {
    pub endpoint: String,
    /// The hub's pinned `key_id`. REQUIRED in v5 — an unpinned hub cannot be
    /// distinguished from an impostor, and v4 merely warned about it.
    #[serde(default)]
    pub key_id: Option<String>,
}

impl FederationConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.hub.key_id.as_deref().unwrap_or("").is_empty() {
            anyhow::bail!(
                "hub.key_id is not set. Re-run `ll join` — v5 requires the hub \
                 identity to be pinned, so a substituted hub is rejected rather \
                 than warned about."
            );
        }
        let insecure_ok = std::env::var("LL_ALLOW_INSECURE_WS").is_ok();
        if !self.hub.endpoint.starts_with("wss://") && !insecure_ok {
            anyhow::bail!("hub.endpoint must use wss:// (got {})", self.hub.endpoint);
        }
        Ok(())
    }

    /// Construct a config in-memory for tests, without touching disk.
    #[cfg(test)]
    pub fn test_fixture(default: &str, rules: Vec<(String, String)>) -> Self {
        FederationConfig {
            identity: Identity {
                display_name: "test".into(),
                pubkey: "ed25519:AAAA".into(),
            },
            visibility: VisibilityConfig {
                default: default.to_string(),
                rules: rules
                    .into_iter()
                    .map(|(pattern, tier)| VisibilityRule { pattern, tier })
                    .collect(),
            },
            hub: HubEndpoint {
                endpoint: "wss://example.invalid/ws".into(),
                key_id: None,
            },
            vault_id: None,
            vault_path: None,
            graph: false,
        }
    }
}

pub fn load_config(config_dir: &Path) -> anyhow::Result<FederationConfig> {
    let config_path = config_dir.join("federation").join("config.json");
    let text = std::fs::read_to_string(&config_path)?;
    Ok(serde_json::from_str(&text)?)
}

pub fn resolve_config_dir_opt(opt: Option<String>) -> PathBuf {
    opt.map(PathBuf::from).unwrap_or_else(resolve_config_dir)
}

pub fn resolve_config_dir() -> PathBuf {
    if let Ok(pd) = std::env::var("CLAUDE_PLUGIN_DATA") {
        return PathBuf::from(pd);
    }
    eprintln!("warning: CLAUDE_PLUGIN_DATA not set and --config-dir not provided; pass --config-dir <plugin-data-root>");
    PathBuf::from(".")
}

pub fn seed_path(config_dir: &Path) -> PathBuf {
    config_dir.join("federation").join(".seed")
}

/// Path for the migration-only `.seed-meta.json` sidecar file.
pub fn seed_meta_path(config_dir: &Path) -> PathBuf {
    config_dir.join("federation").join(".seed-meta.json")
}

/// Path for the encrypted-at-rest seed fallback (`.seed.enc`).
pub fn encrypted_seed_path(config_dir: &Path) -> PathBuf {
    config_dir.join("federation").join(".seed.enc")
}

/// Keyring service name. Stable; bump the `-v1` suffix if the seed format changes.
pub const KEYRING_SERVICE: &str = "ai.learning-loop.federation";

/// Legacy un-namespaced account name. Older installs wrote to this. Reads on
/// the canonical plugin-data config_dir fall back to it for migration; new
/// writes always use [`keyring_user`].
pub const KEYRING_USER_LEGACY: &str = "signing-seed-v1";

/// Compute the per-`config_dir` keyring account name.
///
/// Why namespace: `keyring::Entry::new(SERVICE, USER)` is globally scoped per
/// OS user. A single fixed account name means any process — test fixture,
/// leaked dev watcher, parallel test thread — that calls `write_keyring`
/// against the same SERVICE+USER stomps the production install's seed. We've
/// seen this happen and it silently breaks federation auth.
///
/// The namespaced name is `signing-seed-v1-<hex8>` where `<hex8>` is the
/// first 8 hex chars of `sha256(canonicalized config_dir path)`. Tempdirs
/// and dev/test config_dirs each get their own entry, isolated from prod.
pub fn keyring_user(config_dir: &Path) -> String {
    use sha2::{Digest, Sha256};
    let canonical = std::fs::canonicalize(config_dir).unwrap_or_else(|_| config_dir.to_path_buf());
    let hash = Sha256::digest(canonical.as_os_str().as_encoded_bytes());
    let hex8: String = hash.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("signing-seed-v1-{hex8}")
}

pub fn data_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("federation").join("data")
}

pub fn export_db_path(config_dir: &Path) -> PathBuf {
    data_dir(config_dir).join("local-export.db")
}

/// Last successfully-uploaded export, kept as the "base" the hub agreed on.
/// Used as the diff source for v3 patchset uploads.
pub fn base_export_db_path(config_dir: &Path) -> PathBuf {
    data_dir(config_dir).join("base-export.db")
}

/// Hex sha256 of the bytes the hub has stored under our identity, mirroring
/// the hub-side index.db.sha256 sidecar so patchset uploads can pre-check
/// the base before serialising a diff.
pub fn base_export_sha_path(config_dir: &Path) -> PathBuf {
    data_dir(config_dir).join("base-export.sha256")
}

pub fn peers_dir(config_dir: &Path) -> PathBuf {
    data_dir(config_dir).join("peers")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_parses_with_the_new_optional_fields() {
        let raw = serde_json::json!({
            "identity": {"displayName": "robin", "pubkey": "ed25519:AAAA"},
            "visibility": {"default": "private", "rules": []},
            "hub": {"endpoint": "wss://h.example/ws", "key_id": "zAbc"},
            "vault_id": "019abc",
            "vault_path": "/home/r/brain"
        }).to_string();
        let c: FederationConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(c.vault_id.as_deref(), Some("019abc"));
        assert_eq!(c.hub.key_id.as_deref(), Some("zAbc"));
    }

    #[test]
    fn a_pre_v5_config_without_the_new_fields_still_parses() {
        let raw = serde_json::json!({
            "identity": {"displayName": "robin", "pubkey": "ed25519:AAAA"},
            "visibility": {"default": "private", "rules": []},
            "hub": {"endpoint": "wss://h.example/ws"}
        }).to_string();
        let c: FederationConfig = serde_json::from_str(&raw).unwrap();
        assert!(c.vault_id.is_none());
    }

    #[test]
    fn a_config_without_a_pinned_hub_key_is_invalid() {
        let c = FederationConfig::test_fixture("private", vec![]);
        let err = c.validate().unwrap_err();
        assert!(err.to_string().contains("hub.key_id"),
            "an unpinned hub was a warning in v4 and is an error in v5");
    }

    #[test]
    fn a_ws_endpoint_is_rejected_unless_the_test_escape_hatch_is_set() {
        std::env::remove_var("LL_ALLOW_INSECURE_WS");
        let mut c = FederationConfig::test_fixture("private", vec![]);
        c.hub.endpoint = "ws://insecure.example/ws".into();
        c.hub.key_id = Some("zAbc".into());
        assert!(c.validate().unwrap_err().to_string().contains("wss://"));

        std::env::set_var("LL_ALLOW_INSECURE_WS", "1");
        assert!(c.validate().is_ok());
        std::env::remove_var("LL_ALLOW_INSECURE_WS");
    }

    /// Files still legitimately mentioning `peer_id`: the wire protocol
    /// (`SyncHello`/`AuthChallenge`/envelope meta in `client.rs`, `auth.rs`,
    /// `protocol/messages.rs`) and the search-side peer iteration that reads
    /// it (`export.rs`, `search/federation.rs`, `search/query.rs`,
    /// `search/reflect.rs`). Plan 6 (client handshake and sync) removes it
    /// from `client.rs`; nothing currently scheduled removes it from the
    /// rest — that gap is real, and this allowlist exists to keep it visible
    /// rather than let it pass silently. Shrink this list as each file drops
    /// `peer_id`; once it's empty, delete the allowlist and assert directly
    /// against the whole tree.
    const PEER_ID_ALLOWLIST: &[&str] = &[
        "sync/client.rs",
        "sync/auth.rs",
        "sync/protocol/messages.rs",
        "sync/export.rs",
        "search/federation.rs",
        "search/query.rs",
        "search/reflect.rs",
    ];

    #[test]
    fn no_source_file_mentions_peer_id() {
        // This file (the guard itself) necessarily names the string it hunts
        // for, both here and in the allowlist doc comment above — skip it.
        const SELF: &str = "sync/config.rs";
        let src_root = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        let mut offenders = Vec::new();
        for entry in walkdir::WalkDir::new(src_root) {
            let entry = entry.unwrap();
            if entry.path().extension().is_none_or(|e| e != "rs") { continue; }
            let rel = entry.path().strip_prefix(src_root).unwrap()
                .to_string_lossy().replace('\\', "/");
            if rel == SELF { continue; }
            let src = std::fs::read_to_string(entry.path()).unwrap();
            if !src.contains("peer_id") { continue; }
            if !PEER_ID_ALLOWLIST.contains(&rel.as_str()) {
                offenders.push(rel);
            }
        }
        assert!(offenders.is_empty(),
            "peer_id found outside the allowlist (update PEER_ID_ALLOWLIST if this \
             file's removal was scheduled, otherwise fix it): {offenders:?}");
    }
}
