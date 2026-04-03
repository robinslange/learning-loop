use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags};
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

pub fn discover_peer_dbs(config_dir: &Path, local_model_id: &str) -> Vec<(String, Connection)> {
    let peers_dir = config_dir.join("federation").join("data").join("peers");
    let entries = match std::fs::read_dir(&peers_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut peers = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let peer_id = entry.file_name().to_string_lossy().to_string();
        let db_path = entry.path().join("index.db");
        if !db_path.exists() {
            continue;
        }

        let conn = match Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let model_id: String = match conn.query_row(
            "SELECT value FROM meta WHERE key = 'model_id'",
            [],
            |r| r.get(0),
        ) {
            Ok(id) => id,
            Err(_) => continue,
        };

        if model_id != local_model_id {
            eprintln!("Skipping peer {peer_id}: model mismatch ({model_id} vs {local_model_id})");
            continue;
        }

        peers.push((peer_id, conn));
    }

    peers
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

// --- Composable search building blocks ---

fn local_rrf_scores(
    conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    all_embeddings: &[(i64, String, Vec<f32>)],
    graph: &HashMap<String, Vec<String>>,
) -> HashMap<String, f64> {
    let mut vec_scored: Vec<(String, f64)> = all_embeddings
        .iter()
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

    rrf_scores
}

fn add_peer_rrf_scores(
    rrf_scores: &mut HashMap<String, f64>,
    peer_id: &str,
    peer_conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    peer_embeddings: &[(i64, String, Vec<f32>)],
) {
    let mut peer_vec: Vec<(String, f64)> = peer_embeddings
        .iter()
        .map(|(_, path, emb)| {
            (format!("peer:{peer_id}/{path}"), cosine(query_vec, emb) as f64)
        })
        .collect();
    peer_vec.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    peer_vec.truncate(30);
    add_ranked_rrf(rrf_scores, peer_vec.iter().map(|(p, _)| p.as_str()));

    let peer_fts = fts_bm25_query(peer_conn, query_text, 30);
    add_ranked_rrf(
        rrf_scores,
        peer_fts.iter().map(|(_, path, _)| format!("peer:{peer_id}/{path}")).collect::<Vec<_>>().iter().map(|s| s.as_str()),
    );
}

fn add_ranked_rrf<'a>(rrf_scores: &mut HashMap<String, f64>, items: impl Iterator<Item = &'a str>) {
    for (rank, path) in items.enumerate() {
        *rrf_scores.entry(path.to_string()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
    }
}

fn finalize_rrf(rrf_scores: HashMap<String, f64>, top_n: usize) -> Vec<(String, f64)> {
    let mut results: Vec<(String, f64)> = rrf_scores.into_iter().collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_n);
    results
}

// --- Public search API ---

pub fn hybrid_query(conn: &Connection, query_text: &str, top_n: usize) -> Vec<SearchResult> {
    let query_vec = embed_query(query_text);
    hybrid_query_inner(conn, &query_vec, query_text, top_n)
}

