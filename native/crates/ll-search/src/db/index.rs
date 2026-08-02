use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::config::EMBED_BATCH_SIZE;
use crate::embed::embed_documents;
use crate::preprocess::{content_hash_parts, preprocess_file, Intention};

use super::query::{chrono_iso_now, compute_project_phases, compute_sessions};
use super::schema::{create_schema, drop_all};

#[derive(Debug, Clone)]
pub struct WalkEntry {
    pub rel_path: String,
    pub full_path: String,
    pub mtime: f64,
}

#[derive(Serialize)]
pub struct IndexResult {
    pub embedded: usize,
    pub deleted: usize,
    pub total: usize,
}

/// One fully-preprocessed note ready for database insertion.
pub struct EmbedItem {
    pub path: String,
    pub title: String,
    pub tags: String,
    pub body: String,
    pub text: String,
    pub hash: String,
    pub mtime: f64,
    pub links: Vec<String>,
    pub intentions: Vec<Intention>,
}

/// SQL for the three FTS content-sync triggers managed by schema.rs.
///
/// We temporarily drop these triggers during batch inserts to avoid N
/// per-row FTS writes, then rebuild the FTS index once at the end and
/// recreate the triggers.  This is the dominant throughput win for large
/// batches.
const FTS_TRIGGER_AI: &str =
    "CREATE TRIGGER IF NOT EXISTS notes_content_ai AFTER INSERT ON notes_content BEGIN
        INSERT INTO notes_fts(rowid, title, tags, body)
        VALUES (new.id, new.title, new.tags, new.body);
    END;";

const FTS_TRIGGER_AD: &str =
    "CREATE TRIGGER IF NOT EXISTS notes_content_ad AFTER DELETE ON notes_content BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, tags, body)
        VALUES ('delete', old.id, old.title, old.tags, old.body);
    END;";

const FTS_TRIGGER_AU: &str =
    "CREATE TRIGGER IF NOT EXISTS notes_content_au AFTER UPDATE ON notes_content BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, tags, body)
        VALUES ('delete', old.id, old.title, old.tags, old.body);
        INSERT INTO notes_fts(rowid, title, tags, body)
        VALUES (new.id, new.title, new.tags, new.body);
    END;";

