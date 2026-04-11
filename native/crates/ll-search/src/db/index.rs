use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::embed::embed_documents;
use crate::preprocess::{content_hash, preprocess_file};

use super::query::{chrono_iso_now, compute_project_phases, compute_sessions};
use super::schema::{create_schema, drop_all};

const BATCH_SIZE: usize = 32;

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

pub fn reindex(conn: &Connection, vault_path: &str, force: bool) -> IndexResult {
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
            .prepare("SELECT id, path, content_hash, mtime FROM notes")
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            })
            .unwrap();
        for row in rows {
            let (id, path, hash, mtime) = row.unwrap();
            existing.insert(path, (id, hash, mtime));
        }
    }

    struct EmbedItem {
        path: String,
        title: String,
        tags: String,
        body: String,
        text: String,
        hash: String,
        mtime: f64,
        links: Vec<String>,
    }

    let mut to_embed: Vec<EmbedItem> = Vec::new();
    let mut to_update_mtime: Vec<(i64, f64)> = Vec::new();
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

        let hash = content_hash(&result.text).to_string();

        if let Some(&(id, ref ex_hash, _)) = ex {
            if *ex_hash == hash {
                to_update_mtime.push((id, file.mtime));
                continue;
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
            });
        } else {
            to_embed.push(EmbedItem {
                path: file.rel_path.clone(),
                title: result.title,
                tags: result.tags,
                body: result.body,
                text: result.text,
                hash,
                mtime: file.mtime,
                links: result.links,
            });
        }
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

    let mut embedded_items: Vec<(usize, Vec<f32>)> = Vec::with_capacity(to_embed.len());

    for batch_start in (0..to_embed.len()).step_by(BATCH_SIZE) {
        let batch_end = (batch_start + BATCH_SIZE).min(to_embed.len());
        let texts: Vec<String> = to_embed[batch_start..batch_end]
            .iter()
            .map(|item| item.text.clone())
            .collect();
        let vecs = embed_documents(&texts);
        for (j, vec) in vecs.into_iter().enumerate() {
            embedded_items.push((batch_start + j, vec));
        }
        eprintln!(
            "  Embedded {}/{}",
            batch_end,
            to_embed.len()
        );
    }

    conn.execute_batch("BEGIN TRANSACTION;").unwrap();

    for &(idx, ref vec) in &embedded_items {
        let item = &to_embed[idx];
        conn.execute(
            "INSERT INTO notes (path, content_hash, mtime, title, tags)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET
               content_hash = ?2, mtime = ?3, title = ?4, tags = ?5",
            params![item.path, item.hash, item.mtime, item.title, item.tags],
        )
        .unwrap();

        let note_id: i64 = conn
            .query_row(
                "SELECT id FROM notes WHERE path = ?1",
                params![item.path],
                |row| row.get(0),
            )
            .unwrap();

        conn.execute(
            "INSERT OR REPLACE INTO notes_content (id, title, tags, body) VALUES (?1, ?2, ?3, ?4)",
            params![note_id, item.title, item.tags, item.body],
        )
        .unwrap();

        conn.execute("DELETE FROM embeddings WHERE id = ?1", params![note_id])
            .unwrap();

        let blob: Vec<u8> = vec.iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.execute(
            "INSERT INTO embeddings (id, data) VALUES (?1, ?2)",
            params![note_id, blob],
        )
        .unwrap();

        conn.execute("DELETE FROM links WHERE source_id = ?1", params![note_id])
            .unwrap();
        for target in &item.links {
            conn.execute(
                "INSERT OR IGNORE INTO links (source_id, target_path) VALUES (?1, ?2)",
                params![note_id, target],
            )
            .unwrap();
        }
    }

    for &(id, mtime) in &to_update_mtime {
        conn.execute(
            "UPDATE notes SET mtime = ?1 WHERE id = ?2",
            params![mtime, id],
        )
        .unwrap();
    }

    for &id in &to_delete {
        conn.execute("DELETE FROM embeddings WHERE id = ?1", params![id])
            .unwrap();
        conn.execute("DELETE FROM links WHERE source_id = ?1", params![id])
            .unwrap();
        conn.execute("DELETE FROM notes_content WHERE id = ?1", params![id])
            .unwrap();
        conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
            .unwrap();
    }

    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .unwrap_or(0);

    let now = chrono_iso_now();
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params!["indexed_at", now],
    )
    .unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params!["note_count", total.to_string()],
    )
    .unwrap();

    conn.execute_batch("COMMIT;").unwrap();

    let total = total as usize;
    eprintln!("Index complete: {} notes indexed", total);

    compute_sessions(conn);
    compute_project_phases(conn);

    IndexResult {
        embedded: embedded_items.len(),
        deleted: to_delete.len(),
        total,
    }
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
