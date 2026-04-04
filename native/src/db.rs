use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::embed::{embed_documents, model_id};
use crate::preprocess::{content_hash, preprocess_file};

const SCHEMA_VERSION: u32 = 3;
const DTYPE: &str = "q8";
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

#[derive(Serialize)]
pub struct Status {
    #[serde(rename = "noteCount")]
    pub note_count: i64,
    #[serde(rename = "vaultFileCount")]
    pub vault_file_count: usize,
    #[serde(rename = "missingFromIndex")]
    pub missing_from_index: i64,
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub dtype: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: String,
    #[serde(rename = "indexedAt")]
    pub indexed_at: String,
}

pub fn open_db(db_path: &str) -> Connection {
    if let Some(parent) = Path::new(db_path).parent() {
        fs::create_dir_all(parent).ok();
    }

    let conn = Connection::open(db_path).expect("failed to open database");
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
        .expect("failed to set pragmas");

    let has_meta: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='meta'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    if !has_meta {
        create_schema(&conn);
    }

    ensure_embeddings_table(&conn);
    ensure_links_table(&conn);
    conn
}

fn create_schema(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            content_hash TEXT NOT NULL,
            mtime REAL NOT NULL,
            title TEXT,
            tags TEXT,
            visibility TEXT DEFAULT 'private'
        );

        CREATE TABLE IF NOT EXISTS notes_content (
            id INTEGER PRIMARY KEY,
            title TEXT,
            tags TEXT,
            body TEXT
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            title, tags, body,
            content='notes_content',
            content_rowid='id',
            tokenize='porter unicode61 remove_diacritics 1'
        );

        CREATE TABLE IF NOT EXISTS embeddings (
            id INTEGER PRIMARY KEY,
            data BLOB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS links (
            source_id INTEGER NOT NULL,
            target_path TEXT NOT NULL,
            UNIQUE(source_id, target_path)
        );
        CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_path);

        CREATE TRIGGER IF NOT EXISTS notes_content_ai AFTER INSERT ON notes_content BEGIN
            INSERT INTO notes_fts(rowid, title, tags, body)
            VALUES (new.id, new.title, new.tags, new.body);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_content_ad AFTER DELETE ON notes_content BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, tags, body)
            VALUES ('delete', old.id, old.title, old.tags, old.body);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_content_au AFTER UPDATE ON notes_content BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, tags, body)
            VALUES ('delete', old.id, old.title, old.tags, old.body);
            INSERT INTO notes_fts(rowid, title, tags, body)
            VALUES (new.id, new.title, new.tags, new.body);
        END;",
    )
    .expect("failed to create schema");

    let upsert = "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)";
    conn.execute(upsert, params!["schema_version", SCHEMA_VERSION.to_string()])
        .unwrap();
    conn.execute(upsert, params!["model_id", model_id()]).unwrap();
    conn.execute(upsert, params!["dtype", DTYPE]).unwrap();
    conn.execute(upsert, params!["indexed_at", ""]).unwrap();
    conn.execute(upsert, params!["note_count", "0"]).unwrap();
}

fn ensure_embeddings_table(conn: &Connection) {
    if !table_exists(conn, "embeddings") {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS embeddings (id INTEGER PRIMARY KEY, data BLOB NOT NULL);",
        )
        .expect("failed to create embeddings table");
    }
}

fn ensure_links_table(conn: &Connection) {
    if !table_exists(conn, "links") {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS links (
                source_id INTEGER NOT NULL,
                target_path TEXT NOT NULL,
                UNIQUE(source_id, target_path)
            );
            CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_path);",
        )
        .expect("failed to create links table");
    }
}

fn drop_vec0_remnants(conn: &Connection) {
    // vec0 virtual tables can't be dropped without the vec0 module loaded.
    // Drop the underlying storage tables directly, ignore errors.
    for t in &[
        "note_embeddings_vector_chunks00",
        "note_embeddings_rowids",
        "note_embeddings_chunks",
        "note_embeddings_info",
        "note_embeddings",
    ] {
        conn.execute_batch(&format!("DROP TABLE IF EXISTS \"{}\";", t))
            .ok();
    }
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        params![name],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
        > 0
}

