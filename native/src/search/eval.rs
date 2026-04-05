use std::collections::{HashMap, HashSet};

use rayon::prelude::*;
use rusqlite::Connection;
use serde::Serialize;

use crate::embed::embed_query;

use super::scoring::{add_ranked_rrf, cosine, fts_bm25_query, collect_seeds, finalize_rrf, rocchio_prf_with, PrfParams};
use super::graph::{load_link_graph, personalized_pagerank, tag_expand};
use super::store::EmbeddingStore;

#[derive(Debug, Serialize)]
pub struct EvalResult {
    pub num_queries: usize,
    pub min_links: usize,
    pub configs: Vec<EvalConfig>,
}

#[derive(Debug, Serialize)]
pub struct EvalConfig {
    pub label: String,
    pub recall_at_5: f64,
    pub recall_at_10: f64,
    pub mrr: f64,
    pub hits_at_1: f64,
}

struct EvalQuery {
    title: String,
    path: String,
    relevant: HashSet<String>,
}

fn resolve_target(conn: &Connection, basename: &str) -> Option<String> {
    let pattern = format!("%/{}.md", basename);
    conn.query_row(
        "SELECT path FROM notes WHERE path LIKE ?1 LIMIT 1",
        rusqlite::params![pattern],
        |row| row.get::<_, String>(0),
    ).ok().or_else(|| {
        let pattern2 = format!("{}.md", basename);
        conn.query_row(
            "SELECT path FROM notes WHERE path LIKE ?1 LIMIT 1",
            rusqlite::params![pattern2],
            |row| row.get::<_, String>(0),
        ).ok()
    })
}

