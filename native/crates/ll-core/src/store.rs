//! In-memory embedding index with fast path and ID lookups.
//!
//! [`EmbeddingStore`] is constructed via [`EmbeddingStore::from_data`] and
//! wrapped in an `Arc` so it can be shared across search tasks without copying
//! the embedding data.

use std::collections::HashMap;
use std::sync::Arc;

/// An in-memory index of `(note_id, path, embedding)` triples.
///
/// Indexed by both string path and integer note ID for O(1) lookup.
/// All data is owned by the store; accessors either return references or
/// allocate a fresh `Arc<[f32]>` on each call (cost similar to cloning a
/// `Vec<f32>`, but the returned value is reference-counted).
///
/// # Thread safety
///
/// `EmbeddingStore` is immutable after construction and is always wrapped in
/// an `Arc<EmbeddingStore>` so it is safe to share across threads.
pub struct EmbeddingStore {
    data: Vec<(i64, String, Vec<f32>)>,
    path_index: HashMap<String, usize>,
    id_index: HashMap<i64, usize>,
}

impl EmbeddingStore {
    /// Build the store from a flat vec of `(id, path, embedding)` triples and
    /// return it wrapped in an `Arc`.
    ///
    /// Constructs both path and ID indices in a single pass.
    pub fn from_data(data: Vec<(i64, String, Vec<f32>)>) -> Arc<Self> {
        let path_index: HashMap<String, usize> = data
            .iter()
            .enumerate()
            .map(|(i, (_, path, _))| (path.clone(), i))
            .collect();
        let id_index: HashMap<i64, usize> = data
            .iter()
            .enumerate()
            .map(|(i, (id, _, _))| (*id, i))
            .collect();
        Arc::new(Self { data, path_index, id_index })
    }

    /// Return a slice of all stored `(id, path, embedding)` triples.
    pub fn all(&self) -> &[(i64, String, Vec<f32>)] {
        &self.data
    }

    /// Return the embedding for `path` as a cloned `Vec<f32>`.
    #[deprecated(since = "0.1.4", note = "use get_arc_by_path to avoid the Vec clone")]
    pub fn get_by_path(&self, path: &str) -> Option<Vec<f32>> {
        let &i = self.path_index.get(path)?;
        Some(self.data[i].2.clone())
    }

    /// Return the embedding for note `id` as a cloned `Vec<f32>`.
    #[deprecated(since = "0.1.4", note = "use get_arc_by_id to avoid the Vec clone")]
    pub fn get_by_id(&self, id: i64) -> Option<Vec<f32>> {
        let &i = self.id_index.get(&id)?;
        Some(self.data[i].2.clone())
    }

    /// Return the embedding for `path` as a reference-counted slice.
    ///
    /// Allocates a new `Arc<[f32]>` on each call by copying the slice header
    /// (not the data). Cheaper than cloning the full `Vec<f32>` when the
    /// caller only needs to read the values.
    pub fn get_arc_by_path(&self, path: &str) -> Option<Arc<[f32]>> {
        let &i = self.path_index.get(path)?;
        Some(Arc::from(self.data[i].2.as_slice()))
    }

    /// Return the embedding for note `id` as a reference-counted slice.
    ///
    /// Same allocation model as [`get_arc_by_path`](EmbeddingStore::get_arc_by_path).
    pub fn get_arc_by_id(&self, id: i64) -> Option<Arc<[f32]>> {
        let &i = self.id_index.get(&id)?;
        Some(Arc::from(self.data[i].2.as_slice()))
    }

    /// Iterate over all entries yielding `(id, path, Arc<[f32]>)`.
    ///
    /// Allocates one `Arc<[f32]>` per entry on each call. Use [`all`](EmbeddingStore::all)
    /// when you need the raw slice and won't be sharing the vectors across
    /// thread boundaries.
    pub fn iter_arc(&self) -> impl Iterator<Item = (i64, &str, Arc<[f32]>)> + '_ {
        self.data.iter().map(|(id, path, emb)| {
            (*id, path.as_str(), Arc::from(emb.as_slice()))
        })
    }

    /// Return the number of entries in the store.
    pub fn len(&self) -> usize {
        self.data.len()
    }

    /// Return `true` if the store contains no entries.
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// Return the embedding dimension, or 0 if the store is empty.
    pub fn dim(&self) -> usize {
        self.data.first().map(|(_, _, emb)| emb.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_store() -> Arc<EmbeddingStore> {
        let data = vec![
            (1, "a.md".to_string(), vec![1.0, 0.0, 0.0]),
            (2, "b.md".to_string(), vec![0.0, 1.0, 0.0]),
        ];
        EmbeddingStore::from_data(data)
    }

    #[test]
    fn test_store_from_data() {
        let store = sample_store();
        assert_eq!(store.len(), 2);
        assert!(!store.is_empty());
        assert_eq!(store.dim(), 3);
        #[allow(deprecated)]
        {
            assert!(store.get_by_path("a.md").is_some());
            assert!(store.get_by_path("nonexistent.md").is_none());
            assert!(store.get_by_id(1).is_some());
            assert!(store.get_by_id(999).is_none());
        }
    }

    #[test]
    fn test_get_arc_by_path() {
        let store = sample_store();
        let arc = store.get_arc_by_path("a.md").expect("a.md should exist");
        assert_eq!(arc.len(), 3);
        assert!((arc[0] - 1.0).abs() < 1e-6);
        assert!(store.get_arc_by_path("missing.md").is_none());
    }

    #[test]
    fn test_get_arc_by_id() {
        let store = sample_store();
        let arc = store.get_arc_by_id(2).expect("id 2 should exist");
        assert_eq!(arc.len(), 3);
        assert!((arc[1] - 1.0).abs() < 1e-6);
        assert!(store.get_arc_by_id(999).is_none());
    }

    #[test]
    fn test_iter_arc() {
        let store = sample_store();
        let entries: Vec<_> = store.iter_arc().collect();
        assert_eq!(entries.len(), 2);
        let (id, path, arc) = &entries[0];
        assert_eq!(*id, 1);
        assert_eq!(*path, "a.md");
        assert_eq!(arc.len(), 3);
    }
}
