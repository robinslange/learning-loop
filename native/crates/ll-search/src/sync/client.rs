use std::path::Path;
use std::time::Duration;
use anyhow::Context;
use ed25519_dalek::SigningKey;
use futures_util::{SinkExt, StreamExt};
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Sha256, Digest};
use tokio_tungstenite::tungstenite::Message;

use super::auth;
use super::config::{
    export_db_path, last_export_mtime_path, peers_dir, seed_path, FederationConfig,
};
use super::error::SyncError;
use super::export::{export_index, ExportResult};
use super::handshake::SyncReadyPayload;
use super::protocol::{
    ClientMessage, Envelope, EnvelopeMeta, HubMessage, PeerTimestamp, ENVELOPE_HEADER_LEN,
    HUB_INBOUND_CAP, PROTOCOL_VERSION_FRAMED,
};
use super::protocol_v5::{ClientMsg, HubMsg, VaultState};
use super::state::{self, HubHolds, SyncState};

const META_FILE_VERSION: u32 = 2;
const RECV_TIMEOUT: Duration = Duration::from_secs(30);
const SEND_TIMEOUT: Duration = Duration::from_secs(60);

/// Test-only override for `RECV_TIMEOUT` via `LL_SYNC_RECV_TIMEOUT_MS` env var.
/// Production callers ignore this; it exists so integration tests can shorten
/// the silent-hub timeout from 30s to ~1s without changing source code.
fn recv_timeout() -> Duration {
    std::env::var("LL_SYNC_RECV_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(RECV_TIMEOUT)
}

fn send_timeout() -> Duration {
    std::env::var("LL_SYNC_SEND_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(SEND_TIMEOUT)
}

pub(super) type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Tailscale's CGNAT range (100.64.0.0/10): first octet 100, second octet
/// in 64..=127. Tailnet traffic is already WireGuard-encrypted end-to-end,
/// so requiring TLS on top buys nothing.
fn is_tailscale_cgnat_ip(host: &str) -> bool {
    host.parse::<std::net::Ipv4Addr>()
        .map(|ip| {
            let [a, b, ..] = ip.octets();
            a == 100 && (64..=127).contains(&b)
        })
        .unwrap_or(false)
}

/// Enforce wss:// for hub connections. Cleartext `ws://` (and any other
/// scheme) is rejected so the vault index never streams unencrypted, EXCEPT
/// for loopback hosts (127.0.0.1 / ::1 / localhost) and Tailscale tailnet
/// hosts (100.64.0.0/10 CGNAT range, or `.ts.net` MagicDNS names), where
/// ws:// is allowed since those transports are already encrypted.
fn check_hub_scheme(endpoint: &str) -> anyhow::Result<()> {
    let rest = endpoint.trim();
    if let Some(after) = rest.strip_prefix("wss://") {
        let _ = after;
        return Ok(());
    }
    if let Some(after) = rest.strip_prefix("ws://") {
        let authority = after
            .split(|c| c == '/' || c == '?' || c == '#')
            .next()
            .unwrap_or("");
        let host = if let Some(rest) = authority.strip_prefix('[') {
            rest.split(']').next().unwrap_or("")
        } else {
            authority.split(':').next().unwrap_or("")
        };
        if host == "127.0.0.1" || host == "::1" || host == "localhost" {
            return Ok(());
        }
        if is_tailscale_cgnat_ip(host) || host.ends_with(".ts.net") {
            return Ok(());
        }
        anyhow::bail!(
            "refusing cleartext ws:// connection to non-loopback hub {endpoint:?}; \
             federation requires wss:// (or a Tailscale tailnet host)"
        );
    }
    let scheme = rest.split("://").next().unwrap_or(rest);
    anyhow::bail!(
        "unsupported hub scheme {scheme:?} in {endpoint:?}; federation requires wss://"
    )
}

fn is_safe_peer_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[derive(Debug, Serialize)]
pub struct SyncResult {
    pub export: Option<ExportResult>,
    pub uploaded_notes: i64,
    pub skipped_upload: bool,
    pub downloaded: Vec<DownloadedPeer>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DownloadedPeer {
    pub peer_id: String,
    pub note_count: i64,
}

/// Run one sync cycle and record what it did, whether it worked or not.
///
/// Every way the cycle can fail lives inside `run_cycle`, so a cycle that
/// dies before it ever reaches the hub still leaves a state file behind —
/// that is precisely the cycle nobody noticed for two months.
pub async fn sync_all_async(
    source_db: &Path,
    vault_path: &Path,
    config_dir: &Path,
    config: &FederationConfig,
) -> anyhow::Result<SyncResult> {
    // The last thing this cycle knew the hub to hold. `run_cycle` fills it in
    // as it learns, so a cycle that dies halfway records what it had learned
    // by then rather than nothing at all.
    let mut known_holds = None;
    let outcome = run_cycle(source_db, vault_path, config_dir, config, &mut known_holds).await;

    let now = unix_now();
    let (outcome_label, detail, last_success_at) = match &outcome {
        Ok(_) => (state::OUTCOME_OK, None, Some(now)),
        Err(e) => (
            state::OUTCOME_ERROR,
            Some(e.to_string()),
            // A failure must not erase when this vault last synced: how long
            // the outage has been running is the whole question. Best-effort
            // by construction — `read_state` reports a corrupt file as
            // missing, so one corruption loses the answer permanently.
            state::read_state(config_dir)
                .ok()
                .flatten()
                .and_then(|prev| prev.last_success_at),
        ),
    };
    // Failing to record the cycle must never mask the cycle's own error.
    let _ = state::write_state(config_dir, &SyncState {
        last_attempt_at: now,
        last_success_at,
        outcome: outcome_label.to_string(),
        detail,
        hub_holds: known_holds,
    });

    outcome
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn run_cycle(
    source_db: &Path,
    vault_path: &Path,
    config_dir: &Path,
    config: &FederationConfig,
    known_holds: &mut Option<HubHolds>,
) -> anyhow::Result<SyncResult> {
    let prepared = prepare_export(source_db, vault_path, config_dir, config).await?;

    // Pre-flight upload size check (R12). Frame overhead is 36 bytes.
    if prepared.bytes.len() + ENVELOPE_HEADER_LEN > HUB_INBOUND_CAP {
        return Err(SyncError::EnvelopeOversize { cap: HUB_INBOUND_CAP }.into());
    }

    let seed = auth::load_seed(&seed_path(config_dir))?;
    let peer_id = config.identity.display_name.clone();

    let (mut ws, ready) =
        connect_and_authenticate(config, &seed, &peer_id, &prepared.model_id).await?;
    let framed_path = ready.protocol_version >= PROTOCOL_VERSION_FRAMED;

    let (vault_id, this_vault) = this_vault_state(config, &ready.vault_state)?;
    // What the hub reported at the handshake. Everything after this point
    // can fail, and if it does this is the last thing we knew.
    *known_holds = Some(hub_holds(this_vault));

    let uploaded = upload_index(&mut ws, config_dir, vault_id, this_vault, &prepared).await?;
    *known_holds = Some(uploaded.hub_holds);

    let (downloaded, skipped) = download_peers(&mut ws, config_dir, framed_path).await?;

    let _ = ws.close(None).await;
    eprintln!("Sync complete");

    Ok(SyncResult {
        export: prepared.result,
        uploaded_notes: uploaded.note_count,
        skipped_upload: uploaded.skipped,
        downloaded,
        skipped,
    })
}

struct PreparedExport {
    bytes: Vec<u8>,
    hash: String,
    current_max_mtime: u64,
    note_count: i64,
    schema_version: String,
    model_id: String,
    result: Option<ExportResult>,
}

async fn prepare_export(
    source_db: &Path,
    vault_path: &Path,
    config_dir: &Path,
    config: &FederationConfig,
) -> anyhow::Result<PreparedExport> {
    let export_path = export_db_path(config_dir);
    std::fs::create_dir_all(config_dir.join("federation"))?;
    let mtime_path = last_export_mtime_path(config_dir);

    let last_mtime: u64 = std::fs::read_to_string(&mtime_path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let vault_owned = vault_path.to_path_buf();
    let current_max_mtime = tokio::task::spawn_blocking(move || max_md_mtime(&vault_owned))
        .await
        .map_err(|e| anyhow::anyhow!("mtime scan task panicked: {e}"))?;
    let vault_changed = current_max_mtime > last_mtime;

    let need_export = vault_changed || !export_path.exists();
    let (bytes, result) = if need_export {
        eprintln!("Exporting local index...");
        let source_owned = source_db.to_path_buf();
        let vault_owned = vault_path.to_path_buf();
        let export_owned = export_path.clone();
        let config_owned = config.clone();
        let result = tokio::task::spawn_blocking(move || {
            export_index(&source_owned, &vault_owned, &export_owned, &config_owned)
        })
        .await
        .map_err(|e| anyhow::anyhow!("export task panicked: {e}"))??;
        eprintln!("Export complete: {} exported, {} skipped", result.exported, result.skipped);
        let export_owned = export_path.clone();
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(&export_owned))
            .await
            .map_err(|e| anyhow::anyhow!("export read task panicked: {e}"))??;
        (bytes, Some(result))
    } else {
        eprintln!("No vault changes since last export");
        let export_owned = export_path.clone();
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(&export_owned))
            .await
            .map_err(|e| anyhow::anyhow!("export read task panicked: {e}"))??;
        (bytes, None)
    };
    let hash = hex::encode(Sha256::digest(&bytes));

    // Read the upload metadata from the export we are about to send, never
    // from the source index or from `ExportResult`. When the export is reused
    // from disk, a re-index in between would make the source's `model_id`
    // describe different bytes than the ones on the wire.
    let export_owned = export_path.clone();
    let (note_count, schema_version, model_id) = tokio::task::spawn_blocking(
        move || -> anyhow::Result<(i64, String, String)> {
            let export = Connection::open_with_flags(
                &export_owned,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let meta = |key: &str| -> anyhow::Result<String> {
                Ok(export.query_row(
                    "SELECT value FROM meta WHERE key = ?1",
                    [key],
                    |r| r.get::<_, String>(0),
                )?)
            };
            let note_count = meta("note_count")?
                .parse()
                .context("export meta note_count is not an integer")?;
            Ok((note_count, meta("schema_version")?, meta("model_id")?))
        },
    )
    .await
    .map_err(|e| anyhow::anyhow!("export meta lookup panicked: {e}"))??;

    Ok(PreparedExport {
        bytes,
        hash,
        current_max_mtime,
        note_count,
        schema_version,
        model_id,
        result,
    })
}

async fn connect_and_authenticate(
    config: &FederationConfig,
    seed: &SigningKey,
    peer_id: &str,
    model_id: &str,
) -> anyhow::Result<(WsStream, SyncReadyPayload)> {
    let hub_url = &config.hub.endpoint;
    check_hub_scheme(hub_url)?;
    let connect_url = if hub_url.ends_with("/ws") {
        hub_url.clone()
    } else {
        format!("{}/ws", hub_url.trim_end_matches('/'))
    };
    eprintln!("Connecting to hub at {connect_url} as {peer_id} (model {model_id})...");
    let (mut ws, _response) = tokio_tungstenite::connect_async(&connect_url)
        .await
        .context("failed to connect to hub")?;

    // Channel binding: the exporter ties a completed handshake to this exact
    // TLS session, so relaying it onto a different connection fails
    // signature verification. `LL_ALLOW_INSECURE_WS` is the local test
    // harness escape hatch only (`check_hub_scheme` already restricts
    // cleartext `ws://` to loopback/tailnet hosts).
    let exporter = match ws.get_ref() {
        tokio_tungstenite::MaybeTlsStream::Rustls(tls) => {
            let (_io, conn) = tls.get_ref();
            let mut out = [0u8; 32];
            conn.export_keying_material(&mut out, super::handshake::EXPORTER_LABEL, None)?;
            out
        }
        _ if std::env::var("LL_ALLOW_INSECURE_WS").is_ok() => [0u8; 32],
        _ => anyhow::bail!("hub connection is not TLS; refusing to authenticate"),
    };

    let vault_ids: Vec<String> = config.vault_id.clone().into_iter().collect();
    let ready = super::handshake::authenticate(&mut ws, seed, config, &vault_ids, &exporter, None).await?;
    eprintln!("Authenticated (protocol v{})", ready.protocol_version);

    Ok((ws, ready))
}

#[derive(Debug, PartialEq, Eq)]
pub enum UploadDecision {
    Upload,
    Skip,
}

/// Decide whether to upload, using ONLY what the hub reports it holds.
///
/// v4 read `federation/last-export-hash` — a local file describing what this
/// client believed it had once uploaded. When the hub lost its index (or, as
/// happened, never had one because its credentials were absent), the client
/// kept reporting "no changes" forever and nothing ever re-uploaded.
///
/// `last-export-hash` is gone — nothing read it once the hub became the
/// authority, and a file in `federation/` that looks authoritative and is
/// read by nothing is how this bug got written in the first place. The
/// separate `last-export-mtime` decides whether to re-export; it never
/// decides whether to send.
pub fn upload_decision(export_hash: &str, state: Option<&VaultState>) -> UploadDecision {
    match state.and_then(|s| s.holds.as_ref()) {
        Some(held) if held.sha256 == export_hash => UploadDecision::Skip,
        _ => UploadDecision::Upload,
    }
}

/// The hub's report for the vault this config is joined to, resolved once.
///
/// The upload decision and `sync-state.json` describe the same entry; two
/// lookups is how they would come to describe different ones.
fn this_vault_state<'c, 'v>(
    config: &'c FederationConfig,
    vault_state: &'v [VaultState],
) -> anyhow::Result<(&'c str, Option<&'v VaultState>)> {
    let vault_id = config.vault_id.as_deref().ok_or_else(|| {
        anyhow::anyhow!("no vault_id in this federation config; run `ll join` in this vault")
    })?;
    Ok((vault_id, vault_state.iter().find(|v| v.vault_id == vault_id)))
}

/// What the upload half did, and what the hub holds once it has done it.
#[derive(Debug)]
struct Uploaded {
    note_count: i64,
    skipped: bool,
    /// After an accepted upload, the index the hub acknowledged. On the skip
    /// path, what the hub reported at the handshake — which is the same
    /// index, since that is what skipping means.
    hub_holds: HubHolds,
}

/// What the hub reports it holds, in the form the state file records. The
/// count is the hub's, never the local one.
fn hub_holds(state: Option<&VaultState>) -> HubHolds {
    match state.and_then(|s| s.holds.as_ref()) {
        Some(held) => HubHolds::Index {
            sha256: held.sha256.clone(),
            note_count: held.note_count,
        },
        None => HubHolds::Nothing,
    }
}

/// Send the export to the hub over the v5 wire: a JSON `UploadIndex`
/// declaring what follows, then the raw export bytes as one binary frame,
/// then the hub's `UploadAck`. No envelope, no compression, no chunking —
/// the hub hashes exactly the bytes in that frame.
async fn upload_index(
    ws: &mut WsStream,
    config_dir: &Path,
    vault_id: &str,
    this_vault: Option<&VaultState>,
    prepared: &PreparedExport,
) -> anyhow::Result<Uploaded> {
    if upload_decision(&prepared.hash, this_vault) == UploadDecision::Skip {
        eprintln!("Hub already holds this index, skipping upload");
        return Ok(Uploaded {
            note_count: 0,
            skipped: true,
            hub_holds: hub_holds(this_vault),
        });
    }

    send_json(ws, &ClientMsg::UploadIndex {
        vault_id: vault_id.to_string(),
        sha256: prepared.hash.clone(),
        note_count: prepared.note_count,
        schema_version: prepared.schema_version.clone(),
        model_id: prepared.model_id.clone(),
    })
    .await?;
    send_binary(ws, prepared.bytes.clone()).await?;
    eprintln!(
        "Sent local index ({} KB, {} notes declared)",
        prepared.bytes.len() / 1024,
        prepared.note_count
    );

    let acked_sha = match recv_json::<HubMsg>(ws).await? {
        // v5's UploadAck carries no count, so this line must not imply the hub
        // agreed with ours.
        HubMsg::UploadAck { vault_id, sha256 } => {
            eprintln!("Hub stored the index for {vault_id}");
            sha256
        }
        HubMsg::Reject { reason } => anyhow::bail!("hub rejected upload: {reason}"),
        other => anyhow::bail!("expected upload-ack, got: {other:?}"),
    };

    // We hashed these bytes ourselves, so we are the side holding ground
    // truth. A hub acknowledging a different index has stored something we
    // cannot account for; fail loud rather than write its claim into our own
    // state file.
    if acked_sha != prepared.hash {
        anyhow::bail!(
            "hub acknowledged a different index than we sent: we declared {}, it acked \
             {acked_sha}",
            prepared.hash,
        );
    }

    std::fs::write(
        last_export_mtime_path(config_dir),
        prepared.current_max_mtime.to_string(),
    )?;

    Ok(Uploaded {
        note_count: prepared.note_count,
        skipped: false,
        // Checked against the ack just above, so this is the index the hub
        // confirmed. The count is not: v5's UploadAck carries none, so it is
        // the count we declared alongside those bytes.
        hub_holds: HubHolds::Index {
            sha256: prepared.hash.clone(),
            note_count: prepared.note_count,
        },
    })
}

async fn download_peers(
    ws: &mut WsStream,
    config_dir: &Path,
    framed_path: bool,
) -> anyhow::Result<(Vec<DownloadedPeer>, Vec<String>)> {
    send_json(ws, &ClientMessage::ListPeers).await?;
    let peer_list = recv_json::<HubMessage>(ws).await?;
    let peers = match peer_list {
        HubMessage::PeerList { peers } => peers,
        other => anyhow::bail!("expected peer-list, got: {other:?}"),
    };
    eprintln!("{} peers available", peers.len());

    let peers_base = peers_dir(config_dir);
    let mut downloaded = Vec::new();
    let mut skipped = Vec::new();

    for peer in &peers {
        if !is_safe_peer_id(&peer.peer_id) {
            eprintln!("rejecting peer with unsafe peer_id: {:?}", peer.peer_id);
            continue;
        }
        let peer_dir = peers_base.join(&peer.peer_id);
        let meta_path = peer_dir.join("index.db.meta");

        if peer_is_fresh(&meta_path, &peer.updated_at) {
            eprintln!("Peer {} up to date, skipping", peer.peer_id);
            skipped.push(peer.peer_id.clone());
            continue;
        }

        let peer_framed = framed_path
            && peer.protocol_version.map(|v| v >= PROTOCOL_VERSION_FRAMED).unwrap_or(true);

        eprintln!("Fetching index for {} (framed={peer_framed})...", peer.peer_id);

        send_json(ws, &ClientMessage::GetPeerEnvelope {
            peer_id: peer.peer_id.clone(),
        }).await?;
        let envelope_msg = recv_json::<HubMessage>(ws).await?;
        let envelope_meta = match envelope_msg {
            HubMessage::PeerEnvelope { envelope: Some(ref env) } => {
                EnvelopeMeta::from_value(env).ok()
            }
            _ => None,
        };

        send_json(ws, &ClientMessage::GetPeerIndex {
            peer_id: peer.peer_id.clone(),
        }).await?;

        let raw = match recv_binary_or_reject(ws).await? {
            Some(bytes) => bytes,
            None => continue,
        };

        let data = if peer_framed {
            match Envelope::decode(&raw) {
                Ok(env) => {
                    if let Some(ref meta) = envelope_meta {
                        if !hash_matches(&env.hash, &meta.sha256) {
                            eprintln!("Peer {} frame-vs-meta hash mismatch, skipping", peer.peer_id);
                            continue;
                        }
                    }
                    env.body
                }
                Err(e) => {
                    eprintln!("Peer {} frame decode failed: {e}, skipping", peer.peer_id);
                    continue;
                }
            }
        } else {
            if raw.len() > 100 * 1024 * 1024 {
                eprintln!("Peer {} index too large ({}MB), skipping",
                    peer.peer_id, raw.len() / 1024 / 1024);
                continue;
            }
            if let Some(ref meta) = envelope_meta {
                let actual = hex::encode(Sha256::digest(&raw));
                if actual != meta.sha256 {
                    eprintln!("Peer {} hash mismatch, skipping", peer.peer_id);
                    continue;
                }
            }
            raw
        };

        std::fs::create_dir_all(&peer_dir)?;
        let peer_db_path = peer_dir.join("index.db");
        let peer_db_owned = peer_db_path.clone();
        tokio::task::spawn_blocking(move || std::fs::write(&peer_db_owned, &data))
            .await
            .map_err(|e| anyhow::anyhow!("peer write task panicked: {e}"))??;
        let peer_db_owned = peer_db_path.clone();
        let peer_id_owned = peer.peer_id.clone();
        if let Err(e) = tokio::task::spawn_blocking(move || ensure_peer_fts(&peer_db_owned))
            .await
            .map_err(|e| anyhow::anyhow!("ensure_peer_fts task panicked: {e}"))?
        {
            eprintln!("FTS rebuild for {} failed: {e}", peer.peer_id);
        }
        let peer_db_owned = peer_db_path.clone();
        let peer_id_for_embed = peer_id_owned.clone();
        if let Err(e) = tokio::task::spawn_blocking(move || {
            ensure_peer_embeddings(&peer_db_owned, &peer_id_for_embed)
        })
        .await
        .map_err(|e| anyhow::anyhow!("ensure_peer_embeddings task panicked: {e}"))?
        {
            eprintln!("Embedding generation for {} failed: {e}", peer.peer_id);
        }
        let updated_at_unix = PeerTimestamp::parse(&peer.updated_at).ok().map(|t| t.0);
        let meta = serde_json::json!({
            "schema_version": META_FILE_VERSION,
            "updated_at": peer.updated_at,
            "updated_at_unix": updated_at_unix,
            "note_count": peer.note_count,
        });
        std::fs::write(&meta_path, serde_json::to_string_pretty(&meta)?)?;
        eprintln!("Saved {} ({} notes)", peer.peer_id, peer.note_count);
        downloaded.push(DownloadedPeer {
            peer_id: peer.peer_id.clone(),
            note_count: peer.note_count,
        });
    }

    Ok((downloaded, skipped))
}

fn hash_matches(in_frame: &[u8; 32], hex_hash: &str) -> bool {
    match hex::decode(hex_hash) {
        Ok(bytes) if bytes.len() == 32 => bytes[..] == in_frame[..],
        _ => false,
    }
}

fn peer_is_fresh(meta_path: &Path, peer_updated_at: &str) -> bool {
    let Ok(meta_text) = std::fs::read_to_string(meta_path) else {
        return false;
    };
    let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_text) else {
        return false;
    };

    let schema_version = meta.get("schema_version").and_then(|v| v.as_u64()).unwrap_or(1);
    let peer_unix = match PeerTimestamp::parse(peer_updated_at) {
        Ok(t) => t.0,
        Err(_) => return false,
    };
    if schema_version >= 2 {
        if let Some(stored_unix) = meta.get("updated_at_unix").and_then(|v| v.as_u64()) {
            return stored_unix == peer_unix;
        }
    }
    let stored_at = meta.get("updated_at").and_then(|v| v.as_str()).unwrap_or("");
    PeerTimestamp::parse(stored_at).ok().map(|t| t.0) == Some(peer_unix)
}

fn max_md_mtime(dir: &Path) -> u64 {
    let mut max = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.file_name().is_some_and(|n| n.to_str().is_some_and(|s| s.starts_with('.'))) {
                continue;
            }
            if path.is_dir() {
                max = max.max(max_md_mtime(&path));
            } else if path.extension().is_some_and(|e| e == "md") {
                if let Ok(meta) = path.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(d) = modified.duration_since(std::time::UNIX_EPOCH) {
                            max = max.max(d.as_secs());
                        }
                    }
                }
            }
        }
    }
    max
}

