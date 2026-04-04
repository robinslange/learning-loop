use std::collections::{HashMap, HashSet};

use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::db::load_all_embeddings;
use crate::embed::embed_query;

use super::scoring::{add_ranked_rrf, cosine, fts_bm25_query, collect_seeds, finalize_rrf, rocchio_prf};
use super::graph::{load_link_graph, personalized_pagerank, tag_expand};
use super::federation::{add_peer_rrf_scores, load_title_federated};
use super::store::EmbeddingStore;

#[derive(Serialize)]
pub struct SearchResult {
    pub path: String,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<f64>,
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

pub(crate) fn local_rrf_scores(
    conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    store: &EmbeddingStore,
    graph: &HashMap<String, Vec<String>>,
) -> HashMap<String, f64> {
    let all_embeddings = store.all();
    let mut vec_scored: Vec<(String, f64)> = all_embeddings
        .par_iter()
        .map(|(_, path, emb)| (path.clone(), cosine(query_vec, emb) as f64))
        .collect();
    vec_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    vec_scored.truncate(30);

    let fts_results = fts_bm25_query(conn, query_text, 30);

    let mut rrf_scores: HashMap<String, f64> = HashMap::new();
    add_ranked_rrf(&mut rrf_scores, vec_scored.iter().map(|(p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf_scores, fts_results.iter().map(|(_, p, _)| p.as_str()));

    let seeds = collect_seeds(&vec_scored, &fts_results);
    let ppr_results = personalized_pagerank(graph, &seeds, 0.5, 20);
    let tag_results = tag_expand(conn, &seeds);
    add_ranked_rrf(&mut rrf_scores, ppr_results.iter().map(|(p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf_scores, tag_results.iter().map(|(p, _)| p.as_str()));

    let prf_results = rocchio_prf(query_vec, &vec_scored, &all_embeddings);
    add_ranked_rrf(&mut rrf_scores, prf_results.iter().map(|(p, _)| p.as_str()));

    rrf_scores
}

pub fn hybrid_query(conn: &Connection, query_text: &str, top_n: usize, temporal: &TemporalParams, store: &EmbeddingStore) -> Vec<SearchResult> {
    let query_vec = embed_query(query_text);
    hybrid_query_inner(conn, &query_vec, query_text, top_n, temporal, store)
}

pub(crate) fn hybrid_query_inner(
    conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    top_n: usize,
    temporal: &TemporalParams,
    store: &EmbeddingStore,
) -> Vec<SearchResult> {
    let graph = load_link_graph(conn);
    let mut rrf = local_rrf_scores(conn, query_vec, query_text, store, &graph);
    let titles = load_titles_map(conn);
    let mtimes = load_mtime_map(conn);

    if temporal.has_any() {
        apply_temporal_boost(&mut rrf, &mtimes, temporal, conn);
    }

    finalize_rrf(rrf, top_n)
        .into_iter()
        .map(|(path, score)| SearchResult {
            title: titles.get(&path).cloned().flatten(),
            mtime: mtimes.get(&path).copied(),
            path,
            score,
        })
        .collect()
}

pub fn hybrid_query_federated(
    conn: &Connection,
    query_text: &str,
    top_n: usize,
    peers: &[(String, Connection)],
    temporal: &TemporalParams,
    store: &EmbeddingStore,
) -> Vec<SearchResult> {
    let query_vec = embed_query(query_text);
    hybrid_query_federated_inner(conn, &query_vec, query_text, top_n, peers, temporal, store)
}

pub(crate) fn hybrid_query_federated_inner(
    conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    top_n: usize,
    peers: &[(String, Connection)],
    temporal: &TemporalParams,
    store: &EmbeddingStore,
) -> Vec<SearchResult> {
    let graph = load_link_graph(conn);
    let mut rrf = local_rrf_scores(conn, query_vec, query_text, store, &graph);
    let mtimes = load_mtime_map(conn);

    let local_dim = query_vec.len();

    for (peer_id, peer_conn) in peers {
        let peer_embeddings = load_all_embeddings(peer_conn);
        let peer_dim = peer_embeddings.first().map(|(_, _, e)| e.len()).unwrap_or(0);

        if peer_dim == local_dim && peer_dim > 0 {
            add_peer_rrf_scores(&mut rrf, peer_id, peer_conn, query_vec, query_text, &peer_embeddings);
        } else {
            let peer_fts = fts_bm25_query(peer_conn, query_text, 30);
            add_ranked_rrf(
                &mut rrf,
                peer_fts.iter()
                    .map(|(_, path, _)| format!("peer:{peer_id}/{path}"))
                    .collect::<Vec<_>>()
                    .iter()
                    .map(|s| s.as_str()),
            );
        }
    }

    if temporal.has_any() {
        apply_temporal_boost(&mut rrf, &mtimes, temporal, conn);
    }

    finalize_rrf(rrf, top_n)
        .into_iter()
        .map(|(path, score)| SearchResult {
            title: load_title_federated(&path, conn, peers),
            mtime: mtimes.get(&path).copied(),
            path,
            score,
        })
        .collect()
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
    mtime_map: &HashMap<String, f64>,
    params: &TemporalParams,
    conn: &Connection,
) {
    if params.after.is_some() || params.before.is_some() {
        rrf_scores.retain(|path, _| {
            let Some(&mtime) = mtime_map.get(path) else {
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
        let half_life_secs = half_life_days * 86400.0;

        if half_life_secs > 0.0 {
            let ln2 = std::f64::consts::LN_2;
            for (path, score) in rrf_scores.iter_mut() {
                if let Some(&mtime) = mtime_map.get(path) {
                    let age_secs = (now_secs - mtime).max(0.0);
                    let decay = (-ln2 * age_secs / half_life_secs).exp();
                    *score *= decay;
                }
            }
        }
    }

    if let Some(ref tag) = params.project_tag {
        if let Some((phase_start, phase_end)) = load_project_phase(conn, tag) {
            let sigma = (phase_end - phase_start) / 4.0;
            if sigma > 0.0 {
                let center = (phase_start + phase_end) / 2.0;
                let two_sigma_sq = 2.0 * sigma * sigma;

                for (path, score) in rrf_scores.iter_mut() {
                    if let Some(&mtime) = mtime_map.get(path) {
                        let diff = mtime - center;
                        let boost = (-(diff * diff) / two_sigma_sq).exp();
                        *score *= 1.0 + 0.15 * (boost - 0.5);
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

    #[test]
    fn test_hybrid_query_inner_returns_results() {
        let emb_a = norm(&[1.0, 0.0, 0.0]);
        let emb_b = norm(&[0.0, 1.0, 0.0]);
        let conn = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep is important for memory consolidation", &emb_a),
            ("3-permanent/diet.md", "diet and nutrition", "Protein intake affects muscle recovery", &emb_b),
        ]);
        let store = EmbeddingStore::load(&conn);

        let query_vec = norm(&[1.0, 0.1, 0.0]);
        let results = hybrid_query_inner(&conn, &query_vec, "sleep", 5, &TemporalParams::default(), &store);

        assert!(!results.is_empty());
        assert_eq!(results[0].path, "3-permanent/sleep.md");
        assert_eq!(results[0].title, Some("sleep architecture".to_string()));
    }

    #[test]
    fn test_hybrid_query_inner_empty_db() {
        let conn = create_test_db(&[]);
        let store = EmbeddingStore::load(&conn);
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = hybrid_query_inner(&conn, &query_vec, "sleep", 5, &TemporalParams::default(), &store);
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
        let store = EmbeddingStore::load(&local);
        let peer = create_peer_db(&[
            ("3-permanent/circadian.md", "circadian rhythm", "Light exposure controls the circadian clock", &emb_b),
            ("3-permanent/melatonin.md", "melatonin synthesis", "Melatonin is produced in the pineal gland", &emb_c),
        ]);

        let peers = vec![("alice".to_string(), peer)];
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = hybrid_query_federated_inner(&local, &query_vec, "sleep", 10, &peers, &TemporalParams::default(), &store);

        let paths: Vec<&str> = results.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"3-permanent/sleep.md"));
        assert!(paths.iter().any(|p| p.starts_with("peer:alice/")));
    }

    #[test]
    fn test_federated_peer_path_prefixing() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let local = create_test_db(&[
            ("local.md", "local note", "local content", &emb),
        ]);
        let store = EmbeddingStore::load(&local);
        let peer = create_peer_db(&[
            ("3-permanent/note.md", "peer note", "peer content about sleep", &emb),
        ]);

        let peers = vec![("bob".to_string(), peer)];
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = hybrid_query_federated_inner(&local, &query_vec, "sleep", 10, &peers, &TemporalParams::default(), &store);

        let peer_results: Vec<&SearchResult> = results.iter().filter(|r| r.path.starts_with("peer:")).collect();
        for r in &peer_results {
            assert!(r.path.starts_with("peer:bob/"));
            let after_prefix = r.path.strip_prefix("peer:bob/").unwrap();
            assert!(!after_prefix.starts_with("peer:"));
        }
    }

    #[test]
    fn test_federated_no_peers_matches_local() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep is critical", &emb),
        ]);
        let store = EmbeddingStore::load(&conn);

        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let local_results = hybrid_query_inner(&conn, &query_vec, "sleep", 5, &TemporalParams::default(), &store);

        let conn2 = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep is critical", &emb),
        ]);
        let store2 = EmbeddingStore::load(&conn2);
        let peers: Vec<(String, Connection)> = vec![];
        let fed_results = hybrid_query_federated_inner(&conn2, &query_vec, "sleep", 5, &peers, &TemporalParams::default(), &store2);

        assert_eq!(local_results.len(), fed_results.len());
        for (l, f) in local_results.iter().zip(fed_results.iter()) {
            assert_eq!(l.path, f.path);
        }
    }

    #[test]
    fn test_federated_peer_no_embeddings_table() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let local = create_test_db(&[
            ("local.md", "local note", "sleep cycles and stages", &emb),
        ]);
        let store = EmbeddingStore::load(&local);
        let peer = create_peer_db_no_embeddings(&[
            ("peer-note.md", "peer note", "circadian rhythm and sleep"),
        ]);

        let peers = vec![("charlie".to_string(), peer)];
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = hybrid_query_federated_inner(&local, &query_vec, "sleep", 10, &peers, &TemporalParams::default(), &store);

        assert!(!results.is_empty());
        assert!(results.iter().any(|r| r.path == "local.md"));
        let peer_results: Vec<&SearchResult> = results.iter().filter(|r| r.path.starts_with("peer:charlie/")).collect();
        for r in &peer_results {
            assert!(r.score > 0.0);
        }
    }

    #[test]
    fn test_federated_peer_no_fts_table() {
        let emb_local = norm(&[1.0, 0.0, 0.0]);
        let emb_peer = norm(&[0.9, 0.1, 0.0]);
        let local = create_test_db(&[
            ("local.md", "local note", "sleep content", &emb_local),
        ]);
        let store = EmbeddingStore::load(&local);
        let peer = create_peer_db_no_fts(&[
            ("peer.md", "peer note", &emb_peer),
        ]);

        let peers = vec![("delta".to_string(), peer)];
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = hybrid_query_federated_inner(&local, &query_vec, "sleep", 10, &peers, &TemporalParams::default(), &store);

        assert!(!results.is_empty());
        let peer_results: Vec<&SearchResult> = results.iter().filter(|r| r.path.starts_with("peer:delta/")).collect();
        assert!(!peer_results.is_empty());
    }
}
