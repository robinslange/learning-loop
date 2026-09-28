pub mod cluster;
pub mod context;
pub mod eval;
pub mod federation;
pub mod graph;
pub mod query;
pub mod reflect;
pub mod scoring;
pub mod store;
#[cfg(test)]
pub(crate) mod test_helpers;
#[cfg(feature = "research")]
pub mod tune;

pub use cluster::{
    cluster_notes, discriminate_pairs, similar_notes, DiscriminatePair, SimilarResult,
};
pub use context::SearchContext;
pub use eval::eval_funnel;
#[cfg(feature = "research")]
pub use eval::{eval_prf, lane_diagnostics, tune_weights, LaneStat};
pub use federation::{
    batch_load_bodies_federated, discover_peer_dbs, discover_peer_dbs_for, query_scope, QueryScope,
};
pub use query::{
    build_query_response, hybrid_query_with_ctx, QueryMeta, QueryResponse, SearchResult,
    TemporalParams,
};
pub use reflect::{reflect_scan, ReflectQueryResult, ReflectScanResult};
pub use store::{load_store, EmbeddingStore};
#[cfg(feature = "research")]
pub use tune::tune_prf;

#[cfg(feature = "research")]
/// The shipped fusion weights, for harnesses that want to mark them in a sweep.
pub fn scoring_defaults() -> scoring::FusionWeights {
    scoring::FusionWeights::default()
}
