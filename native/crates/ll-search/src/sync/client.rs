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
    base_export_db_path, base_export_sha_path, export_db_path, peers_dir, seed_path,
    FederationConfig,
};
use super::export::compute_patchset;
use super::error::SyncError;
use super::export::{export_index, ExportResult};
use super::protocol::{
    manifest_root, ChunkedFrame, ClientMessage, Envelope, EnvelopeMeta, HubMessage, PeerTimestamp,
    CHUNK_MAX_BODY_SIZE, ENVELOPE_HEADER_LEN, HUB_INBOUND_CAP, PROTOCOL_VERSION_CHUNKED,
    PROTOCOL_VERSION_FRAMED, PROTOCOL_VERSION_LATEST,
};

const SCHEMA_VERSION: u32 = 1;
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

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

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

pub async fn sync_all_async(
    source_db: &Path,
    vault_path: &Path,
    config_dir: &Path,
    config: &FederationConfig,
) -> anyhow::Result<SyncResult> {
    let prepared = prepare_export(source_db, vault_path, config_dir, config).await?;

    // Pre-flight upload size check (R12). Frame overhead is 36 bytes.
    if prepared.bytes.len() + ENVELOPE_HEADER_LEN > HUB_INBOUND_CAP {
        return Err(SyncError::EnvelopeOversize { cap: HUB_INBOUND_CAP }.into());
    }

    let seed = auth::load_seed(&seed_path(config_dir))?;
    let peer_id = config.identity.display_name.clone();

    let (mut ws, negotiated_protocol) =
        connect_and_authenticate(config, &seed, &peer_id, &prepared.model_id).await?;
    let framed_path = negotiated_protocol >= PROTOCOL_VERSION_FRAMED;

    let export_path = export_db_path(config_dir);
    let (uploaded_notes, skipped_upload) = upload_index(
        &mut ws,
        config_dir,
        config,
        &export_path,
        &prepared.bytes,
        &prepared.hash,
        &seed,
        &peer_id,
        negotiated_protocol,
        prepared.current_max_mtime,
    )
    .await?;

    let (downloaded, skipped) = download_peers(&mut ws, config_dir, framed_path).await?;

    let _ = ws.close(None).await;
    eprintln!("Sync complete");

    Ok(SyncResult {
        export: prepared.result,
        uploaded_notes,
        skipped_upload,
        downloaded,
        skipped,
    })
}

struct PreparedExport {
    bytes: Vec<u8>,
    hash: String,
    current_max_mtime: u64,
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
    let fed_dir = config_dir.join("federation");
    std::fs::create_dir_all(&fed_dir)?;
    let mtime_path = fed_dir.join("last-export-mtime");

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

    let model_id = if let Some(ref r) = result {
        r.model_id.clone()
    } else {
        let source_owned = source_db.to_path_buf();
        tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
            let source = Connection::open_with_flags(
                &source_owned,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            Ok(source.query_row("SELECT value FROM meta WHERE key = 'model_id'", [], |r| r.get(0))?)
        })
        .await
        .map_err(|e| anyhow::anyhow!("model_id lookup panicked: {e}"))??
    };

    Ok(PreparedExport { bytes, hash, current_max_mtime, model_id, result })
}

async fn connect_and_authenticate(
    config: &FederationConfig,
    seed: &SigningKey,
    peer_id: &str,
    model_id: &str,
) -> anyhow::Result<(WsStream, u32)> {
    let hub_url = &config.hub.endpoint;
    let connect_url = if hub_url.ends_with("/ws") {
        hub_url.clone()
    } else {
        format!("{}/ws", hub_url.trim_end_matches('/'))
    };
    eprintln!("Connecting to hub at {connect_url}...");
    let (mut ws, _response) = tokio_tungstenite::connect_async(&connect_url)
        .await
        .context("failed to connect to hub")?;

    send_json(&mut ws, &ClientMessage::SyncHello {
        peer_id: peer_id.to_string(),
        supported_models: vec![model_id.to_string()],
        model_id: model_id.to_string(),
        schema_version: SCHEMA_VERSION,
        protocol_version: Some(PROTOCOL_VERSION_LATEST),
    }).await?;

    let challenge = recv_json::<HubMessage>(&mut ws).await?;
    let negotiated_protocol: u32 = match challenge {
        HubMessage::SyncReject { reason } => anyhow::bail!("hub rejected: {reason}"),
        HubMessage::AuthChallenge { nonce, hub_pubkey } => {
            let sig = auth::sign_challenge(seed, &nonce, peer_id, &hub_pubkey)?;
            send_json(&mut ws, &ClientMessage::AuthResponse { signature: sig }).await?;

            let ready = recv_json::<HubMessage>(&mut ws).await?;
            match ready {
                HubMessage::SyncReady { protocol_version, .. } => {
                    eprintln!("Authenticated (protocol v{protocol_version})");
                    protocol_version
                }
                HubMessage::SyncReject { reason } => anyhow::bail!("auth failed: {reason}"),
                other => anyhow::bail!("unexpected: {other:?}"),
            }
        }
        HubMessage::SyncReady { protocol_version, .. } => {
            eprintln!("Hub ready (no auth, protocol v{protocol_version})");
            protocol_version
        }
        other => anyhow::bail!("unexpected: {other:?}"),
    };

    Ok((ws, negotiated_protocol))
}

