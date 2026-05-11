//! Search ranking algorithms: BM25/FTS query helpers, RRF fusion, and Rocchio
//! pseudo-relevance feedback.
//!
//! All functions are pure (no I/O). SQLite connections are passed in by the
//! caller so this module has no database ownership.

use std::collections::HashMap;

/// Reciprocal Rank Fusion smoothing constant.
///
/// Larger values reduce the impact of rank position; the default of 5.0 is the
/// value from the original Cormack et al. 2009 paper.
pub const RRF_K: f64 = 5.0;

/// Default alpha weight for the query vector in Rocchio PRF.
///
/// The feedback centroid receives weight `1 - PRF_ALPHA`. Tuning upward
/// strengthens query fidelity; tuning downward amplifies feedback influence.
pub const PRF_ALPHA: f32 = 0.7;

/// Default number of top documents used as PRF feedback.
pub const PRF_K: usize = 3;

/// Parameters for Rocchio pseudo-relevance feedback.
#[derive(Debug, Clone, Copy)]
pub struct PrfParams {
    /// Weight on the original query vector (0.0-1.0).
    pub alpha: f32,
    /// Weight on the pseudo-relevance centroid (0.0-1.0).
    pub beta: f32,
    /// Number of top-ranked documents to use as feedback.
    pub k: usize,
}

impl Default for PrfParams {
    fn default() -> Self {
        Self { alpha: PRF_ALPHA, beta: 1.0 - PRF_ALPHA, k: PRF_K }
    }
}

/// Configuration for a SQLite FTS5 table and its associated content table.
///
/// `#[non_exhaustive]` -- new fields may be added in patch releases. Use the
/// `VAULT_FTS` constant rather than constructing this directly in downstream
/// code.
#[non_exhaustive]
pub struct FtsConfig {
    /// Name of the FTS5 virtual table (e.g. `"notes_fts"`).
    pub fts_table: &'static str,
    /// Name of the content-rowid table that FTS5 is built over.
    pub content_table: &'static str,
    /// Name of the primary items table (used for path lookups).
    pub items_table: &'static str,
    /// Primary key column name shared across tables.
    pub id_column: &'static str,
    /// Path column name in the items table.
    pub path_column: &'static str,
    /// BM25 column weights string as accepted by the SQLite `bm25()` function.
    pub bm25_weights: &'static str,
}

/// Default FTS configuration targeting the `notes_fts` / `notes` schema used
/// by ll-search.
pub const VAULT_FTS: FtsConfig = FtsConfig {
    fts_table: "notes_fts",
    content_table: "notes_content",
    items_table: "notes",
    id_column: "id",
    path_column: "path",
    bm25_weights: "10.0, 5.0, 1.0",
};

/// Dot product of two L2-normalized vectors, equivalent to cosine similarity.
///
/// # Panics (debug builds only)
///
/// Asserts that both input vectors are unit-length. Release builds skip the
/// assertion for performance.
pub fn dot_product(a: &[f32], b: &[f32]) -> f32 {
    debug_assert!(
        (a.iter().map(|x| x * x).sum::<f32>().sqrt() - 1.0).abs() < 0.01,
        "dot_product assumes L2-normalized vectors (a)"
    );
    debug_assert!(
        (b.iter().map(|x| x * x).sum::<f32>().sqrt() - 1.0).abs() < 0.01,
        "dot_product assumes L2-normalized vectors (b)"
    );
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Escape a free-text query for use in a SQLite FTS5 `MATCH` expression.
///
/// Each whitespace-separated token is wrapped in double quotes so that
/// punctuation and operator characters in user input are treated as literals.
pub fn fts_escape(text: &str) -> String {
    text.split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Run a BM25 FTS5 query and return the top `limit` results.
///
/// Returns `Vec<(note_id, path, bm25_score)>`. The score is the raw SQLite
/// `bm25()` value (negative; more negative = better match). Returns an empty
/// vec on query failure rather than propagating the error, so callers can
/// degrade gracefully when FTS is unavailable.
pub fn fts_bm25_query(
    conn: &rusqlite::Connection,
    query: &str,
    limit: usize,
    config: &FtsConfig,
) -> Vec<(i64, String, f64)> {
    let escaped = fts_escape(query);
    if escaped.is_empty() {
        return Vec::new();
    }

    let sql = format!(
        "SELECT nc.{id}, n.{path}, bm25({fts}, {weights}) as score
         FROM {fts}
         JOIN {content} nc ON nc.{id} = {fts}.rowid
         JOIN {items} n ON n.{id} = nc.{id}
         WHERE {fts} MATCH ?1
         ORDER BY score
         LIMIT ?2",
        id = config.id_column,
        path = config.path_column,
        fts = config.fts_table,
        content = config.content_table,
        items = config.items_table,
        weights = config.bm25_weights,
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(rusqlite::params![escaped, limit as i64], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, f64>(2)?,
        ))
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    rows.filter_map(|r| r.ok()).collect()
}

/// Run a BM25 FTS5 query and return the top `limit` results, propagating errors.
///
/// Returns `Vec<(note_id, path, bm25_score)>`. The score is the raw SQLite
/// `bm25()` value (negative; more negative = better match). Returns
/// `Err(ll_core::Error::Sqlite(_))` if the FTS table is missing or the query
/// fails, so callers can distinguish infrastructure failures from empty result
/// sets.
///
/// Use [`fts_bm25_query`] when a best-effort fallback to empty vec is preferred
/// (e.g. federation peers where FTS may be unavailable).
pub fn try_fts_bm25_query(
    conn: &rusqlite::Connection,
    query: &str,
    limit: usize,
    config: &FtsConfig,
) -> crate::Result<Vec<(i64, String, f64)>> {
    let escaped = fts_escape(query);
    if escaped.is_empty() {
        return Ok(Vec::new());
    }

    let sql = format!(
        "SELECT nc.{id}, n.{path}, bm25({fts}, {weights}) as score
         FROM {fts}
         JOIN {content} nc ON nc.{id} = {fts}.rowid
         JOIN {items} n ON n.{id} = nc.{id}
         WHERE {fts} MATCH ?1
         ORDER BY score
         LIMIT ?2",
        id = config.id_column,
        path = config.path_column,
        fts = config.fts_table,
        content = config.content_table,
        items = config.items_table,
        weights = config.bm25_weights,
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![escaped, limit as i64], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, f64>(2)?,
        ))
    })?;

    rows.collect::<Result<Vec<_>, rusqlite::Error>>().map_err(crate::Error::from)
}

