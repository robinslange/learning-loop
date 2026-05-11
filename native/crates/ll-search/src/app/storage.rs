use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use rusqlite::Connection;

use crate::db;

pub trait Storage: Send + Sync {
    fn all_embeddings(&self) -> Result<Vec<(i64, String, Vec<f32>)>>;
    fn embedding_by_id(&self, id: i64) -> Result<Option<Vec<f32>>>;
    fn titles_map(&self) -> Result<HashMap<String, Option<String>>>;
    fn mtime_map(&self) -> Result<HashMap<String, f64>>;
    fn tags_map(&self) -> Result<HashMap<String, Vec<String>>>;
    fn link_graph(&self) -> Result<HashMap<String, Vec<String>>>;
    fn note_count(&self) -> Result<i64>;
}

pub struct SqliteStorage {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteStorage {
    pub fn open(db_path: &str) -> Result<Self> {
        let conn = db::open_db(db_path)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn with_conn<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> T,
    {
        let guard = self.conn.lock().expect("SqliteStorage mutex poisoned");
        Ok(f(&guard))
    }
}

impl Storage for SqliteStorage {
    fn all_embeddings(&self) -> Result<Vec<(i64, String, Vec<f32>)>> {
        self.with_conn(db::load_all_embeddings)
    }

    fn embedding_by_id(&self, id: i64) -> Result<Option<Vec<f32>>> {
        self.with_conn(|c| db::load_embedding(c, id))
    }

    fn titles_map(&self) -> Result<HashMap<String, Option<String>>> {
        self.with_conn(crate::search::query::load_titles_map)
    }

    fn mtime_map(&self) -> Result<HashMap<String, f64>> {
        self.with_conn(crate::search::query::load_mtime_map)
    }

    fn tags_map(&self) -> Result<HashMap<String, Vec<String>>> {
        self.with_conn(crate::search::graph::load_tags_map)
    }

    fn link_graph(&self) -> Result<HashMap<String, Vec<String>>> {
        self.with_conn(crate::search::graph::load_link_graph)
    }

    fn note_count(&self) -> Result<i64> {
        self.with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0)
        })
    }
}