/// Write a batch of already-embedded notes into an open transaction.
///
/// **Plan B — FTS bypass + `prepare_cached` + `RETURNING id`:**
/// 1. Drop the three FTS content-sync triggers on `notes_content`.
/// 2. Run all per-note inserts with `prepare_cached`; `INSERT … RETURNING id`
///    eliminates the per-note `SELECT id` round-trip.
/// 3. Rebuild the FTS index once via `INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`.
/// 4. Recreate the three triggers.
///
/// This reduces O(N) FTS writes to one bulk rebuild, which is the dominant
/// throughput improvement for large batches (≥1k notes).
///
/// The caller is responsible for wrapping this in a transaction and
/// committing afterwards.  FTS is consistent at commit time.
///
/// Exposed as `pub` so benchmarks and integration tests can drive the write
/// path without going through the full `reindex` pipeline (including ONNX).
pub fn insert_embedded(
    conn: &Connection,
    items: &[&EmbedItem],
    vecs: &[Vec<f32>],
) -> Result<()> {
    debug_assert_eq!(items.len(), vecs.len(), "items and vecs must be 1-to-1");

    // Drop FTS triggers for the duration of this batch so each notes_content
    // write doesn't fan out to a separate FTS row operation.
    conn.execute_batch(
        "DROP TRIGGER IF EXISTS notes_content_ai;
         DROP TRIGGER IF EXISTS notes_content_ad;
         DROP TRIGGER IF EXISTS notes_content_au;",
    )?;

    for (item, vec) in items.iter().zip(vecs.iter()) {
        let note_id: i64 = conn
            .prepare_cached(
                "INSERT INTO notes (path, content_hash, mtime, title, tags)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(path) DO UPDATE SET
                   content_hash = excluded.content_hash,
                   mtime = excluded.mtime,
                   title = excluded.title,
                   tags = excluded.tags
                 RETURNING id",
            )?
            .query_row(
                params![item.path, item.hash, item.mtime, item.title, item.tags],
                |row| row.get(0),
            )?;

        conn.prepare_cached(
            "INSERT OR REPLACE INTO notes_content (id, title, tags, body) VALUES (?1, ?2, ?3, ?4)",
        )?
        .execute(params![note_id, item.title, item.tags, item.body])?;

        conn.prepare_cached("DELETE FROM embeddings WHERE id = ?1")?
            .execute(params![note_id])?;

        let blob: Vec<u8> = vec.iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.prepare_cached(
            "INSERT INTO embeddings (id, data) VALUES (?1, ?2)",
        )?
        .execute(params![note_id, blob])?;

        conn.prepare_cached("DELETE FROM links WHERE source_id = ?1")?
            .execute(params![note_id])?;
        {
            let mut link_stmt = conn.prepare_cached(
                "INSERT OR IGNORE INTO links (source_id, target_path) VALUES (?1, ?2)",
            )?;
            for target in &item.links {
                link_stmt.execute(params![note_id, target])?;
            }
        }

        conn.prepare_cached("DELETE FROM intentions WHERE note_id = ?1")?
            .execute(params![note_id])?;
        {
            let mut intent_stmt = conn.prepare_cached(
                "INSERT OR REPLACE INTO intentions (note_id, context, cue) VALUES (?1, ?2, ?3)",
            )?;
            for intent in &item.intentions {
                intent_stmt.execute(params![note_id, intent.context, intent.cue])?;
            }
        }
    }

    // Rebuild FTS from the current notes_content rows (one pass), then restore
    // the per-row triggers so incremental updates after this batch work normally.
    conn.execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('rebuild');")?;
    conn.execute_batch(FTS_TRIGGER_AI)?;
    conn.execute_batch(FTS_TRIGGER_AD)?;
    conn.execute_batch(FTS_TRIGGER_AU)?;

    Ok(())
}