fn hybrid_query_inner(
    conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    top_n: usize,
) -> Vec<SearchResult> {
    let all_embeddings = load_all_embeddings(conn);
    let graph = load_link_graph(conn);
    let rrf = local_rrf_scores(conn, query_vec, query_text, &all_embeddings, &graph);
    let titles = load_titles_map(conn);

    finalize_rrf(rrf, top_n)
        .into_iter()
        .map(|(path, score)| SearchResult {
            title: titles.get(&path).cloned().flatten(),
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
) -> Vec<SearchResult> {
    let query_vec = embed_query(query_text);
    hybrid_query_federated_inner(conn, &query_vec, query_text, top_n, peers)
}

fn hybrid_query_federated_inner(
    conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    top_n: usize,
    peers: &[(String, Connection)],
) -> Vec<SearchResult> {
    let all_embeddings = load_all_embeddings(conn);
    let graph = load_link_graph(conn);
    let mut rrf = local_rrf_scores(conn, query_vec, query_text, &all_embeddings, &graph);

    for (peer_id, peer_conn) in peers {
        let peer_embeddings = load_all_embeddings(peer_conn);
        add_peer_rrf_scores(&mut rrf, peer_id, peer_conn, query_vec, query_text, &peer_embeddings);
    }

    finalize_rrf(rrf, top_n)
        .into_iter()
        .map(|(path, score)| SearchResult {
            title: load_title_federated(&path, conn, peers),
            path,
            score,
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

pub fn reflect_scan_federated(
    conn: &Connection,
    queries: &[String],
    top_n: usize,
    candidates_n: usize,
    discriminate_threshold: f32,
    peers: &[(String, Connection)],
) -> ReflectScanResult {
    let all_embeddings = load_all_embeddings(conn);
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
                title: merged_titles.get(&r.path).cloned().flatten(),
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
                                .map(|(_, _, emb)| cosine(query_vec, emb) as f64)
                        })
                } else {
                    all_embeddings
                        .iter()
                        .find(|(_, path, _)| *path == best.path)
                        .map(|(_, _, emb)| cosine(query_vec, emb) as f64)
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

    // Phase 4: discriminate on LOCAL result paths only
    let local_result_paths: Vec<String> = all_result_paths
        .iter()
        .filter(|p| !p.starts_with("peer:"))
        .cloned()
        .collect();
    let mut local_deduped = local_result_paths;
    local_deduped.sort();
    local_deduped.dedup();
    let confusable_pairs = discriminate_pairs(conn, &local_deduped, discriminate_threshold);

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

fn load_title(conn: &Connection, path: &str) -> Option<String> {
    conn.query_row(
        "SELECT title FROM notes WHERE path = ?1",
        params![path],
        |r| r.get(0),
    )
    .ok()
    .flatten()
}

fn load_title_federated(
    path: &str,
    conn: &Connection,
    peers: &[(String, Connection)],
) -> Option<String> {
    if let Some(rest) = path.strip_prefix("peer:") {
        let slash = rest.find('/')?;
        let pid = &rest[..slash];
        let actual = &rest[slash + 1..];
        let (_, pc) = peers.iter().find(|(id, _)| id == pid)?;
        load_title(pc, actual)
    } else {
        load_title(conn, path)
    }
}

fn load_link_graph(conn: &Connection) -> HashMap<String, Vec<String>> {
    let mut basename_to_path: HashMap<String, String> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT path FROM notes") {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            for path in rows.flatten() {
                let basename = path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&path)
                    .strip_suffix(".md")
                    .unwrap_or(&path)
                    .to_lowercase();
                basename_to_path.entry(basename).or_insert(path);
            }
        }
    }

    let mut edges: HashMap<String, HashSet<String>> = HashMap::new();
    let mut stmt = match conn.prepare(
        "SELECT n.path, l.target_path FROM links l JOIN notes n ON l.source_id = n.id",
    ) {
        Ok(s) => s,
        Err(_) => return HashMap::new(),
    };

    let rows = match stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) {
        Ok(r) => r,
        Err(_) => return HashMap::new(),
    };

    for row in rows.flatten() {
        let (source_path, target_basename) = row;
        if let Some(target_path) = basename_to_path.get(&target_basename) {
            if source_path != *target_path {
                edges.entry(source_path.clone()).or_default().insert(target_path.clone());
                edges.entry(target_path.clone()).or_default().insert(source_path.clone());
            }
        }
    }

    edges.into_iter().map(|(k, v)| (k, v.into_iter().collect())).collect()
}

