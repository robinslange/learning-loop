//! Integration tests for the ll-core 0.1.4 public API additions (track 0A) and
//! the robustness additions (track 1G: LockPoisoned, RerankReport, try_fts_bm25_query,
//! From<anyhow::Error>).

use ll_core::{
    embed::ModelConfig,
    error::Error,
    rerank::{rerank_with_report, RerankReport},
    scoring::{try_fts_bm25_query, fts_bm25_query, VAULT_FTS},
    store::EmbeddingStore,
    Error as CrateError, Result as CrateResult, PAGERANK_ITERS, TOP_K,
};
use std::sync::Arc;

// ── Error enum ────────────────────────────────────────────────────────────────

#[test]
fn error_display_dim_mismatch() {
    let err = Error::EmbeddingDimMismatch { expected: 384, actual: 256 };
    let msg = err.to_string();
    assert!(msg.contains("384"), "expected 384 in message, got: {msg}");
    assert!(msg.contains("256"), "expected 256 in message, got: {msg}");
}

#[test]
fn error_display_batch_empty() {
    let err = Error::BatchEmpty;
    let msg = err.to_string();
    assert!(!msg.is_empty());
}

#[test]
fn error_from_rusqlite() {
    // Constructing a rusqlite::Error via its From impl confirms the conversion
    // is wired up correctly.
    let sqlite_err = rusqlite::Error::InvalidParameterCount(1, 2);
    let err: Error = sqlite_err.into();
    let msg = err.to_string();
    assert!(msg.contains("sqlite"), "expected 'sqlite' in message, got: {msg}");
}

#[test]
fn error_store_lookup() {
    let err = Error::StoreLookup { key: "brain/missing.md".to_string() };
    let msg = err.to_string();
    assert!(msg.contains("missing.md"), "expected key in message, got: {msg}");
}

// ── Result alias ─────────────────────────────────────────────────────────────

#[test]
fn result_alias_ok() {
    fn make() -> CrateResult<u32> { Ok(42) }
    let ok = make();
    assert_eq!(ok.expect("value should be Ok"), 42);
}

#[test]
fn result_alias_err() {
    let err: CrateResult<u32> = Err(CrateError::BatchEmpty);
    assert!(err.is_err());
}

// ── Config constants ──────────────────────────────────────────────────────────

#[test]
fn top_k_equals_30() {
    assert_eq!(TOP_K, 30);
}

#[test]
fn pagerank_iters_equals_20() {
    assert_eq!(PAGERANK_ITERS, 20);
}

// ── Arc accessors on EmbeddingStore ──────────────────────────────────────────

fn make_store() -> Arc<EmbeddingStore> {
    let data = vec![
        (1i64, "notes/a.md".to_string(), vec![1.0f32, 0.0, 0.0]),
        (2i64, "notes/b.md".to_string(), vec![0.0f32, 1.0, 0.0]),
        (3i64, "notes/c.md".to_string(), vec![0.0f32, 0.0, 1.0]),
    ];
    EmbeddingStore::from_data(data)
}

#[test]
fn get_arc_by_path_found() {
    let store = make_store();
    let arc = store.get_arc_by_path("notes/a.md").expect("notes/a.md should exist");
    assert_eq!(arc.len(), 3);
    assert!((arc[0] - 1.0).abs() < 1e-6, "first component should be 1.0");
    assert!(arc[1].abs() < 1e-6);
}

#[test]
fn get_arc_by_path_missing() {
    let store = make_store();
    assert!(store.get_arc_by_path("notes/nonexistent.md").is_none());
}

#[test]
fn get_arc_by_id_found() {
    let store = make_store();
    let arc = store.get_arc_by_id(2).expect("id 2 should exist");
    assert_eq!(arc.len(), 3);
    assert!((arc[1] - 1.0).abs() < 1e-6, "second component should be 1.0");
}

#[test]
fn get_arc_by_id_missing() {
    let store = make_store();
    assert!(store.get_arc_by_id(999).is_none());
}

