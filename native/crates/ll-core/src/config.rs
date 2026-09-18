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

/// Upper bound on power-iteration steps in `personalized_pagerank`.
///
/// A cap, not a count: the walk stops early once the score vector settles, so
/// this only bounds the worst case. The previous note here claimed twenty
/// steps converge "for graphs up to ~100k nodes with damping 0.85", which
/// described a damping factor no caller uses (ll-search runs 0.5, deliberately
/// and for a documented reason) and asserted a convergence nothing measured.
/// Lower damping settles faster, so the bound is generous for this caller.
pub const PAGERANK_ITERS: usize = 20;
