use std::collections::HashMap;
use std::sync::Arc;

use rayon::prelude::*;
use rusqlite::Connection;

use super::scoring::{add_ranked_rrf, dot_product, fts_bm25_query, collect_seeds, rocchio_prf_with, PrfParams};
use super::graph::{load_link_graph, load_tags_map, personalized_pagerank};
use super::store::{EmbeddingStore, load_store};
use super::query::{load_titles_map, load_mtime_map};


pub struct SearchContext {
    pub(crate) store: Arc<EmbeddingStore>,
    pub(crate) graph: Arc<HashMap<String, Vec<String>>>,
    pub(crate) titles: Arc<HashMap<String, Option<String>>>,
    pub(crate) mtimes: Arc<HashMap<String, f64>>,
    pub(crate) tags: Arc<HashMap<String, Vec<String>>>,
    pub(crate) data_version: i64,
}

pub(crate) struct Signals {
    pub vec_scored: Vec<(String, f64)>,
    pub fts_results: Vec<(i64, String, f64)>,
    pub ppr_results: Vec<(String, f64)>,
    pub tag_results: Vec<(String, f64)>,
}

impl SearchContext {
    pub fn build(conn: &Connection) -> Self {
        let store = load_store(conn);
        let graph = Arc::new(load_link_graph(conn));
        let titles = Arc::new(load_titles_map(conn));
        let mtimes = Arc::new(load_mtime_map(conn));
        let tags = Arc::new(load_tags_map(conn));
        let data_version = read_data_version(conn);
        Self { store, graph, titles, mtimes, tags, data_version }
    }

    pub fn is_stale(&self, conn: &Connection) -> bool {
        read_data_version(conn) != self.data_version
    }

    pub fn refresh(&mut self, conn: &Connection) {
        *self = Self::build(conn);
    }

    pub(crate) fn compute_signals(
        &self,
        conn: &Connection,
        query_vec: &[f32],
        query_text: &str,
    ) -> Signals {
        let all_embeddings = self.store.all();
        let mut vec_scored: Vec<(String, f64)> = all_embeddings
            .par_iter()
            .map(|(_, path, emb)| (path.clone(), dot_product(query_vec, emb) as f64))
            .collect();
        vec_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        vec_scored.truncate(30);

        let fts_results = fts_bm25_query(conn, query_text, 30);
        let seeds = collect_seeds(&vec_scored, &fts_results);
        let ppr_results = personalized_pagerank(&self.graph, &seeds, 0.5, 20);
        let tag_results = tag_expand_from_map(&self.tags, &seeds);

        Signals { vec_scored, fts_results, ppr_results, tag_results }
    }

    pub(crate) fn rrf_from_signals(
        &self,
        signals: &Signals,
        extra: Option<&[(String, f64)]>,
    ) -> HashMap<String, f64> {
        let mut rrf: HashMap<String, f64> = HashMap::new();
        add_ranked_rrf(&mut rrf, signals.vec_scored.iter().map(|(p, _)| p.as_str()));
        add_ranked_rrf(&mut rrf, signals.fts_results.iter().map(|(_, p, _)| p.as_str()));
        add_ranked_rrf(&mut rrf, signals.ppr_results.iter().map(|(p, _)| p.as_str()));
        add_ranked_rrf(&mut rrf, signals.tag_results.iter().map(|(p, _)| p.as_str()));
        if let Some(extra) = extra {
            add_ranked_rrf(&mut rrf, extra.iter().map(|(p, _)| p.as_str()));
        }
        rrf
    }

    pub(crate) fn local_rrf_scores(
        &self,
        conn: &Connection,
        query_vec: &[f32],
        query_text: &str,
    ) -> HashMap<String, f64> {
        let all_embeddings = self.store.all();
        let signals = self.compute_signals(conn, query_vec, query_text);

        let mut rrf = self.rrf_from_signals(&signals, None);

        // Hybrid-feedback PRF
        let mut initial: Vec<(String, f64)> = rrf.iter().map(|(p, s)| (p.clone(), *s)).collect();
        initial.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        initial.truncate(30);
        let prf_params = PrfParams { alpha: 0.5, beta: 0.5, k: 1 };
        let prf_results = rocchio_prf_with(query_vec, &initial, all_embeddings, &prf_params);
        add_ranked_rrf(&mut rrf, prf_results.iter().map(|(p, _)| p.as_str()));

        rrf
    }
}

fn read_data_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
}

