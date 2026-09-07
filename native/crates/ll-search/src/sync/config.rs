use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
pub struct FederationConfig {
    pub identity: Identity,
    pub visibility: VisibilityConfig,
    pub hub: HubEndpoint,
    /// Whether this vault may be drawn on the federation-wide graph. Sent on
    /// every `ClientHello`, where the hub requires it with no serde default.
    ///
    /// The default here is `false`, and stays `false`: `opt_in` means off
    /// until someone says otherwise, and this publishes a person's notes into
    /// a shared graph. The v4 failure was that nothing could set it at all —
    /// `ll graph-opt-in` is that missing setter, and `ll status` shows the
    /// value. A `true` default would be a different bug wearing this one's
    /// clothes.
    ///
    /// Named for the wire field it feeds. It was `graph` while it fed only
    /// v4's upload envelope, and one flag answering to two names across a
    /// repo boundary is how the two ends drift.
    #[serde(default, alias = "graph")]
    pub graph_opt_in: bool,
    #[serde(default)]
    pub vault_id: Option<String>,
    #[serde(default)]
    pub vault_path: Option<String>,
    /// The `key_id` of the recovery keypair `ll join` generated. The public
    /// half only — the secret exists exactly once, as the 24 words shown at
    /// join time, and is never written anywhere.
    #[serde(default)]
    pub recovery_key_id: Option<String>,
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
            recovery_key_id: None,
            graph_opt_in: false,
        }
    }
}

pub fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join("federation").join("config.json")
}

pub fn load_config(config_dir: &Path) -> anyhow::Result<FederationConfig> {
    let text = std::fs::read_to_string(config_path(config_dir))?;
    Ok(serde_json::from_str(&text)?)
}