fn personalized_pagerank(
    graph: &HashMap<String, Vec<String>>,
    seeds: &[String],
    damping: f32,
    iterations: usize,
) -> Vec<(String, f64)> {
    if seeds.is_empty() || graph.is_empty() {
        return Vec::new();
    }

    let seed_score = 1.0 / seeds.len() as f64;
    let d = damping as f64;
    let mut scores: HashMap<String, f64> = HashMap::new();
    let seed_set: HashSet<&str> = seeds.iter().map(|s| s.as_str()).collect();

    for s in seeds {
        if graph.contains_key(s) {
            scores.insert(s.clone(), seed_score);
        }
    }

    for _ in 0..iterations {
        let mut new_scores: HashMap<String, f64> = HashMap::new();

        for s in seeds {
            if graph.contains_key(s) {
                *new_scores.entry(s.clone()).or_default() += (1.0 - d) * seed_score;
            }
        }

        for (node, score) in &scores {
            if let Some(neighbors) = graph.get(node) {
                let share = d * score / neighbors.len() as f64;
                for neighbor in neighbors {
                    *new_scores.entry(neighbor.clone()).or_default() += share;
                }
            }
        }

        scores = new_scores;
    }

    let mut results: Vec<(String, f64)> = scores
        .into_iter()
        .filter(|(path, score)| *score > 1e-6 && !seed_set.contains(path.as_str()))
        .collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(30);
    results
}

