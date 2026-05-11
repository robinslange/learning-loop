//! Reindex throughput benchmark — Track 0E baseline + Track 1F new variant.
//!
//! Variants:
//!   - cold_preprocess_only: preprocess files, no SQLite inserts (0E baseline).
//!   - cold_preprocess_plus_insert: preprocess + deterministic embeddings + full
//!     INSERT path via `insert_embedded` (1F target). Does NOT require ONNX.
//!   - cold_full_onnx: full reindex including ONNX (gated on LL_BENCH_REAL_ONNX=1).
//!   - warm_no_changes: second pass with no changes (gated on LL_BENCH_REAL_ONNX=1).
//!
//! sample_size(10) + measurement_time(60s) per the plan; CARGO_BENCH_QUICK uses 1k notes.

mod common;

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use ll_search::db::{EmbedItem, insert_embedded};
use ll_search::preprocess::{preprocess_note, preprocess_file};

const SEED: u64 = 20260511;
const EMBED_DIM: usize = 384;

fn note_count() -> usize {
    if std::env::var("CARGO_BENCH_QUICK").is_ok() { 1000 } else { 10000 }
}

/// Build the synthetic vault on disk and return (vault, db paths in tempdir).
fn setup_vault(n: usize) -> (common::SyntheticVault, tempfile::TempDir, String) {
    let vault = common::build_synthetic_vault_on_disk(n, SEED);
    let db_dir = tempfile::TempDir::new().unwrap();
    let db_path = db_dir.path().join("bench.db").to_str().unwrap().to_string();
    (vault, db_dir, db_path)
}

fn bench_cold_preprocess_only(c: &mut Criterion) {
    let n = note_count();
    let vault = common::build_synthetic_vault_on_disk(n, SEED);

    c.bench_with_input(
        BenchmarkId::new("cold_preprocess_only", n),
        &n,
        |b, _| {
            b.iter(|| {
                let mut processed = 0usize;
                for path in &vault.note_paths {
                    if let Ok(raw) = std::fs::read_to_string(path) {
                        let fname = path.file_name().unwrap().to_str().unwrap();
                        if preprocess_note(&raw, fname).is_some() {
                            processed += 1;
                        }
                    }
                }
                processed
            });
        },
    );
}

/// Benchmark: preprocess all vault files + generate deterministic embeddings +
/// write through the full INSERT path (`insert_embedded`).
///
/// This is the 1F target variant.  It measures what the user actually waits
/// for during a reindex: disk reads, preprocessing, and SQLite writes.
/// ONNX is replaced with deterministic vectors so the bench runs anywhere.
///
/// Exit criterion: median(post-1F) ≤ 0.5 × median(pre-1F) on /10000.
fn bench_cold_preprocess_plus_insert(c: &mut Criterion) {
    let n = note_count();
    let (vault, _db_dir, _db_path) = setup_vault(n);

    // Pre-build items + vecs outside the iter loop so we measure insert cost only.
    let mut items: Vec<EmbedItem> = Vec::with_capacity(n);
    let mut vecs: Vec<Vec<f32>> = Vec::with_capacity(n);

    for (i, path) in vault.note_paths.iter().enumerate() {
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let fname = path.file_name().unwrap().to_str().unwrap();
        let Some(result) = preprocess_file(&raw, fname) else { continue };
        let emb = common::deterministic_embedding(i as u64, EMBED_DIM, SEED);
        items.push(EmbedItem {
            path: format!("{i:05}.md"),
            title: result.title,
            tags: result.tags,
            body: result.body,
            text: result.text,
            hash: format!("bench-hash-{i}"),
            mtime: 1640000000.0 + i as f64 * 3600.0,
            links: result.links,
            intentions: result.intentions,
        });
        vecs.push(emb);
    }

    let item_refs: Vec<&EmbedItem> = items.iter().collect();

    // Use a fresh on-disk DB per iteration via open_db (which runs create_schema
    // + run_migrations).  Slightly heavier than in-memory but measures the real
    // path users hit.  The TempDir is outside the iter loop so OS allocation
    // cost is paid once.
    let bench_db_dir = tempfile::TempDir::new().unwrap();
    let bench_db_path = bench_db_dir.path().join("insert_bench.db");
    let bench_db_str = bench_db_path.to_str().unwrap().to_string();

    c.bench_with_input(
        BenchmarkId::new("cold_preprocess_plus_insert", n),
        &n,
        |b, _| {
            b.iter(|| {
                // Wipe and re-create per iteration for a clean write baseline.
                let _ = std::fs::remove_file(&bench_db_path);
                let conn = ll_search::db::open_db(&bench_db_str).unwrap();
                conn.execute_batch("BEGIN TRANSACTION;").unwrap();
                insert_embedded(&conn, &item_refs, &vecs).unwrap();
                conn.execute_batch("COMMIT;").unwrap();
                std::hint::black_box(items.len())
            });
        },
    );
}

