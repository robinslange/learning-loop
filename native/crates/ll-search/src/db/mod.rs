pub mod schema;
pub mod index;
pub mod query;

pub use schema::{open_db, check_model_mismatch, migrate_embeddings, drop_old_embeddings};
pub use index::{reindex, walk_vault, WalkEntry, IndexResult};
pub use query::{
    load_embedding, load_all_embeddings, get_status, list_tags,
    compute_sessions, compute_project_phases, Status, TagInfo,
    chrono_iso_now, days_to_ymd, list_sessions, SessionInfo,
    link_stats, LinkStats, FolderStats,
};
