use std::collections::HashMap;

use rayon::prelude::*;
use serde::Serialize;

use crate::embed::embed_query;

use super::scoring::{add_ranked_rrf, cosine, fts_bm25_query, collect_seeds, finalize_rrf, rocchio_prf_with, PrfParams};
use super::graph::{load_link_graph, personalized_pagerank, tag_expand};
use super::store::EmbeddingStore;

#[derive(Debug, Serialize)]
pub struct TuneResult {
    pub baseline: Vec<QueryResult>,
    pub strategies: Vec<StrategyResult>,
}

#[derive(Debug, Serialize)]
pub struct StrategyResult {
    pub strategy: String,
    pub alpha: f32,
    pub k: usize,
    pub queries: Vec<QueryResult>,
    pub avg_new_at_5: f64,
    pub avg_new_at_10: f64,
    pub avg_promoted: f64,
    pub avg_demoted: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub query: String,
    pub top10: Vec<String>,
}

struct Signals {
    vec_scored: Vec<(String, f64)>,
    fts_results: Vec<(i64, String, f64)>,
    ppr_results: Vec<(String, f64)>,
    tag_results: Vec<(String, f64)>,
}

fn compute_signals(
    conn: &rusqlite::Connection,
    query_vec: &[f32],
    query_text: &str,
    all_embeddings: &[(i64, String, Vec<f32>)],
    graph: &HashMap<String, Vec<String>>,
) -> Signals {
    let mut vec_scored: Vec<(String, f64)> = all_embeddings
        .par_iter()
        .map(|(_, path, emb)| (path.clone(), cosine(query_vec, emb) as f64))
        .collect();
    vec_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    vec_scored.truncate(30);

    let fts_results = fts_bm25_query(conn, query_text, 30);
    let seeds = collect_seeds(&vec_scored, &fts_results);
    let ppr_results = personalized_pagerank(graph, &seeds, 0.5, 20);
    let tag_results = tag_expand(conn, &seeds);

    Signals { vec_scored, fts_results, ppr_results, tag_results }
}

