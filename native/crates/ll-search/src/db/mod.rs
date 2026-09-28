pub mod schema;
pub mod index;
pub mod query;

pub use schema::{open_db, open_or_create_db};
#[cfg(feature = "research")]
pub use schema::{migrate_embeddings, drop_old_embeddings};
pub use index::{reindex, walk_vault, WalkEntry, IndexResult, EmbedItem, insert_embedded};
pub use query::{
    load_embedding, load_all_embeddings, get_status, list_tags,
    compute_sessions, compute_project_phases, Status, TagInfo,
    chrono_iso_now, days_to_ymd,
    link_stats, LinkStats, FolderStats,
    list_intentions_summary, list_intentions_for_context,
    IntentionSummary, IntentionDetail,
};
#[cfg(feature = "research")]
pub use query::{list_sessions, SessionInfo};
