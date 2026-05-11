use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use parking_lot::RwLock;
use rusqlite::Connection;

use super::storage::{SqliteStorage, Storage};
use crate::search::context::SearchContext;

/// Placeholder configuration for the application. Track 0H fills this with
/// real constants; Track 1E wires it into the query path.
#[derive(Default)]
pub struct AppConfig {
    pub config_dir: Option<String>,
}

/// Cached list of federation peers. Filled lazily; Phase 1E does the full
/// peer-discovery wiring.
#[derive(Default)]
pub struct PeerCache {
    pub peers: Vec<String>,
    pub last_refreshed: u64,
}

impl PeerCache {
    pub fn new() -> Self {
        Self {
            peers: Vec::new(),
            last_refreshed: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        }
    }
}

pub struct AppState {
    pub storage: Arc<dyn Storage>,
    pub peers: RwLock<PeerCache>,
    pub config: AppConfig,
    /// Cached `SearchContext` shared across queries. Populated lazily on first
    /// call to `ensure_search_context`; invalidated when `PRAGMA data_version`
    /// changes (i.e. after a reindex).
    search_context: RwLock<Option<Arc<SearchContext>>>,
}

impl AppState {
    pub fn from_db(db_path: &str, config_dir: Option<String>) -> Result<Self> {
        let storage = SqliteStorage::open(db_path)?;
        Ok(Self {
            storage: Arc::new(storage),
            peers: RwLock::new(PeerCache::new()),
            config: AppConfig { config_dir },
            search_context: RwLock::new(None),
        })
    }

    pub fn note_count(&self) -> Result<i64> {
        self.storage.note_count()
    }

    /// Return the cached `SearchContext`, building it if absent or stale.
    ///
    /// Invalidation uses `PRAGMA data_version`: SQLite increments this on
    /// every write commit, so a reindex will bump it and cause a rebuild on
    /// the next query.
    pub fn ensure_search_context(&self, conn: &Connection) -> Arc<SearchContext> {
        // Fast path: read lock, return if valid.
        {
            let guard = self.search_context.read();
            if let Some(ctx) = guard.as_ref() {
                if !ctx.is_stale(conn) {
                    return Arc::clone(ctx);
                }
            }
        }
        // Slow path: acquire write lock and rebuild. Re-check under write lock
        // to avoid a double-build race if two callers arrive simultaneously.
        let mut guard = self.search_context.write();
        if let Some(ctx) = guard.as_ref() {
            if !ctx.is_stale(conn) {
                return Arc::clone(ctx);
            }
        }
        let fresh = Arc::new(SearchContext::build(conn));
        *guard = Some(Arc::clone(&fresh));
        fresh
    }
}
