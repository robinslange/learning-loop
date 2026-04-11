use std::sync::Arc;

use rusqlite::Connection;

pub use ll_core::store::EmbeddingStore;

use crate::db::load_all_embeddings;

pub fn load_store(conn: &Connection) -> Arc<EmbeddingStore> {
    let data = load_all_embeddings(conn);
    EmbeddingStore::from_data(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::test_helpers::helpers::*;

    #[test]
    fn test_store_load_and_lookup() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_test_db(&[
            ("a.md", "a", "content a", &emb),
            ("b.md", "b", "content b", &emb),
        ]);
        let store = load_store(&conn);
        assert_eq!(store.len(), 2);
        assert!(store.get_by_path("a.md").is_some());
        assert!(store.get_by_path("nonexistent.md").is_none());
        assert_eq!(store.dim(), 3);
    }

    #[test]
    fn test_store_get_by_id() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_test_db(&[("a.md", "a", "content", &emb)]);
        let store = load_store(&conn);
        assert!(store.get_by_id(1).is_some());
        assert!(store.get_by_id(999).is_none());
    }
}