pub(super) async fn send_json<T: serde::Serialize>(
    ws: &mut WsStream,
    msg: &T,
) -> anyhow::Result<()> {
    let text = serde_json::to_string(msg).map_err(SyncError::from)?;
    let to = send_timeout();
    tokio::time::timeout(to, ws.send(Message::text(text)))
        .await
        .map_err(|_| SyncError::SendTimeout { timeout: to })?
        .map_err(SyncError::from)?;
    Ok(())
}

async fn send_binary(ws: &mut WsStream, payload: Vec<u8>) -> anyhow::Result<()> {
    let to = send_timeout();
    tokio::time::timeout(to, ws.send(Message::binary(payload)))
        .await
        .map_err(|_| SyncError::SendTimeout { timeout: to })?
        .map_err(SyncError::from)?;
    Ok(())
}

pub(super) async fn recv_json<T: serde::de::DeserializeOwned>(
    ws: &mut WsStream,
) -> anyhow::Result<T> {
    loop {
        let recv_to = recv_timeout();
        let send_to = send_timeout();
        let msg = tokio::time::timeout(recv_to, ws.next())
            .await
            .map_err(|_| SyncError::RecvTimeout { timeout: recv_to })?
            .ok_or(SyncError::ClosedUnexpected)?
            .map_err(SyncError::from)?;
        match msg {
            Message::Text(text) => return Ok(serde_json::from_str(text.as_str()).map_err(SyncError::from)?),
            Message::Ping(data) => {
                tokio::time::timeout(send_to, ws.send(Message::Pong(data)))
                    .await
                    .map_err(|_| SyncError::SendTimeout { timeout: send_to })?
                    .map_err(SyncError::from)?;
            }
            Message::Close(_) => return Err(SyncError::ClosedUnexpected.into()),
            _ => continue,
        }
    }
}

