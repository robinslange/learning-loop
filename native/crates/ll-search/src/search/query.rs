use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::config::{PHASE_SIGMA_DIVISOR, RECENCY_BOOST_SCALAR, SECS_PER_DAY};
use crate::db::load_all_embeddings;
use crate::embed::embed_query;

use super::scoring::finalize_rrf;
use super::federation::{add_peer_rrf_scores_guarded, load_title_federated};
use super::context::SearchContext;

// The model only ranks on score; full f64 precision (~18 chars) is wasted
// context tokens. Filtering and sorting already ran on the full-precision
// value in Rust, so rounding at serialization cannot change results — it
// only trims the emitted JSON. Applied via serialize_with so every
// SearchResult construction site shares one rounding rule.
fn serialize_score_4dp<S: serde::Serializer>(score: &f64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64((score * 1e4).round() / 1e4)
}

#[derive(Serialize)]
pub struct SearchResult {
    pub path: String,
    #[serde(serialize_with = "serialize_score_4dp")]
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<f64>,
}

#[derive(Serialize)]
pub struct QueryResponse {
    pub meta: QueryMeta,
    pub results: Vec<SearchResult>,
}

#[derive(Serialize)]
pub struct QueryMeta {
    pub query: String,
    pub total_indexed: usize,
    pub above_threshold: usize,
    pub threshold: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Default)]
pub struct TemporalParams {
    pub recency_days: Option<f64>,
    pub after: Option<f64>,
    pub before: Option<f64>,
    pub session_id: Option<i64>,
    pub project_tag: Option<String>,
}

impl TemporalParams {
    pub fn has_any(&self) -> bool {
        self.recency_days.is_some()
            || self.after.is_some()
            || self.before.is_some()
            || self.session_id.is_some()
            || self.project_tag.is_some()
    }
}

/// Query using a pre-built (cached) `SearchContext`, avoiding a rebuild per
/// call. `peers` may be empty, and then this is the local query.
pub fn hybrid_query_with_ctx(
    ctx: &SearchContext,
    conn: &Connection,
    query_text: &str,
    top_n: usize,
    peers: &[(String, Connection)],
    temporal: &TemporalParams,
) -> anyhow::Result<Vec<SearchResult>> {
    let query_vec = embed_query(query_text)?;
    Ok(hybrid_query_with_ctx_inner(ctx, conn, &query_vec, query_text, top_n, peers, temporal))
}

pub(crate) fn hybrid_query_with_ctx_inner(
    ctx: &SearchContext,
    conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    top_n: usize,
    peers: &[(String, Connection)],
    temporal: &TemporalParams,
) -> Vec<SearchResult> {
    let mut rrf = ctx.local_rrf_scores(conn, query_vec, query_text);

    for (peer_id, peer_conn) in peers {
        let peer_embeddings = load_all_embeddings(peer_conn);
        add_peer_rrf_scores_guarded(&mut rrf, peer_id, peer_conn, query_vec, query_text, &peer_embeddings);
    }

    if temporal.has_any() {
        apply_temporal_boost(&mut rrf, &ctx.mtimes, temporal, conn, &ctx.decay_lut);
    }

    finalize_rrf(rrf, top_n)
        .into_iter()
        .map(|(path, score)| SearchResult {
            title: result_title(ctx, conn, peers, &path),
            mtime: ctx.mtimes.get(path.as_str()).copied(),
            path,
            score,
        })
        .collect()
}

/// A local path's title is already in `ctx`; only a peer's needs a lookup.
pub(crate) fn result_title(
    ctx: &SearchContext,
    conn: &Connection,
    peers: &[(String, Connection)],
    path: &str,
) -> Option<String> {
    if path.starts_with("peer:") {
        load_title_federated(path, conn, peers)
    } else {
        ctx.titles.get(path).cloned().flatten().map(|a| a.to_string())
    }
}

pub fn total_note_count(conn: &Connection) -> usize {
    conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, usize>(0))
        .unwrap_or(0)
}

pub fn build_query_response(
    query: String,
    results: Vec<SearchResult>,
    conn: &Connection,
    threshold: f64,
) -> QueryResponse {
    let total_indexed = total_note_count(conn);
    let above: Vec<SearchResult> = results
        .into_iter()
        .filter(|r| r.score >= threshold)
        .collect();
    let above_count = above.len();
    let hint = if above_count == 0 {
        Some(format!(
            "0 results above {:.1} threshold in {} indexed notes. Try broader terms or --threshold 0.1",
            threshold, total_indexed
        ))
    } else {
        None
    };
    QueryResponse {
        meta: QueryMeta {
            query,
            total_indexed,
            above_threshold: above_count,
            threshold,
            hint,
        },
        results: above,
    }
}