fn tag_expand(conn: &Connection, seed_paths: &[String]) -> Vec<(String, f64)> {
    let tags_map = load_tags_map(conn);
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
    for (path, tags) in &tags_map {
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

fn collect_seeds(
    vec_scored: &[(String, f64)],
    fts_results: &[(i64, String, f64)],
) -> Vec<String> {
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

pub fn batch_load_bodies_federated(
    conn: &Connection,
    peers: &[(String, Connection)],
    paths: &[String],
) -> HashMap<String, String> {
    let mut local_paths = Vec::new();
    let mut peer_groups: HashMap<&str, Vec<String>> = HashMap::new();

    for path in paths {
        if let Some(rest) = path.strip_prefix("peer:") {
            if let Some(slash) = rest.find('/') {
                let pid = &rest[..slash];
                let actual = &rest[slash + 1..];
                peer_groups.entry(pid).or_default().push(actual.to_string());
            }
        } else {
            local_paths.push(path.clone());
        }
    }

    let mut bodies = batch_load_bodies(conn, &local_paths);
    for (peer_id, peer_conn) in peers {
        if let Some(stripped) = peer_groups.get(peer_id.as_str()) {
            for (path, body) in batch_load_bodies(peer_conn, stripped) {
                bodies.insert(format!("peer:{peer_id}/{path}"), body);
            }
        }
    }
    bodies
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn create_test_db(notes: &[(&str, &str, &str, &[f32])]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE notes (
                 id INTEGER PRIMARY KEY,
                 path TEXT UNIQUE NOT NULL,
                 content_hash TEXT NOT NULL,
                 mtime REAL NOT NULL,
                 title TEXT,
                 tags TEXT,
                 visibility TEXT DEFAULT 'private'
             );
             CREATE TABLE notes_content (
                 id INTEGER PRIMARY KEY,
                 title TEXT,
                 tags TEXT,
                 body TEXT
             );
             CREATE VIRTUAL TABLE notes_fts USING fts5(
                 title, tags, body,
                 content='notes_content',
                 content_rowid='id',
                 tokenize='porter unicode61 remove_diacritics 1'
             );
             CREATE TABLE embeddings (
                 id INTEGER PRIMARY KEY,
                 data BLOB NOT NULL
             );
             INSERT INTO meta (key, value) VALUES ('model_id', 'test-model');",
        )
        .unwrap();

        for (i, (path, title, body, emb)) in notes.iter().enumerate() {
            let id = (i + 1) as i64;
            conn.execute(
                "INSERT INTO notes (id, path, content_hash, mtime, title, tags) VALUES (?1, ?2, 'hash', 0.0, ?3, '')",
                params![id, path, title],
            ).unwrap();
            conn.execute(
                "INSERT INTO notes_content (id, title, tags, body) VALUES (?1, ?2, '', ?3)",
                params![id, title, body],
            ).unwrap();
            let blob: Vec<u8> = emb.iter().flat_map(|f| f.to_le_bytes()).collect();
            conn.execute(
                "INSERT INTO embeddings (id, data) VALUES (?1, ?2)",
                params![id, blob],
            ).unwrap();
        }

        conn.execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").unwrap();
        conn
    }

    fn create_peer_db(notes: &[(&str, &str, &str, &[f32])]) -> Connection {
        create_test_db(notes)
    }

    fn create_peer_db_no_embeddings(notes: &[(&str, &str, &str)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE notes (
                 id INTEGER PRIMARY KEY,
                 path TEXT UNIQUE NOT NULL,
                 title TEXT,
                 tags TEXT,
                 tier TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE notes_content (
                 id INTEGER PRIMARY KEY,
                 title TEXT,
                 tags TEXT,
                 body TEXT
             );
             CREATE VIRTUAL TABLE notes_fts USING fts5(
                 title, tags, body,
                 content='notes_content',
                 content_rowid='id',
                 tokenize='porter unicode61 remove_diacritics 1'
             );
             INSERT INTO meta (key, value) VALUES ('model_id', 'test-model');",
        )
        .unwrap();

        for (i, (path, title, body)) in notes.iter().enumerate() {
            let id = (i + 1) as i64;
            conn.execute(
                "INSERT INTO notes (id, path, title, tags, tier, updated_at) VALUES (?1, ?2, ?3, '', 'public', 0)",
                params![id, path, title],
            ).unwrap();
            conn.execute(
                "INSERT INTO notes_content (id, title, tags, body) VALUES (?1, ?2, '', ?3)",
                params![id, title, body],
            ).unwrap();
        }

        conn.execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").unwrap();
        conn
    }

    fn create_peer_db_no_fts(notes: &[(&str, &str, &[f32])]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE notes (
                 id INTEGER PRIMARY KEY,
                 path TEXT UNIQUE NOT NULL,
                 title TEXT,
                 tags TEXT,
                 tier TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE notes_content (
                 id INTEGER PRIMARY KEY,
                 title TEXT,
                 tags TEXT,
                 body TEXT
             );
             CREATE TABLE embeddings (
                 id INTEGER PRIMARY KEY,
                 data BLOB NOT NULL
             );
             INSERT INTO meta (key, value) VALUES ('model_id', 'test-model');",
        )
        .unwrap();

        for (i, (path, title, emb)) in notes.iter().enumerate() {
            let id = (i + 1) as i64;
            conn.execute(
                "INSERT INTO notes (id, path, title, tags, tier, updated_at) VALUES (?1, ?2, ?3, '', 'public', 0)",
                params![id, path, title],
            ).unwrap();
            conn.execute(
                "INSERT INTO notes_content (id, title, tags, body) VALUES (?1, ?2, '', ?3)",
                params![id, title, title],
            ).unwrap();
            let blob: Vec<u8> = emb.iter().flat_map(|f| f.to_le_bytes()).collect();
            conn.execute(
                "INSERT INTO embeddings (id, data) VALUES (?1, ?2)",
                params![id, blob],
            ).unwrap();
        }

        conn
    }

    fn norm(v: &[f32]) -> Vec<f32> {
        let mag = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if mag == 0.0 { return v.to_vec(); }
        v.iter().map(|x| x / mag).collect()
    }

    // --- discover_peer_dbs ---

    #[test]
    fn test_discover_peer_dbs_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let peers = discover_peer_dbs(tmp.path(), "test-model");
        assert!(peers.is_empty());
    }

    #[test]
    fn test_discover_peer_dbs_model_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let peers_dir = tmp.path().join("federation").join("data").join("peers").join("alice");
        std::fs::create_dir_all(&peers_dir).unwrap();
        let db_path = peers_dir.join("index.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta (key, value) VALUES ('model_id', 'wrong-model');",
        ).unwrap();
        drop(conn);

        let peers = discover_peer_dbs(tmp.path(), "test-model");
        assert!(peers.is_empty());
    }

    #[test]
    fn test_discover_peer_dbs_valid() {
        let tmp = tempfile::tempdir().unwrap();
        let peers_dir = tmp.path().join("federation").join("data").join("peers").join("alice");
        std::fs::create_dir_all(&peers_dir).unwrap();
        let db_path = peers_dir.join("index.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta (key, value) VALUES ('model_id', 'test-model');",
        ).unwrap();
        drop(conn);

        let peers = discover_peer_dbs(tmp.path(), "test-model");
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].0, "alice");
    }

    // --- hybrid_query_inner ---

    #[test]
    fn test_hybrid_query_inner_returns_results() {
        let emb_a = norm(&[1.0, 0.0, 0.0]);
        let emb_b = norm(&[0.0, 1.0, 0.0]);
        let conn = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep is important for memory consolidation", &emb_a),
            ("3-permanent/diet.md", "diet and nutrition", "Protein intake affects muscle recovery", &emb_b),
        ]);

        let query_vec = norm(&[1.0, 0.1, 0.0]);
        let results = hybrid_query_inner(&conn, &query_vec, "sleep", 5);

        assert!(!results.is_empty());
        assert_eq!(results[0].path, "3-permanent/sleep.md");
        assert_eq!(results[0].title, Some("sleep architecture".to_string()));
    }

    #[test]
    fn test_hybrid_query_inner_empty_db() {
        let conn = create_test_db(&[]);
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = hybrid_query_inner(&conn, &query_vec, "sleep", 5);
        assert!(results.is_empty());
    }

    // --- hybrid_query_federated_inner ---

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
        let results = hybrid_query_federated_inner(&local, &query_vec, "sleep", 10, &peers);

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
        let peer = create_peer_db(&[
            ("3-permanent/note.md", "peer note", "peer content about sleep", &emb),
        ]);

        let peers = vec![("bob".to_string(), peer)];
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = hybrid_query_federated_inner(&local, &query_vec, "sleep", 10, &peers);

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

        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let local_results = hybrid_query_inner(&conn, &query_vec, "sleep", 5);

        let conn2 = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep is critical", &emb),
        ]);
        let peers: Vec<(String, Connection)> = vec![];
        let fed_results = hybrid_query_federated_inner(&conn2, &query_vec, "sleep", 5, &peers);

        assert_eq!(local_results.len(), fed_results.len());
        for (l, f) in local_results.iter().zip(fed_results.iter()) {
            assert_eq!(l.path, f.path);
        }
    }

    // --- graceful degradation ---

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
        let results = hybrid_query_federated_inner(&local, &query_vec, "sleep", 10, &peers);

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
        let peer = create_peer_db_no_fts(&[
            ("peer.md", "peer note", &emb_peer),
        ]);

        let peers = vec![("delta".to_string(), peer)];
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let results = hybrid_query_federated_inner(&local, &query_vec, "sleep", 10, &peers);

        assert!(!results.is_empty());
        let peer_results: Vec<&SearchResult> = results.iter().filter(|r| r.path.starts_with("peer:delta/")).collect();
        assert!(!peer_results.is_empty());
    }

    // --- batch_load_bodies_federated ---

    #[test]
    fn test_batch_load_bodies_federated_routes_correctly() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let local = create_test_db(&[
            ("local.md", "local", "local body text", &emb),
        ]);
        let peer = create_peer_db(&[
            ("peer-note.md", "peer", "peer body text", &emb),
        ]);

        let peers = vec![("eve".to_string(), peer)];
        let paths = vec![
            "local.md".to_string(),
            "peer:eve/peer-note.md".to_string(),
        ];

        let bodies = batch_load_bodies_federated(&local, &peers, &paths);
        assert_eq!(bodies.get("local.md").unwrap(), "local body text");
        assert_eq!(bodies.get("peer:eve/peer-note.md").unwrap(), "peer body text");
    }

    #[test]
    fn test_batch_load_bodies_federated_missing_peer() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let local = create_test_db(&[
            ("local.md", "local", "local body", &emb),
        ]);

        let peers: Vec<(String, Connection)> = vec![];
        let paths = vec![
            "local.md".to_string(),
            "peer:unknown/note.md".to_string(),
        ];

        let bodies = batch_load_bodies_federated(&local, &peers, &paths);
        assert_eq!(bodies.len(), 1);
        assert!(bodies.contains_key("local.md"));
    }

    // --- ensure_peer_fts (via client.rs, tested indirectly) ---

    #[test]
    fn test_fts_rebuild_on_export_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
                 id INTEGER PRIMARY KEY,
                 path TEXT NOT NULL,
                 title TEXT NOT NULL,
                 tags TEXT,
                 tier TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE notes_content (
                 id INTEGER PRIMARY KEY,
                 title TEXT,
                 tags TEXT,
                 body TEXT
             );
             INSERT INTO notes (id, path, title, tags, tier, updated_at) VALUES (1, 'test.md', 'test title', 'tag1', 'public', 0);
             INSERT INTO notes_content (id, title, tags, body) VALUES (1, 'test title', 'tag1', 'body text about sleep');",
        ).unwrap();

        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
                 title, tags, body,
                 content='notes_content',
                 content_rowid='id',
                 tokenize='porter unicode61 remove_diacritics 1'
             );
             INSERT INTO notes_fts(notes_fts) VALUES('rebuild');",
        ).unwrap();

        let results = fts_bm25_query(&conn, "sleep", 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].1, "test.md");
    }

    // --- fts_bm25_query edge cases ---

    #[test]
    fn test_fts_empty_query() {
        let conn = create_test_db(&[
            ("note.md", "note", "content", &norm(&[1.0, 0.0, 0.0])),
        ]);
        let results = fts_bm25_query(&conn, "", 10);
        assert!(results.is_empty());
    }

    #[test]
    fn test_fts_no_table() {
        let conn = Connection::open_in_memory().unwrap();
        let results = fts_bm25_query(&conn, "test", 10);
        assert!(results.is_empty());
    }

    // --- cosine ---

    #[test]
    fn test_cosine_identical() {
        let v = norm(&[1.0, 0.0, 0.0]);
        let sim = cosine(&v, &v);
        assert!((sim - 1.0).abs() < 1e-5);
    }

    #[test]
    fn test_cosine_orthogonal() {
        let a = norm(&[1.0, 0.0, 0.0]);
        let b = norm(&[0.0, 1.0, 0.0]);
        let sim = cosine(&a, &b);
        assert!(sim.abs() < 1e-5);
    }

    // --- PPR ---

    fn create_graph_db(notes: &[(&str, &str, &str, &[f32])], links: &[(&str, &str)]) -> Connection {
        let conn = create_test_db(notes);
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS links (
                source_id INTEGER NOT NULL,
                target_path TEXT NOT NULL,
                UNIQUE(source_id, target_path)
            );
            CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_path);",
        ).unwrap();

        for (source_path, target_basename) in links {
            let source_id: i64 = conn.query_row(
                "SELECT id FROM notes WHERE path = ?1",
                params![source_path],
                |r| r.get(0),
            ).unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO links (source_id, target_path) VALUES (?1, ?2)",
                params![source_id, target_basename],
            ).unwrap();
        }
        conn
    }

    #[test]
    fn test_ppr_single_seed_chain() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_graph_db(
            &[
                ("a.md", "a", "content a", &emb),
                ("b.md", "b", "content b", &emb),
                ("c.md", "c", "content c", &emb),
                ("d.md", "d", "content d", &emb),
            ],
            &[("a.md", "b"), ("b.md", "c"), ("c.md", "d")],
        );

        let graph = load_link_graph(&conn);
        assert!(!graph.is_empty());

        let results = personalized_pagerank(&graph, &["a.md".to_string()], 0.5, 20);
        assert!(!results.is_empty());
        let paths: Vec<&str> = results.iter().map(|r| r.0.as_str()).collect();
        assert!(paths.contains(&"b.md"));
        if results.len() >= 2 {
            assert!(results[0].1 >= results[1].1);
        }
    }

    #[test]
    fn test_ppr_bridge_node() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        // Two clusters connected by bridge
        // Cluster 1: a-b-bridge, Cluster 2: bridge-c-d
        let conn = create_graph_db(
            &[
                ("a.md", "a", "content", &emb),
                ("b.md", "b", "content", &emb),
                ("bridge.md", "bridge", "content", &emb),
                ("c.md", "c", "content", &emb),
                ("d.md", "d", "content", &emb),
            ],
            &[
                ("a.md", "b"), ("b.md", "bridge"),
                ("bridge.md", "c"), ("c.md", "d"),
            ],
        );

        let graph = load_link_graph(&conn);
        let results = personalized_pagerank(
            &graph,
            &["a.md".to_string(), "d.md".to_string()],
            0.5,
            20,
        );

        let bridge_score = results.iter().find(|(p, _)| p == "bridge.md").map(|(_, s)| *s);
        assert!(bridge_score.is_some(), "bridge node should appear in results");
        // Bridge is reachable from both seeds -- it should appear in results
        // The exact ranking depends on graph topology and damping
    }

    #[test]
    fn test_ppr_empty_graph() {
        let graph: HashMap<String, Vec<String>> = HashMap::new();
        let results = personalized_pagerank(&graph, &["a.md".to_string()], 0.5, 20);
        assert!(results.is_empty());
    }

    // --- tag expansion ---

    #[test]
    fn test_tag_expand_idf_filtering() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_test_db(&[
            ("a.md", "a", "content", &emb),
            ("b.md", "b", "content", &emb),
            ("c.md", "c", "content", &emb),
        ]);
        // Tag "rare" on a and b (freq=2, qualifies)
        conn.execute("UPDATE notes SET tags = 'rare' WHERE path = 'a.md'", []).unwrap();
        conn.execute("UPDATE notes SET tags = 'rare' WHERE path = 'b.md'", []).unwrap();
        conn.execute("UPDATE notes SET tags = 'common' WHERE path = 'c.md'", []).unwrap();

        let results = tag_expand(&conn, &["a.md".to_string()]);
        let paths: Vec<&str> = results.iter().map(|r| r.0.as_str()).collect();
        assert!(paths.contains(&"b.md"));
        assert!(!paths.contains(&"c.md"));
        assert!(!paths.contains(&"a.md"));
    }

    #[test]
    fn test_tag_expand_excludes_high_freq() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let mut notes: Vec<(&str, &str, &str, &[f32])> = Vec::new();
        // Create 25 notes all tagged "popular" (freq > 20, excluded)
        let paths: Vec<String> = (0..25).map(|i| format!("note{i}.md")).collect();
        let titles: Vec<String> = (0..25).map(|i| format!("note{i}")).collect();
        for i in 0..25 {
            notes.push((&paths[i], &titles[i], "content", &emb));
        }
        let conn = create_test_db(&notes);
        for i in 0..25 {
            conn.execute(
                "UPDATE notes SET tags = 'popular' WHERE path = ?1",
                params![paths[i]],
            ).unwrap();
        }

        let results = tag_expand(&conn, &["note0.md".to_string()]);
        assert!(results.is_empty());
    }

    // --- load_link_graph ---

    #[test]
    fn test_load_link_graph_undirected() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_graph_db(
            &[("a.md", "a", "content", &emb), ("b.md", "b", "content", &emb)],
            &[("a.md", "b")],
        );
        let graph = load_link_graph(&conn);
        assert!(graph.get("a.md").unwrap().contains(&"b.md".to_string()));
        assert!(graph.get("b.md").unwrap().contains(&"a.md".to_string()));
    }

    #[test]
    fn test_load_link_graph_no_table() {
        let conn = Connection::open_in_memory().unwrap();
        let graph = load_link_graph(&conn);
        assert!(graph.is_empty());
    }
}
