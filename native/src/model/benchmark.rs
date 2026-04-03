use std::path::Path;
use std::time::Instant;

use anyhow::{Context, Result};
use serde::Serialize;

use super::loader;
use super::{EmbeddingProvider, KnownModel};

#[derive(Debug, Serialize)]
pub struct BenchmarkResult {
    pub model_a: String,
    pub model_b: String,
    pub queries: Vec<QueryComparison>,
    pub summary: BenchmarkSummary,
}

#[derive(Debug, Serialize)]
pub struct QueryComparison {
    pub query: String,
    pub model_a_top5: Vec<String>,
    pub model_b_top5: Vec<String>,
    pub overlap_at_5: usize,
    pub overlap_at_10: usize,
    pub rank_correlation: f64,
}

#[derive(Debug, Serialize)]
pub struct BenchmarkSummary {
    pub avg_overlap_at_5: f64,
    pub avg_overlap_at_10: f64,
    pub avg_rank_correlation: f64,
    pub model_a_index_time_ms: u64,
    pub model_b_index_time_ms: u64,
    pub model_a_query_time_ms: u64,
    pub model_b_query_time_ms: u64,
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn rank_by_cosine(
    query: &[f32],
    embeddings: &[Vec<f32>],
    paths: &[String],
) -> Vec<(String, f64)> {
    let mut scored: Vec<(String, f64)> = paths
        .iter()
        .zip(embeddings.iter())
        .map(|(path, emb)| (path.clone(), cosine(query, emb) as f64))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored
}

fn set_overlap(a: &[String], b: &[String]) -> usize {
    a.iter().filter(|item| b.contains(item)).count()
}

fn spearman_rho(a: &[(String, f64)], b: &[(String, f64)], top_n: usize) -> f64 {
    let a_top: Vec<&str> = a.iter().take(top_n).map(|(p, _)| p.as_str()).collect();
    let b_top: Vec<&str> = b.iter().take(top_n).map(|(p, _)| p.as_str()).collect();

    let common: Vec<&str> = a_top
        .iter()
        .filter(|p| b_top.contains(p))
        .copied()
        .collect();

    if common.len() < 2 {
        return 0.0;
    }

    let n = common.len() as f64;
    let d_squared_sum: f64 = common
        .iter()
        .map(|p| {
            let rank_a = a_top.iter().position(|x| x == p).unwrap() as f64;
            let rank_b = b_top.iter().position(|x| x == p).unwrap() as f64;
            let d = rank_a - rank_b;
            d * d
        })
        .sum();

    1.0 - (6.0 * d_squared_sum) / (n * (n * n - 1.0))
}

fn embed_all_batched(
    provider: &dyn EmbeddingProvider,
    texts: &[String],
    batch_size: usize,
) -> Result<Vec<Vec<f32>>> {
    let mut all = Vec::with_capacity(texts.len());
    for chunk in texts.chunks(batch_size) {
        let batch = provider.embed_documents(&chunk.to_vec())?;
        all.extend(batch);
    }
    Ok(all)
}

pub fn run_benchmark(
    db_path: &Path,
    model_a: &KnownModel,
    model_b: &KnownModel,
    queries: &[String],
) -> Result<BenchmarkResult> {
    let provider_a = loader::load_provider(model_a).context("loading model A")?;
    let provider_b = loader::load_provider(model_b).context("loading model B")?;

    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .context("opening database read-only")?;

    let mut stmt = conn.prepare(
        "SELECT n.path, nc.body FROM notes n JOIN notes_content nc ON n.id = nc.id WHERE nc.body IS NOT NULL AND nc.body != ''",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    let paths: Vec<String> = rows.iter().map(|(p, _)| p.clone()).collect();
    let bodies: Vec<String> = rows.iter().map(|(_, b)| b.clone()).collect();

    eprintln!("Loaded {} notes from database", paths.len());

    eprintln!("Embedding with model A ({})...", provider_a.model_id());
    let t0 = Instant::now();
    let embeddings_a = embed_all_batched(provider_a.as_ref(), &bodies, 32)?;
    let model_a_index_time = t0.elapsed().as_millis() as u64;

    eprintln!("Embedding with model B ({})...", provider_b.model_id());
    let t0 = Instant::now();
    let embeddings_b = embed_all_batched(provider_b.as_ref(), &bodies, 32)?;
    let model_b_index_time = t0.elapsed().as_millis() as u64;

    let mut query_comparisons = Vec::new();
    let mut total_query_time_a: u64 = 0;
    let mut total_query_time_b: u64 = 0;

    for query_text in queries {
        let t0 = Instant::now();
        let q_emb_a = provider_a.embed_query(query_text)?;
        let ranked_a = rank_by_cosine(&q_emb_a, &embeddings_a, &paths);
        total_query_time_a += t0.elapsed().as_millis() as u64;

        let t0 = Instant::now();
        let q_emb_b = provider_b.embed_query(query_text)?;
        let ranked_b = rank_by_cosine(&q_emb_b, &embeddings_b, &paths);
        total_query_time_b += t0.elapsed().as_millis() as u64;

        let top5_a: Vec<String> = ranked_a.iter().take(5).map(|(p, _)| p.clone()).collect();
        let top5_b: Vec<String> = ranked_b.iter().take(5).map(|(p, _)| p.clone()).collect();
        let top10_a: Vec<String> = ranked_a.iter().take(10).map(|(p, _)| p.clone()).collect();
        let top10_b: Vec<String> = ranked_b.iter().take(10).map(|(p, _)| p.clone()).collect();

        let overlap_5 = set_overlap(&top5_a, &top5_b);
        let overlap_10 = set_overlap(&top10_a, &top10_b);
        let rho = spearman_rho(&ranked_a, &ranked_b, 20);

        query_comparisons.push(QueryComparison {
            query: query_text.clone(),
            model_a_top5: top5_a,
            model_b_top5: top5_b,
            overlap_at_5: overlap_5,
            overlap_at_10: overlap_10,
            rank_correlation: rho,
        });
    }

    let n = queries.len().max(1) as f64;
    let avg_overlap_5 = query_comparisons.iter().map(|q| q.overlap_at_5 as f64).sum::<f64>() / n;
    let avg_overlap_10 = query_comparisons.iter().map(|q| q.overlap_at_10 as f64).sum::<f64>() / n;
    let avg_rho = query_comparisons.iter().map(|q| q.rank_correlation).sum::<f64>() / n;
    let avg_query_time_a = total_query_time_a / queries.len().max(1) as u64;
    let avg_query_time_b = total_query_time_b / queries.len().max(1) as u64;

    Ok(BenchmarkResult {
        model_a: provider_a.model_id().to_string(),
        model_b: provider_b.model_id().to_string(),
        queries: query_comparisons,
        summary: BenchmarkSummary {
            avg_overlap_at_5: avg_overlap_5,
            avg_overlap_at_10: avg_overlap_10,
            avg_rank_correlation: avg_rho,
            model_a_index_time_ms: model_a_index_time,
            model_b_index_time_ms: model_b_index_time,
            model_a_query_time_ms: avg_query_time_a,
            model_b_query_time_ms: avg_query_time_b,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_identical() {
        let v = vec![0.6, 0.8];
        assert!((cosine(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_orthogonal() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        assert!((cosine(&a, &b)).abs() < 1e-6);
    }

    #[test]
    fn test_set_overlap() {
        let a = vec!["a".into(), "b".into(), "c".into()];
        let b = vec!["b".into(), "c".into(), "d".into()];
        assert_eq!(set_overlap(&a, &b), 2);
    }

    #[test]
    fn test_set_overlap_none() {
        let a: Vec<String> = vec!["a".into()];
        let b: Vec<String> = vec!["b".into()];
        assert_eq!(set_overlap(&a, &b), 0);
    }

    #[test]
    fn test_rank_by_cosine_ordering() {
        let query = vec![1.0, 0.0];
        let embeddings = vec![vec![0.0, 1.0], vec![1.0, 0.0], vec![0.7, 0.7]];
        let paths = vec!["a".into(), "b".into(), "c".into()];
        let ranked = rank_by_cosine(&query, &embeddings, &paths);
        assert_eq!(ranked[0].0, "b");
        assert_eq!(ranked[1].0, "c");
        assert_eq!(ranked[2].0, "a");
    }

    #[test]
    fn test_spearman_identical_ranking() {
        let a: Vec<(String, f64)> = vec![
            ("x".into(), 0.9),
            ("y".into(), 0.8),
            ("z".into(), 0.7),
        ];
        let b = a.clone();
        let rho = spearman_rho(&a, &b, 3);
        assert!((rho - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_spearman_reversed_ranking() {
        let a: Vec<(String, f64)> = vec![
            ("x".into(), 0.9),
            ("y".into(), 0.8),
            ("z".into(), 0.7),
        ];
        let b: Vec<(String, f64)> = vec![
            ("z".into(), 0.9),
            ("y".into(), 0.8),
            ("x".into(), 0.7),
        ];
        let rho = spearman_rho(&a, &b, 3);
        assert!((rho - (-1.0)).abs() < 1e-6);
    }

    #[test]
    fn test_spearman_no_overlap() {
        let a: Vec<(String, f64)> = vec![("x".into(), 0.9)];
        let b: Vec<(String, f64)> = vec![("y".into(), 0.9)];
        let rho = spearman_rho(&a, &b, 1);
        assert_eq!(rho, 0.0);
    }
}
