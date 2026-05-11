//! Shared helpers for ll-search Criterion benchmarks.
//!
//! These are kept isolated from src/ to avoid contaminating production code
//! with bench-only schema duplication and deterministic data utilities.

#![allow(dead_code)]

use rusqlite::{Connection, params};

// ---------------------------------------------------------------------------
// Deterministic PRNG — splitmix64
// ---------------------------------------------------------------------------

pub struct Splitmix64(pub u64);

impl Splitmix64 {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }

    pub fn next_f32(&mut self) -> f32 {
        (self.next() as f64 / u64::MAX as f64) as f32
    }

    pub fn next_usize(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

// ---------------------------------------------------------------------------
// Deterministic embedding — unit-normalised 384-dim vector
// ---------------------------------------------------------------------------

/// Produce a deterministic unit-normalised f32 vector of length `dim`.
///
/// The vector is reproducible across platforms because it uses only integer
/// arithmetic seeded from `note_id` and `seed`.
pub fn deterministic_embedding(note_id: u64, dim: usize, seed: u64) -> Vec<f32> {
    let mut rng = Splitmix64(seed ^ note_id.wrapping_mul(0x517cc1b727220a95));
    let mut v: Vec<f32> = (0..dim)
        .map(|_| rng.next_f32() * 2.0 - 1.0)
        .collect();
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
    for x in &mut v {
        *x /= norm;
    }
    v
}

// ---------------------------------------------------------------------------
// Deterministic text
// ---------------------------------------------------------------------------

const CORPUS: &[&str] = &[
    "activation", "adaptive", "aggregate", "algorithm", "alignment",
    "allocation", "analysis", "anchor", "annotation", "architecture",
    "attention", "attribute", "augmentation", "bayesian", "bias",
    "boundary", "branching", "buffer", "calibration", "capacity",
    "causal", "channel", "classifier", "cluster", "coherence",
    "compression", "computation", "concept", "confidence", "consolidation",
    "constraint", "context", "convergence", "correlation", "criterion",
    "decay", "decomposition", "delta", "density", "dependency",
    "depth", "detection", "dimension", "distribution", "divergence",
    "dynamics", "embedding", "encoding", "entropy", "evaluation",
    "evidence", "evolution", "expansion", "extraction", "feedback",
    "filter", "flow", "focus", "frequency", "function",
    "gradient", "graph", "heuristic", "hierarchy", "hypothesis",
    "inference", "integration", "interaction", "invariance", "iteration",
    "kernel", "knowledge", "label", "latent", "layer",
    "learning", "likelihood", "loss", "manifold", "mapping",
    "memory", "metric", "mixture", "model", "momentum",
    "network", "noise", "normalization", "objective", "optimization",
    "output", "parameter", "pattern", "penalty", "perception",
];

/// Produce a deterministic text string of approximately `words` words.
pub fn deterministic_text(seed: u64, words: usize) -> String {
    let mut rng = Splitmix64(seed);
    let mut out = String::with_capacity(words * 8);
    for i in 0..words {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(CORPUS[rng.next_usize(CORPUS.len())]);
    }
    out
}

// ---------------------------------------------------------------------------
// Synthetic SQLite database builders
// ---------------------------------------------------------------------------

/// Schema duplicated from db/schema.rs — benches cannot use cfg(test) from src/.
fn create_bench_schema(conn: &Connection) {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE IF NOT EXISTS notes (
             id       INTEGER PRIMARY KEY,
             path     TEXT UNIQUE NOT NULL,
             content_hash TEXT NOT NULL,
             mtime    REAL NOT NULL,
             title    TEXT,
             tags     TEXT,
             session_id INTEGER,
             visibility TEXT DEFAULT 'private'
         );
         CREATE TABLE IF NOT EXISTS notes_content (
             id   INTEGER PRIMARY KEY,
             title TEXT,
             tags  TEXT,
             body  TEXT
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
             title, tags, body,
             content='notes_content',
             content_rowid='id',
             tokenize='porter unicode61 remove_diacritics 1'
         );
         CREATE TABLE IF NOT EXISTS embeddings (
             id   INTEGER PRIMARY KEY,
             data BLOB NOT NULL
         );
         CREATE TABLE IF NOT EXISTS links (
             source_id INTEGER NOT NULL,
             target_id INTEGER NOT NULL,
             PRIMARY KEY (source_id, target_id)
         );
         INSERT OR IGNORE INTO meta (key, value) VALUES ('model_id', 'bench-model');
         INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '5');",
    ).expect("bench schema creation failed");
}