/// Accumulate RRF scores for a ranked list of document paths.
///
/// Call once per retrieval system (e.g. vector, FTS, graph). Documents that
/// appear in multiple lists accumulate scores from each.
pub fn add_ranked_rrf<'a>(rrf_scores: &mut HashMap<String, f64>, items: impl Iterator<Item = &'a str>) {
    for (rank, path) in items.enumerate() {
        *rrf_scores.entry(path.to_string()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
    }
}

/// Sort and truncate an RRF score map to `top_n` results.
///
/// Consumes the score map and returns a sorted `Vec<(path, score)>` with the
/// highest-scoring documents first.
pub fn finalize_rrf(rrf_scores: HashMap<String, f64>, top_n: usize) -> Vec<(String, f64)> {
    let mut results: Vec<(String, f64)> = rrf_scores.into_iter().collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_n);
    results
}

/// Collect seed document paths from the top of vector and FTS result lists.
///
/// Takes up to 10 items from each source, deduplicating across sources. Used
/// to build the personalization set for PageRank.
pub fn collect_seeds(
    vec_scored: &[(String, f64)],
    fts_results: &[(i64, String, f64)],
) -> Vec<String> {
    use std::collections::HashSet;
    let mut seeds: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for (path, _) in vec_scored.iter().take(10) {
        if seen.insert(path.clone()) {
            seeds.push(path.clone());
        }
    }
    for (_, path, _) in fts_results.iter().take(10) {
        if seen.insert(path.clone()) {
            seeds.push(path.clone());
        }
    }
    seeds
}

/// Expand a query vector using Rocchio pseudo-relevance feedback.
///
/// Computes a centroid of the top-`params.k` feedback documents, then blends
/// it with the original query vector using `params.alpha` / `params.beta`
/// weights. The result is L2-normalized and scored against `all_embeddings`.
///
/// Returns at most [`crate::TOP_K`] results, sorted by descending score.
/// Returns an empty vec if none of the top results have embeddings.
pub fn rocchio_prf_with(
    query_vec: &[f32],
    top_results: &[(String, f64)],
    all_embeddings: &[(i64, String, Vec<f32>)],
    params: &PrfParams,
) -> Vec<(String, f64)> {
    let dim = query_vec.len();
    let emb_map: HashMap<&str, &Vec<f32>> = all_embeddings
        .iter()
        .map(|(_, path, emb)| (path.as_str(), emb))
        .collect();

    let feedback_vecs: Vec<&Vec<f32>> = top_results
        .iter()
        .take(params.k)
        .filter_map(|(path, _)| emb_map.get(path.as_str()).copied())
        .collect();

    if feedback_vecs.is_empty() {
        return Vec::new();
    }

    let mut expanded = vec![0.0f32; dim];
    for d in 0..dim {
        let fb_mean: f32 = feedback_vecs.iter().map(|v| v[d]).sum::<f32>() / feedback_vecs.len() as f32;
        expanded[d] = params.alpha * query_vec[d] + params.beta * fb_mean;
    }

    let norm: f32 = expanded.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in &mut expanded {
            *x /= norm;
        }
    }

    let mut prf_scored: Vec<(String, f64)> = all_embeddings
        .iter()
        .map(|(_, path, emb)| (path.clone(), dot_product(&expanded, emb) as f64))
        .collect();
    prf_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    prf_scored.truncate(crate::config::TOP_K);
    prf_scored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dot_product_identical() {
        let v = vec![1.0f32, 0.0, 0.0];
        let sim = dot_product(&v, &v);
        assert!((sim - 1.0).abs() < 1e-5);
    }

    #[test]
    fn test_dot_product_orthogonal() {
        let a = vec![1.0f32, 0.0, 0.0];
        let b = vec![0.0f32, 1.0, 0.0];
        let sim = dot_product(&a, &b);
        assert!(sim.abs() < 1e-5);
    }

    #[test]
    fn test_fts_escape() {
        assert_eq!(fts_escape("hello world"), "\"hello\" \"world\"");
        assert_eq!(fts_escape(""), "");
        assert_eq!(fts_escape("  "), "");
    }

    #[test]
    fn test_rrf_basic() {
        let mut scores = HashMap::new();
        add_ranked_rrf(&mut scores, ["a", "b", "c"].iter().copied());
        assert!(scores["a"] > scores["b"]);
        assert!(scores["b"] > scores["c"]);
    }

    #[test]
    fn test_finalize_rrf_truncates() {
        let mut scores = HashMap::new();
        for i in 0..20 {
            scores.insert(format!("doc_{}", i), 1.0 / (i + 1) as f64);
        }
        let results = finalize_rrf(scores, 5);
        assert_eq!(results.len(), 5);
    }
}
