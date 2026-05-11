//! Embedding throughput benchmark — Track 0E baseline.
//!
//! Two variants:
//!   - preprocess_only: runs preprocess_note over 100 synthetic markdown
//!     files (no ONNX). Always available.
//!   - real_onnx: runs through the full embedding pipeline. Gated by
//!     LL_BENCH_REAL_ONNX=1. Requires the ONNX model binary to be present.

mod common;

use criterion::{Criterion, criterion_group, criterion_main};

const SEED: u64 = 20260511;

fn bench_preprocess_only(c: &mut Criterion) {
    let count: usize = if std::env::var("CARGO_BENCH_QUICK").is_ok() { 20 } else { 100 };
    let texts: Vec<String> = (0..count)
        .map(|i| {
            let body = common::deterministic_text(SEED ^ i as u64, 100);
            let _filename = format!("{i:05}-bench.md");
            format!(
                "---\ntitle: \"Bench Note {i}\"\ntags: [\"bench\"]\nmtime: {}\n---\n\n# Bench Note {i}\n\n{body}\n",
                1640000000u64 + i as u64 * 3600
            )
        })
        .collect();
    let filenames: Vec<String> = (0..count).map(|i| format!("{i:05}-bench.md")).collect();

    c.bench_function("preprocess_only", |b| {
        b.iter(|| {
            let mut processed = 0usize;
            for (raw, fname) in texts.iter().zip(filenames.iter()) {
                if ll_search::preprocess::preprocess_note(raw, fname).is_some() {
                    processed += 1;
                }
            }
            processed
        });
    });
}

fn bench_real_onnx(c: &mut Criterion) {
    if std::env::var("LL_BENCH_REAL_ONNX").as_deref() != Ok("1") {
        eprintln!("[embed_throughput] real_onnx skipped (set LL_BENCH_REAL_ONNX=1 to enable)");
        return;
    }

    let count: usize = if std::env::var("CARGO_BENCH_QUICK").is_ok() { 10 } else { 100 };
    let texts: Vec<String> = (0..count)
        .map(|i| {
            let body = common::deterministic_text(SEED ^ i as u64, 60);
            format!("Title: Bench Note {i}\n\n{body}")
        })
        .collect();

    c.bench_function("real_onnx", |b| {
        b.iter(|| {
            let embedded = ll_search::embed::embed_documents(&texts);
            embedded.len()
        });
    });
}

criterion_group! {
    name = embed_throughput;
    config = Criterion::default()
        .sample_size(20)
        .measurement_time(std::time::Duration::from_secs(10))
        .warm_up_time(std::time::Duration::from_secs(2));
    targets = bench_preprocess_only, bench_real_onnx
}

criterion_main!(embed_throughput);