/// Read the next binary message from the websocket. If the hub sends a `SyncReject`
/// text frame in place of binary (peer-not-found etc.), surface that as `Ok(None)`
/// so the caller can skip the peer without aborting the loop.
async fn recv_binary_or_reject(ws: &mut WsStream) -> anyhow::Result<Option<Vec<u8>>> {
    loop {
        let recv_to = recv_timeout();
        let send_to = send_timeout();
        let msg = tokio::time::timeout(recv_to, ws.next())
            .await
            .map_err(|_| SyncError::RecvTimeout { timeout: recv_to })?
            .ok_or(SyncError::ClosedUnexpected)?
            .map_err(SyncError::from)?;
        match msg {
            Message::Binary(data) => return Ok(Some(data.into())),
            Message::Text(text) => {
                if let Ok(HubMessage::SyncReject { reason }) =
                    serde_json::from_str::<HubMessage>(text.as_str())
                {
                    eprintln!("hub rejected: {reason}");
                    return Ok(None);
                }
                continue;
            }
            Message::Ping(data) => {
                tokio::time::timeout(send_to, ws.send(Message::Pong(data)))
                    .await
                    .map_err(|_| SyncError::SendTimeout { timeout: send_to })?
                    .map_err(SyncError::from)?;
            }
            Message::Close(_) => return Err(SyncError::ClosedUnexpected.into()),
            _ => continue,
        }
    }
}

