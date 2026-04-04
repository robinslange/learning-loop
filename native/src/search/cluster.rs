use rusqlite::{params, Connection};
use serde::Serialize;

use crate::db::{load_all_embeddings, load_embedding};

use super::scoring::cosine;
use super::graph::load_tags_map;
use super::query::{find_note_id, resolve_note_id_like};

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
