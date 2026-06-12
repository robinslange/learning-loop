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

/// Maximum token count for which [`fts_escape`] keeps FTS5 implicit-AND
/// semantics. Queries with more tokens switch to OR.
///
/// Short queries (CLI lookups, note titles) are precision-oriented: requiring
/// every term keeps the result list tight. Long queries are natural-language
/// prompts (the JIT injection path) where no single note contains every
/// token, so implicit AND returns zero rows and kills the keyword signal.
pub const FTS_AND_MAX_TOKENS: usize = 3;

/// Maximum number of tokens included in an OR-joined FTS5 query.
///
/// Tokens beyond this cap are dropped (after case-insensitive deduplication)
/// to bound MATCH expression size on very long natural-language queries.
pub const FTS_OR_TOKEN_CAP: usize = 32;

/// Escape a free-text query for use in a SQLite FTS5 `MATCH` expression.
///
/// Each whitespace-separated token is wrapped in double quotes so that
/// punctuation and operator characters in user input are treated as literals.
///
/// Join semantics depend on query length:
///
/// - **<= [`FTS_AND_MAX_TOKENS`] tokens**: tokens are joined with a space
///   (FTS5 implicit AND). Short queries — CLI lookups and title-shaped
///   queries — want precision: all terms must be present.
/// - **> [`FTS_AND_MAX_TOKENS`] tokens**: tokens are deduplicated
///   (case-insensitively, keeping first occurrence), capped at
///   [`FTS_OR_TOKEN_CAP`], and joined with ` OR `. Long queries are
///   natural-language prompts where requiring every token matches nothing;
///   OR semantics let BM25 rank notes containing any subset of the terms.
///   BM25 scores remain negative (more negative = better) either way.
pub fn fts_escape(text: &str) -> String {
    let quoted: Vec<String> = text
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();

    if quoted.len() <= FTS_AND_MAX_TOKENS {
        return quoted.join(" ");
    }

    let mut seen = std::collections::HashSet::new();
    let deduped: Vec<String> = quoted
        .into_iter()
        .filter(|t| seen.insert(t.to_lowercase()))
        .take(FTS_OR_TOKEN_CAP)
        .collect();
    deduped.join(" OR ")
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
    fn test_fts_escape_short_query_keeps_implicit_and() {
        assert_eq!(fts_escape("hello world"), "\"hello\" \"world\"");
        assert_eq!(fts_escape("a b c"), "\"a\" \"b\" \"c\"");
        assert_eq!(fts_escape(""), "");
        assert_eq!(fts_escape("  "), "");
    }

    #[test]
    fn test_fts_escape_long_query_uses_or() {
        assert_eq!(
            fts_escape("how does sticky positioning break"),
            "\"how\" OR \"does\" OR \"sticky\" OR \"positioning\" OR \"break\""
        );
    }

    #[test]
    fn test_fts_escape_dedupes_case_insensitive() {
        assert_eq!(
            fts_escape("the cache The Cache misses again"),
            "\"the\" OR \"cache\" OR \"misses\" OR \"again\""
        );
    }

    #[test]
    fn test_fts_escape_caps_token_count() {
        let tokens: Vec<String> = (0..50).map(|i| format!("tok{i}")).collect();
        let escaped = fts_escape(&tokens.join(" "));
        let parts: Vec<&str> = escaped.split(" OR ").collect();
        assert_eq!(parts.len(), FTS_OR_TOKEN_CAP);
        assert_eq!(parts[0], "\"tok0\"");
        assert_eq!(parts[31], "\"tok31\"");
    }

    #[test]
    fn test_fts_escape_quotes_remain_escaped_in_or_mode() {
        let escaped = fts_escape("one two three four \"quoted\"");
        assert!(escaped.contains("\"\"\"quoted\"\"\""));
        assert!(escaped.contains(" OR "));
    }

    fn fts_fixture(docs: &[(&str, &str)]) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (id INTEGER PRIMARY KEY, path TEXT NOT NULL);
             CREATE TABLE notes_content (id INTEGER PRIMARY KEY, title TEXT, tags TEXT, body TEXT);
             CREATE VIRTUAL TABLE notes_fts USING fts5(
                 title, tags, body,
                 content='notes_content',
                 content_rowid='id',
                 tokenize='porter unicode61 remove_diacritics 1'
             );",
        )
        .unwrap();
        for (i, (path, body)) in docs.iter().enumerate() {
            let id = (i + 1) as i64;
            conn.execute(
                "INSERT INTO notes (id, path) VALUES (?1, ?2)",
                rusqlite::params![id, path],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO notes_content (id, title, tags, body) VALUES (?1, ?2, '', ?3)",
                rusqlite::params![id, path, body],
            )
            .unwrap();
        }
        conn.execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").unwrap();
        conn
    }

    #[test]
    fn test_long_nl_query_matches_subset_of_tokens() {
        let conn = fts_fixture(&[
            ("sticky.md", "overflow hidden on the scroll root kills position sticky"),
            ("cache.md", "a recurring entity cache needs a hard ttl ceiling"),
        ]);
        // 12-token natural-language query; neither note contains every token.
        let query = "why does my position sticky header stop working when overflow is hidden";
        let results = fts_bm25_query(&conn, query, 10, &VAULT_FTS);
        assert_eq!(results.len(), 1, "OR semantics should match the subset-overlap note");
        assert_eq!(results[0].1, "sticky.md");
        assert!(results[0].2 < 0.0, "bm25 scores stay negative (more negative = better)");
    }

    #[test]
    fn test_long_query_ranks_higher_overlap_first() {
        let conn = fts_fixture(&[
            ("partial.md", "the scroll root and nothing else"),
            ("full.md", "overflow hidden on the scroll root kills position sticky"),
        ]);
        let query = "position sticky broken by overflow hidden on the scroll root";
        let results = fts_bm25_query(&conn, query, 10, &VAULT_FTS);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].1, "full.md", "note matching more query tokens ranks first");
        assert!(results[0].2 < results[1].2, "better match has more-negative bm25 score");
    }

    #[test]
    fn test_short_query_requires_all_tokens() {
        let conn = fts_fixture(&[
            ("both.md", "token cache ceiling"),
            ("one.md", "token budget exceeded"),
        ]);
        let results = fts_bm25_query(&conn, "token cache", 10, &VAULT_FTS);
        assert_eq!(results.len(), 1, "short queries keep implicit-AND precision");
        assert_eq!(results[0].1, "both.md");
    }

    #[test]
    fn test_stopword_only_long_query_returns_no_match_gracefully() {
        let conn = fts_fixture(&[("a.md", "substantive content about embeddings")]);
        let results = fts_bm25_query(&conn, "the and of to is the and of", 10, &VAULT_FTS);
        assert!(results.is_empty(), "no overlap means no rows, not an error");
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