fn ensure_peer_fts(db_path: &Path) -> anyhow::Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            title, tags, body,
            content='notes_content',
            content_rowid='id',
            tokenize='porter unicode61 remove_diacritics 1'
        );
        INSERT INTO notes_fts(notes_fts) VALUES('rebuild');"
    )?;
    Ok(())
}

fn ensure_peer_embeddings(db_path: &Path, peer_id: &str) -> anyhow::Result<()> {
    let conn = Connection::open(db_path)?;

    let has_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='embeddings'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    let has_data = has_table && conn
        .query_row("SELECT COUNT(*) FROM embeddings", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0) > 0;

    if has_data {
        return Ok(());
    }

    let mut stmt = conn.prepare(
        "SELECT nc.id, nc.body FROM notes_content nc WHERE nc.body IS NOT NULL AND nc.body != ''"
    )?;
    let notes: Vec<(i64, String)> = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?
    .filter_map(|r| r.ok())
    .collect();
    drop(stmt);

    if notes.is_empty() {
        return Ok(());
    }

    eprintln!("Generating embeddings for peer {} ({} notes)...", peer_id, notes.len());

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS embeddings (id INTEGER PRIMARY KEY, data BLOB NOT NULL);"
    )?;

    let batch_size = 32;
    let mut embedded = 0;

    for chunk in notes.chunks(batch_size) {
        let texts: Vec<String> = chunk.iter().map(|(_, body)| body.clone()).collect();
        let vecs = crate::embed::try_embed_documents(&texts)?;

        conn.execute_batch("BEGIN TRANSACTION;")?;
        for ((id, _), vec) in chunk.iter().zip(vecs.iter()) {
            let blob: Vec<u8> = vec.iter().flat_map(|f| f.to_le_bytes()).collect();
            conn.execute(
                "INSERT OR REPLACE INTO embeddings (id, data) VALUES (?1, ?2)",
                rusqlite::params![id, blob],
            )?;
        }
        conn.execute_batch("COMMIT;")?;

        embedded += chunk.len();
        eprintln!("  Embedded {}/{}", embedded, notes.len());
    }

    eprintln!("Peer {} embeddings complete", peer_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::protocol_v5::HeldIndex;

    #[test]
    fn check_hub_scheme_accepts_wss() {
        assert!(check_hub_scheme("wss://hub.example.com/ws").is_ok());
        assert!(check_hub_scheme("wss://hub.example.com").is_ok());
    }

    #[test]
    fn check_hub_scheme_rejects_cleartext_ws_to_remote() {
        let err = check_hub_scheme("ws://hub.example.com/ws").unwrap_err().to_string();
        assert!(err.contains("ws://"), "error should name the scheme: {err}");
        assert!(check_hub_scheme("http://hub.example.com").is_err());
        assert!(check_hub_scheme("hub.example.com").is_err());
    }

    #[test]
    fn check_hub_scheme_allows_loopback_ws() {
        assert!(check_hub_scheme("ws://127.0.0.1:8080/ws").is_ok());
        assert!(check_hub_scheme("ws://localhost:9000").is_ok());
        assert!(check_hub_scheme("ws://[::1]:8080/ws").is_ok());
    }

    #[test]
    fn check_hub_scheme_allows_tailscale_cgnat_ws() {
        assert!(check_hub_scheme("ws://100.101.102.103:8787").is_ok());
        assert!(check_hub_scheme("ws://100.64.0.0:8787").is_ok());
        assert!(check_hub_scheme("ws://100.127.255.255:8787/ws").is_ok());
    }

    #[test]
    fn check_hub_scheme_allows_ts_net_hostname_ws() {
        assert!(check_hub_scheme("ws://my-hub.tailnet-name.ts.net:8787").is_ok());
    }

    #[test]
    fn check_hub_scheme_rejects_non_tailscale_ws() {
        assert!(check_hub_scheme("ws://8.8.8.8:1").is_err());
        assert!(check_hub_scheme("ws://100.63.255.255:8787").is_err());
        assert!(check_hub_scheme("ws://100.128.0.0:8787").is_err());
        assert!(check_hub_scheme("ws://hub.example.com:8787").is_err());
    }

    #[test]
    fn is_safe_peer_id_accepts_valid() {
        assert!(is_safe_peer_id("abc123"));
        assert!(is_safe_peer_id("peer-01"));
        assert!(is_safe_peer_id("peer_01"));
        assert!(is_safe_peer_id("ABC_123-xyz"));
    }

    #[test]
    fn is_safe_peer_id_rejects_traversal() {
        assert!(!is_safe_peer_id("../etc"));
        assert!(!is_safe_peer_id(".."));
        assert!(!is_safe_peer_id("foo/bar"));
        assert!(!is_safe_peer_id("foo\\bar"));
        assert!(!is_safe_peer_id(""));
        assert!(!is_safe_peer_id("foo bar"));
    }

    #[test]
    fn is_safe_peer_id_rejects_overlong() {
        let long = "a".repeat(129);
        assert!(!is_safe_peer_id(&long));
        assert!(is_safe_peer_id(&"a".repeat(128)));
    }

    #[test]
    fn is_safe_peer_id_rejects_unicode() {
        assert!(!is_safe_peer_id("peer\u{200B}id"));
        assert!(!is_safe_peer_id("café"));
    }

    #[test]
    fn no_source_file_accepts_an_unauthenticated_hub() {
        // Needles assembled from parts so `include_str!` below — which pulls
        // in this very test — can't match its own assertion literals.
        let no_auth = concat!("no ", "auth");
        let mitm = concat!("MITM", "-vulnerable");
        let src = include_str!("client.rs");
        assert!(!src.contains(no_auth));
        assert!(!src.contains(mitm),
            "an unpinned hub is now an error, so there is nothing left to warn about");
    }

    #[test]
    fn hash_matches_pairs() {
        let mut h = [0u8; 32];
        for (i, b) in h.iter_mut().enumerate() {
            *b = i as u8;
        }
        assert!(hash_matches(&h, &hex::encode(h)));
        assert!(!hash_matches(&h, &hex::encode([0u8; 32])));
        assert!(!hash_matches(&h, "not_hex"));
        assert!(!hash_matches(&h, &hex::encode([0u8; 31])));
    }

    fn held(sha256: &str) -> HeldIndex {
        HeldIndex { sha256: sha256.into(), note_count: 10, uploaded_at: 1 }
    }

    #[test]
    fn uploads_when_the_hub_holds_nothing_even_if_the_local_hash_matches() {
        let decision = upload_decision("abc123", Some(&VaultState {
            vault_id: "v1".into(),
            holds: None,
        }));

        assert_eq!(decision, UploadDecision::Upload,
            "THE 2026-07 OUTAGE: the client said 'no changes' from its own file \
             while the hub held nothing, for two months, at INFO level");
    }

    #[test]
    fn skips_only_when_the_hub_confirms_it_holds_this_exact_index() {
        let decision = upload_decision("abc123", Some(&VaultState {
            vault_id: "v1".into(),
            holds: Some(held("abc123")),
        }));
        assert_eq!(decision, UploadDecision::Skip);
    }

    #[test]
    fn uploads_when_the_hub_holds_a_different_index() {
        let decision = upload_decision("abc123", Some(&VaultState {
            vault_id: "v1".into(),
            holds: Some(held("stale999")),
        }));
        assert_eq!(decision, UploadDecision::Upload);
    }

    #[test]
    fn uploads_when_the_hub_does_not_mention_this_vault_at_all() {
        assert_eq!(upload_decision("abc123", None), UploadDecision::Upload,
            "a hub that never mentions the vault has not confirmed it holds the index");
    }

    /// The positive control deliberately looks for a token that exists only
    /// in the body. `state` would not do: it appears in the signature too, so
    /// a slice that captured the signature and truncated before the body
    /// would satisfy the control while checking none of the logic.
    #[test]
    fn the_local_hash_file_is_never_consulted_for_the_decision() {
        let src = include_str!("client.rs");
        let idx = src.find("pub fn upload_decision").expect("function exists");
        let body = src[idx..].split("\n}\n").next().expect("function has a closing brace");
        assert!(body.contains("UploadDecision::Skip"),
            "positive control: if this slice missed the function body, the assertion below \
             would pass by reading nothing");
        assert!(!body.contains("last-export-hash"),
            "the upload decision must depend only on what the hub reports");
    }

    type WsServer = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    async fn spawn_mock_hub<F, Fut>(handler: F) -> std::net::SocketAddr
    where
        F: FnOnce(WsServer) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                if let Ok(ws) = tokio_tungstenite::accept_async(stream).await {
                    handler(ws).await;
                }
            }
        });
        addr
    }

    fn prepared_fixture(bytes: Vec<u8>) -> PreparedExport {
        let hash = hex::encode(Sha256::digest(&bytes));
        PreparedExport {
            bytes,
            hash,
            current_max_mtime: 7,
            note_count: 42,
            schema_version: "2".into(),
            model_id: "m".into(),
            result: None,
        }
    }

    async fn client_to(addr: std::net::SocketAddr) -> WsStream {
        tokio_tungstenite::connect_async(format!("ws://{addr}")).await.unwrap().0
    }

    #[tokio::test]
    async fn the_upload_is_a_json_declaration_then_one_raw_binary_frame() {
        let body = b"pretend-this-is-a-sqlite-file".to_vec();
        let expected_hash = hex::encode(Sha256::digest(&body));
        let (tx, rx) = tokio::sync::oneshot::channel();
        let addr = spawn_mock_hub(|mut ws| async move {
            let declared = match ws.next().await.unwrap().unwrap() {
                Message::Text(t) => serde_json::from_str::<ClientMsg>(t.as_str()).unwrap(),
                other => panic!("expected the upload-index declaration, got {other:?}"),
            };
            let frame = match ws.next().await.unwrap().unwrap() {
                Message::Binary(b) => b.to_vec(),
                other => panic!("expected one raw binary frame, got {other:?}"),
            };
            let ClientMsg::UploadIndex { ref vault_id, ref sha256, .. } = declared else {
                panic!("expected upload-index, got {declared:?}")
            };
            let ack = HubMsg::UploadAck { vault_id: vault_id.clone(), sha256: sha256.clone() };
            ws.send(Message::text(serde_json::to_string(&ack).unwrap())).await.unwrap();
            let _ = tx.send((declared, frame));
        })
        .await;

        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        let mut config = FederationConfig::test_fixture("private", vec![]);
        config.vault_id = Some("v1".into());
        let prepared = prepared_fixture(body.clone());
        let mut ws = client_to(addr).await;

        let (vault_id, this_vault) = this_vault_state(&config, &[]).unwrap();
        let outcome = upload_index(&mut ws, dir.path(), vault_id, this_vault, &prepared)
            .await
            .unwrap();
        assert_eq!((outcome.note_count, outcome.skipped), (42, false));
        // The counterpart to the reject test: "must not advance" only means
        // something if a successful upload does advance it.
        assert_eq!(
            std::fs::read_to_string(last_export_mtime_path(dir.path())).unwrap(),
            "7",
        );

        let (declared, frame) = rx.await.unwrap();
        assert_eq!(frame, body,
            "the hub runs Sha256 over exactly this frame: no envelope header, no zstd, no chunking");
        match declared {
            ClientMsg::UploadIndex { vault_id, sha256, note_count, schema_version, model_id } => {
                assert_eq!(vault_id, "v1");
                assert_eq!(sha256, expected_hash);
                assert_eq!(note_count, 42);
                assert_eq!(schema_version, "2");
                assert_eq!(model_id, "m");
            }
            other => panic!("expected upload-index, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_hub_reject_fails_the_sync_with_the_hubs_reason() {
        let addr = spawn_mock_hub(|mut ws| async move {
            let _decl = ws.next().await;
            let _frame = ws.next().await;
            let reject = HubMsg::Reject { reason: "not authorized to write this vault".into() };
            ws.send(Message::text(serde_json::to_string(&reject).unwrap())).await.unwrap();
        })
        .await;

        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        let mtime_path = last_export_mtime_path(dir.path());
        std::fs::write(&mtime_path, "1").unwrap();
        let mut config = FederationConfig::test_fixture("private", vec![]);
        config.vault_id = Some("v1".into());
        let mut ws = client_to(addr).await;

        let (vault_id, this_vault) = this_vault_state(&config, &[]).unwrap();
        let err =
            upload_index(&mut ws, dir.path(), vault_id, this_vault, &prepared_fixture(b"x".to_vec()))
                .await
                .unwrap_err()
                .to_string();
        assert!(err.contains("not authorized to write this vault"), "{err}");
        // The fixture's mtime is 7, so a swallowed reject would advance this to "7".
        assert_eq!(std::fs::read_to_string(&mtime_path).unwrap(), "1",
            "a rejected upload must not advance the re-export watermark");
    }

    #[tokio::test]
    async fn a_hub_that_acks_a_different_index_fails_the_upload() {
        let addr = spawn_mock_hub(|mut ws| async move {
            let _decl = ws.next().await;
            let _frame = ws.next().await;
            let ack = HubMsg::UploadAck {
                vault_id: "v1".into(),
                sha256: "beef".repeat(16),
            };
            ws.send(Message::text(serde_json::to_string(&ack).unwrap())).await.unwrap();
        })
        .await;

        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        let mtime_path = last_export_mtime_path(dir.path());
        std::fs::write(&mtime_path, "1").unwrap();
        let mut config = FederationConfig::test_fixture("private", vec![]);
        config.vault_id = Some("v1".into());
        let prepared = prepared_fixture(b"x".to_vec());
        let mut ws = client_to(addr).await;

        let (vault_id, this_vault) = this_vault_state(&config, &[]).unwrap();
        let err = upload_index(&mut ws, dir.path(), vault_id, this_vault, &prepared)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains(&prepared.hash), "the error names what we sent: {err}");
        assert!(err.contains(&"beef".repeat(16)), "and what the hub acked: {err}");
        assert_eq!(std::fs::read_to_string(&mtime_path).unwrap(), "1",
            "an unaccountable ack must not advance the re-export watermark either");
    }

    /// The upload writes the re-export watermark and the next export reads
    /// it. Nothing checked that the two ends agreed on the file: if they ever
    /// name different paths the client re-exports on every single sync,
    /// forever, and no test and no log line says anything is wrong.
    #[tokio::test]
    async fn the_watermark_the_upload_writes_is_the_one_the_next_export_reads() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.db");
        let vault = dir.path().join("vault");
        super::super::export::build_source_db(
            &source,
            Some("01926d7e-0000-7000-8000-00000000000a"),
        );
        super::super::export::public_vault_with_note(&vault);
        let mut config = FederationConfig::test_fixture("private", vec![]);
        config.vault_id = Some("v1".into());

        let first = prepare_export(&source, &vault, dir.path(), &config).await.unwrap();
        assert!(first.result.is_some(), "precondition: a cold config dir exports");

        let addr = spawn_mock_hub(|mut ws| async move {
            let Message::Text(t) = ws.next().await.unwrap().unwrap() else { panic!("no decl") };
            let ClientMsg::UploadIndex { vault_id, sha256, .. } =
                serde_json::from_str(t.as_str()).unwrap()
            else {
                panic!("expected upload-index")
            };
            let _frame = ws.next().await.unwrap().unwrap();
            let ack = HubMsg::UploadAck { vault_id, sha256 };
            ws.send(Message::text(serde_json::to_string(&ack).unwrap())).await.unwrap();
        })
        .await;
        let mut ws = client_to(addr).await;
        let (vault_id, this_vault) = this_vault_state(&config, &[]).unwrap();
        upload_index(&mut ws, dir.path(), vault_id, this_vault, &first).await.unwrap();

        let second = prepare_export(&source, &vault, dir.path(), &config).await.unwrap();
        assert!(second.result.is_none(),
            "the vault has not changed, so the watermark the upload just wrote must \
             satisfy the next export's check");
    }

    /// Ties the three keys `prepare_export` reads to the three
    /// `export_index` writes, by running the real export instead of
    /// hand-building the table. Rename a key in `export.rs`, or change
    /// `params![exported.to_string()]` to `params![exported]` so it lands as
    /// INTEGER, and this goes red — a hand-built fixture agrees with whatever
    /// the reader expects and would stay green while every real sync failed.
    ///
    /// It cannot replace the hand-built test below: `export_index` always
    /// writes `schema_version = 2`, which is also `META_FILE_VERSION`, so the
    /// trap that test exists for is invisible from here.
    #[tokio::test]
    async fn the_upload_metadata_matches_what_the_export_actually_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.db");
        let vault = dir.path().join("vault");
        super::super::export::build_source_db(
            &source,
            Some("01926d7e-0000-7000-8000-00000000000a"),
        );
        super::super::export::public_vault_with_note(&vault);

        let config = FederationConfig::test_fixture("private", vec![]);
        let prepared =
            prepare_export(&source, &vault, dir.path(), &config).await.unwrap();

        let exported = prepared.result.as_ref().expect("the export ran").exported;
        assert_eq!(exported, 1, "precondition: the fixture note is public and exports");
        assert_eq!(prepared.note_count, exported as i64);
        assert_eq!(prepared.model_id, "test-model");
        assert_eq!(prepared.schema_version, "2");
    }

    /// The declared metadata must describe the bytes on the wire, so it is
    /// read from the export DB — never from the source index, and never from
    /// a version constant. `META_FILE_VERSION` and the export's own
    /// `SCHEMA_VERSION` both happen to be 2, so a fixture using 2 would pass
    /// no matter which of the three the code read. This one uses 9.
    #[tokio::test]
    async fn the_upload_metadata_is_read_from_the_export_db() {
        let dir = tempfile::tempdir().unwrap();
        let export_path = export_db_path(dir.path());
        std::fs::create_dir_all(export_path.parent().unwrap()).unwrap();
        let conn = Connection::open(&export_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta VALUES ('note_count', '7'), ('schema_version', '9'),
                                     ('model_id', 'from-the-export');",
        )
        .unwrap();
        drop(conn);

        let vault = tempfile::tempdir().unwrap();
        let config = FederationConfig::test_fixture("private", vec![]);
        let prepared =
            prepare_export(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
                .await
                .unwrap();

        assert!(prepared.result.is_none(), "precondition: the export was reused, not rebuilt");
        assert_eq!(prepared.note_count, 7);
        assert_eq!(prepared.schema_version, "9");
        assert_eq!(prepared.model_id, "from-the-export");
    }

    #[test]
    fn a_missing_vault_id_is_an_error_naming_ll_join() {
        let config = FederationConfig::test_fixture("private", vec![]);
        assert!(config.vault_id.is_none(), "fixture precondition");

        let err = this_vault_state(&config, &[]).unwrap_err().to_string();
        assert!(err.contains("ll join"),
            "ambiguous scope fails loud and names the fix, never defaults or skips: {err}");
    }

    #[test]
    fn the_hub_holding_nothing_is_recorded_as_nothing() {
        assert_eq!(hub_holds(None), HubHolds::Nothing,
            "a hub that never mentions the vault holds nothing for it");
        assert_eq!(
            hub_holds(Some(&VaultState { vault_id: "v1".into(), holds: None })),
            HubHolds::Nothing,
        );
    }

    #[test]
    fn the_recorded_count_is_the_hubs_not_the_local_one() {
        let state = VaultState { vault_id: "v1".into(), holds: Some(held("abc123")) };
        assert_eq!(
            hub_holds(Some(&state)),
            HubHolds::Index { sha256: "abc123".into(), note_count: 10 },
            "note_count is what the hub reports it holds; the local export's count \
             is a different number and answers a different question",
        );
    }

    #[test]
    fn the_vault_entry_is_the_one_matching_this_config() {
        let mut config = FederationConfig::test_fixture("private", vec![]);
        config.vault_id = Some("v2".into());
        let states = vec![
            VaultState { vault_id: "v1".into(), holds: Some(held("wrong")) },
            VaultState { vault_id: "v2".into(), holds: Some(held("right")) },
        ];

        let (vault_id, this_vault) = this_vault_state(&config, &states).unwrap();
        assert_eq!(vault_id, "v2");
        assert_eq!(this_vault.unwrap().holds.as_ref().unwrap().sha256, "right");
    }
}
