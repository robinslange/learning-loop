use std::path::{Path, PathBuf};
use serde::Deserialize;

#[derive(Clone, Deserialize)]
pub struct FederationConfig {
    pub identity: Identity,
    pub visibility: VisibilityConfig,
    pub hub: HubEndpoint,
    #[serde(default)]
    pub peers: Vec<PeerConfig>,
    #[serde(default)]
    pub graph: bool,
}

#[derive(Clone, Deserialize)]
pub struct Identity {
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub pubkey: String,
}

#[derive(Clone, Deserialize)]
pub struct VisibilityConfig {
    pub default: String,
    #[serde(default)]
    pub rules: Vec<VisibilityRule>,
}

#[derive(Clone, Deserialize)]
pub struct VisibilityRule {
    pub pattern: String,
    pub tier: String,
}

#[derive(Clone, Deserialize)]
pub struct HubEndpoint {
    pub endpoint: String,
}

#[derive(Clone, Deserialize)]
pub struct PeerConfig {
    pub id: String,
    pub pubkey: String,
    pub endpoint: String,
}

pub fn load_config(config_dir: &Path) -> anyhow::Result<FederationConfig> {
    let config_path = config_dir.join("federation").join("config.json");
    let text = std::fs::read_to_string(&config_path)?;
    Ok(serde_json::from_str(&text)?)
}

/// Load federation config, optionally overriding the hub endpoint and peer_id.
///
/// Resolution order:
/// 1. If `hub_endpoint_override` is `Some`, use it and synthesise a minimal
///    config without reading from disk. Identity comes from the seed store.
///    `peer_id_override` MUST also be `Some` in this case — passing `None`
///    is a usage error (would silently send `"self"` as the peer_id in the
///    handshake, causing the hub to reject the signed challenge).
/// 2. Otherwise, read `federation/config.json` as [`load_config`] does.
///
/// Use case: atomic onboarding flow in skills/federation. The skill calls
/// `ll-search sync --hub-endpoint <url> --peer-id <id>` before writing config;
/// only on success does it write the file.
pub fn load_config_with_override(
    config_dir: &Path,
    hub_endpoint_override: Option<&str>,
    peer_id_override: Option<&str>,
) -> anyhow::Result<FederationConfig> {
    if hub_endpoint_override.is_none() && peer_id_override.is_some() {
        eprintln!(
            "warning: --peer-id / LL_PEER_ID was provided without --hub-endpoint / \
             LL_HUB_ENDPOINT; the override is ignored when reading config from disk"
        );
    }
    if let Some(endpoint) = hub_endpoint_override {
        let seed = super::seed_store::load_or_create(config_dir)?;
        let pubkey = super::auth::pubkey_b64(&seed.signing_key);
        let display_name = peer_id_override
            .map(String::from)
            .ok_or_else(|| anyhow::anyhow!(
                "load_config_with_override: --hub-endpoint provided without --peer-id; \
                 skills must pass both when bypassing federation/config.json"
            ))?;
        return Ok(FederationConfig {
            identity: Identity {
                display_name,
                pubkey,
            },
            visibility: VisibilityConfig {
                default: String::from("private"),
                rules: vec![],
            },
            hub: HubEndpoint { endpoint: endpoint.to_string() },
            peers: vec![],
            graph: false,
        });
    }
    load_config(config_dir)
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

/// Hex sha256 of the bytes the hub has stored under our peer_id, mirroring
/// the hub-side index.db.sha256 sidecar so patchset uploads can pre-check
/// the base before serialising a diff.
pub fn base_export_sha_path(config_dir: &Path) -> PathBuf {
    data_dir(config_dir).join("base-export.sha256")
}

pub fn peers_dir(config_dir: &Path) -> PathBuf {
    data_dir(config_dir).join("peers")
}