fn insert_note(conn: &Connection, id: i64, path: &str, title: &str, tags: &str, body: &str, emb: &[f32]) {
    conn.execute(
        "INSERT OR IGNORE INTO notes (id, path, content_hash, mtime, title, tags)
         VALUES (?1, ?2, 'bench', ?3, ?4, ?5)",
        params![id, path, id as f64 * 1000.0, title, tags],
    ).unwrap();
    conn.execute(
        "INSERT OR IGNORE INTO notes_content (id, title, tags, body) VALUES (?1, ?2, ?3, ?4)",
        params![id, title, tags, body],
    ).unwrap();
    let blob: Vec<u8> = emb.iter().flat_map(|f| f.to_le_bytes()).collect();
    conn.execute(
        "INSERT OR IGNORE INTO embeddings (id, data) VALUES (?1, ?2)",
        params![id, blob],
    ).unwrap();
}

/// Build an in-memory SQLite DB with `n` synthetic notes of `dim`-dimensional embeddings.
pub fn build_synthetic_db_in_memory(n: usize, dim: usize, seed: u64) -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory db failed");
    create_bench_schema(&conn);
    populate_db(&conn, n, dim, seed);
    conn.execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").unwrap();
    conn
}

/// Vault directory on disk for reindex benches.
pub struct SyntheticVault {
    pub dir: tempfile::TempDir,
    pub note_paths: Vec<std::path::PathBuf>,
}

/// Build a temporary on-disk vault with `n` markdown files.
pub fn build_synthetic_vault_on_disk(n: usize, seed: u64) -> SyntheticVault {
    let dir = tempfile::TempDir::new().expect("tempdir failed");
    let mut rng = Splitmix64(seed);
    let mut note_paths = Vec::with_capacity(n);

    for i in 0..n {
        let title = format!("Note {i}");
        let tags = CORPUS[rng.next_usize(CORPUS.len())];
        let body = deterministic_text(seed ^ i as u64, 50);
        let content = format!("---\ntitle: \"{title}\"\ntags: [\"{tags}\"]\nmtime: {}\n---\n\n# {title}\n\n{body}\n",
            1640000000u64 + i as u64 * 3600);
        let path = dir.path().join(format!("{i:05}.md"));
        std::fs::write(&path, content).unwrap();
        note_paths.push(path);
    }

    SyntheticVault { dir, note_paths }
}

fn populate_db(conn: &Connection, n: usize, dim: usize, seed: u64) {
    let mut rng = Splitmix64(seed);
    for i in 0..n {
        let id = (i + 1) as i64;
        let path = format!("{i:05}-bench.md");
        let title = format!("Bench Note {i}");
        let tags = CORPUS[rng.next_usize(CORPUS.len())];
        let body = deterministic_text(seed ^ i as u64, 40);
        let emb = deterministic_embedding(id as u64, dim, seed);
        insert_note(conn, id, &path, &title, tags, &body, &emb);
    }
}

/// Dot product of two equal-length slices.
pub fn dot_product(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// RRF scoring accumulation (mirrors ll-core behaviour).
pub fn add_ranked_rrf(scores: &mut std::collections::HashMap<String, f64>, ranked: impl Iterator<Item = String>) {
    const K: f64 = 60.0;
    for (rank, path) in ranked.enumerate() {
        *scores.entry(path).or_insert(0.0) += 1.0 / (K + (rank + 1) as f64);
    }
}
