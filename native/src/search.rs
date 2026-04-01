use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::db::{load_all_embeddings, load_embedding};
use crate::embed::embed_query;

const RRF_K: f64 = 5.0;

#[derive(Serialize)]
pub struct SearchResult {
    pub path: String,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Serialize)]
pub struct SimilarResult {
    pub path: String,
    pub score: f64,
    pub tags: Vec<String>,
}

#[derive(Serialize)]
pub struct DiscriminatePair {
    #[serde(rename = "noteA")]
    pub note_a: String,
    #[serde(rename = "noteB")]
    pub note_b: String,
    pub similarity: f64,
}

#[derive(Serialize)]
pub struct ReflectQueryResult {
    pub query: String,
    pub top_match_similarity: f64,
    pub results: Vec<SearchResult>,
}

#[derive(Serialize)]
pub struct ReflectScanResult {
    pub queries: Vec<ReflectQueryResult>,
    pub confusable_pairs: Vec<DiscriminatePair>,
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn fts_escape(text: &str) -> String {
    text.split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn fts_bm25_query(conn: &Connection, query: &str, limit: usize) -> Vec<(i64, String, f64)> {
    let escaped = fts_escape(query);
    if escaped.is_empty() {
        return Vec::new();
    }

    let mut stmt = match conn.prepare(
        "SELECT nc.id, n.path, bm25(notes_fts, 10.0, 5.0, 1.0) as score
         FROM notes_fts
         JOIN notes_content nc ON nc.id = notes_fts.rowid
         JOIN notes n ON n.id = nc.id
         WHERE notes_fts MATCH ?1
         ORDER BY score
         LIMIT ?2",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![escaped, limit as i64], |row| {
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

pub fn hybrid_query(conn: &Connection, query_text: &str, top_n: usize) -> Vec<SearchResult> {
    let query_vec = embed_query(query_text);
    let all_embeddings = load_all_embeddings(conn);

    let mut vec_scored: Vec<(String, f64)> = all_embeddings
        .iter()
        .map(|(_, path, emb)| (path.clone(), cosine(&query_vec, emb) as f64))
        .collect();
    vec_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    vec_scored.truncate(30);

    let fts_results = fts_bm25_query(conn, query_text, 30);

    let mut rrf_scores: HashMap<String, f64> = HashMap::new();

    for (rank, (path, _)) in vec_scored.iter().enumerate() {
        *rrf_scores.entry(path.clone()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
    }

    for (rank, (_, path, _)) in fts_results.iter().enumerate() {
        *rrf_scores.entry(path.clone()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
    }

    let mut results: Vec<(String, f64)> = rrf_scores.into_iter().collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_n);

    let titles: HashMap<String, Option<String>> = {
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
    };

    results
        .into_iter()
        .map(|(path, score)| SearchResult {
            title: titles.get(&path).cloned().flatten(),
            path,
            score,
        })
        .collect()
}

pub fn keyword_search(conn: &Connection, keywords: &str, top_n: usize) -> Vec<SearchResult> {
    let fts_results = fts_bm25_query(conn, keywords, top_n);

    let titles: HashMap<String, Option<String>> = {
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
    };

    fts_results
        .into_iter()
        .map(|(_, path, score)| SearchResult {
            title: titles.get(&path).cloned().flatten(),
            path,
            score: -score,
        })
        .collect()
}

pub fn similar_notes(conn: &Connection, note_path: &str, top_n: usize) -> Vec<SimilarResult> {
    let note_id = find_note_id(conn, note_path);
    let note_id = match note_id {
        Some(id) => id,
        None => return Vec::new(),
    };

    let note_emb = match load_embedding(conn, note_id) {
        Some(e) => e,
        None => return Vec::new(),
    };

    let all = load_all_embeddings(conn);

    let mut scored: Vec<(i64, String, f32)> = all
        .iter()
        .filter(|(id, _, _)| *id != note_id)
        .map(|(id, path, emb)| (*id, path.clone(), cosine(&note_emb, emb)))
        .collect();

    scored.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_n);

    let tags_map = load_tags_map(conn);

    scored
        .into_iter()
        .map(|(_, path, sim)| {
            let score = (1.0 - (sim * sim) as f64 / 2.0) * 10000.0;
            let score = score.round() / 10000.0;
            let tags = tags_map
                .get(&path)
                .cloned()
                .unwrap_or_default();
            SimilarResult { path, score, tags }
        })
        .collect()
}

pub fn cluster_notes(conn: &Connection, threshold: f32) -> Vec<Vec<String>> {
    let all = load_all_embeddings(conn);
    let n = all.len();
    let mut assigned = vec![false; n];
    let mut clusters: Vec<Vec<String>> = Vec::new();

    for i in 0..n {
        if assigned[i] {
            continue;
        }
        assigned[i] = true;
        let mut cluster = vec![all[i].1.clone()];

        for j in (i + 1)..n {
            if assigned[j] {
                continue;
            }
            if cosine(&all[i].2, &all[j].2) >= threshold {
                assigned[j] = true;
                cluster.push(all[j].1.clone());
            }
        }

        if cluster.len() > 1 {
            clusters.push(cluster);
        }
    }

    clusters.sort_by(|a, b| b.len().cmp(&a.len()));
    clusters
}

pub fn discriminate_pairs(
    conn: &Connection,
    paths: &[String],
    threshold: f32,
) -> Vec<DiscriminatePair> {
    let embeddings: Vec<(String, Vec<f32>)> = if paths.is_empty() {
        load_all_embeddings(conn)
            .into_iter()
            .map(|(_, path, emb)| (path, emb))
            .collect()
    } else {
        paths
            .iter()
            .filter_map(|p| {
                let id = resolve_note_id_like(conn, p)?;
                let emb = load_embedding(conn, id)?;
                let path: String = conn
                    .query_row("SELECT path FROM notes WHERE id = ?1", params![id], |row| {
                        row.get(0)
                    })
                    .ok()?;
                Some((path, emb))
            })
            .collect()
    };

    let mut pairs: Vec<DiscriminatePair> = Vec::new();
    let n = embeddings.len();

    for i in 0..n {
        for j in (i + 1)..n {
            let sim = cosine(&embeddings[i].1, &embeddings[j].1);
            if sim >= threshold {
                pairs.push(DiscriminatePair {
                    note_a: embeddings[i].0.clone(),
                    note_b: embeddings[j].0.clone(),
                    similarity: sim as f64,
                });
            }
        }
    }

    pairs.sort_by(|a, b| b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal));
    pairs
}

pub fn reflect_scan(
    conn: &Connection,
    queries: &[String],
    top_n: usize,
    candidates_n: usize,
    discriminate_threshold: f32,
) -> ReflectScanResult {
    let all_embeddings = load_all_embeddings(conn);
    let titles = load_titles_map(conn);

    let mut all_candidate_paths: Vec<String> = Vec::new();
    let mut per_query: Vec<(String, Vec<f32>, Vec<SearchResult>)> = Vec::new();

    // Phase 1: hybrid search per query, collect candidates
    for query_text in queries {
        let query_vec = embed_query(query_text);

        let mut vec_scored: Vec<(String, f64)> = all_embeddings
            .iter()
            .map(|(_, path, emb)| (path.clone(), cosine(&query_vec, emb) as f64))
            .collect();
        vec_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        vec_scored.truncate(30);

        let fts_results = fts_bm25_query(conn, query_text, 30);

        let mut rrf_scores: HashMap<String, f64> = HashMap::new();
        for (rank, (path, _)) in vec_scored.iter().enumerate() {
            *rrf_scores.entry(path.clone()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
        }
        for (rank, (_, path, _)) in fts_results.iter().enumerate() {
            *rrf_scores.entry(path.clone()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
        }

        let mut candidates: Vec<(String, f64)> = rrf_scores.into_iter().collect();
        candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        candidates.truncate(candidates_n);

        let candidate_results: Vec<SearchResult> = candidates
            .into_iter()
            .map(|(path, score)| SearchResult {
                title: titles.get(&path).cloned().flatten(),
                path,
                score,
            })
            .collect();

        for r in &candidate_results {
            all_candidate_paths.push(r.path.clone());
        }

        per_query.push((query_text.clone(), query_vec, candidate_results));
    }

    // Phase 2: batch-fetch bodies for all candidates
    all_candidate_paths.sort();
    all_candidate_paths.dedup();
    let bodies = batch_load_bodies(conn, &all_candidate_paths);

    // Phase 3: rerank each query's candidates
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
            })
            .collect();

        let top_sim = results.first().and_then(|best| {
            all_embeddings
                .iter()
                .find(|(_, path, _)| *path == best.path)
                .map(|(_, _, emb)| cosine(query_vec, emb) as f64)
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

    // Phase 4: discriminate on scoped result set
    all_result_paths.sort();
    all_result_paths.dedup();
    let confusable_pairs = discriminate_pairs(conn, &all_result_paths, discriminate_threshold);

    ReflectScanResult {
        queries: query_results,
        confusable_pairs,
    }
}

fn find_note_id(conn: &Connection, path: &str) -> Option<i64> {
    conn.query_row(
        "SELECT id FROM notes WHERE path = ?1",
        params![path],
        |row| row.get(0),
    )
    .ok()
    .or_else(|| resolve_note_id_like(conn, path))
}

fn resolve_note_id_like(conn: &Connection, path: &str) -> Option<i64> {
    let pattern = format!("%{}", path);
    conn.query_row(
        "SELECT id FROM notes WHERE path LIKE ?1 LIMIT 1",
        params![pattern],
        |row| row.get(0),
    )
    .ok()
}

fn load_titles_map(conn: &Connection) -> HashMap<String, Option<String>> {
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

fn batch_load_bodies(conn: &Connection, paths: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for path in paths {
        if let Ok(body) = conn.query_row(
            "SELECT nc.body FROM notes_content nc JOIN notes n ON nc.id = n.id WHERE n.path = ?1",
            params![path],
            |row| row.get::<_, String>(0),
        ) {
            map.insert(path.clone(), body);
        }
    }
    map
}

fn load_tags_map(conn: &Connection) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT path, tags FROM notes") {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        }) {
            for row in rows.flatten() {
                let tags = row
                    .1
                    .unwrap_or_default()
                    .split_whitespace()
                    .map(String::from)
                    .collect();
                map.insert(row.0, tags);
            }
        }
    }
    map
}
