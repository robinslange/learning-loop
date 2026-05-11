use ll_search::db::schema::open_db;
use rusqlite::Connection;
use tempfile::NamedTempFile;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Open a fresh, empty database via the public open_db path.
fn fresh_db() -> (NamedTempFile, Connection) {
    let f = NamedTempFile::new().expect("tempfile");
    let path = f.path().to_str().expect("utf8 path").to_owned();
    let conn = open_db(&path).expect("open_db");
    (f, conn)
}

/// Create a minimal v4-era database without any migration infrastructure:
/// notes table, meta table (schema_version = 4), no indices, no session_id.
fn v4_db() -> (NamedTempFile, Connection) {
    let f = NamedTempFile::new().expect("tempfile");
    let path = f.path().to_str().expect("utf8 path").to_owned();

    let conn = Connection::open(&path).expect("open");
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;

         CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

         CREATE TABLE notes (
             id           INTEGER PRIMARY KEY,
             path         TEXT UNIQUE NOT NULL,
             content_hash TEXT NOT NULL,
             mtime        REAL NOT NULL,
             title        TEXT,
             tags         TEXT,
             visibility   TEXT DEFAULT 'private'
         );

         CREATE TABLE notes_content (id INTEGER PRIMARY KEY, title TEXT, tags TEXT, body TEXT);

         CREATE VIRTUAL TABLE notes_fts USING fts5(
             title, tags, body,
             content='notes_content',
             content_rowid='id',
             tokenize='porter unicode61 remove_diacritics 1'
         );

         CREATE TABLE embeddings (id INTEGER PRIMARY KEY, data BLOB NOT NULL);

         CREATE TABLE links (
             source_id  INTEGER NOT NULL,
             target_path TEXT NOT NULL,
             UNIQUE(source_id, target_path)
         );
         CREATE INDEX idx_links_target ON links(target_path);

         CREATE TABLE intentions (
             note_id INTEGER NOT NULL,
             context TEXT NOT NULL,
             cue TEXT,
             PRIMARY KEY (note_id, context)
         );
         CREATE INDEX idx_intentions_context ON intentions(context);

         INSERT INTO meta (key, value) VALUES ('schema_version', '4');",
    )
    .expect("v4 schema");

    // Insert some pre-existing rows to verify they survive migration.
    conn.execute_batch(
        "INSERT INTO notes (path, content_hash, mtime, title, tags)
         VALUES ('a.md', 'hash1', 100.0, 'Note A', 'foo bar'),
                ('b.md', 'hash2', 200.0, 'Note B', NULL);",
    )
    .expect("seed rows");

    drop(conn);

    // Reopen through the full open_db stack so migrations run.
    let conn = open_db(&path).expect("open_db after v4 seed");
    (f, conn)
}

// ---------------------------------------------------------------------------
// Helpers for querying indices
// ---------------------------------------------------------------------------

fn index_names(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notes' ORDER BY name",
        )
        .expect("prepare index query");
    stmt.query_map([], |row| row.get::<_, String>(0))
        .expect("query")
        .filter_map(|r| r.ok())
        .collect()
}

fn applied_versions(conn: &Connection) -> Vec<u32> {
    let mut stmt = conn
        .prepare("SELECT version FROM _migrations ORDER BY version")
        .expect("prepare migrations query");
    stmt.query_map([], |row| row.get::<_, u32>(0))
        .expect("query")
        .filter_map(|r| r.ok())
        .collect()
}

fn schema_version(conn: &Connection) -> String {
    conn.query_row(
        "SELECT value FROM meta WHERE key = 'schema_version'",
        [],
        |row| row.get::<_, String>(0),
    )
    .expect("schema_version")
}

// ---------------------------------------------------------------------------
// Test 1: fresh DB gets all three indices
// ---------------------------------------------------------------------------