pub(crate) fn find_note_id(conn: &Connection, path: &str) -> Option<i64> {
    conn.query_row(
        "SELECT id FROM notes WHERE path = ?1",
        params![path],
        |row| row.get(0),
    )
    .ok()
    .or_else(|| resolve_note_id_like(conn, path))
}

pub(crate) fn resolve_note_id_like(conn: &Connection, path: &str) -> Option<i64> {
    let pattern = format!("%{}", path);
    conn.query_row(
        "SELECT id FROM notes WHERE path LIKE ?1 LIMIT 1",
        params![pattern],
        |row| row.get(0),
    )
    .ok()
}

pub(crate) fn load_titles_map(conn: &Connection) -> HashMap<String, Option<String>> {
    let mut map = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT path, title FROM notes") {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        }) {
            for row in rows.flatten() {
                map.insert(row.0, row.1);
            }
        }
    }
    map
}

pub(crate) fn load_mtime_map(conn: &Connection) -> HashMap<String, f64> {
    let mut map = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT path, mtime FROM notes") {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        }) {
            for row in rows.flatten() {
                map.insert(row.0, row.1 / 1000.0);
            }
        }
    }
    map
}

fn load_project_phase(conn: &Connection, tag: &str) -> Option<(f64, f64)> {
    conn.query_row(
        "SELECT first_mtime, last_mtime FROM project_phases WHERE tag = ?1",
        params![tag.to_lowercase()],
        |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?)),
    )
    .ok()
}