fn build_eval_set(conn: &Connection, min_links: usize) -> Vec<EvalQuery> {
    let mut stmt = conn.prepare(
        "SELECT l.source_id, n.path, n.title, l.target_path
         FROM links l
         JOIN notes n ON n.id = l.source_id
         ORDER BY l.source_id"
    ).expect("failed to prepare eval query");

    let rows: Vec<(i64, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .expect("query failed")
        .filter_map(|r| r.ok())
        .collect();

    let mut grouped: HashMap<i64, (String, String, Vec<String>)> = HashMap::new();
    for (id, path, title, target) in rows {
        grouped.entry(id)
            .or_insert_with(|| (path, title, Vec::new()))
            .2.push(target);
    }

    let mut queries: Vec<EvalQuery> = Vec::new();
    for (_id, (path, title, targets)) in grouped {
        let mut relevant = HashSet::new();
        for t in &targets {
            if let Some(resolved) = resolve_target(conn, t) {
                if resolved != path {
                    relevant.insert(resolved);
                }
            }
        }
        if relevant.len() >= min_links {
            queries.push(EvalQuery { title, path, relevant });
        }
    }

    queries.sort_by(|a, b| a.path.cmp(&b.path));
    queries
}

fn rrf_baseline(
    conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    all_embeddings: &[(i64, String, Vec<f32>)],
    graph: &HashMap<String, Vec<String>>,
) -> Vec<String> {
    let mut vec_scored: Vec<(String, f64)> = all_embeddings
        .par_iter()
        .map(|(_, path, emb)| (path.clone(), cosine(query_vec, emb) as f64))
        .collect();
    vec_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    vec_scored.truncate(30);

    let fts_results = fts_bm25_query(conn, query_text, 30);

    let mut rrf: HashMap<String, f64> = HashMap::new();
    add_ranked_rrf(&mut rrf, vec_scored.iter().map(|(p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf, fts_results.iter().map(|(_, p, _)| p.as_str()));

    let seeds = collect_seeds(&vec_scored, &fts_results);
    let ppr_results = personalized_pagerank(graph, &seeds, 0.5, 20);
    let tag_results = tag_expand(conn, &seeds);
    add_ranked_rrf(&mut rrf, ppr_results.iter().map(|(p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf, tag_results.iter().map(|(p, _)| p.as_str()));

    finalize_rrf(rrf, 10).into_iter().map(|(p, _)| p).collect()
}

fn rrf_hybrid_prf(
    conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    all_embeddings: &[(i64, String, Vec<f32>)],
    graph: &HashMap<String, Vec<String>>,
    params: &PrfParams,
) -> Vec<String> {
    let mut vec_scored: Vec<(String, f64)> = all_embeddings
        .par_iter()
        .map(|(_, path, emb)| (path.clone(), cosine(query_vec, emb) as f64))
        .collect();
    vec_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    vec_scored.truncate(30);

    let fts_results = fts_bm25_query(conn, query_text, 30);

    let mut rrf: HashMap<String, f64> = HashMap::new();
    add_ranked_rrf(&mut rrf, vec_scored.iter().map(|(p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf, fts_results.iter().map(|(_, p, _)| p.as_str()));

    let seeds = collect_seeds(&vec_scored, &fts_results);
    let ppr_results = personalized_pagerank(graph, &seeds, 0.5, 20);
    let tag_results = tag_expand(conn, &seeds);
    add_ranked_rrf(&mut rrf, ppr_results.iter().map(|(p, _)| p.as_str()));
    add_ranked_rrf(&mut rrf, tag_results.iter().map(|(p, _)| p.as_str()));

    // Hybrid-feedback PRF
    let mut initial: Vec<(String, f64)> = rrf.iter().map(|(p, s)| (p.clone(), *s)).collect();
    initial.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    initial.truncate(30);
    let prf_results = rocchio_prf_with(query_vec, &initial, all_embeddings, params);
    add_ranked_rrf(&mut rrf, prf_results.iter().map(|(p, _)| p.as_str()));

    finalize_rrf(rrf, 10).into_iter().map(|(p, _)| p).collect()
}

fn score_ranking(results: &[String], relevant: &HashSet<String>, source_path: &str) -> (f64, f64, f64, f64) {
    let filtered: Vec<&String> = results.iter().filter(|p| *p != source_path).collect();

    let recall_5 = filtered.iter().take(5).filter(|p| relevant.contains(p.as_str())).count() as f64
        / relevant.len().max(1) as f64;
    let recall_10 = filtered.iter().take(10).filter(|p| relevant.contains(p.as_str())).count() as f64
        / relevant.len().max(1) as f64;

    let mrr = filtered.iter().enumerate()
        .find(|(_, p)| relevant.contains(p.as_str()))
        .map(|(i, _)| 1.0 / (i as f64 + 1.0))
        .unwrap_or(0.0);

    let hit_1 = if filtered.first().map(|p| relevant.contains(p.as_str())).unwrap_or(false) { 1.0 } else { 0.0 };

    (recall_5, recall_10, mrr, hit_1)
}

pub fn eval_prf(conn: &Connection, store: &EmbeddingStore, min_links: usize) -> EvalResult {
    let queries = build_eval_set(conn, min_links);
    let all_embeddings = store.all();
    let graph = load_link_graph(conn);

    eprintln!("Eval set: {} queries with {}+ resolved links", queries.len(), min_links);

    let param_grid = vec![
        ("no-prf", None),
        ("a=0.5 k=1", Some(PrfParams { alpha: 0.5, beta: 0.5, k: 1 })),
        ("a=0.5 k=3", Some(PrfParams { alpha: 0.5, beta: 0.5, k: 3 })),
        ("a=0.7 k=1", Some(PrfParams { alpha: 0.7, beta: 0.3, k: 1 })),
        ("a=0.7 k=3", Some(PrfParams { alpha: 0.7, beta: 0.3, k: 3 })),
        ("a=0.8 k=1", Some(PrfParams { alpha: 0.8, beta: 0.2, k: 1 })),
        ("a=0.8 k=3", Some(PrfParams { alpha: 0.8, beta: 0.2, k: 3 })),
        ("a=0.9 k=1", Some(PrfParams { alpha: 0.9, beta: 0.1, k: 1 })),
        ("a=0.9 k=3", Some(PrfParams { alpha: 0.9, beta: 0.1, k: 3 })),
        ("a=0.9 k=5", Some(PrfParams { alpha: 0.9, beta: 0.1, k: 5 })),
    ];

    let mut configs = Vec::new();

    for (label, params) in &param_grid {
        let mut total_r5 = 0.0;
        let mut total_r10 = 0.0;
        let mut total_mrr = 0.0;
        let mut total_h1 = 0.0;
        let n = queries.len() as f64;

        for q in &queries {
            let qvec = embed_query(&q.title);
            let results = match params {
                None => rrf_baseline(conn, &qvec, &q.title, &all_embeddings, &graph),
                Some(p) => rrf_hybrid_prf(conn, &qvec, &q.title, &all_embeddings, &graph, p),
            };
            let (r5, r10, mrr, h1) = score_ranking(&results, &q.relevant, &q.path);
            total_r5 += r5;
            total_r10 += r10;
            total_mrr += mrr;
            total_h1 += h1;
        }

        configs.push(EvalConfig {
            label: label.to_string(),
            recall_at_5: total_r5 / n,
            recall_at_10: total_r10 / n,
            mrr: total_mrr / n,
            hits_at_1: total_h1 / n,
        });

        eprintln!("  {} done", label);
    }

    EvalResult {
        num_queries: queries.len(),
        min_links,
        configs,
    }
}
