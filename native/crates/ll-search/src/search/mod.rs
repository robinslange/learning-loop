pub mod scoring;
pub mod query;
pub mod federation;
pub mod graph;
pub mod cluster;
pub mod reflect;
pub mod store;
#[cfg(feature = "research")]
pub mod tune;
pub mod eval;
pub mod context;
#[cfg(test)]
pub(crate) mod test_helpers;

pub use query::{SearchResult, QueryResponse, QueryMeta, TemporalParams, hybrid_query_with_ctx, build_query_response};
pub use federation::{discover_peer_dbs, discover_peer_dbs_for, batch_load_bodies_federated, query_scope, QueryScope};
pub use cluster::{SimilarResult, DiscriminatePair, similar_notes, cluster_notes, discriminate_pairs};
pub use reflect::{ReflectQueryResult, ReflectScanResult, reflect_scan};
pub use store::{EmbeddingStore, load_store};
#[cfg(feature = "research")]
pub use tune::tune_prf;
pub use eval::eval_funnel;
#[cfg(feature = "research")]
pub use eval::{eval_prf, tune_weights, lane_diagnostics, LaneStat};
pub use context::SearchContext;

#[cfg(feature = "research")]
/// The shipped fusion weights, for harnesses that want to mark them in a sweep.
pub fn scoring_defaults() -> scoring::FusionWeights {
    scoring::FusionWeights::default()
}