#[allow(clippy::too_many_arguments)]
async fn upload_index(
    ws: &mut WsStream,
    config_dir: &Path,
    config: &FederationConfig,
    export_path: &Path,
    export_bytes: &[u8],
    export_hash: &str,
    seed: &SigningKey,
    peer_id: &str,
    negotiated_protocol: u32,
    current_max_mtime: u64,
) -> anyhow::Result<(i64, bool)> {
    let fed_dir = config_dir.join("federation");
    let hash_path = fed_dir.join("last-export-hash");
    let mtime_path = fed_dir.join("last-export-mtime");

    let upload_unchanged = std::fs::read_to_string(&hash_path)
        .map(|stored| stored.trim() == export_hash)
        .unwrap_or(false);

    if upload_unchanged {
        eprintln!("Index unchanged since last sync, skipping upload");
        send_json(ws, &ClientMessage::SyncSkipUpload).await?;
        let skip_ack = recv_json::<HubMessage>(ws).await?;
        match skip_ack {
            HubMessage::SyncSkipAck => eprintln!("Hub acknowledged skip"),
            other => anyhow::bail!("expected sync-skip-ack, got: {other:?}"),
        }
        return Ok((0, true));
    }

    // Try patchset upload first when v3 negotiated + base on disk.
    let patchset_outcome = if negotiated_protocol >= PROTOCOL_VERSION_CHUNKED {
        try_patchset_upload(ws, config_dir, config, export_path, export_bytes, seed, peer_id).await?
    } else {
        None
    };

    let (notes, hub_stored_sha) = if let Some((n, sha)) = patchset_outcome {
        (n, sha)
    } else {
        upload_full(ws, config, export_bytes, seed, peer_id, negotiated_protocol).await?
    };

    // Rotate the local base when v3 succeeded. SQLite session apply
    // on the hub side produces a row-equivalent but not byte-equivalent
    // DB compared to our local-export.db, so the next patchset upload
    // must advertise the HUB's post-apply sha as base_export_sha256, not
    // ours. The hub echoes its stored hash in SyncAck.stored_sha256;
    // fall back to our local export_hash when the field is absent (older
    // hub or full-upload path).
    if negotiated_protocol >= PROTOCOL_VERSION_CHUNKED {
        let base_db_path = base_export_db_path(config_dir);
        let base_sha_path = base_export_sha_path(config_dir);
        if let Some(parent) = base_db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::copy(export_path, &base_db_path)?;
        let base_sha = hub_stored_sha.as_deref().unwrap_or(export_hash);
        std::fs::write(&base_sha_path, base_sha)?;
    }

    std::fs::write(&hash_path, export_hash)?;
    std::fs::write(&mtime_path, current_max_mtime.to_string())?;

    Ok((notes, false))
}