pub fn reindex(conn: &Connection, vault_path: &str, force: bool) -> Result<IndexResult> {
    if force {
        eprintln!("Force rebuild: dropping all tables...");
        drop_all(conn);
        create_schema(conn);
    }

    let vault_files = walk_vault(vault_path);
    let vault_paths: HashSet<&str> = vault_files.iter().map(|f| f.rel_path.as_str()).collect();

    let mut existing: HashMap<String, (i64, String, f64)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, path, content_hash, mtime FROM notes")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            })?;
        for row in rows {
            let (id, path, hash, mtime) = row?;
            existing.insert(path, (id, hash, mtime));
        }
    }

    let mut to_embed: Vec<EmbedItem> = Vec::new();
    let mut to_update_mtime: Vec<(i64, f64)> = Vec::new();
    let mut to_update_intentions: Vec<(i64, Vec<Intention>)> = Vec::new();
    let mut to_delete: Vec<i64> = Vec::new();
    let mut skipped: usize = 0;

    for file in &vault_files {
        let ex = existing.get(&file.rel_path);

        if let Some(&(_, _, ex_mtime)) = ex {
            if (ex_mtime - file.mtime).abs() < 1.0 {
                skipped += 1;
                continue;
            }
        }

        let raw = match fs::read_to_string(&file.full_path) {
            Ok(s) => s,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        let filename = Path::new(&file.rel_path)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or(&file.rel_path);

        let result = match preprocess_file(&raw, filename) {
            Some(r) => r,
            None => {
                skipped += 1;
                continue;
            }
        };

        let hash = content_hash_parts(&result.title, &result.tags, &result.body);

        if let Some(&(id, ref ex_hash, _)) = ex {
            if *ex_hash == hash {
                to_update_mtime.push((id, file.mtime));
                to_update_intentions.push((id, result.intentions));
                continue;
            }
        }

        to_embed.push(EmbedItem {
            path: file.rel_path.clone(),
            title: result.title,
            tags: result.tags,
            body: result.body,
            text: result.text,
            hash,
            mtime: file.mtime,
            links: result.links,
            intentions: result.intentions,
        });
    }

    for (path, &(id, _, _)) in &existing {
        if !vault_paths.contains(path.as_str()) {
            to_delete.push(id);
        }
    }

    eprintln!(
        "Index: {} to embed, {} mtime-only, {} to delete, {} unchanged",
        to_embed.len(),
        to_update_mtime.len(),
        to_delete.len(),
        skipped
    );

    let mut embedded_vecs: Vec<Vec<f32>> = Vec::with_capacity(to_embed.len());

    for batch_start in (0..to_embed.len()).step_by(EMBED_BATCH_SIZE) {
        let batch_end = (batch_start + EMBED_BATCH_SIZE).min(to_embed.len());
        let texts: Vec<String> = to_embed[batch_start..batch_end]
            .iter()
            .map(|item| item.text.clone())
            .collect();
        let vecs = embed_documents(&texts);
        embedded_vecs.extend(vecs);
        eprintln!("  Embedded {}/{}", batch_end, to_embed.len());
    }

    conn.execute_batch("BEGIN TRANSACTION;")?;

    let item_refs: Vec<&EmbedItem> = to_embed.iter().collect();
    insert_embedded(conn, &item_refs, &embedded_vecs)?;

    for &(id, mtime) in &to_update_mtime {
        conn.prepare_cached("UPDATE notes SET mtime = ?1 WHERE id = ?2")?
            .execute(params![mtime, id])?;
    }

    for (id, intentions) in &to_update_intentions {
        conn.prepare_cached("DELETE FROM intentions WHERE note_id = ?1")?
            .execute(params![id])?;
        let mut stmt = conn.prepare_cached(
            "INSERT OR REPLACE INTO intentions (note_id, context, cue) VALUES (?1, ?2, ?3)",
        )?;
        for intent in intentions {
            stmt.execute(params![id, intent.context, intent.cue])?;
        }
    }

    for &id in &to_delete {
        conn.prepare_cached("DELETE FROM embeddings WHERE id = ?1")?
            .execute(params![id])?;
        conn.prepare_cached("DELETE FROM links WHERE source_id = ?1")?
            .execute(params![id])?;
        conn.prepare_cached("DELETE FROM intentions WHERE note_id = ?1")?
            .execute(params![id])?;
        conn.prepare_cached("DELETE FROM notes_content WHERE id = ?1")?
            .execute(params![id])?;
        conn.prepare_cached("DELETE FROM notes WHERE id = ?1")?
            .execute(params![id])?;
    }

    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .unwrap_or(0);

    let now = chrono_iso_now();
    conn.prepare_cached(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
    )?
    .execute(params!["indexed_at", now])?;
    conn.prepare_cached(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
    )?
    .execute(params!["note_count", total.to_string()])?;

    conn.execute_batch("COMMIT;")?;

    let total = total as usize;
    eprintln!("Index complete: {} notes indexed", total);

    compute_sessions(conn);
    compute_project_phases(conn);

    conn.execute(
        "DELETE FROM intentions WHERE note_id NOT IN (SELECT id FROM notes)",
        [],
    )
    .ok();

    Ok(IndexResult {
        embedded: embedded_vecs.len(),
        deleted: to_delete.len(),
        total,
    })
}

pub fn walk_vault(vault_path: &str) -> Vec<WalkEntry> {
    let mut entries = Vec::new();
    walk_dir(Path::new(vault_path), Path::new(vault_path), &mut entries);
    entries
}

