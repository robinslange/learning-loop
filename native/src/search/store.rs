use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::Connection;

use crate::db::load_all_embeddings;

pub struct EmbeddingStore {
    data: Vec<(i64, String, Vec<f32>)>,
    path_index: HashMap<String, usize>,
}

impl EmbeddingStore {
    pub fn load(conn: &Connection) -> Arc<Self> {
        let data = load_all_embeddings(conn);
        let path_index: HashMap<String, usize> = data
            .iter()
            .enumerate()
            .map(|(i, (_, path, _))| (path.clone(), i))
            .collect();
        Arc::new(Self { data, path_index })
    }

    pub fn all(&self) -> &[(i64, String, Vec<f32>)] {
        &self.data
    }

    pub fn get_by_path(&self, path: &str) -> Option<Vec<f32>> {
        let &i = self.path_index.get(path)?;
        Some(self.data[i].2.clone())
    }

    pub fn get_by_id(&self, id: i64) -> Option<Vec<f32>> {
        self.data
            .iter()
            .find(|(eid, _, _)| *eid == id)
            .map(|(_, _, emb)| emb.clone())
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn dim(&self) -> usize {
        self.data.first().map(|(_, _, emb)| emb.len()).unwrap_or(0)
    }
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
        let store = EmbeddingStore::load(&conn);
        assert_eq!(store.len(), 2);
        assert!(store.get_by_path("a.md").is_some());
        assert!(store.get_by_path("nonexistent.md").is_none());
        assert_eq!(store.dim(), 3);
    }

    #[test]
    fn test_store_get_by_id() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_test_db(&[("a.md", "a", "content", &emb)]);
        let store = EmbeddingStore::load(&conn);
        assert!(store.get_by_id(1).is_some());
        assert!(store.get_by_id(999).is_none());
    }
}
