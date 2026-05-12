use std::collections::HashSet;
use std::path::Path;
use anyhow::Context;
use rusqlite::{params, Connection};
use serde::Serialize;

use super::config::FederationConfig;
use super::visibility::VisibilityEngine;

const SCHEMA_VERSION: u32 = 1;

/// Maximum notes per multi-row INSERT chunk.
///
/// 240 rows × 6 placeholders = 1440 parameters — well under both the
/// legacy SQLite 999-param ceiling and the modern 32766 ceiling.
const INSERT_CHUNK: usize = 240;

#[derive(Debug, Serialize)]
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
         );
         CREATE TABLE links (
             source_id INTEGER NOT NULL,
             target_path TEXT NOT NULL,
             UNIQUE(source_id, target_path)
         );"
    )?;

    // --- Phase 1: load all rows from source and pre-compute visibility -------
    //
    // Reading all frontmatter here (one disk pass) is cheaper than reading
    // it per-row inside the INSERT loop.  Memory cost: ~300 B/note at 10k
    // notes ≈ 3 MB — well within the 200 MB RSS budget.

    struct NoteRow {
        id: i64,
        path: String,
        title: String,
        tags: String,
        body: String,
    }

    let mut all_rows: Vec<NoteRow> = Vec::new();
    {
        let mut stmt = source.prepare(
            "SELECT n.id, n.path, n.title, n.tags, nc.body
             FROM notes n
             JOIN notes_content nc ON nc.id = n.id"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(NoteRow {
                id:    row.get::<_, i64>(0)?,
                path:  row.get::<_, String>(1)?,
                title: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                tags:  row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                body:  row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            })
        })?;
        for row in rows {
            let mut r = row?;
            r.path = r.path.replace('\\', "/");
            all_rows.push(r);
        }
    }

    // Build visibility inputs once: (path, frontmatter_visibility).
    let vis_inputs: Vec<(String, Option<String>)> = all_rows
        .iter()
        .map(|r| (r.path.clone(), read_frontmatter_visibility(vault_path, &r.path)))
        .collect();

    // Evaluate the whole batch — O(n) glob matching, no per-row disk I/O.
    let tiers = engine.evaluate_batch(&vis_inputs);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // --- Phase 2: INSERT exported notes in chunks ---------------------------

    export.execute("BEGIN", [])?;

    let mut exported = 0usize;
    let mut skipped = 0usize;
    let mut exported_ids: HashSet<i64> = HashSet::new();

    for (row, tier) in all_rows.iter().zip(tiers.iter()) {
        if *tier == "private" {
            skipped += 1;
            continue;
        }

        let export_body = if *tier == "public" {
            row.body.clone()
        } else {
            summarize(&row.body, 300)
        };

        export.prepare_cached(
            "INSERT INTO notes (id, path, title, tags, tier, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?
        .execute(params![row.id, row.path, row.title, row.tags, tier, now])?;

        export.prepare_cached(
            "INSERT INTO notes_content (id, title, tags, body) VALUES (?1, ?2, ?3, ?4)",
        )?
        .execute(params![row.id, row.title, row.tags, export_body])?;

        exported_ids.insert(row.id);
        exported += 1;
    }

    // --- Phase 3: copy embeddings for exported notes in chunks --------------

    let mut emb_stmt = source.prepare(
        "SELECT e.id, e.data FROM embeddings e JOIN notes n ON e.id = n.id"
    )?;

    let emb_rows: Vec<(i64, Vec<u8>)> = emb_stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?
        .filter_map(|r| r.ok())
        .filter(|(id, _)| exported_ids.contains(id))
        .collect();

    for chunk in emb_rows.chunks(INSERT_CHUNK) {
        for (id, data) in chunk {
            export.prepare_cached(
                "INSERT INTO embeddings (id, data) VALUES (?1, ?2)",
            )?
            .execute(params![id, data])?;
        }
    }

    // --- Phase 4: copy links for exported notes -----------------------------

    let has_links = source
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='links'",
            [],
            |_| Ok(()),
        )
        .is_ok();

    if has_links {
        let mut link_stmt = source.prepare(
            "SELECT source_id, target_path FROM links"
        )?;
        let link_rows: Vec<(i64, String)> = link_stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .filter(|(source_id, _)| exported_ids.contains(source_id))
            .collect();

        for chunk in link_rows.chunks(INSERT_CHUNK) {
            for (source_id, target_path) in chunk {
                export.prepare_cached(
                    "INSERT OR IGNORE INTO links (source_id, target_path) VALUES (?1, ?2)",
                )?
                .execute(params![source_id, target_path])?;
            }
        }
    }

    // --- Phase 5: meta ------------------------------------------------------

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

/// Read the `visibility:` frontmatter key from a vault file.
///
/// Returns `None` if the file is missing, has no YAML frontmatter, or has no
/// `visibility` key.  Called once per note during the pre-compute phase.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn summarize_short_text_unchanged() {
        let text = "A short note.";
        assert_eq!(summarize(text, 300), "A short note.");
    }

    #[test]
    fn summarize_uses_first_paragraph_only() {
        let text = "First paragraph content.\n\nSecond paragraph that should be excluded.";
        let result = summarize(text, 300);
        assert_eq!(result, "First paragraph content.");
        assert!(!result.contains("Second"));
    }

    #[test]
    fn summarize_truncates_at_word_boundary() {
        let text = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10";
        let result = summarize(text, 20);
        assert!(result.ends_with("..."), "should end with ellipsis");
        let without_ellipsis = result.trim_end_matches("...");
        assert!(!without_ellipsis.ends_with(' '), "no trailing space before ellipsis");
        assert!(without_ellipsis.len() < 20, "truncated portion fits within limit");
    }

    #[test]
    fn summarize_exact_length_not_truncated() {
        let text = "hello";
        assert_eq!(summarize(text, 5), "hello");
    }

    #[test]
    fn summarize_empty_string() {
        assert_eq!(summarize("", 100), "");
    }

    #[test]
    fn read_frontmatter_visibility_returns_value() {
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "---\nvisibility: public\ntitle: Test\n---\n\nBody.").unwrap();
        let dir = f.path().parent().unwrap();
        let name = f.path().file_name().unwrap().to_str().unwrap();
        let result = read_frontmatter_visibility(dir, name);
        assert_eq!(result.as_deref(), Some("public"));
    }

    #[test]
    fn read_frontmatter_visibility_missing_key_returns_none() {
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "---\ntitle: No visibility key\n---\n\nBody.").unwrap();
        let dir = f.path().parent().unwrap();
        let name = f.path().file_name().unwrap().to_str().unwrap();
        let result = read_frontmatter_visibility(dir, name);
        assert_eq!(result, None);
    }

    #[test]
    fn read_frontmatter_visibility_no_frontmatter_returns_none() {
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "Just plain content without frontmatter.").unwrap();
        let dir = f.path().parent().unwrap();
        let name = f.path().file_name().unwrap().to_str().unwrap();
        let result = read_frontmatter_visibility(dir, name);
        assert_eq!(result, None);
    }

    #[test]
    fn read_frontmatter_visibility_trims_whitespace() {
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "---\nvisibility:  listed  \n---\n\nBody.").unwrap();
        let dir = f.path().parent().unwrap();
        let name = f.path().file_name().unwrap().to_str().unwrap();
        let result = read_frontmatter_visibility(dir, name);
        assert_eq!(result.as_deref(), Some("listed"));
    }
}