fn walk_dir(root: &Path, dir: &Path, entries: &mut Vec<WalkEntry>) {
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        if ft.is_dir() {
            if name_str.starts_with('_') {
                continue;
            }
            walk_dir(root, &path, entries);
        } else if name_str.ends_with(".md") {
            let mtime = match fs::metadata(&path) {
                Ok(m) => {
                    m.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs_f64() * 1000.0)
                        .unwrap_or(0.0)
                }
                Err(_) => continue,
            };

            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");

            entries.push(WalkEntry {
                rel_path: rel,
                full_path: path.to_string_lossy().to_string(),
                mtime,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_or_create_db;
    use tempfile::TempDir;

    fn make_item(path: &str, title: &str, body: &str) -> EmbedItem {
        EmbedItem {
            path: path.to_string(),
            title: title.to_string(),
            tags: String::new(),
            body: body.to_string(),
            text: format!("{title} {body}"),
            hash: format!("hash-{path}"),
            mtime: 1640000000.0,
            links: Vec::new(),
            intentions: Vec::new(),
        }
    }

    fn open_temp_db() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.db").to_str().unwrap().to_string();
        let conn = open_or_create_db(&path).unwrap();
        (dir, conn)
    }

    #[test]
    fn insert_embedded_returns_correct_row_count() {
        let (_dir, conn) = open_temp_db();
        let items = [
            make_item("a.md", "Alpha", "body of alpha"),
            make_item("b.md", "Beta", "body of beta"),
        ];
        let vecs = [vec![0.1_f32; 384], vec![0.2_f32; 384]];
        let refs: Vec<&EmbedItem> = items.iter().collect();

        conn.execute_batch("BEGIN TRANSACTION;").unwrap();
        insert_embedded(&conn, &refs, &vecs).unwrap();
        conn.execute_batch("COMMIT;").unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn insert_embedded_fts_is_searchable_after_insert() {
        let (_dir, conn) = open_temp_db();
        let item = make_item("fts-test.md", "Unique FTS Title", "xyzzy placeholder content");
        let vec = vec![0.5_f32; 384];

        conn.execute_batch("BEGIN TRANSACTION;").unwrap();
        insert_embedded(&conn, &[&item], std::slice::from_ref(&vec)).unwrap();
        conn.execute_batch("COMMIT;").unwrap();

        let hit: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'xyzzy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hit, 1, "FTS should index the inserted note body");
    }

    #[test]
    fn insert_embedded_upsert_updates_existing_note() {
        let (_dir, conn) = open_temp_db();
        let item_v1 = make_item("upsert.md", "Version 1", "old body");
        let item_v2 = make_item("upsert.md", "Version 2", "new body");
        let vec = vec![0.1_f32; 384];

        conn.execute_batch("BEGIN TRANSACTION;").unwrap();
        insert_embedded(&conn, &[&item_v1], std::slice::from_ref(&vec)).unwrap();
        conn.execute_batch("COMMIT;").unwrap();

        conn.execute_batch("BEGIN TRANSACTION;").unwrap();
        insert_embedded(&conn, &[&item_v2], std::slice::from_ref(&vec)).unwrap();
        conn.execute_batch("COMMIT;").unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "upsert should not duplicate the note");

        let title: String = conn
            .query_row("SELECT title FROM notes WHERE path = 'upsert.md'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(title, "Version 2");
    }

    #[test]
    fn insert_embedded_fts_triggers_restored_after_batch() {
        let (_dir, conn) = open_temp_db();
        let item = make_item("trigger-test.md", "Trigger Test", "initial body");
        let vec = vec![0.1_f32; 384];

        conn.execute_batch("BEGIN TRANSACTION;").unwrap();
        insert_embedded(&conn, &[&item], std::slice::from_ref(&vec)).unwrap();
        conn.execute_batch("COMMIT;").unwrap();

        // Verify the trigger exists again after the batch
        let trigger_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='notes_content_ai'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(trigger_count, 1, "notes_content_ai trigger should be restored after insert_embedded");

        // Verify incremental FTS updates work after restore
        conn.execute(
            "INSERT INTO notes_content (id, title, tags, body) VALUES (9999, 'Manual Insert', '', 'postbatch content')",
            [],
        ).unwrap();
        let fts_hit: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'postbatch'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fts_hit, 1, "trigger should fire for inserts after insert_embedded completes");
    }
}