fn drop_all(conn: &Connection) {
    conn.execute_batch(
        "DROP TABLE IF EXISTS links;
        DROP TABLE IF EXISTS embeddings;
        DROP TABLE IF EXISTS notes_fts;
        DROP TRIGGER IF EXISTS notes_content_ai;
        DROP TRIGGER IF EXISTS notes_content_ad;
        DROP TRIGGER IF EXISTS notes_content_au;
        DROP TABLE IF EXISTS notes_content;
        DROP TABLE IF EXISTS notes;
        DROP TABLE IF EXISTS meta;",
    )
    .expect("failed to drop tables");
    drop_vec0_remnants(conn);
    conn.execute_batch("VACUUM;").ok();
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

pub fn compute_sessions(conn: &Connection) {
    let has_session_col = conn.prepare("SELECT session_id FROM notes LIMIT 0").is_ok();
    if !has_session_col {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN session_id INTEGER;").unwrap();
    }

    let mut notes: Vec<(i64, f64)> = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT id, mtime FROM notes ORDER BY mtime") {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
        }) {
            for row in rows.flatten() {
                notes.push(row);
            }
        }
    }

    if notes.is_empty() {
        return;
    }

    let gaps_min: Vec<f64> = notes.windows(2)
        .map(|w| ((w[1].1 - w[0].1) / 60_000.0).max(0.0))
        .collect();

    let threshold_min = find_session_threshold(&gaps_min);
    eprintln!("Session threshold: {:.0} minutes ({} notes)", threshold_min, notes.len());

    let mut session_id: i64 = 0;
    let mut assignments: Vec<(i64, i64)> = Vec::with_capacity(notes.len());
    assignments.push((notes[0].0, session_id));

    for i in 1..notes.len() {
        let gap_min = (notes[i].1 - notes[i - 1].1) / 60_000.0;
        if gap_min > threshold_min {
            session_id += 1;
        }
        assignments.push((notes[i].0, session_id));
    }

    conn.execute_batch("BEGIN TRANSACTION;").unwrap();
    for (note_id, sid) in &assignments {
        conn.execute(
            "UPDATE notes SET session_id = ?1 WHERE id = ?2",
            params![sid, note_id],
        ).ok();
    }
    conn.execute_batch("COMMIT;").unwrap();

    eprintln!("Assigned {} sessions across {} notes", session_id + 1, notes.len());
}

fn find_session_threshold(gaps_min: &[f64]) -> f64 {
    if gaps_min.is_empty() {
        return 30.0;
    }

    let max_bucket = 480;
    let mut counts = vec![0u32; max_bucket + 1];
    for &g in gaps_min {
        let bucket = (g as usize).min(max_bucket);
        counts[bucket] += 1;
    }

    let window = 10i32;
    let mut smoothed = vec![0.0f64; max_bucket + 1];
    for m in 0..=max_bucket {
        let mut sum = 0.0;
        let mut n = 0;
        for d in -window..=window {
            let idx = m as i32 + d;
            if idx >= 0 && idx <= max_bucket as i32 {
                sum += counts[idx as usize] as f64;
                n += 1;
            }
        }
        smoothed[m] = sum / n as f64;
    }

    let search_start = 15;
    let search_end = 120.min(max_bucket);
    let mut min_val = f64::MAX;
    let mut min_idx = 30;

    for m in search_start..=search_end {
        if smoothed[m] < min_val {
            min_val = smoothed[m];
            min_idx = m;
        }
    }

    min_idx as f64
}