#[test]
fn migration_creates_indices_on_fresh_db() {
    let (_f, conn) = fresh_db();

    let names = index_names(&conn);

    // The three new indices must be present.
    assert!(
        names.contains(&"idx_notes_mtime".to_string()),
        "idx_notes_mtime missing; got: {names:?}"
    );
    assert!(
        names.contains(&"idx_notes_tags".to_string()),
        "idx_notes_tags missing; got: {names:?}"
    );
    assert!(
        names.contains(&"idx_notes_session_id".to_string()),
        "idx_notes_session_id missing; got: {names:?}"
    );

    // idx_notes_path must NOT appear — auto-index covers it.
    assert!(
        !names.contains(&"idx_notes_path".to_string()),
        "idx_notes_path should not be created (UNIQUE auto-index handles it)"
    );

    // Migration recorded correctly.
    assert_eq!(applied_versions(&conn), vec![1]);

    // Schema version bumped to 5.
    assert_eq!(schema_version(&conn), "5");
}

// ---------------------------------------------------------------------------
// Test 2: idempotent across reopens
// ---------------------------------------------------------------------------

#[test]
fn migration_is_idempotent_across_reopens() {
    let f = NamedTempFile::new().expect("tempfile");
    let path = f.path().to_str().expect("utf8 path").to_owned();

    // First open — runs migration.
    {
        let _conn = open_db(&path).expect("first open");
    }

    // Second open — migration must not fail or duplicate entries.
    let conn = open_db(&path).expect("second open");

    let names = index_names(&conn);
    assert!(names.contains(&"idx_notes_mtime".to_string()));
    assert!(names.contains(&"idx_notes_tags".to_string()));
    assert!(names.contains(&"idx_notes_session_id".to_string()));

    // Still exactly one entry per migration.
    assert_eq!(applied_versions(&conn), vec![1]);
    assert_eq!(schema_version(&conn), "5");
}

// ---------------------------------------------------------------------------
// Test 3: pre-existing v4 DB — session_id added, indices created, rows intact
// ---------------------------------------------------------------------------

#[test]
fn migration_upgrades_pre_existing_db_without_indices_or_session_id() {
    let (_f, conn) = v4_db();

    // All three indices must exist.
    let names = index_names(&conn);
    assert!(names.contains(&"idx_notes_mtime".to_string()));
    assert!(names.contains(&"idx_notes_tags".to_string()));
    assert!(names.contains(&"idx_notes_session_id".to_string()));

    // session_id column was added (probe succeeds).
    assert!(
        conn.prepare("SELECT session_id FROM notes LIMIT 0").is_ok(),
        "session_id column should exist after migration"
    );

    // Pre-existing rows are preserved.
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .expect("count");
    assert_eq!(count, 2, "pre-existing rows must survive migration");

    // Migration recorded; schema version updated.
    assert_eq!(applied_versions(&conn), vec![1]);
    assert_eq!(schema_version(&conn), "5");
}

// ---------------------------------------------------------------------------
// Test 4: EXPLAIN QUERY PLAN uses idx_notes_mtime
// ---------------------------------------------------------------------------

#[test]
fn explain_query_plan_uses_mtime_index() {
    let f = NamedTempFile::new().expect("tempfile");
    let path = f.path().to_str().expect("utf8 path").to_owned();
    let conn = open_db(&path).expect("open_db");

    // Seed 50 rows so the query planner chooses the index.
    for i in 0..50i64 {
        conn.execute(
            "INSERT INTO notes (path, content_hash, mtime) VALUES (?1, ?2, ?3)",
            rusqlite::params![format!("note{i}.md"), format!("hash{i}"), i as f64 * 10.0],
        )
        .expect("insert");
    }
    conn.execute_batch("ANALYZE;").expect("analyze");

    // Collect the EXPLAIN QUERY PLAN output.
    let mut stmt = conn
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM notes WHERE mtime > 200.0")
        .expect("prepare eqp");
    let plan: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(3))
        .expect("query eqp")
        .filter_map(|r| r.ok())
        .collect();

    let plan_text = plan.join(" ");
    assert!(
        plan_text.contains("idx_notes_mtime"),
        "expected idx_notes_mtime in query plan; got: {plan_text:?}"
    );
}
