use std::collections::HashMap;

use rayon::prelude::*;
use serde::Serialize;

use crate::embed::embed_query;

use super::scoring::{add_ranked_rrf, cosine, fts_bm25_query, collect_seeds, finalize_rrf, rocchio_prf_with, PrfParams};
use super::graph::{load_link_graph, personalized_pagerank, tag_expand};
use super::store::EmbeddingStore;

#[derive(Debug, Serialize)]
pub struct TuneResult {
    pub configs: Vec<ConfigResult>,
    pub baseline: BaselineResult,
}

#[derive(Debug, Serialize)]
pub struct BaselineResult {
    pub label: String,
    pub queries: Vec<QueryResult>,
}

#[derive(Debug, Serialize)]
pub struct ConfigResult {
    pub alpha: f32,
    pub beta: f32,
    pub k: usize,
    pub label: String,
    pub queries: Vec<QueryResult>,
    pub avg_change_at_5: f64,
    pub avg_change_at_10: f64,
    pub avg_new_in_top5: f64,
    pub avg_new_in_top10: f64,
}

#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub query: String,
    pub top5: Vec<String>,
    pub top10: Vec<String>,
}

fn rrf_no_prf(
    conn: &rusqlite::Connection,
    query_vec: &[f32],
    query_text: &str,
    all_embeddings: &[(i64, String, Vec<f32>)],
    graph: &HashMap<String, Vec<String>>,
    top_n: usize,
) -> Vec<(String, f64)> {
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

    finalize_rrf(rrf_scores, top_n)
}

fn rrf_with_prf(
    conn: &rusqlite::Connection,
    query_vec: &[f32],
    query_text: &str,
    all_embeddings: &[(i64, String, Vec<f32>)],
    graph: &HashMap<String, Vec<String>>,
    params: &PrfParams,
    top_n: usize,
) -> Vec<(String, f64)> {
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

    let prf_results = rocchio_prf_with(query_vec, &vec_scored, all_embeddings, params);
    add_ranked_rrf(&mut rrf_scores, prf_results.iter().map(|(p, _)| p.as_str()));

    finalize_rrf(rrf_scores, top_n)
}

pub fn tune_prf(
    conn: &rusqlite::Connection,
    queries: &[String],
    store: &EmbeddingStore,
) -> TuneResult {
    let all_embeddings = store.all();
    let graph = load_link_graph(conn);

    let configs = vec![
        PrfParams { alpha: 0.5, beta: 0.5, k: 1 },
        PrfParams { alpha: 0.5, beta: 0.5, k: 2 },
        PrfParams { alpha: 0.5, beta: 0.5, k: 3 },
        PrfParams { alpha: 0.5, beta: 0.5, k: 5 },
        PrfParams { alpha: 0.6, beta: 0.4, k: 1 },
        PrfParams { alpha: 0.6, beta: 0.4, k: 2 },
        PrfParams { alpha: 0.6, beta: 0.4, k: 3 },
        PrfParams { alpha: 0.6, beta: 0.4, k: 5 },
        PrfParams { alpha: 0.7, beta: 0.3, k: 1 },
        PrfParams { alpha: 0.7, beta: 0.3, k: 2 },
        PrfParams { alpha: 0.7, beta: 0.3, k: 3 },
        PrfParams { alpha: 0.7, beta: 0.3, k: 5 },
        PrfParams { alpha: 0.8, beta: 0.2, k: 1 },
        PrfParams { alpha: 0.8, beta: 0.2, k: 2 },
        PrfParams { alpha: 0.8, beta: 0.2, k: 3 },
        PrfParams { alpha: 0.8, beta: 0.2, k: 5 },
        PrfParams { alpha: 0.9, beta: 0.1, k: 1 },
        PrfParams { alpha: 0.9, beta: 0.1, k: 2 },
        PrfParams { alpha: 0.9, beta: 0.1, k: 3 },
        PrfParams { alpha: 0.9, beta: 0.1, k: 5 },
    ];

    // Baseline: no PRF
    let baseline_queries: Vec<QueryResult> = queries.iter().map(|q| {
        let qvec = embed_query(q);
        let results = rrf_no_prf(conn, &qvec, q, &all_embeddings, &graph, 10);
        let top5: Vec<String> = results.iter().take(5).map(|(p, _)| p.clone()).collect();
        let top10: Vec<String> = results.iter().take(10).map(|(p, _)| p.clone()).collect();
        QueryResult { query: q.clone(), top5, top10 }
    }).collect();

    let baseline = BaselineResult {
        label: "no-prf".to_string(),
        queries: baseline_queries,
    };

    // Each PRF config
    let config_results: Vec<ConfigResult> = configs.iter().map(|params| {
        let query_results: Vec<QueryResult> = queries.iter().map(|q| {
            let qvec = embed_query(q);
            let results = rrf_with_prf(conn, &qvec, q, &all_embeddings, &graph, params, 10);
            let top5: Vec<String> = results.iter().take(5).map(|(p, _)| p.clone()).collect();
            let top10: Vec<String> = results.iter().take(10).map(|(p, _)| p.clone()).collect();
            QueryResult { query: q.clone(), top5, top10 }
        }).collect();

        let n = queries.len() as f64;
        let mut total_change_5 = 0.0;
        let mut total_change_10 = 0.0;
        let mut total_new_5 = 0.0;
        let mut total_new_10 = 0.0;

        for (i, qr) in query_results.iter().enumerate() {
            let bl = &baseline.queries[i];
            let changed_5 = qr.top5.iter().filter(|p| !bl.top5.contains(p)).count();
            let changed_10 = qr.top10.iter().filter(|p| !bl.top10.contains(p)).count();
            total_change_5 += changed_5 as f64;
            total_change_10 += changed_10 as f64;
            total_new_5 += changed_5 as f64;
            total_new_10 += changed_10 as f64;
        }

        ConfigResult {
            alpha: params.alpha,
            beta: params.beta,
            k: params.k,
            label: format!("a={:.1} k={}", params.alpha, params.k),
            queries: query_results,
            avg_change_at_5: total_change_5 / n,
            avg_change_at_10: total_change_10 / n,
            avg_new_in_top5: total_new_5 / n,
            avg_new_in_top10: total_new_10 / n,
        }
    }).collect();

    TuneResult {
        configs: config_results,
        baseline,
    }
}