fn rrf_from_signals(signals: &Signals, extra: Option<&[(String, f64)]>) -> HashMap<String, f64> {
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

// Strategy A: Replace original vector with PRF vector
fn strategy_replace(
    conn: &rusqlite::Connection,
    query_vec: &[f32],
    query_text: &str,
    all_embeddings: &[(i64, String, Vec<f32>)],
    graph: &HashMap<String, Vec<String>>,
    params: &PrfParams,
) -> Vec<(String, f64)> {
    let signals = compute_signals(conn, query_vec, query_text, all_embeddings, graph);
    let prf_results = rocchio_prf_with(query_vec, &signals.vec_scored, all_embeddings, params);

    // Replace: use PRF vector instead of original vector
    let mut rrf: HashMap<String, f64> = HashMap::new();
    add_ranked_rrf(&mut rrf, prf_results.iter().map(|(p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf, signals.fts_results.iter().map(|(_, p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf, signals.ppr_results.iter().map(|(p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf, signals.tag_results.iter().map(|(p, _)| p.as_str()));

    finalize_rrf(rrf, 10)
}

// Strategy B: Feed PRF from hybrid RRF results, not just vector
fn strategy_hybrid_feedback(
    conn: &rusqlite::Connection,
    query_vec: &[f32],
    query_text: &str,
    all_embeddings: &[(i64, String, Vec<f32>)],
    graph: &HashMap<String, Vec<String>>,
    params: &PrfParams,
) -> Vec<(String, f64)> {
    let signals = compute_signals(conn, query_vec, query_text, all_embeddings, graph);

    // Get initial RRF ranking (no PRF)
    let rrf = rrf_from_signals(&signals, None);
    let mut initial: Vec<(String, f64)> = rrf.into_iter().collect();
    initial.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    initial.truncate(30);

    // Feed PRF from hybrid results (not just vector results)
    let prf_results = rocchio_prf_with(query_vec, &initial, all_embeddings, params);

    // Add PRF as 5th signal
    let rrf = rrf_from_signals(&signals, Some(&prf_results));
    finalize_rrf(rrf, 10)
}

// Strategy C: Two-pass. Run 4-signal RRF, feed top-k to PRF, replace vector with expanded
fn strategy_two_pass(
    conn: &rusqlite::Connection,
    query_vec: &[f32],
    query_text: &str,
    all_embeddings: &[(i64, String, Vec<f32>)],
    graph: &HashMap<String, Vec<String>>,
    params: &PrfParams,
) -> Vec<(String, f64)> {
    let signals = compute_signals(conn, query_vec, query_text, all_embeddings, graph);

    // Pass 1: full 4-signal RRF
    let rrf = rrf_from_signals(&signals, None);
    let mut pass1: Vec<(String, f64)> = rrf.into_iter().collect();
    pass1.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    pass1.truncate(30);

    // PRF from hybrid results
    let prf_results = rocchio_prf_with(query_vec, &pass1, all_embeddings, params);

    // Pass 2: replace original vector with PRF vector
    let mut rrf2: HashMap<String, f64> = HashMap::new();
    add_ranked_rrf(&mut rrf2, prf_results.iter().map(|(p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf2, signals.fts_results.iter().map(|(_, p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf2, signals.ppr_results.iter().map(|(p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf2, signals.tag_results.iter().map(|(p, _)| p.as_str()));

    finalize_rrf(rrf2, 10)
}

fn rank_position(results: &[String], item: &str) -> Option<usize> {
    results.iter().position(|p| p == item)
}

pub fn tune_prf(
    conn: &rusqlite::Connection,
    queries: &[String],
    store: &EmbeddingStore,
) -> TuneResult {
    let all_embeddings = store.all();
    let graph = load_link_graph(conn);

    // Baseline: no PRF
    let baseline: Vec<QueryResult> = queries.iter().map(|q| {
        let qvec = embed_query(q);
        let signals = compute_signals(conn, &qvec, q, &all_embeddings, &graph);
        let rrf = rrf_from_signals(&signals, None);
        let results = finalize_rrf(rrf, 10);
        let top10: Vec<String> = results.iter().map(|(p, _)| p.clone()).collect();
        QueryResult { query: q.clone(), top10 }
    }).collect();

    let param_grid = vec![
        PrfParams { alpha: 0.5, beta: 0.5, k: 1 },
        PrfParams { alpha: 0.5, beta: 0.5, k: 3 },
        PrfParams { alpha: 0.7, beta: 0.3, k: 1 },
        PrfParams { alpha: 0.7, beta: 0.3, k: 3 },
        PrfParams { alpha: 0.9, beta: 0.1, k: 1 },
        PrfParams { alpha: 0.9, beta: 0.1, k: 3 },
    ];

    type StrategyFn = fn(&rusqlite::Connection, &[f32], &str, &[(i64, String, Vec<f32>)], &HashMap<String, Vec<String>>, &PrfParams) -> Vec<(String, f64)>;

    let strategy_fns: Vec<(&str, StrategyFn)> = vec![
        ("replace", strategy_replace as StrategyFn),
        ("hybrid-fb", strategy_hybrid_feedback as StrategyFn),
        ("two-pass", strategy_two_pass as StrategyFn),
    ];

    let mut strategies = Vec::new();

    for (name, func) in &strategy_fns {
        for params in &param_grid {
            let query_results: Vec<QueryResult> = queries.iter().map(|q| {
                let qvec = embed_query(q);
                let results = func(conn, &qvec, q, &all_embeddings, &graph, params);
                let top10: Vec<String> = results.iter().map(|(p, _)| p.clone()).collect();
                QueryResult { query: q.clone(), top10 }
            }).collect();

            let n = queries.len() as f64;
            let mut total_new_5 = 0.0;
            let mut total_new_10 = 0.0;
            let mut total_promoted = 0.0;
            let mut total_demoted = 0.0;

            for (i, qr) in query_results.iter().enumerate() {
                let bl = &baseline[i];
                let bl5: Vec<&str> = bl.top10.iter().take(5).map(|s| s.as_str()).collect();
                let bl10: Vec<&str> = bl.top10.iter().map(|s| s.as_str()).collect();
                let qr5: Vec<&str> = qr.top10.iter().take(5).map(|s| s.as_str()).collect();
                let qr10: Vec<&str> = qr.top10.iter().map(|s| s.as_str()).collect();

                total_new_5 += qr5.iter().filter(|p| !bl5.contains(p)).count() as f64;
                total_new_10 += qr10.iter().filter(|p| !bl10.contains(p)).count() as f64;

                // Count notes that moved up or down in ranking
                for (rank, path) in qr.top10.iter().enumerate() {
                    if let Some(bl_rank) = rank_position(&bl.top10, path) {
                        if rank < bl_rank { total_promoted += 1.0; }
                        if rank > bl_rank { total_demoted += 1.0; }
                    }
                }
            }

            strategies.push(StrategyResult {
                strategy: name.to_string(),
                alpha: params.alpha,
                k: params.k,
                queries: query_results,
                avg_new_at_5: total_new_5 / n,
                avg_new_at_10: total_new_10 / n,
                avg_promoted: total_promoted / n,
                avg_demoted: total_demoted / n,
            });
        }
    }

    TuneResult { baseline, strategies }
}
