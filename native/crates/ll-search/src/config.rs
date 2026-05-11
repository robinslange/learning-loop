//! Shared numeric constants for ll-search.
//!
//! All magic numbers that appear in more than one place, or that encode a
//! meaningful policy decision, live here. Consumer modules import via
//! `use crate::config::*` or name specific constants.
//!
//! ## Changing a value
//! Change it once here. The doc comment on each constant explains what it
//! controls so reviewers can assess impact without tracing call sites.

// ---------------------------------------------------------------------------
// Stage caps
// ---------------------------------------------------------------------------

/// Number of candidates retained after the vector-similarity stage.
///
/// Applied as `.truncate(TOP_K_VEC)` on the cosine-ranked candidate list
/// before RRF fusion. Raising this increases recall at the cost of more
/// BM25 + PageRank comparisons downstream.
pub const TOP_K_VEC: usize = 30;

/// Number of candidates returned by the BM25 full-text search stage.
///
/// Passed as the `limit` argument to `fts_bm25_query`. Matches `TOP_K_VEC`
/// so both signals contribute equally to the initial RRF pool.
pub const TOP_K_FTS: usize = 30;

/// Size of the fused RRF pool used as input to PRF expansion.
///
/// After vec + FTS + PPR + tag signals are merged, the top `TOP_K_INITIAL`
/// entries are used to compute the Rocchio query-expansion vector.
pub const TOP_K_INITIAL: usize = 30;

/// Number of candidates retained from the tag-IDF expansion stage.
///
/// Applied in `SearchContext::tag_expand_from_map` and the legacy
/// `tag_expand` path. Kept separate from `TOP_K_INITIAL` so tuning the
/// semantic PRF pool does not accidentally affect the tag-graph budget.
pub const TOP_K_GRAPH: usize = 30;

/// Number of BM25 candidates requested from a federation peer when the
/// peer's embedding dimension does not match the local model.
///
/// Applies only to the text-only federation fallback path.
pub const TOP_K_FEDERATION: usize = 30;

// ---------------------------------------------------------------------------
// Graph & ranking
// ---------------------------------------------------------------------------

/// Damping factor for personalized PageRank.
///
/// ll-search uses **0.5**, not the textbook 0.85, because the graph is
/// sparse and the algorithm is biased strongly toward seed paths. A lower
/// damping factor keeps results close to the seeds even in well-connected
/// neighbourhoods, which is the desired behaviour for focused note retrieval.
pub const PAGERANK_DAMPING: f32 = 0.5;

/// Maximum number of power-iteration steps for personalized PageRank.
///
/// Empirically sufficient for convergence on graphs up to ~50 k notes.
/// Increase if large vaults show ranking instability across queries.
pub const PAGERANK_ITERS: usize = 20;

/// Alpha (query weight) for Rocchio pseudo-relevance feedback.
///
/// Controls how much the original query vector is preserved after expansion.
/// `alpha + beta = 1.0` is the standard Rocchio constraint.
pub const PRF_ALPHA: f32 = 0.5;

/// Beta (feedback weight) for Rocchio pseudo-relevance feedback.
///
/// Controls how strongly the top-k feedback documents shift the query vector.
pub const PRF_BETA: f32 = 0.5;

/// Number of top-ranked feedback documents used in Rocchio PRF.
///
/// `k = 1` means only the single best document is used as a feedback signal,
/// which avoids drift when the top result is highly relevant but all others
/// are noise.
pub const PRF_K: usize = 1;

// ---------------------------------------------------------------------------
// Tag-frequency band
// ---------------------------------------------------------------------------

/// Minimum tag frequency (inclusive) for a tag to qualify for IDF expansion.
///
/// Tags appearing on fewer than this many notes are too rare to be reliable
/// expansion signals (likely typos or one-off labels).
pub const TAG_FREQ_BAND_MIN: usize = 2;

/// Maximum tag frequency (inclusive) for a tag to qualify for IDF expansion.
///
/// Tags appearing on more than this many notes are too common to be
/// discriminative (equivalent to stop-words in full-text search).
pub const TAG_FREQ_BAND_MAX: usize = 20;

// ---------------------------------------------------------------------------
// Temporal
// ---------------------------------------------------------------------------

/// Seconds per day, used in half-life recency decay calculations.
///
/// Stored as `f64` to avoid repeated casts in the hot temporal-boost path.
pub const SECS_PER_DAY: f64 = 86_400.0;

/// Divisor applied to the phase window width to derive the Gaussian sigma.
///
/// For a project phase spanning `[start, end]`, sigma = `(end - start) /
/// PHASE_SIGMA_DIVISOR`. A divisor of 4 means the ±2σ range covers the
/// full phase window, giving a soft bell-curve boost centred on the phase.
pub const PHASE_SIGMA_DIVISOR: f64 = 4.0;

/// Scalar weight for the Gaussian project-phase recency boost.
///
/// The final score multiplier is `1.0 + RECENCY_BOOST_SCALAR * (boost - 0.5)`
/// where `boost` is the normalised Gaussian value in [0, 1]. The `0.5` in
/// that expression is the Gaussian midpoint, **not** this constant.
pub const RECENCY_BOOST_SCALAR: f64 = 0.15;

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/// Number of documents processed per embedding batch during reindex.
///
/// Sized to fill the ONNX session's preferred batch dimension for BGE-small
/// (384-dim). Increasing this reduces per-document overhead but raises peak
/// memory usage linearly.
pub const EMBED_BATCH_SIZE: usize = 32;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/// Default session-gap threshold (minutes) used when the gap histogram
/// algorithm cannot find a local minimum in the search range.
///
/// Also used as the initial value of `min_idx` in the histogram search,
/// which means it acts as a fallback if no bucket in the search range beats
/// the initial `f64::MAX` comparison.
pub const SESSION_THRESHOLD_DEFAULT_M: f64 = 30.0;

/// Lower bound (minutes) of the session-gap search range in the histogram.
///
/// Gaps shorter than this are considered intra-session and are not candidates
/// for the session boundary threshold.
pub const SESSION_SEARCH_RANGE_MIN_M: usize = 15;

/// Upper bound (minutes) of the session-gap search range in the histogram.
///
/// Gaps longer than this are capped at this value during the search. 120
/// minutes (2 hours) is a pragmatic ceiling: any gap longer than 2 hours
/// almost certainly represents a distinct work session.
pub const SESSION_SEARCH_RANGE_MAX_M: usize = 120;
