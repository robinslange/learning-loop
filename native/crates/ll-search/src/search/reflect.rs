use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;

use crate::db::load_all_embeddings;
use crate::embed::embed_query;

use super::scoring::{dot_product, finalize_rrf};
use super::query::{local_rrf_scores, load_titles_map, SearchResult};
use super::graph::load_link_graph;
use super::federation::{add_peer_rrf_scores, batch_load_bodies, batch_load_bodies_federated};
use super::cluster::discriminate_pairs;
use super::store::EmbeddingStore;

#[derive(Serialize)]
pub struct ReflectQueryResult {
    pub query: String,
    pub top_match_similarity: f64,
    pub results: Vec<SearchResult>,
}

#[derive(Serialize)]
pub struct ReflectScanResult {
    pub queries: Vec<ReflectQueryResult>,
    pub confusable_pairs: Vec<super::cluster::DiscriminatePair>,
}

pub fn reflect_scan(
    conn: &Connection,
    queries: &[String],
    top_n: usize,
    candidates_n: usize,
    discriminate_threshold: f32,
    store: &EmbeddingStore,
) -> ReflectScanResult {
    let all_embeddings = store.all();
    let titles = load_titles_map(conn);
    let graph = load_link_graph(conn);

    let mut all_candidate_paths: Vec<String> = Vec::new();
    let mut per_query: Vec<(String, Vec<f32>, Vec<SearchResult>)> = Vec::new();

    for query_text in queries {
        let query_vec = embed_query(query_text);
        let rrf = local_rrf_scores(conn, &query_vec, query_text, &all_embeddings, &graph);

        let candidate_results: Vec<SearchResult> = finalize_rrf(rrf, candidates_n)
            .into_iter()
            .map(|(path, score)| SearchResult {
                title: titles.get(&path).cloned().flatten(),
                mtime: None,
                path,
                score,
            })
            .collect();

        for r in &candidate_results {
            all_candidate_paths.push(r.path.clone());
        }

        per_query.push((query_text.clone(), query_vec, candidate_results));
    }

    all_candidate_paths.sort();
    all_candidate_paths.dedup();
    let bodies = batch_load_bodies(conn, &all_candidate_paths);

    let mut all_result_paths: Vec<String> = Vec::new();
    let mut query_results: Vec<ReflectQueryResult> = Vec::new();

    for (query_text, query_vec, candidate_results) in &per_query {
        let docs: Vec<(String, String)> = candidate_results
            .iter()
            .filter_map(|r| {
                let body = bodies.get(&r.path)?;
                Some((r.path.clone(), body.clone()))
            })
            .collect();

        let reranked = crate::rerank::rerank(query_text, &docs, top_n);

        let results: Vec<SearchResult> = reranked
            .iter()
            .map(|r| SearchResult {
                path: r.path.clone(),
                score: r.score,
                title: titles.get(&r.path).cloned().flatten(),
                mtime: None,
            })
            .collect();

        let top_sim = results.first().and_then(|best| {
            all_embeddings
                .iter()
                .find(|(_, path, _)| *path == best.path)
                .map(|(_, _, emb)| dot_product(query_vec, emb) as f64)
        }).unwrap_or(0.0);

        for r in &results {
            all_result_paths.push(r.path.clone());
        }

        query_results.push(ReflectQueryResult {
            query: query_text.clone(),
            top_match_similarity: top_sim,
            results,
        });
    }

    all_result_paths.sort();
    all_result_paths.dedup();
    let confusable_pairs = discriminate_pairs(conn, &all_result_paths, discriminate_threshold, store);

    ReflectScanResult {
        queries: query_results,
        confusable_pairs,
    }
}

