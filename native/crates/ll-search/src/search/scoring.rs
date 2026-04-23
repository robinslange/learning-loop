pub(crate) use ll_core::scoring::{
    PrfParams,
    dot_product,
    add_ranked_rrf, finalize_rrf,
    collect_seeds, rocchio_prf_with,
};
use ll_core::scoring::VAULT_FTS;

pub(crate) fn fts_bm25_query(conn: &rusqlite::Connection, query: &str, limit: usize) -> Vec<(i64, String, f64)> {
    ll_core::scoring::fts_bm25_query(conn, query, limit, &VAULT_FTS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_helpers::helpers::*;
    use rusqlite::Connection;

    #[test]
    fn test_fts_rebuild_on_export_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
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
             INSERT INTO notes (id, path, title, tags, tier, updated_at) VALUES (1, 'test.md', 'test title', 'tag1', 'public', 0);
             INSERT INTO notes_content (id, title, tags, body) VALUES (1, 'test title', 'tag1', 'body text about sleep');",
        ).unwrap();

        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
                 title, tags, body,
                 content='notes_content',
                 content_rowid='id',
                 tokenize='porter unicode61 remove_diacritics 1'
             );
             INSERT INTO notes_fts(notes_fts) VALUES('rebuild');",
        ).unwrap();

        let results = fts_bm25_query(&conn, "sleep", 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].1, "test.md");
    }

    #[test]
    fn test_fts_empty_query() {
        let conn = create_test_db(&[
            ("note.md", "note", "content", &norm(&[1.0, 0.0, 0.0])),
        ]);
        let results = fts_bm25_query(&conn, "", 10);
        assert!(results.is_empty());
    }

    #[test]
    fn test_fts_no_table() {
        let conn = Connection::open_in_memory().unwrap();
        let results = fts_bm25_query(&conn, "test", 10);
        assert!(results.is_empty());
    }

    #[test]
    fn test_dot_product_identical() {
        let v = norm(&[1.0, 0.0, 0.0]);
        let sim = dot_product(&v, &v);
        assert!((sim - 1.0).abs() < 1e-5);
    }

    #[test]
    fn test_dot_product_orthogonal() {
        let a = norm(&[1.0, 0.0, 0.0]);
        let b = norm(&[0.0, 1.0, 0.0]);
        let sim = dot_product(&a, &b);
        assert!(sim.abs() < 1e-5);
    }
}
