use rusqlite::Connection;
use std::sync::Arc;
use tempfile::TempDir;

fn open_rw_conn(db_path: &str) -> Connection {
    Connection::open(db_path).expect("open rw connection")
}

fn create_fixture_db(dir: &TempDir) -> String {
    let db_path = dir.path().join("test.db").to_string_lossy().into_owned();
    let conn = Connection::open(&db_path).expect("open db");

    conn.execute_batch(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE notes (
             id INTEGER PRIMARY KEY,
             path TEXT UNIQUE NOT NULL,
             content_hash TEXT NOT NULL DEFAULT '',
             mtime REAL NOT NULL DEFAULT 0,
             title TEXT,
             tags TEXT,
             visibility TEXT DEFAULT 'private'
         );
         CREATE TABLE embeddings (id INTEGER PRIMARY KEY, data BLOB NOT NULL);
         CREATE TABLE links (source_id INTEGER NOT NULL, target_path TEXT NOT NULL,
             UNIQUE(source_id, target_path));",
    )
    .expect("create schema");

    conn.execute(
        "INSERT INTO notes (id, path, content_hash, mtime, title, tags) VALUES (1, 'a.md', 'h1', 1000.0, 'Note A', 'alpha')",
        [],
    )
    .expect("insert note 1");
    conn.execute(
        "INSERT INTO notes (id, path, content_hash, mtime, title, tags) VALUES (2, 'b.md', 'h2', 2000.0, 'Note B', 'beta')",
        [],
    )
    .expect("insert note 2");

    let emb: Vec<u8> = vec![0.0f32, 1.0f32, 0.0f32]
        .into_iter()
        .flat_map(|f: f32| f.to_le_bytes())
        .collect();
    conn.execute(
        "INSERT INTO embeddings (id, data) VALUES (1, ?1)",
        rusqlite::params![emb],
    )
    .expect("insert embedding 1");
    conn.execute(
        "INSERT INTO embeddings (id, data) VALUES (2, ?1)",
        rusqlite::params![emb],
    )
    .expect("insert embedding 2");

    conn.execute(
        "INSERT INTO links (source_id, target_path) VALUES (1, 'b')",
        [],
    )
    .expect("insert link");

    db_path
}

#[test]
fn app_state_constructs_from_fixture_db() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = create_fixture_db(&dir);

    let state = ll_search::app::AppState::from_db(&db_path, None)
        .expect("AppState::from_db");

    let count = state.note_count().expect("note_count");
    assert_eq!(count, 2, "expected 2 notes");

    let embeddings = state.storage.all_embeddings().expect("all_embeddings");
    assert_eq!(embeddings.len(), 2, "expected 2 embeddings");
    for (id, path, vec) in &embeddings {
        assert!(*id > 0, "id must be positive");
        assert!(!path.is_empty(), "path must not be empty");
        assert_eq!(vec.len(), 3, "embedding dim must be 3");
    }

    let titles = state.storage.titles_map().expect("titles_map");
    assert_eq!(titles.get("a.md"), Some(&Some("Note A".to_string())));
    assert_eq!(titles.get("b.md"), Some(&Some("Note B".to_string())));

    let mtimes = state.storage.mtime_map().expect("mtime_map");
    assert!(mtimes.contains_key("a.md"), "a.md must be in mtime_map");
    assert!(mtimes.contains_key("b.md"), "b.md must be in mtime_map");

    let tags = state.storage.tags_map().expect("tags_map");
    assert!(tags.contains_key("a.md"), "a.md must be in tags_map");
    let a_tags = tags.get("a.md").unwrap();
    assert!(a_tags.contains(&"alpha".to_string()), "a.md must have tag 'alpha'");
}

#[test]
fn app_state_peer_cache_default_empty() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = create_fixture_db(&dir);

    let state = ll_search::app::AppState::from_db(&db_path, None)
        .expect("AppState::from_db");

    let cache = state.peers.read();
    assert!(cache.peers.is_empty(), "peer cache must start empty");
}

#[test]
fn ensure_search_context_rebuilds_after_data_version_bump() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = create_fixture_db(&dir);

    let state = ll_search::app::AppState::from_db(&db_path, None)
        .expect("AppState::from_db");

    // Reader connection — this is what the daemon would hold long-lived.
    let reader_conn = open_rw_conn(&db_path);

    // First call builds the context.
    let ctx_v1 = state.ensure_search_context(&reader_conn);
    assert!(!ctx_v1.is_stale(&reader_conn), "freshly built context must not be stale");

    // Write via a separate connection — PRAGMA data_version increments on the
    // reader only when a *different* connection commits a write (SQLite semantics).
    {
        let writer_conn = open_rw_conn(&db_path);
        writer_conn.execute(
            "INSERT INTO notes (id, path, content_hash, mtime, title, tags) VALUES (99, 'c.md', 'h99', 3000.0, 'Note C', 'gamma')",
            [],
        ).expect("insert note c");
    }

    // The cached context should now be stale as seen from the reader.
    assert!(ctx_v1.is_stale(&reader_conn), "context must be stale after external write");

    // ensure_search_context must return a fresh context.
    let ctx_v2 = state.ensure_search_context(&reader_conn);
    assert!(!ctx_v2.is_stale(&reader_conn), "rebuilt context must not be stale");
}

#[test]
fn ensure_search_context_reuses_when_not_stale() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = create_fixture_db(&dir);

    let state = ll_search::app::AppState::from_db(&db_path, None)
        .expect("AppState::from_db");

    let conn = open_rw_conn(&db_path);

    let ctx_v1 = state.ensure_search_context(&conn);
    let ctx_v2 = state.ensure_search_context(&conn);
    // Both should point to the same Arc allocation.
    assert!(Arc::ptr_eq(&ctx_v1, &ctx_v2), "second call must reuse the same Arc");
}

#[test]
fn app_state_storage_is_arc_clone() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = create_fixture_db(&dir);

    let state = ll_search::app::AppState::from_db(&db_path, None)
        .expect("AppState::from_db");

    let storage_clone: Arc<dyn ll_search::app::Storage> = Arc::clone(&state.storage);
    let count_a = state.storage.note_count().expect("note_count from original");
    let count_b = storage_clone.note_count().expect("note_count from clone");
    assert_eq!(count_a, count_b, "cloned Arc must see same data");
}
