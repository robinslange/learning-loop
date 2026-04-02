use std::path::Path;
use anyhow::Context;
use rusqlite::{params, Connection};
use serde::Serialize;

use super::config::FederationConfig;
use super::visibility::VisibilityEngine;

const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize)]
pub struct ExportResult {
    pub exported: usize,
    pub skipped: usize,
    #[serde(skip)]
    pub model_id: String,
}

pub fn export_index(
    source_db_path: &Path,
    vault_path: &Path,
    export_path: &Path,
    config: &FederationConfig,
) -> anyhow::Result<ExportResult> {
    if let Some(parent) = export_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let source = Connection::open_with_flags(
        source_db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .context("failed to open source index")?;

    let model_id: String = source
        .query_row("SELECT value FROM meta WHERE key = 'model_id'", [], |r| r.get(0))
        .context("source index has no model_id")?;

    let rules: Vec<(String, String)> = config
        .visibility
        .rules
        .iter()
        .map(|r| (r.pattern.clone(), r.tier.clone()))
        .collect();
    let engine = VisibilityEngine::new(&config.visibility.default, &rules);

    if export_path.exists() {
        std::fs::remove_file(export_path)?;
    }

    let export = Connection::open(export_path)?;
    export.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE notes (
             id INTEGER PRIMARY KEY,
             path TEXT NOT NULL,
             title TEXT NOT NULL,
             tags TEXT,
             tier TEXT NOT NULL,
             updated_at INTEGER NOT NULL
         );
         CREATE TABLE notes_content (
             id INTEGER PRIMARY KEY,
             title TEXT,
             tags TEXT,
             body TEXT
         );
         CREATE TABLE meta (
             key TEXT PRIMARY KEY,
             value TEXT
         );
         CREATE TABLE embeddings (
             id INTEGER PRIMARY KEY,
             data BLOB NOT NULL
         );"
    )?;

    let mut stmt = source.prepare(
        "SELECT n.id, n.path, n.title, n.tags, nc.body
         FROM notes n
         JOIN notes_content nc ON nc.id = n.id"
    )?;

    let mut exported = 0usize;
    let mut skipped = 0usize;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    export.execute("BEGIN", [])?;

    for row in rows {
        let (id, path, title, tags, body) = row?;
        let title = title.unwrap_or_default();
        let tags = tags.unwrap_or_default();
        let body = body.unwrap_or_default();

        let fm_vis = read_frontmatter_visibility(vault_path, &path);
        let tier = engine.evaluate(&path, fm_vis.as_deref());

        if tier == "private" {
            skipped += 1;
            continue;
        }

        let export_body = if tier == "public" {
            body
        } else {
            summarize(&body, 300)
        };

        export.execute(
            "INSERT INTO notes (id, path, title, tags, tier, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, path, title, tags, tier, now],
        )?;
        export.execute(
            "INSERT INTO notes_content (id, title, tags, body) VALUES (?1, ?2, ?3, ?4)",
            params![id, title, tags, export_body],
        )?;

        exported += 1;
    }

    // Copy embeddings for exported notes
    let mut emb_stmt = source.prepare(
        "SELECT e.id, e.data FROM embeddings e JOIN notes n ON e.id = n.id"
    )?;

    let emb_rows = emb_stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    for row in emb_rows {
        let (id, data) = row?;
        if export.query_row(
            "SELECT 1 FROM notes WHERE id = ?1",
            params![id],
            |_| Ok(()),
        ).is_ok() {
            export.execute(
                "INSERT INTO embeddings (id, data) VALUES (?1, ?2)",
                params![id, data],
            )?;
        }
    }

    let peer_id = &config.identity.display_name;
    let now_iso = crate::db::chrono_iso_now();
    export.execute("INSERT INTO meta (key, value) VALUES ('model_id', ?1)", params![model_id])?;
    export.execute("INSERT INTO meta (key, value) VALUES ('schema_version', ?1)", params![SCHEMA_VERSION.to_string()])?;
    export.execute("INSERT INTO meta (key, value) VALUES ('peer_id', ?1)", params![peer_id])?;
    export.execute("INSERT INTO meta (key, value) VALUES ('exported_at', ?1)", params![now_iso])?;
    export.execute("INSERT INTO meta (key, value) VALUES ('note_count', ?1)", params![exported.to_string()])?;

    export.execute("COMMIT", [])?;

    Ok(ExportResult { exported, skipped, model_id })
}

fn read_frontmatter_visibility(vault_path: &Path, rel_path: &str) -> Option<String> {
    let full_path = vault_path.join(rel_path);
    let raw = std::fs::read_to_string(full_path).ok()?;
    if !raw.starts_with("---\n") {
        return None;
    }
    let end = raw[4..].find("\n---")?;
    let fm = &raw[4..4 + end];
    for line in fm.lines() {
        let trimmed = line.trim();
        if let Some(val) = trimmed.strip_prefix("visibility:") {
            return Some(val.trim().to_string());
        }
    }
    None
}

fn summarize(text: &str, max_chars: usize) -> String {
    let first_para = text.split("\n\n").next().unwrap_or(text).trim();
    if first_para.chars().count() <= max_chars {
        return first_para.to_string();
    }
    let byte_end = first_para
        .char_indices()
        .nth(max_chars)
        .map(|(i, _)| i)
        .unwrap_or(first_para.len());
    let truncated = &first_para[..byte_end];
    let last_space = truncated.rfind(' ').unwrap_or(byte_end);
    format!("{}...", &truncated[..last_space])
}
