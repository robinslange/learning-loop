use std::collections::HashMap;

pub(crate) const RRF_K: f64 = 5.0;

pub(crate) const PRF_ALPHA: f32 = 0.7;
const _PRF_BETA: f32 = 0.3;
pub(crate) const PRF_K: usize = 3;

#[derive(Debug, Clone, Copy)]
pub struct PrfParams {
    pub alpha: f32,
    pub beta: f32,
    pub k: usize,
}

impl Default for PrfParams {
    fn default() -> Self {
        Self { alpha: PRF_ALPHA, beta: 1.0 - PRF_ALPHA, k: PRF_K }
    }
}

pub(crate) fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

pub(crate) fn fts_escape(text: &str) -> String {
    text.split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn fts_bm25_query(conn: &rusqlite::Connection, query: &str, limit: usize) -> Vec<(i64, String, f64)> {
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

    let rows = match stmt.query_map(rusqlite::params![escaped, limit as i64], |row| {
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

pub(crate) fn add_ranked_rrf<'a>(rrf_scores: &mut HashMap<String, f64>, items: impl Iterator<Item = &'a str>) {
    for (rank, path) in items.enumerate() {
        *rrf_scores.entry(path.to_string()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
    }
}

pub(crate) fn finalize_rrf(rrf_scores: HashMap<String, f64>, top_n: usize) -> Vec<(String, f64)> {
    let mut results: Vec<(String, f64)> = rrf_scores.into_iter().collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_n);
    results
}

pub(crate) fn collect_seeds(
    vec_scored: &[(String, f64)],
    fts_results: &[(i64, String, f64)],
) -> Vec<String> {
    use std::collections::HashSet;
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

pub(crate) fn rocchio_prf_with(
    query_vec: &[f32],
    top_results: &[(String, f64)],
    all_embeddings: &[(i64, String, Vec<f32>)],
    params: &PrfParams,
) -> Vec<(String, f64)> {
    let dim = query_vec.len();
    let emb_map: HashMap<&str, &Vec<f32>> = all_embeddings
        .iter()
        .map(|(_, path, emb)| (path.as_str(), emb))
        .collect();

    let feedback_vecs: Vec<&Vec<f32>> = top_results
        .iter()
        .take(params.k)
        .filter_map(|(path, _)| emb_map.get(path.as_str()).copied())
        .collect();

    if feedback_vecs.is_empty() {
        return Vec::new();
    }

    let mut expanded = vec![0.0f32; dim];
    for d in 0..dim {
        let fb_mean: f32 = feedback_vecs.iter().map(|v| v[d]).sum::<f32>() / feedback_vecs.len() as f32;
        expanded[d] = params.alpha * query_vec[d] + params.beta * fb_mean;
    }

    let norm: f32 = expanded.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for d in 0..dim {
            expanded[d] /= norm;
        }
    }

    let mut prf_scored: Vec<(String, f64)> = all_embeddings
        .iter()
        .map(|(_, path, emb)| (path.clone(), cosine(&expanded, emb) as f64))
        .collect();
    prf_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    prf_scored.truncate(30);
    prf_scored
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_helpers::helpers::*;
    use rusqlite::Connection;

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
}