/// Try a patchset (incremental) upload. Returns `Ok(Some(..))` on hub-acked
/// success, `Ok(None)` when we should fall through to a full upload
/// (no stored base, empty patchset, patchset larger than full, compute
/// failure, or base mismatch on the hub side). Bails on any other reject.
async fn try_patchset_upload(
    ws: &mut WsStream,
    config_dir: &Path,
    config: &FederationConfig,
    export_path: &Path,
    export_bytes: &[u8],
    seed: &SigningKey,
    peer_id: &str,
) -> anyhow::Result<Option<(i64, Option<String>)>> {
    let base_db_path = base_export_db_path(config_dir);
    let base_sha_path = base_export_sha_path(config_dir);
    let base_sha = std::fs::read_to_string(&base_sha_path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let (Some(base_sha), true) = (base_sha, base_db_path.exists()) else {
        return Ok(None);
    };

    let base_owned = base_db_path.clone();
    let cur_owned = export_path.to_path_buf();
    let patchset_res = tokio::task::spawn_blocking(move || compute_patchset(&base_owned, &cur_owned))
        .await
        .map_err(|e| anyhow::anyhow!("patchset compute panicked: {e}"))?;

    let patchset = match patchset_res {
        Ok(p) if p.is_empty() => {
            eprintln!("Patchset empty (no row-level changes); using full");
            return Ok(None);
        }
        Ok(ref p) if p.len() >= export_bytes.len() => {
            eprintln!("Patchset larger than full body; using full");
            return Ok(None);
        }
        Ok(p) => p,
        Err(e) => {
            eprintln!("Patchset compute failed ({e}); falling back to full");
            return Ok(None);
        }
    };

    let chunk_size_max: usize = (4 * 1024 * 1024).min(CHUNK_MAX_BODY_SIZE);
    let total_len = patchset.len();
    let chunk_count = (((total_len + chunk_size_max - 1) / chunk_size_max).max(1)) as u32;
    let chunk_hashes: Vec<[u8; 32]> = patchset
        .chunks(chunk_size_max.max(1))
        .map(|s| Sha256::digest(s).into())
        .collect();
    let merkle = manifest_root(&chunk_hashes);

    let mut envelope = auth::create_envelope_v3(
        seed,
        &patchset,
        peer_id,
        config.graph,
        "patchset",
        "raw",
        chunk_count,
        &merkle,
        chunk_size_max as u32,
    );
    envelope["base_export_sha256"] = serde_json::json!(base_sha);
    envelope["base_export_id"] = serde_json::json!(base_sha);
    send_json(ws, &ClientMessage::UploadEnvelope { envelope }).await?;
    eprintln!(
        "Sent patchset ({} bytes, {} chunks @ {} KiB max, vs full {} bytes)",
        total_len,
        chunk_count,
        chunk_size_max / 1024,
        export_bytes.len()
    );
    for (seq, slice) in patchset.chunks(chunk_size_max.max(1)).enumerate() {
        let frame = ChunkedFrame::from_body(seq as u32, chunk_count, slice.to_vec())?;
        send_binary(ws, frame.encode()).await?;
    }

    let ack = recv_json::<HubMessage>(ws).await?;
    match ack {
        HubMessage::SyncAck { note_count, stored_sha256 } => {
            eprintln!("Hub acknowledged patchset: {note_count} notes");
            Ok(Some((note_count, stored_sha256)))
        }
        HubMessage::SyncReject { reason } if reason.contains("patchset base mismatch") => {
            eprintln!("Patchset rejected (base mismatch); falling back to full");
            Ok(None)
        }
        HubMessage::SyncReject { reason } => {
            anyhow::bail!("hub rejected patchset: {reason}")
        }
        other => anyhow::bail!("expected sync-ack after patchset, got: {other:?}"),
    }
}

/// Send the full export body. Chunked (v3+) or single-frame legacy (v1/v2).
async fn upload_full(
    ws: &mut WsStream,
    config: &FederationConfig,
    export_bytes: &[u8],
    seed: &SigningKey,
    peer_id: &str,
    negotiated_protocol: u32,
) -> anyhow::Result<(i64, Option<String>)> {
    if negotiated_protocol >= PROTOCOL_VERSION_CHUNKED {
        let chunk_size_max: usize = (4 * 1024 * 1024).min(CHUNK_MAX_BODY_SIZE);
        let total_len = export_bytes.len();
        let chunk_count = if total_len == 0 {
            1
        } else {
            ((total_len + chunk_size_max - 1) / chunk_size_max) as u32
        };

        let chunk_hashes: Vec<[u8; 32]> = export_bytes
            .chunks(chunk_size_max.max(1))
            .map(|slice| Sha256::digest(slice).into())
            .collect();
        let merkle = manifest_root(&chunk_hashes);

        let envelope = auth::create_envelope_v3(
            seed,
            export_bytes,
            peer_id,
            config.graph,
            "full",
            "raw",
            chunk_count,
            &merkle,
            chunk_size_max as u32,
        );
        send_json(ws, &ClientMessage::UploadEnvelope { envelope }).await?;
        eprintln!(
            "Sent envelope ({} bytes, {} chunks @ {} KiB max)",
            total_len,
            chunk_count,
            chunk_size_max / 1024
        );

        for (seq, slice) in export_bytes.chunks(chunk_size_max.max(1)).enumerate() {
            let frame = ChunkedFrame::from_body(seq as u32, chunk_count, slice.to_vec())?;
            send_binary(ws, frame.encode()).await?;
            eprintln!(
                "  chunk {}/{} ({} KiB)",
                seq as u32 + 1,
                chunk_count,
                slice.len() / 1024
            );
        }
    } else {
        let framed_path = negotiated_protocol >= PROTOCOL_VERSION_FRAMED;
        let payload_size_kb = export_bytes.len() / 1024;
        let envelope = auth::create_envelope(seed, export_bytes, peer_id, config.graph);
        send_json(ws, &ClientMessage::UploadEnvelope { envelope }).await?;

        let payload = if framed_path {
            Envelope::from_body(export_bytes.to_vec())?.encode()
        } else {
            export_bytes.to_vec()
        };
        send_binary(ws, payload).await?;
        eprintln!("Sent local index ({payload_size_kb} KB, framed={framed_path})");
    }

    let ack = recv_json::<HubMessage>(ws).await?;
    match ack {
        HubMessage::SyncAck { note_count, stored_sha256 } => {
            eprintln!("Hub acknowledged: {note_count} notes");
            Ok((note_count, stored_sha256))
        }
        other => anyhow::bail!("expected sync-ack, got: {other:?}"),
    }
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

async fn send_json<T: serde::Serialize>(
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

async fn recv_json<T: serde::de::DeserializeOwned>(
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
}
