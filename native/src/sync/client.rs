use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use anyhow::Context;
use rusqlite::Connection;
use serde::Serialize;
use tungstenite::{connect, Message, WebSocket};
use tungstenite::stream::MaybeTlsStream;

use super::auth;
use super::config::{FederationConfig, seed_path, export_db_path, peers_dir};
use super::export::{export_index, ExportResult};
use super::protocol::{ClientMessage, HubMessage};

const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize)]
pub struct SyncResult {
    pub export: ExportResult,
    pub uploaded_notes: i64,
    pub downloaded: Vec<DownloadedPeer>,
    pub skipped: Vec<String>,
}

#[derive(Serialize)]
pub struct DownloadedPeer {
    pub peer_id: String,
    pub note_count: i64,
}

pub fn sync_all(
    source_db: &Path,
    vault_path: &Path,
    config_dir: &Path,
    config: &FederationConfig,
) -> anyhow::Result<SyncResult> {
    let export_path = export_db_path(config_dir);
    let peer_id = &config.identity.display_name;

    eprintln!("Exporting local index...");
    let export_result = export_index(source_db, vault_path, &export_path, config)?;
    eprintln!("Export complete: {} exported, {} skipped", export_result.exported, export_result.skipped);

    let model_id = export_result.model_id.clone();
    let export_bytes = std::fs::read(&export_path)?;
    let seed = auth::load_seed(&seed_path(config_dir))?;

    let hub_url = &config.hub.endpoint;
    let connect_url = if hub_url.ends_with("/ws") {
        hub_url.clone()
    } else {
        format!("{}/ws", hub_url.trim_end_matches('/'))
    };
    eprintln!("Connecting to hub at {connect_url}...");
    let (mut ws, _response) = connect(&connect_url)
        .context("failed to connect to hub")?;

    send_json(&mut ws, &ClientMessage::SyncHello {
        peer_id: peer_id.clone(),
        supported_models: vec![model_id.clone()],
        model_id,
        schema_version: SCHEMA_VERSION,
    })?;

    let challenge = recv_json::<HubMessage>(&mut ws)?;
    match challenge {
        HubMessage::SyncReject { reason } => anyhow::bail!("hub rejected: {reason}"),
        HubMessage::AuthChallenge { nonce, hub_pubkey } => {
            let sig = auth::sign_challenge(&seed, &nonce, peer_id, &hub_pubkey)?;
            send_json(&mut ws, &ClientMessage::AuthResponse { signature: sig })?;

            let ready = recv_json::<HubMessage>(&mut ws)?;
            match ready {
                HubMessage::SyncReady { .. } => eprintln!("Authenticated"),
                HubMessage::SyncReject { reason } => anyhow::bail!("auth failed: {reason}"),
                other => anyhow::bail!("unexpected: {other:?}"),
            }
        }
        HubMessage::SyncReady { .. } => eprintln!("Hub ready (no auth)"),
        other => anyhow::bail!("unexpected: {other:?}"),
    }

    let envelope = auth::create_envelope(&seed, &export_bytes, peer_id);
    let export_size_kb = export_bytes.len() / 1024;
    ws.send(Message::binary(export_bytes))?;
    eprintln!("Sent local index ({export_size_kb} KB)");

    let ack = recv_json::<HubMessage>(&mut ws)?;
    let uploaded_notes = match ack {
        HubMessage::SyncAck { note_count } => {
            eprintln!("Hub acknowledged: {note_count} notes");
            note_count
        }
        other => anyhow::bail!("expected sync-ack, got: {other:?}"),
    };
    send_json(&mut ws, &ClientMessage::UploadEnvelope { envelope })?;

    send_json(&mut ws, &ClientMessage::ListPeers)?;
    let peer_list = recv_json::<HubMessage>(&mut ws)?;
    let peers = match peer_list {
        HubMessage::PeerList { peers } => peers,
        other => anyhow::bail!("expected peer-list, got: {other:?}"),
    };
    eprintln!("{} peers available", peers.len());

    let peers_base = peers_dir(config_dir);
    let mut downloaded = Vec::new();
    let mut skipped = Vec::new();

    for peer in &peers {
        let peer_dir = peers_base.join(&peer.peer_id);
        let meta_path = peer_dir.join("index.db.meta");

        if let Ok(meta_text) = std::fs::read_to_string(&meta_path) {
            if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_text) {
                if meta["updated_at"].as_str() == Some(&peer.updated_at) {
                    eprintln!("Peer {} up to date, skipping", peer.peer_id);
                    skipped.push(peer.peer_id.clone());
                    continue;
                }
            }
        }

        eprintln!("Fetching index for {}...", peer.peer_id);
        send_json(&mut ws, &ClientMessage::GetPeerIndex {
            peer_id: peer.peer_id.clone(),
        })?;

        let msg = ws.read()?;
        match msg {
            Message::Binary(data) => {
                std::fs::create_dir_all(&peer_dir)?;
                std::fs::write(peer_dir.join("index.db"), &data)?;
                let peer_db_path = peer_dir.join("index.db");
                if let Err(e) = ensure_peer_fts(&peer_db_path) {
                    eprintln!("FTS rebuild for {} failed: {e}", peer.peer_id);
                }
                if let Err(e) = ensure_peer_embeddings(&peer_db_path, &peer.peer_id) {
                    eprintln!("Embedding generation for {} failed: {e}", peer.peer_id);
                }
                let meta = serde_json::json!({
                    "updated_at": peer.updated_at,
                    "note_count": peer.note_count,
                });
                std::fs::write(&meta_path, serde_json::to_string_pretty(&meta)?)?;
                eprintln!("Saved {} ({} notes)", peer.peer_id, peer.note_count);
                downloaded.push(DownloadedPeer {
                    peer_id: peer.peer_id.clone(),
                    note_count: peer.note_count,
                });
            }
            Message::Text(text) => {
                if let Ok(hub_msg) = serde_json::from_str::<HubMessage>(&text) {
                    if let HubMessage::SyncReject { reason } = hub_msg {
                        eprintln!("Peer {} rejected: {reason}", peer.peer_id);
                    }
                }
            }
            _ => {}
        }
    }

    let _ = ws.close(None);
    eprintln!("Sync complete");

    Ok(SyncResult {
        export: export_result,
        uploaded_notes,
        downloaded,
        skipped,
    })
}

fn send_json<S: Read + Write, T: serde::Serialize>(
    ws: &mut WebSocket<S>,
    msg: &T,
) -> anyhow::Result<()> {
    let json = serde_json::to_string(msg)?;
    ws.send(Message::text(json))?;
    Ok(())
}

fn recv_json<T: serde::de::DeserializeOwned>(
    ws: &mut WebSocket<MaybeTlsStream<TcpStream>>,
) -> anyhow::Result<T> {
    loop {
        match ws.read()? {
            Message::Text(text) => return Ok(serde_json::from_str(&text)?),
            Message::Ping(data) => { ws.send(Message::Pong(data))?; }
            Message::Close(_) => anyhow::bail!("connection closed"),
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
        let vecs = crate::embed::embed_documents(&texts);

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