/// Write `config.json` through a temp file and a rename. `ll join` treats
/// this file's existence as proof the whole enrollment worked, so a
/// half-written one would be a lie told to every later run.
pub fn write_config(config_dir: &Path, config: &FederationConfig) -> anyhow::Result<()> {
    let path = config_path(config_dir);
    std::fs::create_dir_all(config_dir.join("federation"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(config)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
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

/// Highest `.md` mtime seen at the last export. `prepare_export` compares the
/// vault against it to decide whether to re-export; it has no say in whether
/// to upload — that is the hub's, via `upload_decision`.
pub fn last_export_mtime_path(config_dir: &Path) -> PathBuf {
    config_dir.join("federation").join("last-export-mtime")
}

pub fn peers_dir(config_dir: &Path) -> PathBuf {
    data_dir(config_dir).join("peers")
}

/// The cache directory for one vault this client may read. Keyed by
/// `vault_id`, which is what a grant names — v4 keyed it by display name and
/// nothing in v5 knows a peer by that.
///
/// `vault_id` reaches this from a grant statement and lands in a path, so
/// callers validate it first; `sync::fetch::is_safe_vault_id` is that check
/// and the only producer of the ids this is called with.
pub fn peer_dir(config_dir: &Path, vault_id: &str) -> PathBuf {
    peers_dir(config_dir).join(vault_id)
}

/// The index a fetch writes and `discover_peer_dbs` reads back. One helper
/// for both ends: a bare `index.db` literal at two call sites has already
/// cost this branch one defect.
pub fn peer_index_path(config_dir: &Path, vault_id: &str) -> PathBuf {
    peer_dir(config_dir, vault_id).join("index.db")
}

/// Every grant this machine signed or was handed, stored verbatim.
///
/// Verbatim because a signature covers exact bytes: a store that kept a
/// parsed form and re-serialised it would produce a statement that no longer
/// verifies, and the failure would surface as "invalid signature" a long way
/// from here.
pub fn grants_path(config_dir: &Path) -> PathBuf {
    config_dir.join("federation").join("grants.json")
}

/// What the last sync cycle did — written on every cycle, succeeded or not.
/// A missing file means no cycle has ever finished writing one, which is a
/// different report from "the last cycle was fine" and must not be rendered
/// as one.
pub fn sync_state_path(config_dir: &Path) -> PathBuf {
    config_dir.join("federation").join("sync-state.json")
}

/// The vaults the hub last said this key may read, and when it said so.
///
/// A file of its own rather than a field on `sync-state.json`, because the
/// two have opposite failure requirements. That file is a report, written at
/// the END of a cycle, and `read_state` turns a corrupt one into "no
/// information" precisely so a bad copy cannot block the sync that would
/// rewrite it. This one is an input to what the reader will serve, written
/// EARLY — before the upload half, which can fail — and a copy it cannot read
/// has to mean "serve nothing" rather than "carry on". Sharing a file would
/// have forced one of those two rules onto the other.
pub fn readable_vaults_path(config_dir: &Path) -> PathBuf {
    config_dir.join("federation").join("readable-vaults.json")
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

    /// The hub requires `graph_opt_in` on every hello and counts it, so the
    /// value this config reports is the one that reaches the graph. Absent
    /// means opted out — the safe half of a publication decision — and the
    /// legacy `graph` key means whatever it said, because renaming a field
    /// must not silently withdraw a vault its owner had published.
    #[test]
    fn graph_opt_in_defaults_to_off_and_still_reads_the_legacy_key() {
        let base = |extra: &str| format!(
            r#"{{"identity":{{"displayName":"robin","pubkey":"ed25519:AAAA"}},
                 "visibility":{{"default":"private","rules":[]}},
                 "hub":{{"endpoint":"wss://h.example/ws","key_id":"zAbc"}}{extra}}}"#
        );

        let absent: FederationConfig = serde_json::from_str(&base("")).unwrap();
        assert!(!absent.graph_opt_in, "a vault nobody opted in is not published");

        let legacy: FederationConfig = serde_json::from_str(&base(r#","graph":true"#)).unwrap();
        assert!(legacy.graph_opt_in, "the pre-rename key still carries its value");

        let current: FederationConfig =
            serde_json::from_str(&base(r#","graph_opt_in":true"#)).unwrap();
        assert!(current.graph_opt_in);

        // And it is written back under the new name, so a config that has been
        // through `ll-search graph-opt-in` names the same field the wire does.
        let written = serde_json::to_value(&current).unwrap();
        assert_eq!(written["graph_opt_in"], serde_json::json!(true));
        assert!(written.get("graph").is_none());
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
        let _env = crate::sync::test_hub::env_lock();
        std::env::remove_var("LL_ALLOW_INSECURE_WS");
        let mut c = FederationConfig::test_fixture("private", vec![]);
        c.hub.endpoint = "ws://insecure.example/ws".into();
        c.hub.key_id = Some("zAbc".into());
        assert!(c.validate().unwrap_err().to_string().contains("wss://"));

        std::env::set_var("LL_ALLOW_INSECURE_WS", "1");
        assert!(c.validate().is_ok());
        std::env::remove_var("LL_ALLOW_INSECURE_WS");
    }

    /// The identity field this guard hunts for, assembled from parts so
    /// this file's own source — including this comment and the assertion
    /// message below — never spells it out as a literal, contiguous match.
    const NEEDLE: &str = concat!("peer", "_id");

    /// Files still legitimately mentioning the peer-id field: the wire
    /// protocol (`SyncHello`/`AuthChallenge`/envelope meta in `client.rs`,
    /// `auth.rs`, `protocol/messages.rs`) and the search-side peer iteration
    /// variable of the same name (`export.rs`, `search/federation.rs`,
    /// `search/query.rs`, `search/reflect.rs`). Plan 6 (client handshake and
    /// sync) removes it from `client.rs`; nothing currently scheduled
    /// removes it from the rest — that gap is real, and this allowlist
    /// exists to keep it visible rather than let it pass silently. Shrink
    /// this list as each file drops the field; once it's empty, delete the
    /// allowlist and assert directly against the whole tree.
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
    fn legacy_identity_field_does_not_reappear_in_source() {
        let src_root = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        let mut offenders = Vec::new();
        for entry in walkdir::WalkDir::new(src_root) {
            let entry = entry.unwrap();
            if entry.path().extension().is_none_or(|e| e != "rs") { continue; }
            let src = std::fs::read_to_string(entry.path()).unwrap();
            if !src.contains(NEEDLE) { continue; }
            let rel = entry.path().strip_prefix(src_root).unwrap()
                .to_string_lossy().replace('\\', "/");
            if !PEER_ID_ALLOWLIST.contains(&rel.as_str()) {
                offenders.push(rel);
            }
        }
        assert!(offenders.is_empty(),
            "{NEEDLE} found outside the allowlist (update PEER_ID_ALLOWLIST if this \
             file's removal was scheduled, otherwise fix it): {offenders:?}");
    }
}