pub fn compute_project_phases(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_phases (
            tag TEXT PRIMARY KEY,
            first_mtime REAL,
            last_mtime REAL,
            note_count INTEGER
        );"
    ).ok();

    let mut tag_data: HashMap<String, (f64, f64, usize)> = HashMap::new();

    if let Ok(mut stmt) = conn.prepare("SELECT tags, mtime FROM notes WHERE tags IS NOT NULL AND tags != ''") {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        }) {
            for row in rows.flatten() {
                let (tags_str, mtime) = row;
                let mtime_sec = mtime / 1000.0;
                for tag in tags_str.split_whitespace() {
                    let tag = tag.to_lowercase();
                    if tag.is_empty() {
                        continue;
                    }
                    let entry = tag_data.entry(tag).or_insert((f64::MAX, f64::MIN, 0));
                    entry.0 = entry.0.min(mtime_sec);
                    entry.1 = entry.1.max(mtime_sec);
                    entry.2 += 1;
                }
            }
        }
    }

    conn.execute_batch("DELETE FROM project_phases;").ok();
    for (tag, (first, last, count)) in &tag_data {
        if *count >= 3 {
            conn.execute(
                "INSERT OR REPLACE INTO project_phases (tag, first_mtime, last_mtime, note_count) VALUES (?1, ?2, ?3, ?4)",
                params![tag, first, last, count],
            ).ok();
        }
    }

    eprintln!("Computed {} project phase tags", tag_data.len());
}

pub fn get_status(conn: &Connection, vault_path: &str) -> Status {
    let mut meta: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT key, value FROM meta").unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap();
        for row in rows {
            let (k, v) = row.unwrap();
            meta.insert(k, v);
        }
    }

    let note_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .unwrap_or(0);

    let vault_files = walk_vault(vault_path);

    Status {
        note_count,
        vault_file_count: vault_files.len(),
        missing_from_index: vault_files.len() as i64 - note_count,
        model_id: meta
            .get("model_id")
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        dtype: meta
            .get("dtype")
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        schema_version: meta
            .get("schema_version")
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        indexed_at: meta
            .get("indexed_at")
            .cloned()
            .unwrap_or_else(|| "never".into()),
    }
}

pub fn load_embedding(conn: &Connection, note_id: i64) -> Option<Vec<f32>> {
    conn.query_row(
        "SELECT data FROM embeddings WHERE id = ?1",
        params![note_id],
        |row| {
            let blob: Vec<u8> = row.get(0)?;
            Ok(blob
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect())
        },
    )
    .ok()
}

