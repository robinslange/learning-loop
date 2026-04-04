#[cfg(test)]
pub(crate) mod helpers {
    use rusqlite::{params, Connection};

    pub fn create_test_db(notes: &[(&str, &str, &str, &[f32])]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE notes (
                 id INTEGER PRIMARY KEY,
                 path TEXT UNIQUE NOT NULL,
                 content_hash TEXT NOT NULL,
                 mtime REAL NOT NULL,
                 title TEXT,
                 tags TEXT,
                 visibility TEXT DEFAULT 'private'
             );
             CREATE TABLE notes_content (
                 id INTEGER PRIMARY KEY,
                 title TEXT,
                 tags TEXT,
                 body TEXT
             );
             CREATE VIRTUAL TABLE notes_fts USING fts5(
                 title, tags, body,
                 content='notes_content',
                 content_rowid='id',
                 tokenize='porter unicode61 remove_diacritics 1'
             );
             CREATE TABLE embeddings (
                 id INTEGER PRIMARY KEY,
                 data BLOB NOT NULL
             );
             INSERT INTO meta (key, value) VALUES ('model_id', 'test-model');",
        )
        .unwrap();

        for (i, (path, title, body, emb)) in notes.iter().enumerate() {
            let id = (i + 1) as i64;
            conn.execute(
                "INSERT INTO notes (id, path, content_hash, mtime, title, tags) VALUES (?1, ?2, 'hash', 0.0, ?3, '')",
                params![id, path, title],
            ).unwrap();
            conn.execute(
                "INSERT INTO notes_content (id, title, tags, body) VALUES (?1, ?2, '', ?3)",
                params![id, title, body],
            ).unwrap();
            let blob: Vec<u8> = emb.iter().flat_map(|f| f.to_le_bytes()).collect();
            conn.execute(
                "INSERT INTO embeddings (id, data) VALUES (?1, ?2)",
                params![id, blob],
            ).unwrap();
        }

        conn.execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").unwrap();
        conn
    }

    pub fn create_peer_db(notes: &[(&str, &str, &str, &[f32])]) -> Connection {
        create_test_db(notes)
    }

    pub fn create_peer_db_no_embeddings(notes: &[(&str, &str, &str)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE notes (
                 id INTEGER PRIMARY KEY,
                 path TEXT UNIQUE NOT NULL,
                 title TEXT,
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
             CREATE VIRTUAL TABLE notes_fts USING fts5(
                 title, tags, body,
                 content='notes_content',
                 content_rowid='id',
                 tokenize='porter unicode61 remove_diacritics 1'
             );
             INSERT INTO meta (key, value) VALUES ('model_id', 'test-model');",
        )
        .unwrap();

        for (i, (path, title, body)) in notes.iter().enumerate() {
            let id = (i + 1) as i64;
            conn.execute(
                "INSERT INTO notes (id, path, title, tags, tier, updated_at) VALUES (?1, ?2, ?3, '', 'public', 0)",
                params![id, path, title],
            ).unwrap();
            conn.execute(
                "INSERT INTO notes_content (id, title, tags, body) VALUES (?1, ?2, '', ?3)",
                params![id, title, body],
            ).unwrap();
        }

        conn.execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").unwrap();
        conn
    }

    pub fn create_peer_db_no_fts(notes: &[(&str, &str, &[f32])]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE notes (
                 id INTEGER PRIMARY KEY,
                 path TEXT UNIQUE NOT NULL,
                 title TEXT,
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
             CREATE TABLE embeddings (
                 id INTEGER PRIMARY KEY,
                 data BLOB NOT NULL
             );
             INSERT INTO meta (key, value) VALUES ('model_id', 'test-model');",
        )
        .unwrap();

        for (i, (path, title, emb)) in notes.iter().enumerate() {
            let id = (i + 1) as i64;
            conn.execute(
                "INSERT INTO notes (id, path, title, tags, tier, updated_at) VALUES (?1, ?2, ?3, '', 'public', 0)",
                params![id, path, title],
            ).unwrap();
            conn.execute(
                "INSERT INTO notes_content (id, title, tags, body) VALUES (?1, ?2, '', ?3)",
                params![id, title, title],
            ).unwrap();
            let blob: Vec<u8> = emb.iter().flat_map(|f| f.to_le_bytes()).collect();
            conn.execute(
                "INSERT INTO embeddings (id, data) VALUES (?1, ?2)",
                params![id, blob],
            ).unwrap();
        }

        conn
    }

    pub fn create_graph_db(notes: &[(&str, &str, &str, &[f32])], links: &[(&str, &str)]) -> Connection {
        let conn = create_test_db(notes);
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS links (
                source_id INTEGER NOT NULL,
                target_path TEXT NOT NULL,
                UNIQUE(source_id, target_path)
            );
            CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_path);",
        ).unwrap();

        for (source_path, target_basename) in links {
            let source_id: i64 = conn.query_row(
                "SELECT id FROM notes WHERE path = ?1",
                params![source_path],
                |r| r.get(0),
            ).unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO links (source_id, target_path) VALUES (?1, ?2)",
                params![source_id, target_basename],
            ).unwrap();
        }
        conn
    }

    pub fn norm(v: &[f32]) -> Vec<f32> {
        let mag = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if mag == 0.0 { return v.to_vec(); }
        v.iter().map(|x| x / mag).collect()
    }
}
