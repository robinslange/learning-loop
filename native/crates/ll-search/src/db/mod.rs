pub mod index;
pub mod query;
pub mod schema;

pub use index::{insert_embedded, reindex, walk_vault, EmbedItem, IndexResult, WalkEntry};
pub use query::{
    chrono_iso_now, compute_project_phases, compute_sessions, days_to_ymd, get_status, link_stats,
    list_intentions_for_context, list_intentions_summary, list_tags, load_all_embeddings,
    load_embedding, FolderStats, IntentionDetail, IntentionSummary, LinkStats, Status, TagInfo,
};
#[cfg(feature = "research")]
pub use query::{list_sessions, SessionInfo};
#[cfg(feature = "research")]
pub use schema::{drop_old_embeddings, migrate_embeddings};
pub use schema::{open_db, open_or_create_db};