pub fn load_all_embeddings(conn: &Connection) -> Vec<(i64, String, Vec<f32>)> {
    let mut stmt = match conn.prepare(
        "SELECT e.id, n.path, e.data FROM embeddings e JOIN notes n ON e.id = n.id",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map([], |row| {
        let id: i64 = row.get(0)?;
        let path: String = row.get(1)?;
        let blob: Vec<u8> = row.get(2)?;
        let vec: Vec<f32> = blob
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        Ok((id, path, vec))
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    rows.filter_map(|r| r.ok()).collect()
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

pub fn chrono_iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;

    let (year, month, day) = days_to_ymd(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

pub fn check_model_mismatch(conn: &Connection, active_model_id: &str) -> bool {
    let stored: String = conn
        .query_row("SELECT value FROM meta WHERE key = 'model_id'", [], |r| r.get(0))
        .unwrap_or_else(|_| "unknown".to_string());
    stored != active_model_id
}

pub fn migrate_embeddings(
    conn: &Connection,
    provider: &dyn crate::model::EmbeddingProvider,
) -> IndexResult {
    let model_id = provider.model_id();
    eprintln!("Migrating embeddings to {} ...", model_id);

    conn.execute_batch("DROP TABLE IF EXISTS embeddings_new;").ok();
    conn.execute_batch(
        "CREATE TABLE embeddings_new (id INTEGER PRIMARY KEY, data BLOB NOT NULL);",
    )
    .expect("create embeddings_new");

    let notes: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT n.id, nc.body FROM notes n JOIN notes_content nc ON n.id = nc.id")
            .unwrap();
        stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    };

    let batch_size = 32;
    let total = notes.len();
    let mut embedded = 0;

    for chunk in notes.chunks(batch_size) {
        let texts: Vec<String> = chunk.iter().map(|(_, body)| body.clone()).collect();
        let vecs = provider.embed_documents(&texts).expect("embed failed");

        conn.execute_batch("BEGIN TRANSACTION;").unwrap();
        for ((id, _), vec) in chunk.iter().zip(vecs.iter()) {
            let blob: Vec<u8> = vec.iter().flat_map(|f| f.to_le_bytes()).collect();
            conn.execute(
                "INSERT OR REPLACE INTO embeddings_new (id, data) VALUES (?1, ?2)",
                params![id, blob],
            )
            .unwrap();
        }
        conn.execute_batch("COMMIT;").unwrap();

        embedded += chunk.len();
        eprintln!("  Migrated {}/{}", embedded, total);
    }

    conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
    conn.execute_batch("ALTER TABLE embeddings RENAME TO embeddings_old;")
        .unwrap();
    conn.execute_batch("ALTER TABLE embeddings_new RENAME TO embeddings;")
        .unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params!["model_id", model_id],
    )
    .unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params!["schema_version", SCHEMA_VERSION.to_string()],
    )
    .unwrap();
    conn.execute_batch("COMMIT;").unwrap();

    eprintln!("Migration complete. Old embeddings retained in 'embeddings_old'.");

    IndexResult {
        embedded,
        deleted: 0,
        total,
    }
}

pub fn drop_old_embeddings(conn: &Connection) {
    conn.execute_batch("DROP TABLE IF EXISTS embeddings_old;")
        .ok();
    conn.execute_batch("VACUUM;").ok();
}

#[derive(Serialize)]
pub struct TagInfo {
    pub tag: String,
    pub count: usize,
    pub first_mtime: f64,
    pub last_mtime: f64,
}

pub fn list_tags(conn: &Connection, min_count: usize) -> Vec<TagInfo> {
    let mut result: Vec<TagInfo> = Vec::new();

    if let Ok(mut stmt) = conn.prepare(
        "SELECT tag, note_count, first_mtime, last_mtime FROM project_phases WHERE note_count >= ?1 ORDER BY note_count DESC"
    ) {
        if let Ok(rows) = stmt.query_map(params![min_count as i64], |row| {
            Ok(TagInfo {
                tag: row.get(0)?,
                count: row.get::<_, i64>(1)? as usize,
                first_mtime: row.get(2)?,
                last_mtime: row.get(3)?,
            })
        }) {
            result = rows.filter_map(|r| r.ok()).collect();
        }
    }

    result
}

#[derive(Serialize)]
pub struct SessionInfo {
    pub session_id: i64,
    pub note_count: usize,
    pub first_mtime: f64,
    pub last_mtime: f64,
    pub sample_titles: Vec<String>,
}

pub fn list_sessions(conn: &Connection, min_notes: usize) -> Vec<SessionInfo> {
    let has_session_col = conn.prepare("SELECT session_id FROM notes LIMIT 0").is_ok();
    if !has_session_col {
        return Vec::new();
    }

    let mut sessions: HashMap<i64, (usize, f64, f64, Vec<String>)> = HashMap::new();

    if let Ok(mut stmt) = conn.prepare(
        "SELECT n.session_id, n.mtime, nc.title FROM notes n LEFT JOIN notes_content nc ON n.id = nc.id WHERE n.session_id IS NOT NULL ORDER BY n.mtime"
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        }) {
            for row in rows.flatten() {
                let (sid, mtime, title) = row;
                let mtime_sec = mtime / 1000.0;
                let entry = sessions.entry(sid).or_insert((0, f64::MAX, f64::MIN, Vec::new()));
                entry.0 += 1;
                entry.1 = entry.1.min(mtime_sec);
                entry.2 = entry.2.max(mtime_sec);
                if entry.3.len() < 3 {
                    if let Some(t) = title {
                        entry.3.push(t);
                    }
                }
            }
        }
    }

    let mut result: Vec<SessionInfo> = sessions
        .into_iter()
        .filter(|(_, (count, _, _, _))| *count >= min_notes)
        .map(|(sid, (count, first, last, titles))| SessionInfo {
            session_id: sid,
            note_count: count,
            first_mtime: first,
            last_mtime: last,
            sample_titles: titles,
        })
        .collect();

    result.sort_by(|a, b| b.first_mtime.partial_cmp(&a.first_mtime).unwrap_or(std::cmp::Ordering::Equal));
    result
}

pub fn days_to_ymd(days_since_epoch: u64) -> (u64, u64, u64) {
    let z = days_since_epoch + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