fn tag_expand_from_map(
    tags_map: &HashMap<String, Vec<String>>,
    seed_paths: &[String],
) -> Vec<(String, f64)> {
    use std::collections::HashSet;

    let total_notes = tags_map.len() as f64;
    if total_notes == 0.0 {
        return Vec::new();
    }
    let seed_set: HashSet<&str> = seed_paths.iter().map(|s| s.as_str()).collect();

    let mut seed_tags: HashSet<String> = HashSet::new();
    for path in seed_paths {
        if let Some(tags) = tags_map.get(path) {
            for tag in tags {
                seed_tags.insert(tag.clone());
            }
        }
    }

    let mut tag_freq: HashMap<&str, usize> = HashMap::new();
    for tags in tags_map.values() {
        for tag in tags {
            *tag_freq.entry(tag.as_str()).or_default() += 1;
        }
    }

    let qualifying: HashSet<&str> = seed_tags
        .iter()
        .filter_map(|t| {
            let freq = *tag_freq.get(t.as_str()).unwrap_or(&0);
            if (2..=20).contains(&freq) {
                Some(t.as_str())
            } else {
                None
            }
        })
        .collect();

    if qualifying.is_empty() {
        return Vec::new();
    }

    let mut candidate_scores: HashMap<&str, f64> = HashMap::new();
    for (path, tags) in tags_map {
        if seed_set.contains(path.as_str()) {
            continue;
        }
        let score: f64 = tags
            .iter()
            .filter(|t| qualifying.contains(t.as_str()))
            .map(|t| {
                let freq = *tag_freq.get(t.as_str()).unwrap_or(&1) as f64;
                (total_notes / freq).ln()
            })
            .sum();
        if score > 0.0 {
            candidate_scores.insert(path.as_str(), score);
        }
    }

    let mut results: Vec<(String, f64)> = candidate_scores
        .into_iter()
        .map(|(path, score)| (path.to_string(), score))
        .collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(30);
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_helpers::helpers::*;

    #[test]
    fn test_build_caches_match_inline() {
        let emb_a = norm(&[1.0, 0.0, 0.0]);
        let emb_b = norm(&[0.0, 1.0, 0.0]);
        let conn = create_test_db(&[
            ("a.md", "title a", "body a", &emb_a),
            ("b.md", "title b", "body b", &emb_b),
        ]);
        let ctx = SearchContext::build(&conn);

        let titles_inline = load_titles_map(&conn);
        let mtimes_inline = load_mtime_map(&conn);
        let graph_inline = load_link_graph(&conn);

        assert_eq!(*ctx.titles, titles_inline);
        assert_eq!(*ctx.mtimes, mtimes_inline);
        assert_eq!(ctx.graph.len(), graph_inline.len());
        assert_eq!(ctx.store.len(), 2);
    }

    #[test]
    fn test_refresh_picks_up_new_note() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_test_db(&[("a.md", "title a", "body a", &emb)]);
        let mut ctx = SearchContext::build(&conn);
        assert_eq!(ctx.store.len(), 1);

        let emb_bytes: Vec<u8> = emb.iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.execute(
            "INSERT INTO notes (path, title, content_hash, mtime) VALUES ('b.md', 'title b', 'hash', 1000.0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO embeddings (id, data) SELECT id, ?1 FROM notes WHERE path = 'b.md'",
            rusqlite::params![emb_bytes],
        ).unwrap();

        ctx.refresh(&conn);
        assert_eq!(ctx.store.len(), 2);
        assert!(ctx.titles.contains_key("b.md"));
    }

    #[test]
    fn test_data_version_is_readable() {
        let conn = create_test_db(&[]);
        let v = read_data_version(&conn);
        assert!(v >= 0, "data_version should be a non-negative integer");
        let ctx = SearchContext::build(&conn);
        let _ = ctx.is_stale(&conn);
    }

    #[test]
    fn test_query_matches_legacy_path() {
        let emb_a = norm(&[1.0, 0.0, 0.0]);
        let emb_b = norm(&[0.0, 1.0, 0.0]);
        let conn = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep is important", &emb_a),
            ("3-permanent/diet.md", "diet and nutrition", "Protein intake matters", &emb_b),
        ]);
        let store = super::super::store::load_store(&conn);
        let query_vec = norm(&[1.0, 0.1, 0.0]);

        let all_embeddings = store.all();
        let graph = load_link_graph(&conn);
        let legacy = super::super::query::local_rrf_scores(
            &conn, &query_vec, "sleep", all_embeddings, &graph,
        );
        let mut legacy_top: Vec<(String, f64)> = legacy.into_iter().collect();
        legacy_top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        legacy_top.truncate(10);

        let ctx = SearchContext::build(&conn);
        let ctx_scores = ctx.local_rrf_scores(&conn, &query_vec, "sleep");
        let mut ctx_top: Vec<(String, f64)> = ctx_scores.into_iter().collect();
        ctx_top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ctx_top.truncate(10);

        let legacy_paths: Vec<&str> = legacy_top.iter().map(|(p, _)| p.as_str()).collect();
        let ctx_paths: Vec<&str> = ctx_top.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(legacy_paths, ctx_paths);
    }
}
