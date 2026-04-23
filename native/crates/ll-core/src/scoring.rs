use std::collections::HashMap;

pub const RRF_K: f64 = 5.0;

pub const PRF_ALPHA: f32 = 0.7;
pub const PRF_K: usize = 3;

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

pub struct FtsConfig {
    pub fts_table: &'static str,
    pub content_table: &'static str,
    pub items_table: &'static str,
    pub id_column: &'static str,
    pub path_column: &'static str,
    pub bm25_weights: &'static str,
}

pub const VAULT_FTS: FtsConfig = FtsConfig {
    fts_table: "notes_fts",
    content_table: "notes_content",
    items_table: "notes",
    id_column: "id",
    path_column: "path",
    bm25_weights: "10.0, 5.0, 1.0",
};

pub fn dot_product(a: &[f32], b: &[f32]) -> f32 {
    debug_assert!(
        (a.iter().map(|x| x * x).sum::<f32>().sqrt() - 1.0).abs() < 0.01,
        "dot_product assumes L2-normalized vectors"
    );
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

pub fn fts_escape(text: &str) -> String {
    text.split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn fts_bm25_query(
    conn: &rusqlite::Connection,
    query: &str,
    limit: usize,
    config: &FtsConfig,
) -> Vec<(i64, String, f64)> {
    let escaped = fts_escape(query);
    if escaped.is_empty() {
        return Vec::new();
    }

    let sql = format!(
        "SELECT nc.{id}, n.{path}, bm25({fts}, {weights}) as score
         FROM {fts}
         JOIN {content} nc ON nc.{id} = {fts}.rowid
         JOIN {items} n ON n.{id} = nc.{id}
         WHERE {fts} MATCH ?1
         ORDER BY score
         LIMIT ?2",
        id = config.id_column,
        path = config.path_column,
        fts = config.fts_table,
        content = config.content_table,
        items = config.items_table,
        weights = config.bm25_weights,
    );

    let mut stmt = match conn.prepare(&sql) {
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

pub fn add_ranked_rrf<'a>(rrf_scores: &mut HashMap<String, f64>, items: impl Iterator<Item = &'a str>) {
    for (rank, path) in items.enumerate() {
        *rrf_scores.entry(path.to_string()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
    }
}

pub fn finalize_rrf(rrf_scores: HashMap<String, f64>, top_n: usize) -> Vec<(String, f64)> {
    let mut results: Vec<(String, f64)> = rrf_scores.into_iter().collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_n);
    results
}

pub fn collect_seeds(
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

pub fn rocchio_prf_with(
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
        .map(|(_, path, emb)| (path.clone(), dot_product(&expanded, emb) as f64))
        .collect();
    prf_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    prf_scored.truncate(30);
    prf_scored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dot_product_identical() {
        let v = vec![1.0f32, 0.0, 0.0];
        let sim = dot_product(&v, &v);
        assert!((sim - 1.0).abs() < 1e-5);
    }

    #[test]
    fn test_dot_product_orthogonal() {
        let a = vec![1.0f32, 0.0, 0.0];
        let b = vec![0.0f32, 1.0, 0.0];
        let sim = dot_product(&a, &b);
        assert!(sim.abs() < 1e-5);
    }

    #[test]
    fn test_fts_escape() {
        assert_eq!(fts_escape("hello world"), "\"hello\" \"world\"");
        assert_eq!(fts_escape(""), "");
        assert_eq!(fts_escape("  "), "");
    }

    #[test]
    fn test_rrf_basic() {
        let mut scores = HashMap::new();
        add_ranked_rrf(&mut scores, ["a", "b", "c"].iter().copied());
        assert!(scores["a"] > scores["b"]);
        assert!(scores["b"] > scores["c"]);
    }

    #[test]
    fn test_finalize_rrf_truncates() {
        let mut scores = HashMap::new();
        for i in 0..20 {
            scores.insert(format!("doc_{}", i), 1.0 / (i + 1) as f64);
        }
        let results = finalize_rrf(scores, 5);
        assert_eq!(results.len(), 5);
    }
}
