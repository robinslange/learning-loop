use std::collections::HashMap;

use serde::Serialize;

use crate::embed::embed_query;

use super::scoring::{add_ranked_rrf, finalize_rrf, rocchio_prf_with, PrfParams};
use super::store::EmbeddingStore;
use super::context::SearchContext;

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

// Strategy A: Replace original vector with PRF vector
fn strategy_replace(
    ctx: &SearchContext,
    conn: &rusqlite::Connection,
    query_vec: &[f32],
    query_text: &str,
    params: &PrfParams,
) -> Vec<(String, f64)> {
    let all_embeddings = ctx.store.all();
    let signals = ctx.compute_signals(conn, query_vec, query_text);
    let prf_results = rocchio_prf_with(query_vec, &signals.vec_scored, all_embeddings, params);

    let mut rrf: HashMap<String, f64> = HashMap::new();
    add_ranked_rrf(&mut rrf, prf_results.iter().map(|(p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf, signals.fts_results.iter().map(|(_, p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf, signals.ppr_results.iter().map(|(p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf, signals.tag_results.iter().map(|(p, _)| p.as_str()));

    finalize_rrf(rrf, 10)
}

// Strategy B: Feed PRF from hybrid RRF results, not just vector
fn strategy_hybrid_feedback(
    ctx: &SearchContext,
    conn: &rusqlite::Connection,
    query_vec: &[f32],
    query_text: &str,
    params: &PrfParams,
) -> Vec<(String, f64)> {
    let all_embeddings = ctx.store.all();
    let signals = ctx.compute_signals(conn, query_vec, query_text);

    let rrf = ctx.rrf_from_signals(&signals, None);
    let mut initial: Vec<(String, f64)> = rrf.into_iter().collect();
    initial.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    initial.truncate(30);

    let prf_results = rocchio_prf_with(query_vec, &initial, all_embeddings, params);
    let rrf = ctx.rrf_from_signals(&signals, Some(&prf_results));
    finalize_rrf(rrf, 10)
}

// Strategy C: Two-pass. Run 4-signal RRF, feed top-k to PRF, replace vector with expanded
fn strategy_two_pass(
    ctx: &SearchContext,
    conn: &rusqlite::Connection,
    query_vec: &[f32],
    query_text: &str,
    params: &PrfParams,
) -> Vec<(String, f64)> {
    let all_embeddings = ctx.store.all();
    let signals = ctx.compute_signals(conn, query_vec, query_text);

    let rrf = ctx.rrf_from_signals(&signals, None);
    let mut pass1: Vec<(String, f64)> = rrf.into_iter().collect();
    pass1.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    pass1.truncate(30);

    let prf_results = rocchio_prf_with(query_vec, &pass1, all_embeddings, params);

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
    _store: &EmbeddingStore,
) -> TuneResult {
    let ctx = SearchContext::build(conn);

    type StrategyFn = fn(&SearchContext, &rusqlite::Connection, &[f32], &str, &PrfParams) -> Vec<(String, f64)>;

    let strategy_fns: Vec<(&str, StrategyFn)> = vec![
        ("replace", strategy_replace as StrategyFn),
        ("hybrid-fb", strategy_hybrid_feedback as StrategyFn),
        ("two-pass", strategy_two_pass as StrategyFn),
    ];

    let baseline: Vec<QueryResult> = queries.iter().map(|q| {
        let qvec = embed_query(q);
        let signals = ctx.compute_signals(conn, &qvec, q);
        let rrf = ctx.rrf_from_signals(&signals, None);
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

    let mut strategies = Vec::new();

    for (name, func) in &strategy_fns {
        for params in &param_grid {
            let query_results: Vec<QueryResult> = queries.iter().map(|q| {
                let qvec = embed_query(q);
                let results = func(&ctx, conn, &qvec, q, params);
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