#[test]
fn iter_arc_yields_all_entries() {
    let store = make_store();
    let entries: Vec<(i64, String, Arc<[f32]>)> = store
        .iter_arc()
        .map(|(id, path, arc)| (id, path.to_string(), arc))
        .collect();
    assert_eq!(entries.len(), 3);
    // ids should be 1, 2, 3 in insertion order
    let ids: Vec<i64> = entries.iter().map(|(id, _, _)| *id).collect();
    assert_eq!(ids, vec![1, 2, 3]);
    // each arc has 3 dimensions
    for (_, _, arc) in &entries {
        assert_eq!(arc.len(), 3);
    }
}

// ── ModelConfig::new constructor ──────────────────────────────────────────────

#[test]
fn model_config_new_sets_required_fields() {
    let cfg = ModelConfig::new("bge-small-en-v1.5".to_string(), 384, 512);
    assert_eq!(cfg.model_id, "bge-small-en-v1.5");
    assert_eq!(cfg.dim, 384);
    assert_eq!(cfg.max_tokens, 512);
}

#[test]
fn model_config_new_defaults() {
    let cfg = ModelConfig::new("test-model".to_string(), 128, 256);
    assert!(cfg.query_prefix.is_none());
    assert!(cfg.passage_prefix.is_none());
    assert!(!cfg.needs_token_type_ids);
    assert!(!cfg.needs_external_pooling);
    assert!(cfg.normalize_embeddings, "normalize_embeddings should default to true");
    assert!(cfg.output_tensor_name.is_none());
}

// ── Track 1G additions ────────────────────────────────────────────────────────

// -- Error::LockPoisoned -------------------------------------------------------

#[test]
fn error_display_lock_poisoned() {
    let err = Error::LockPoisoned { what: "reranker session" };
    let msg = err.to_string();
    assert!(
        msg.contains("reranker session"),
        "expected resource name in display, got: {msg}"
    );
}

// -- From<anyhow::Error> -------------------------------------------------------

#[test]
fn anyhow_error_converts_to_inference_variant() {
    let anyhow_err = anyhow::anyhow!("something went wrong: detail here");
    let err: CrateError = anyhow_err.into();
    match err {
        CrateError::Inference(msg) => {
            assert!(msg.contains("something went wrong"), "got: {msg}");
        }
        other => panic!("expected Error::Inference, got: {other:?}"),
    }
}

// -- rerank_with_report on empty input ----------------------------------------

#[test]
fn rerank_report_empty_input() {
    // No model available in test environment: empty input must short-circuit
    // before any inference and return an empty report.
    let report: RerankReport = rerank_with_report("query", &[], 5);
    assert!(report.scored.is_empty());
    assert!(report.failed.is_empty());
}

// -- try_fts_bm25_query on missing table returns Err --------------------------

#[test]
fn try_fts_bm25_query_missing_table_returns_err() {
    let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
    // No tables created -- FTS table does not exist.
    let result = try_fts_bm25_query(&conn, "hello", 10, &VAULT_FTS);
    assert!(result.is_err(), "expected Err when FTS table is missing");
    // Should specifically be an Sqlite variant.
    match result.unwrap_err() {
        CrateError::Sqlite(_) => {}
        other => panic!("expected Error::Sqlite, got: {other:?}"),
    }
}

#[test]
fn try_fts_bm25_query_empty_query_returns_empty_ok() {
    let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
    // Empty query must return Ok(vec![]) before hitting SQLite.
    let result = try_fts_bm25_query(&conn, "   ", 10, &VAULT_FTS);
    assert!(result.is_ok());
    assert!(result.unwrap().is_empty());
}

// -- legacy fts_bm25_query still returns empty on missing table ----------------

#[test]
fn legacy_fts_bm25_query_missing_table_returns_empty() {
    let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
    // Legacy function must degrade gracefully rather than panic.
    let result = fts_bm25_query(&conn, "hello", 10, &VAULT_FTS);
    assert!(
        result.is_empty(),
        "expected empty vec from legacy fn when table missing"
    );
}
