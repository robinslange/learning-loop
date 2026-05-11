//! Shared numeric constants for ll-core algorithms.
//!
//! ll-search-specific constants (batch sizes, session gap thresholds) live in
//! `ll-search/src/config.rs` and are not re-exported from here.

/// Maximum number of candidates returned from ranked retrieval pipelines.
///
/// Applied at the end of vector scoring (`rocchio_prf_with`) and PageRank
/// (`personalized_pagerank`) to bound result set size before RRF fusion.
/// Callers that need a different limit should pass an explicit `top_n` argument
/// rather than relying on this constant.
pub const TOP_K: usize = 30;

/// Number of power-iteration steps in `personalized_pagerank`.
///
/// Twenty iterations converges to within floating-point noise for graphs up to
/// ~100k nodes with damping 0.85. Increase for very dense graphs; decrease for
/// latency-sensitive paths where approximate rank order is acceptable.
pub const PAGERANK_ITERS: usize = 20;