fn apply_temporal_boost(
    rrf_scores: &mut HashMap<String, f64>,
    mtime_map: &HashMap<std::sync::Arc<str>, f64>,
    params: &TemporalParams,
    conn: &Connection,
    decay_lut: &crate::search::context::DecayLut,
) {
    if params.after.is_some() || params.before.is_some() {
        rrf_scores.retain(|path, _| {
            let Some(&mtime) = mtime_map.get(path.as_str()) else {
                return true;
            };
            if let Some(after) = params.after {
                if mtime < after {
                    return false;
                }
            }
            if let Some(before) = params.before {
                if mtime > before {
                    return false;
                }
            }
            true
        });
    }

    if let Some(session_id) = params.session_id {
        let session_paths: Option<HashSet<String>> = (|| {
            let mut stmt = conn
                .prepare("SELECT path FROM notes WHERE session_id = ?1")
                .ok()?;
            let rows = stmt
                .query_map(rusqlite::params![session_id], |row| row.get::<_, String>(0))
                .ok()?;
            let set: HashSet<String> = rows.filter_map(|r| r.ok()).collect();
            Some(set)
        })();

        if let Some(paths) = session_paths {
            rrf_scores.retain(|path, _| paths.contains(path));
        }
    }

    if let Some(half_life_days) = params.recency_days {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let half_life_secs = half_life_days * SECS_PER_DAY;

        if half_life_secs > 0.0 {
            for (path, score) in rrf_scores.iter_mut() {
                if let Some(&mtime) = mtime_map.get(path.as_str()) {
                    let age_secs = (now_secs - mtime).max(0.0);
                    *score *= decay_lut.decay(age_secs, half_life_secs);
                }
            }
        }
    }

    if let Some(ref tag) = params.project_tag {
        if let Some((phase_start, phase_end)) = load_project_phase(conn, tag) {
            let sigma = (phase_end - phase_start) / PHASE_SIGMA_DIVISOR;
            if sigma > 0.0 {
                let center = (phase_start + phase_end) / 2.0;
                let two_sigma_sq = 2.0 * sigma * sigma;

                for (path, score) in rrf_scores.iter_mut() {
                    if let Some(&mtime) = mtime_map.get(path.as_str()) {
                        let diff = mtime - center;
                        let boost = (-(diff * diff) / two_sigma_sq).exp();
                        *score *= 1.0 + RECENCY_BOOST_SCALAR * (boost - 0.5);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_helpers::helpers::*;
    use rusqlite::Connection;

    fn query(
        conn: &Connection,
        peers: &[(String, Connection)],
        query_vec: &[f32],
        text: &str,
        top_n: usize,
    ) -> Vec<SearchResult> {
        let ctx = SearchContext::build(conn);
        hybrid_query_with_ctx_inner(&ctx, conn, query_vec, text, top_n, peers, &TemporalParams::default())
    }

    #[test]
    fn search_result_score_serializes_at_four_dp() {
        let r = SearchResult {
            path: "a.md".to_string(),
            score: 0.2773399014778325,
            title: None,
            mtime: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        // Full f64 precision (0.2773399014778325) must not reach the wire; the
        // model only ranks on score, so it is rounded to 4dp at serialization.
        assert!(json.contains("\"score\":0.2773"), "got {json}");
        assert!(!json.contains("0.2773399014778325"), "score not rounded: {json}");
    }

    #[test]
    fn test_hybrid_query_returns_results() {
        let emb_a = norm(&[1.0, 0.0, 0.0]);
        let emb_b = norm(&[0.0, 1.0, 0.0]);
        let conn = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep is important for memory consolidation", &emb_a),
            ("3-permanent/diet.md", "diet and nutrition", "Protein intake affects muscle recovery", &emb_b),
        ]);

        let query_vec = norm(&[1.0, 0.1, 0.0]);
        let results = query(&conn, &[], &query_vec, "sleep", 5);

        assert!(!results.is_empty());
        assert_eq!(results[0].path, "3-permanent/sleep.md");
        assert_eq!(results[0].title, Some("sleep architecture".to_string()));
    }

    #[test]
    fn test_hybrid_query_empty_db() {
        let conn = create_test_db(&[]);
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = query(&conn, &[], &query_vec, "sleep", 5);
        assert!(results.is_empty());
    }

    #[test]
    fn test_federated_merges_local_and_peer() {
        let emb_a = norm(&[1.0, 0.0, 0.0]);
        let emb_b = norm(&[0.9, 0.1, 0.0]);
        let emb_c = norm(&[0.8, 0.2, 0.0]);

        let local = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep stages and cycles", &emb_a),
        ]);
        let peer = create_peer_db(&[
            ("3-permanent/circadian.md", "circadian rhythm", "Light exposure controls the circadian clock", &emb_b),
            ("3-permanent/melatonin.md", "melatonin synthesis", "Melatonin is produced in the pineal gland", &emb_c),
        ]);

        let peers = vec![("alice".to_string(), peer)];
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = query(&local, &peers, &query_vec, "sleep", 10);

        let paths: Vec<&str> = results.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"3-permanent/sleep.md"));
        assert!(paths.iter().any(|p| p.starts_with("peer:alice/")));

        let title = |path: &str| results.iter().find(|r| r.path == path).and_then(|r| r.title.clone());
        assert_eq!(title("3-permanent/sleep.md").as_deref(), Some("sleep architecture"));
        assert_eq!(title("peer:alice/3-permanent/circadian.md").as_deref(), Some("circadian rhythm"));
    }

    #[test]
    fn test_federated_peer_path_prefixing() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let local = create_test_db(&[
            ("local.md", "local note", "local content", &emb),
        ]);
        let peer = create_peer_db(&[
            ("3-permanent/note.md", "peer note", "peer content about sleep", &emb),
        ]);

        let peers = vec![("bob".to_string(), peer)];
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = query(&local, &peers, &query_vec, "sleep", 10);

        let peer_results: Vec<&SearchResult> = results.iter().filter(|r| r.path.starts_with("peer:")).collect();
        for r in &peer_results {
            assert!(r.path.starts_with("peer:bob/"));
            let after_prefix = r.path.strip_prefix("peer:bob/").unwrap();
            assert!(!after_prefix.starts_with("peer:"));
        }
    }

    #[test]
    fn test_federated_peer_no_embeddings_table() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let local = create_test_db(&[
            ("local.md", "local note", "sleep cycles and stages", &emb),
        ]);
        let peer = create_peer_db_no_embeddings(&[
            ("peer-note.md", "peer note", "circadian rhythm and sleep"),
        ]);

        let peers = vec![("charlie".to_string(), peer)];
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = query(&local, &peers, &query_vec, "sleep", 10);

        assert!(!results.is_empty());
        assert!(results.iter().any(|r| r.path == "local.md"));
        let peer_results: Vec<&SearchResult> = results.iter().filter(|r| r.path.starts_with("peer:charlie/")).collect();
        for r in &peer_results {
            assert!(r.score > 0.0);
        }
    }

    #[test]
    fn test_query_response_empty_when_below_threshold() {
        let emb_a = norm(&[1.0, 0.0, 0.0]);
        let emb_b = norm(&[0.0, 1.0, 0.0]);
        let conn = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep is important", &emb_a),
            ("3-permanent/diet.md", "diet and nutrition", "Protein intake matters", &emb_b),
        ]);
        let query_vec = norm(&[0.0, 0.0, 1.0]);
        let results = query(&conn, &[], &query_vec, "xyznonexistent", 5);
        let response = build_query_response("xyznonexistent".to_string(), results, &conn, 0.9);
        assert_eq!(response.meta.above_threshold, 0);
        assert!(response.results.is_empty());
        assert!(response.meta.hint.is_some());
    }

    #[test]
    fn test_query_response_includes_results_above_threshold() {
        let emb_a = norm(&[1.0, 0.0, 0.0]);
        let emb_b = norm(&[0.0, 1.0, 0.0]);
        let conn = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep is important", &emb_a),
            ("3-permanent/diet.md", "diet and nutrition", "Protein intake matters", &emb_b),
        ]);
        let query_vec = norm(&[1.0, 0.1, 0.0]);
        let results = query(&conn, &[], &query_vec, "sleep", 5);
        let response = build_query_response("sleep".to_string(), results, &conn, 0.1);
        assert!(response.meta.above_threshold > 0);
        assert!(!response.results.is_empty());
        assert!(response.meta.hint.is_none());
    }

    #[test]
    fn test_query_response_partial_filtering() {
        let emb_a = norm(&[1.0, 0.0, 0.0]);
        let emb_b = norm(&[0.0, 1.0, 0.0]);
        let conn = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep is important", &emb_a),
            ("3-permanent/diet.md", "diet and nutrition", "Protein intake matters", &emb_b),
        ]);
        // Query close to sleep, far from diet
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = query(&conn, &[], &query_vec, "sleep", 10);
        assert!(results.len() >= 2, "need both notes returned to test filtering");
        let max_score = results.iter().map(|r| r.score).fold(0.0_f64, f64::max);
        let min_score = results.iter().map(|r| r.score).fold(f64::MAX, f64::min);
        // Pick a threshold between the two scores so one passes and one doesn't
        let mid = (max_score + min_score) / 2.0;
        let response = build_query_response("sleep".to_string(), results, &conn, mid);
        assert!(response.meta.above_threshold < 2, "threshold should filter at least one result");
        assert!(response.meta.above_threshold >= 1, "threshold should keep at least one result");
        assert_eq!(response.results.len(), response.meta.above_threshold);
        assert!(response.meta.hint.is_none());
        assert_eq!(response.meta.total_indexed, 2);
    }

    #[test]
    fn test_query_response_threshold_zero_passes_all() {
        let emb_a = norm(&[1.0, 0.0, 0.0]);
        let emb_b = norm(&[0.0, 1.0, 0.0]);
        let conn = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep", &emb_a),
            ("3-permanent/diet.md", "diet and nutrition", "Protein intake", &emb_b),
        ]);
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = query(&conn, &[], &query_vec, "sleep", 10);
        let count = results.len();
        let response = build_query_response("sleep".to_string(), results, &conn, 0.0);
        assert_eq!(response.results.len(), count);
        assert_eq!(response.meta.above_threshold, count);
        assert!(response.meta.hint.is_none());
    }

    #[test]
    fn test_query_response_empty_db() {
        let conn = create_test_db(&[]);
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = query(&conn, &[], &query_vec, "anything", 5);
        let response = build_query_response("anything".to_string(), results, &conn, 0.15);
        assert_eq!(response.meta.total_indexed, 0);
        assert_eq!(response.meta.above_threshold, 0);
        assert!(response.results.is_empty());
        assert!(response.meta.hint.is_some());
    }

    #[test]
    fn test_federated_peer_no_fts_table() {
        let emb_local = norm(&[1.0, 0.0, 0.0]);
        let emb_peer = norm(&[0.9, 0.1, 0.0]);
        let local = create_test_db(&[
            ("local.md", "local note", "sleep content", &emb_local),
        ]);
        let peer = create_peer_db_no_fts(&[
            ("peer.md", "peer note", &emb_peer),
        ]);

        let peers = vec![("delta".to_string(), peer)];
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = query(&local, &peers, &query_vec, "sleep", 10);

        assert!(!results.is_empty());
        let peer_results: Vec<&SearchResult> = results.iter().filter(|r| r.path.starts_with("peer:delta/")).collect();
        assert!(!peer_results.is_empty());
    }
}
