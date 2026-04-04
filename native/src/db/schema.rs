use rusqlite::{params, Connection};
use std::fs;
use std::path::Path;

use crate::embed::model_id;

use super::index::IndexResult;

const SCHEMA_VERSION: u32 = 3;
pub(crate) const DTYPE: &str = "q8";

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

pub(crate) fn create_schema(conn: &Connection) {
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

pub(crate) fn drop_vec0_remnants(conn: &Connection) {
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

pub(crate) fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        params![name],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
        > 0
}

pub(crate) fn drop_all(conn: &Connection) {
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
