//! Hot-path query benchmark — Track 0E baseline.
//!
//! Uses pre-computed embeddings (no ONNX) to isolate the RRF / graph / FTS
//! pipeline. A thin local helper mirrors the SearchContext::compute_signals
//! logic without touching query.rs signatures (that is 1E territory).

mod common;

use std::collections::HashMap;

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use rusqlite::Connection;

use common::{
    add_ranked_rrf, build_synthetic_db_in_memory, deterministic_embedding, dot_product,
};

const DIM: usize = 384;
const SEED: u64 = 20260511;

// ---------------------------------------------------------------------------
// Local thin helper that mirrors the RRF core without modifying query.rs
// ---------------------------------------------------------------------------

/// Score all embeddings against `query_vec` using dot product, sort, truncate.
fn vec_score(conn: &Connection, query_vec: &[f32]) -> Vec<(String, f64)> {
    use rusqlite::params;
    let mut stmt = conn
        .prepare("SELECT e.id, n.path, e.data FROM embeddings e JOIN notes n ON e.id = n.id")
        .unwrap();
    let mut scored: Vec<(String, f64)> = stmt
        .query_map(params![], |row| {
            let path: String = row.get(1)?;
            let blob: Vec<u8> = row.get(2)?;
            Ok((path, blob))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .map(|(path, blob)| {
            let emb: Vec<f32> = blob
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            let score = dot_product(query_vec, &emb) as f64;
            (path, score)
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(30);
    scored
}

/// Thin FTS query using ll-core directly (search::scoring re-export is pub(crate)).
fn fts_query(conn: &Connection, text: &str) -> Vec<(String, f64)> {
    use ll_core::scoring::{fts_bm25_query, VAULT_FTS};
    fts_bm25_query(conn, text, 30, &VAULT_FTS)
        .into_iter()
        .map(|(_, path, score)| (path, score))
        .collect()
}

/// Assemble RRF from vector + FTS signals.
fn rrf_scores(
    vec_scored: &[(String, f64)],
    fts_results: &[(String, f64)],
) -> HashMap<String, f64> {
    let mut scores = HashMap::new();
    add_ranked_rrf(&mut scores, vec_scored.iter().map(|(p, _)| p.clone()));
    add_ranked_rrf(&mut scores, fts_results.iter().map(|(p, _)| p.clone()));
    scores
}

// ---------------------------------------------------------------------------
// Benchmark variants
// ---------------------------------------------------------------------------

fn bench_cold_first_call(c: &mut Criterion) {
    let n: usize = if std::env::var("CARGO_BENCH_QUICK").is_ok() { 1000 } else { 10000 };
    let query_vec = deterministic_embedding(42, DIM, SEED);
    let query_text = common::deterministic_text(42, 6);

    c.bench_with_input(
        BenchmarkId::new("cold_first_call", n),
        &n,
        |b, &n| {
            b.iter(|| {
                // Rebuild DB each iteration to simulate cold cache
                let conn = build_synthetic_db_in_memory(n, DIM, SEED);
                let vec_scored = vec_score(&conn, &query_vec);
                let fts_results = fts_query(&conn, &query_text);
                let _scores = rrf_scores(&vec_scored, &fts_results);
            });
        },
    );
}

fn bench_warm_reused_context(c: &mut Criterion) {
    let n: usize = if std::env::var("CARGO_BENCH_QUICK").is_ok() { 1000 } else { 10000 };
    let conn = build_synthetic_db_in_memory(n, DIM, SEED);
    let query_vec = deterministic_embedding(42, DIM, SEED);
    let query_text = common::deterministic_text(42, 6);

    c.bench_function("warm_reused_context", |b| {
        b.iter(|| {
            let vec_scored = vec_score(&conn, &query_vec);
            let fts_results = fts_query(&conn, &query_text);
            let _scores = rrf_scores(&vec_scored, &fts_results);
        });
    });
}

fn bench_warm_with_recency_filter(c: &mut Criterion) {
    let n: usize = if std::env::var("CARGO_BENCH_QUICK").is_ok() { 1000 } else { 10000 };
    let conn = build_synthetic_db_in_memory(n, DIM, SEED);
    let query_vec = deterministic_embedding(42, DIM, SEED);
    let query_text = common::deterministic_text(42, 6);

    // recency cutoff: notes within last 30 days (mtime threshold)
    let cutoff: f64 = 1640000000.0 + (n as f64 * 0.8 * 1000.0);

    c.bench_function("warm_with_recency_filter", |b| {
        b.iter(|| {
            let vec_scored = vec_score(&conn, &query_vec);
            let fts_results = fts_query(&conn, &query_text);
            let mut scores = rrf_scores(&vec_scored, &fts_results);
            // temporal decay: halve score for notes older than cutoff
            use rusqlite::params;
            if let Ok(mut stmt) = conn.prepare("SELECT path, mtime FROM notes WHERE mtime < ?1") {
                if let Ok(rows) = stmt.query_map(params![cutoff], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
                }) {
                    for row in rows.flatten() {
                        if let Some(s) = scores.get_mut(&row.0) {
                            *s *= 0.5;
                        }
                    }
                }
            }
            scores
        });
    });
}

/// Rebuild `SearchContext` on every iteration — represents the pre-1E per-query cost.
///
/// Measures `SearchContext::build` + vec scoring + FTS + RRF assembly. This is
/// what every query paid before 1E (context rebuilt per call).
fn bench_warm_searchcontext_rebuilt(c: &mut Criterion) {
    let n: usize = if std::env::var("CARGO_BENCH_QUICK").is_ok() { 1000 } else { 10000 };
    let conn = build_synthetic_db_in_memory(n, DIM, SEED);
    let query_vec = deterministic_embedding(42, DIM, SEED);
    let query_text = common::deterministic_text(42, 6);

    c.bench_function("warm_searchcontext_rebuilt", |b| {
        b.iter(|| {
            // Rebuild the full context on every call.
            let _ctx = ll_search::search::SearchContext::build(&conn);
            let vec_scored = vec_score(&conn, &query_vec);
            let fts_results = fts_query(&conn, &query_text);
            rrf_scores(&vec_scored, &fts_results)
        });
    });
}

/// Reuse a pre-built `SearchContext` across iterations — represents the 1E cached path.
///
/// The dominant saving: `SearchContext::build` (which loads all embeddings, interns
/// all paths, builds title/mtime/tag/graph maps) is paid once at startup rather than
/// once per query.
fn bench_warm_searchcontext_cached(c: &mut Criterion) {
    let n: usize = if std::env::var("CARGO_BENCH_QUICK").is_ok() { 1000 } else { 10000 };
    let conn = build_synthetic_db_in_memory(n, DIM, SEED);
    let query_vec = deterministic_embedding(42, DIM, SEED);
    let query_text = common::deterministic_text(42, 6);
    // Context built once — paid at startup, reused across queries.
    let _ctx = ll_search::search::SearchContext::build(&conn);

    c.bench_function("warm_searchcontext_cached", |b| {
        b.iter(|| {
            // No rebuild; only pay vec scoring + FTS + RRF each call.
            let vec_scored = vec_score(&conn, &query_vec);
            let fts_results = fts_query(&conn, &query_text);
            rrf_scores(&vec_scored, &fts_results)
        });
    });
}

criterion_group! {
    name = query_hot_path;
    config = Criterion::default()
        .sample_size(20)
        .measurement_time(std::time::Duration::from_secs(10))
        .warm_up_time(std::time::Duration::from_secs(2));
    targets = bench_cold_first_call, bench_warm_reused_context, bench_warm_with_recency_filter,
              bench_warm_searchcontext_rebuilt, bench_warm_searchcontext_cached
}

criterion_main!(query_hot_path);
