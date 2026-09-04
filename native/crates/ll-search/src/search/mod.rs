pub mod scoring;
pub mod query;
pub mod federation;
pub mod graph;
pub mod cluster;
pub mod reflect;
pub mod store;
pub mod tune;
pub mod eval;
pub mod context;
#[cfg(test)]
pub(crate) mod test_helpers;

pub use query::{SearchResult, QueryResponse, QueryMeta, TemporalParams, hybrid_query, hybrid_query_federated, hybrid_query_with_ctx, hybrid_query_federated_with_ctx, build_query_response};
pub use federation::{discover_peer_dbs, discover_peer_dbs_for, batch_load_bodies_federated, query_scope, QueryScope};
pub use cluster::{SimilarResult, DiscriminatePair, similar_notes, cluster_notes, discriminate_pairs};
pub use reflect::{ReflectQueryResult, ReflectScanResult, reflect_scan, reflect_scan_federated};
pub use store::{EmbeddingStore, load_store};
pub use tune::tune_prf;
pub use eval::{eval_prf, eval_funnel, tune_weights, lane_diagnostics, LaneStat};
pub use context::SearchContext;

/// The shipped fusion weights, for harnesses that want to mark them in a sweep.
pub fn scoring_defaults() -> scoring::FusionWeights {
    scoring::FusionWeights::default()
}
