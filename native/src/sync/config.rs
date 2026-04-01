use std::path::{Path, PathBuf};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct FederationConfig {
    pub identity: Identity,
    pub visibility: VisibilityConfig,
    pub hub: HubEndpoint,
    #[serde(default)]
    pub peers: Vec<PeerConfig>,
}

#[derive(Deserialize)]
pub struct Identity {
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub pubkey: String,
}

#[derive(Deserialize)]
pub struct VisibilityConfig {
    pub default: String,
    #[serde(default)]
    pub rules: Vec<VisibilityRule>,
}

#[derive(Deserialize)]
pub struct VisibilityRule {
    pub pattern: String,
    pub tier: String,
}

#[derive(Deserialize)]
pub struct HubEndpoint {
    pub endpoint: String,
}

#[derive(Deserialize)]
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

pub fn resolve_config_dir_opt(opt: Option<String>) -> PathBuf {
    opt.map(PathBuf::from).unwrap_or_else(resolve_config_dir)
}

pub fn resolve_config_dir() -> PathBuf {
    if let Ok(pd) = std::env::var("CLAUDE_PLUGIN_DATA") {
        return PathBuf::from(pd);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(".claude")
        .join("plugins")
        .join("data")
        .join("learning-loop")
}

pub fn seed_path(config_dir: &Path) -> PathBuf {
    config_dir.join("federation").join(".seed")
}

pub fn data_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("federation").join("data")
}

pub fn export_db_path(config_dir: &Path) -> PathBuf {
    data_dir(config_dir).join("local-export.db")
}

pub fn peers_dir(config_dir: &Path) -> PathBuf {
    data_dir(config_dir).join("peers")
}