/// Reference benchmark reproducing the pre-1F INSERT path.
///
/// Uses `conn.execute()` per-note with a separate `SELECT id FROM notes WHERE path = ?`
/// round-trip — the pattern that existed before Track 1F.  Run this alongside
/// `cold_preprocess_plus_insert` to measure the speedup ratio.
///
/// The two variants share the same item/vec inputs so the difference is purely
/// the write strategy.
fn bench_pre_1f_insert_reference(c: &mut Criterion) {
    use rusqlite::params;

    let n = note_count();
    let (vault, _db_dir, _db_path) = setup_vault(n);

    let mut items: Vec<EmbedItem> = Vec::with_capacity(n);
    let mut vecs: Vec<Vec<f32>> = Vec::with_capacity(n);

    for (i, path) in vault.note_paths.iter().enumerate() {
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let fname = path.file_name().unwrap().to_str().unwrap();
        let Some(result) = preprocess_file(&raw, fname) else { continue };
        let emb = common::deterministic_embedding(i as u64, EMBED_DIM, SEED);
        items.push(EmbedItem {
            path: format!("{i:05}.md"),
            title: result.title,
            tags: result.tags,
            body: result.body,
            text: result.text,
            hash: format!("bench-hash-{i}"),
            mtime: 1640000000.0 + i as f64 * 3600.0,
            links: result.links,
            intentions: result.intentions,
        });
        vecs.push(emb);
    }

    let bench_db_dir = tempfile::TempDir::new().unwrap();
    let bench_db_path = bench_db_dir.path().join("pre1f_bench.db");
    let bench_db_str = bench_db_path.to_str().unwrap().to_string();

    c.bench_with_input(
        BenchmarkId::new("pre_1f_insert_reference", n),
        &n,
        |b, _| {
            b.iter(|| {
                let _ = std::fs::remove_file(&bench_db_path);
                let conn = ll_search::db::open_db(&bench_db_str).unwrap();
                conn.execute_batch("BEGIN TRANSACTION;").unwrap();

                for (item, vec) in items.iter().zip(vecs.iter()) {
                    conn.execute(
                        "INSERT INTO notes (path, content_hash, mtime, title, tags)
                         VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT(path) DO UPDATE SET
                           content_hash = ?2, mtime = ?3, title = ?4, tags = ?5",
                        params![item.path, item.hash, item.mtime, item.title, item.tags],
                    ).unwrap();

                    let note_id: i64 = conn
                        .query_row(
                            "SELECT id FROM notes WHERE path = ?1",
                            params![item.path],
                            |row| row.get(0),
                        ).unwrap();

                    conn.execute(
                        "INSERT OR REPLACE INTO notes_content (id, title, tags, body) VALUES (?1, ?2, ?3, ?4)",
                        params![note_id, item.title, item.tags, item.body],
                    ).unwrap();
                    conn.execute("DELETE FROM embeddings WHERE id = ?1", params![note_id]).unwrap();
                    let blob: Vec<u8> = vec.iter().flat_map(|f| f.to_le_bytes()).collect();
                    conn.execute(
                        "INSERT INTO embeddings (id, data) VALUES (?1, ?2)",
                        params![note_id, blob],
                    ).unwrap();
                    conn.execute("DELETE FROM links WHERE source_id = ?1", params![note_id]).unwrap();
                    for target in &item.links {
                        conn.execute(
                            "INSERT OR IGNORE INTO links (source_id, target_path) VALUES (?1, ?2)",
                            params![note_id, target],
                        ).unwrap();
                    }
                    conn.execute("DELETE FROM intentions WHERE note_id = ?1", params![note_id]).unwrap();
                    for intent in &item.intentions {
                        conn.execute(
                            "INSERT OR REPLACE INTO intentions (note_id, context, cue) VALUES (?1, ?2, ?3)",
                            params![note_id, intent.context, intent.cue],
                        ).unwrap();
                    }
                }

                conn.execute_batch("COMMIT;").unwrap();
                std::hint::black_box(items.len())
            });
        },
    );
}

fn bench_cold_full_onnx(c: &mut Criterion) {
    if std::env::var("LL_BENCH_REAL_ONNX").as_deref() != Ok("1") {
        eprintln!("[index_reindex] cold_full_onnx skipped (set LL_BENCH_REAL_ONNX=1 to enable)");
        return;
    }

    let n = note_count();
    let (vault, _db_dir, db_path) = setup_vault(n);
    let vault_path = vault.dir.path().to_str().unwrap().to_string();

    c.bench_with_input(
        BenchmarkId::new("cold_full_onnx", n),
        &vault_path,
        |b, vault_path| {
            b.iter(|| {
                let conn = ll_search::db::open_db(&db_path).unwrap();
                let result = ll_search::db::reindex(&conn, vault_path, true);
                std::hint::black_box(result)
            });
        },
    );
}

fn bench_warm_no_changes(c: &mut Criterion) {
    if std::env::var("LL_BENCH_REAL_ONNX").as_deref() != Ok("1") {
        eprintln!("[index_reindex] warm_no_changes skipped (set LL_BENCH_REAL_ONNX=1 to enable)");
        return;
    }

    let n = note_count();
    let (vault, _db_dir, db_path) = setup_vault(n);
    let vault_path = vault.dir.path().to_str().unwrap().to_string();

    let conn = ll_search::db::open_db(&db_path).unwrap();
    ll_search::db::reindex(&conn, &vault_path, true).ok();

    c.bench_with_input(
        BenchmarkId::new("warm_no_changes", n),
        &vault_path,
        |b, vault_path| {
            b.iter(|| {
                let result = ll_search::db::reindex(&conn, vault_path, false);
                std::hint::black_box(result)
            });
        },
    );
}

criterion_group! {
    name = index_reindex;
    config = Criterion::default()
        .sample_size(10)
        .measurement_time(std::time::Duration::from_secs(60));
    targets = bench_cold_preprocess_only,
              bench_pre_1f_insert_reference,
              bench_cold_preprocess_plus_insert,
              bench_cold_full_onnx,
              bench_warm_no_changes
}

criterion_main!(index_reindex);