pub fn reflect_scan_federated(
    conn: &Connection,
    queries: &[String],
    top_n: usize,
    candidates_n: usize,
    discriminate_threshold: f32,
    peers: &[(String, Connection)],
    store: &EmbeddingStore,
) -> ReflectScanResult {
    let all_embeddings = store.all();
    let titles = load_titles_map(conn);

    let peer_data: Vec<(&str, Vec<(i64, String, Vec<f32>)>, HashMap<String, Option<String>>)> =
        peers
            .iter()
            .map(|(id, pc)| {
                (
                    id.as_str(),
                    load_all_embeddings(pc),
                    load_titles_map(pc),
                )
            })
            .collect();

    let mut merged_titles = titles.clone();
    for (pid, _, pt) in &peer_data {
        for (path, title) in pt {
            merged_titles.insert(format!("peer:{pid}/{path}"), title.clone());
        }
    }

    let graph = load_link_graph(conn);

    let mut all_candidate_paths: Vec<String> = Vec::new();
    let mut per_query: Vec<(String, Vec<f32>, Vec<SearchResult>)> = Vec::new();

    for query_text in queries {
        let query_vec = embed_query(query_text);
        let mut rrf = local_rrf_scores(conn, &query_vec, query_text, &all_embeddings, &graph);

        for (peer_id, peer_conn) in peers {
            let peer_embs = peer_data
                .iter()
                .find(|(id, _, _)| *id == peer_id.as_str())
                .map(|(_, e, _)| e);

            if let Some(embs) = peer_embs {
                add_peer_rrf_scores(&mut rrf, peer_id, peer_conn, &query_vec, query_text, embs);
            } else {
                add_peer_rrf_scores(&mut rrf, peer_id, peer_conn, &query_vec, query_text, &[]);
            }
        }

        let candidate_results: Vec<SearchResult> = finalize_rrf(rrf, candidates_n)
            .into_iter()
            .map(|(path, score)| SearchResult {
                title: merged_titles.get(&path).cloned().flatten(),
                mtime: None,
                path,
                score,
            })
            .collect();

        for r in &candidate_results {
            all_candidate_paths.push(r.path.clone());
        }

        per_query.push((query_text.clone(), query_vec, candidate_results));
    }

    all_candidate_paths.sort();
    all_candidate_paths.dedup();
    let bodies = batch_load_bodies_federated(conn, peers, &all_candidate_paths);

    let mut all_result_paths: Vec<String> = Vec::new();
    let mut query_results: Vec<ReflectQueryResult> = Vec::new();

    for (query_text, query_vec, candidate_results) in &per_query {
        let docs: Vec<(String, String)> = candidate_results
            .iter()
            .filter_map(|r| {
                let body = bodies.get(&r.path)?;
                Some((r.path.clone(), body.clone()))
            })
            .collect();

        let reranked = crate::rerank::rerank(query_text, &docs, top_n);

        let results: Vec<SearchResult> = reranked
            .iter()
            .map(|r| SearchResult {
                path: r.path.clone(),
                score: r.score,
                title: merged_titles.get(&r.path).cloned().flatten(),
                mtime: None,
            })
            .collect();

        let top_sim = results
            .first()
            .and_then(|best| {
                if let Some(rest) = best.path.strip_prefix("peer:") {
                    let slash = rest.find('/')?;
                    let pid = &rest[..slash];
                    let actual = &rest[slash + 1..];
                    peer_data
                        .iter()
                        .find(|(id, _, _)| *id == pid)
                        .and_then(|(_, embs, _)| {
                            embs.iter()
                                .find(|(_, p, _)| p == actual)
                                .map(|(_, _, emb)| dot_product(query_vec, emb) as f64)
                        })
                } else {
                    all_embeddings
                        .iter()
                        .find(|(_, path, _)| *path == best.path)
                        .map(|(_, _, emb)| dot_product(query_vec, emb) as f64)
                }
            })
            .unwrap_or(0.0);

        for r in &results {
            all_result_paths.push(r.path.clone());
        }

        query_results.push(ReflectQueryResult {
            query: query_text.clone(),
            top_match_similarity: top_sim,
            results,
        });
    }

    let local_result_paths: Vec<String> = all_result_paths
        .iter()
        .filter(|p| !p.starts_with("peer:"))
        .cloned()
        .collect();
    let mut local_deduped = local_result_paths;
    local_deduped.sort();
    local_deduped.dedup();
    let confusable_pairs = discriminate_pairs(conn, &local_deduped, discriminate_threshold, store);

    ReflectScanResult {
        queries: query_results,
        confusable_pairs,
    }
}
