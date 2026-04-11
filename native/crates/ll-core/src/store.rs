use std::collections::HashMap;
use std::sync::Arc;

pub struct EmbeddingStore {
    data: Vec<(i64, String, Vec<f32>)>,
    path_index: HashMap<String, usize>,
}

impl EmbeddingStore {
    pub fn from_data(data: Vec<(i64, String, Vec<f32>)>) -> Arc<Self> {
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

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    pub fn dim(&self) -> usize {
        self.data.first().map(|(_, _, emb)| emb.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_store_from_data() {
        let data = vec![
            (1, "a.md".to_string(), vec![1.0, 0.0, 0.0]),
            (2, "b.md".to_string(), vec![0.0, 1.0, 0.0]),
        ];
        let store = EmbeddingStore::from_data(data);
        assert_eq!(store.len(), 2);
        assert!(!store.is_empty());
        assert_eq!(store.dim(), 3);
        assert!(store.get_by_path("a.md").is_some());
        assert!(store.get_by_path("nonexistent.md").is_none());
        assert!(store.get_by_id(1).is_some());
        assert!(store.get_by_id(999).is_none());
    }
}
