use std::collections::HashMap;
use std::sync::Arc;

use rayon::prelude::*;
use rusqlite::Connection;

use crate::config::{
    PAGERANK_DAMPING, PAGERANK_ITERS, PRF_ALPHA, PRF_BETA, PRF_K,
    TAG_FREQ_BAND_MAX, TAG_FREQ_BAND_MIN,
    TOP_K_FTS, TOP_K_GRAPH, TOP_K_INITIAL, TOP_K_VEC,
};
use super::scoring::{add_ranked_rrf, dot_product, fts_bm25_query, collect_seeds, rocchio_prf_with, PrfParams};
use super::graph::{load_link_graph, load_tags_map, personalized_pagerank, personalized_pagerank_holdout};
use super::store::{EmbeddingStore, load_store};
use super::query::{load_titles_map, load_mtime_map};

// ---------------------------------------------------------------------------
// Decay LUT — normalised exponential, built once per SearchContext
// ---------------------------------------------------------------------------

/// Pre-computed normalised exponential decay table.
///
/// `decay(age_secs, half_life_secs)` replaces `(-ln2 * age / half_life).exp()`
/// with a table lookup. The table covers the normalised domain `[0, NORM_MAX]`
/// where `x = age_secs / half_life_secs`. Outside the domain the floor bucket
/// value is returned.
pub(crate) struct DecayLut {
    buckets: Vec<f64>,
}

const DECAY_LUT_BUCKETS: usize = 4096;
const DECAY_LUT_NORM_MAX: f64 = 8.0;
const DECAY_LUT_STEP: f64 = DECAY_LUT_NORM_MAX / (DECAY_LUT_BUCKETS as f64);

impl DecayLut {
    fn new() -> Self {
        let ln2 = std::f64::consts::LN_2;
        let buckets: Vec<f64> = (0..DECAY_LUT_BUCKETS)
            .map(|i| (-ln2 * i as f64 * DECAY_LUT_STEP).exp())
            .collect();
        Self { buckets }
    }

    /// Look up `exp(-ln2 * age_secs / half_life_secs)` from the table.
    #[inline]
    pub(crate) fn decay(&self, age_secs: f64, half_life_secs: f64) -> f64 {
        if half_life_secs <= 0.0 || age_secs <= 0.0 {
            return 1.0;
        }
        let normalised = age_secs / half_life_secs;
        if normalised >= DECAY_LUT_NORM_MAX {
            return *self.buckets.last().unwrap_or(&0.0);
        }
        let idx = (normalised / DECAY_LUT_STEP) as usize;
        self.buckets[idx.min(DECAY_LUT_BUCKETS - 1)]
    }
}

// ---------------------------------------------------------------------------
// SearchContext
// ---------------------------------------------------------------------------

pub struct SearchContext {
    pub(crate) store: Arc<EmbeddingStore>,
    pub(crate) graph: Arc<HashMap<String, Vec<String>>>,
    pub(crate) titles: Arc<HashMap<Arc<str>, Option<Arc<str>>>>,
    pub(crate) mtimes: Arc<HashMap<Arc<str>, f64>>,
    pub(crate) tags: Arc<HashMap<Arc<str>, Vec<Arc<str>>>>,
    /// Paths interned to `Arc<str>`, parallel-indexed with `store.all()`.
    /// Avoids per-entry `String::clone` in the par_iter candidate loop.
    pub(crate) paths_interned: Arc<Vec<Arc<str>>>,
    /// Cached normalised decay LUT — built once, reused across queries.
    pub(crate) decay_lut: Arc<DecayLut>,
    pub(crate) data_version: i64,
}

pub(crate) struct Signals {
    pub vec_scored: Vec<(String, f64)>,
    pub fts_results: Vec<(i64, String, f64)>,
    pub ppr_results: Vec<(String, f64)>,
    pub tag_results: Vec<(String, f64)>,
}

/// Per-stage on/off flags for ablation runs.
///
/// Production code uses `StageFlags::default()` which leaves the four signal
/// stages and PRF on, rerank off. Eval harnesses override individual flags to
/// measure each stage's contribution.
#[derive(Debug, Clone, Copy)]
pub struct StageFlags {
    pub vec_search: bool,
    pub bm25: bool,
    pub ppr: bool,
    pub tag_expand: bool,
    pub prf: bool,
    pub rerank: bool,
}

impl Default for StageFlags {
    fn default() -> Self {
        Self {
            vec_search: true,
            bm25: true,
            ppr: true,
            tag_expand: true,
            prf: true,
            rerank: false,
        }
    }
}

impl SearchContext {
    /// Build a fresh `SearchContext` from the given connection.
    pub fn build(conn: &Connection) -> Self {
        let store = load_store(conn);

        // Intern paths matching store.all() order — one Arc<str> per path.
        let paths_interned: Vec<Arc<str>> = store
            .all()
            .iter()
            .map(|(_, p, _)| Arc::<str>::from(p.as_str()))
            .collect();

        // Build a path -> interned Arc lookup for re-interning secondary maps.
        let mut by_path: HashMap<&str, Arc<str>> =
            HashMap::with_capacity(paths_interned.len());
        for arc in &paths_interned {
            by_path.insert(arc.as_ref(), Arc::clone(arc));
        }

        let graph = Arc::new(load_link_graph(conn));
        let titles = Arc::new(intern_titles(load_titles_map(conn), &by_path));
        let mtimes = Arc::new(intern_mtimes(load_mtime_map(conn), &by_path));
        let tags = Arc::new(intern_tags(load_tags_map(conn), &by_path));
        let decay_lut = Arc::new(DecayLut::new());
        let data_version = read_data_version(conn);

        Self {
            store,
            graph,
            titles,
            mtimes,
            tags,
            paths_interned: Arc::new(paths_interned),
            decay_lut,
            data_version,
        }
    }

    pub fn is_stale(&self, conn: &Connection) -> bool {
        read_data_version(conn) != self.data_version
    }

    pub fn refresh(&mut self, conn: &Connection) {
        *self = Self::build(conn);
    }

    pub(crate) fn compute_signals(
        &self,
        conn: &Connection,
        query_vec: &[f32],
        query_text: &str,
    ) -> Signals {
        self.compute_signals_inner(conn, query_vec, query_text, None)
    }

    /// Eval-only variant of [`Self::compute_signals`] that holds out a source
    /// note from the graph stages.
    ///
    /// `holdout_source` is removed from the PPR/tag seed set and its outgoing
    /// edges are masked from the link graph for this query. The wikilink eval
    /// uses a note's own outlinks as the relevant set; without the holdout,
    /// the source note seeds PageRank and walks the gold edges directly,
    /// circularly inflating the graph stages. Production queries always use
    /// [`Self::compute_signals`] (no masking).
    pub(crate) fn compute_signals_holdout(
        &self,
        conn: &Connection,
        query_vec: &[f32],
        query_text: &str,
        holdout_source: &str,
    ) -> Signals {
        self.compute_signals_inner(conn, query_vec, query_text, Some(holdout_source))
    }

    fn compute_signals_inner(
        &self,
        conn: &Connection,
        query_vec: &[f32],
        query_text: &str,
        holdout_source: Option<&str>,
    ) -> Signals {
        let all_embeddings = self.store.all();
        let paths = &self.paths_interned;

        // Hot path: Arc::clone is a refcount bump (~1 ns), not a String alloc.
        let mut vec_scored_arc: Vec<(Arc<str>, f64)> = all_embeddings
            .par_iter()
            .enumerate()
            .map(|(i, (_, _, emb))| (Arc::clone(&paths[i]), dot_product(query_vec, emb) as f64))
            .collect();
        vec_scored_arc.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        vec_scored_arc.truncate(TOP_K_VEC);

        // Convert survivors to String (bounded to TOP_K_VEC = 30 allocs, negligible).
        let vec_scored: Vec<(String, f64)> = vec_scored_arc
            .iter()
            .map(|(a, s)| (a.to_string(), *s))
            .collect();

        let fts_results = fts_bm25_query(conn, query_text, TOP_K_FTS);
        let mut seeds = collect_seeds(&vec_scored, &fts_results);
        let ppr_results = match holdout_source {
            None => personalized_pagerank(&self.graph, &seeds, PAGERANK_DAMPING, PAGERANK_ITERS),
            Some(src) => {
                seeds.retain(|s| s != src);
                // The graph is stored undirected. The holdout skips the
                // source's adjacency list during the walk (masking every
                // source->outlink edge without cloning the graph) and filters
                // the source from the output — remaining inbound edges feed
                // score into a sink that is never returned.
                personalized_pagerank_holdout(
                    &self.graph, &seeds, PAGERANK_DAMPING, PAGERANK_ITERS, Some(src),
                )
            }
        };
        let tag_results = tag_expand_from_map(&self.tags, &seeds);

        Signals { vec_scored, fts_results, ppr_results, tag_results }
    }

    pub(crate) fn rrf_from_signals(
        &self,
        signals: &Signals,
        extra: Option<&[(String, f64)]>,
    ) -> HashMap<String, f64> {
        self.rrf_from_signals_gated(signals, &StageFlags::default(), extra)
    }

    /// RRF fusion that skips disabled stages. Used by eval harnesses.
    pub(crate) fn rrf_from_signals_gated(
        &self,
        signals: &Signals,
        flags: &StageFlags,
        extra: Option<&[(String, f64)]>,
    ) -> HashMap<String, f64> {
        let mut rrf: HashMap<String, f64> = HashMap::new();
        if flags.vec_search {
            add_ranked_rrf(&mut rrf, signals.vec_scored.iter().map(|(p, _)| p.as_str()));
        }
        if flags.bm25 {
            add_ranked_rrf(&mut rrf, signals.fts_results.iter().map(|(_, p, _)| p.as_str()));
        }
        if flags.ppr {
            add_ranked_rrf(&mut rrf, signals.ppr_results.iter().map(|(p, _)| p.as_str()));
        }
        if flags.tag_expand {
            add_ranked_rrf(&mut rrf, signals.tag_results.iter().map(|(p, _)| p.as_str()));
        }
        if let Some(extra) = extra {
            add_ranked_rrf(&mut rrf, extra.iter().map(|(p, _)| p.as_str()));
        }
        rrf
    }

    pub(crate) fn local_rrf_scores(
        &self,
        conn: &Connection,
        query_vec: &[f32],
        query_text: &str,
    ) -> HashMap<String, f64> {
        let all_embeddings = self.store.all();
        let signals = self.compute_signals(conn, query_vec, query_text);

        let mut rrf = self.rrf_from_signals(&signals, None);

        // Hybrid-feedback PRF
        let mut initial: Vec<(String, f64)> = rrf.iter().map(|(p, s)| (p.clone(), *s)).collect();
        initial.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        initial.truncate(TOP_K_INITIAL);
        let prf_params = PrfParams { alpha: PRF_ALPHA, beta: PRF_BETA, k: PRF_K };
        let prf_results = rocchio_prf_with(query_vec, &initial, all_embeddings, &prf_params);
        add_ranked_rrf(&mut rrf, prf_results.iter().map(|(p, _)| p.as_str()));

        rrf
    }
}

// ---------------------------------------------------------------------------
// Intern helpers — convert String-keyed maps to Arc<str>-keyed maps
// ---------------------------------------------------------------------------

fn intern_titles(
    raw: HashMap<String, Option<String>>,
    by_path: &HashMap<&str, Arc<str>>,
) -> HashMap<Arc<str>, Option<Arc<str>>> {
    let mut out = HashMap::with_capacity(raw.len());
    for (k, v) in raw {
        let key = by_path
            .get(k.as_str())
            .cloned()
            .unwrap_or_else(|| Arc::from(k.as_str()));
        let val = v.map(|s| Arc::<str>::from(s.as_str()));
        out.insert(key, val);
    }
    out
}

fn intern_mtimes(
    raw: HashMap<String, f64>,
    by_path: &HashMap<&str, Arc<str>>,
) -> HashMap<Arc<str>, f64> {
    let mut out = HashMap::with_capacity(raw.len());
    for (k, v) in raw {
        let key = by_path
            .get(k.as_str())
            .cloned()
            .unwrap_or_else(|| Arc::from(k.as_str()));
        out.insert(key, v);
    }
    out
}

fn intern_tags(
    raw: HashMap<String, Vec<String>>,
    by_path: &HashMap<&str, Arc<str>>,
) -> HashMap<Arc<str>, Vec<Arc<str>>> {
    let mut out = HashMap::with_capacity(raw.len());
    for (k, v) in raw {
        let key = by_path
            .get(k.as_str())
            .cloned()
            .unwrap_or_else(|| Arc::from(k.as_str()));
        let tags: Vec<Arc<str>> = v.iter().map(|t| Arc::<str>::from(t.as_str())).collect();
        out.insert(key, tags);
    }
    out
}

// ---------------------------------------------------------------------------
// tag_expand_from_map — operates on Arc<str>-keyed tags map
// ---------------------------------------------------------------------------

fn tag_expand_from_map(
    tags_map: &HashMap<Arc<str>, Vec<Arc<str>>>,
    seed_paths: &[String],
) -> Vec<(String, f64)> {
    use std::collections::HashSet;

    let total_notes = tags_map.len() as f64;
    if total_notes == 0.0 {
        return Vec::new();
    }
    let seed_set: HashSet<&str> = seed_paths.iter().map(|s| s.as_str()).collect();

    let mut seed_tags: HashSet<&str> = HashSet::new();
    for path in seed_paths {
        if let Some(tags) = tags_map.get(path.as_str()) {
            for tag in tags {
                seed_tags.insert(tag.as_ref());
            }
        }
    }

    let mut tag_freq: HashMap<&str, usize> = HashMap::new();
    for tags in tags_map.values() {
        for tag in tags {
            *tag_freq.entry(tag.as_ref()).or_default() += 1;
        }
    }

    let qualifying: HashSet<&str> = seed_tags
        .iter()
        .filter_map(|&t| {
            let freq = *tag_freq.get(t).unwrap_or(&0);
            if (TAG_FREQ_BAND_MIN..=TAG_FREQ_BAND_MAX).contains(&freq) {
                Some(t)
            } else {
                None
            }
        })
        .collect();

    if qualifying.is_empty() {
        return Vec::new();
    }

    let mut candidate_scores: HashMap<&str, f64> = HashMap::new();
    for (path, tags) in tags_map {
        if seed_set.contains(path.as_ref()) {
            continue;
        }
        let score: f64 = tags
            .iter()
            .filter(|t| qualifying.contains(t.as_ref()))
            .map(|t| {
                let freq = *tag_freq.get(t.as_ref()).unwrap_or(&1) as f64;
                (total_notes / freq).ln()
            })
            .sum();
        if score > 0.0 {
            candidate_scores.insert(path.as_ref(), score);
        }
    }

    let mut results: Vec<(String, f64)> = candidate_scores
        .into_iter()
        .map(|(path, score)| (path.to_string(), score))
        .collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(TOP_K_GRAPH);
    results
}

fn read_data_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_helpers::helpers::*;

    #[test]
    fn test_build_caches_match_inline() {
        let emb_a = norm(&[1.0, 0.0, 0.0]);
        let emb_b = norm(&[0.0, 1.0, 0.0]);
        let conn = create_test_db(&[
            ("a.md", "title a", "body a", &emb_a),
            ("b.md", "title b", "body b", &emb_b),
        ]);
        let ctx = SearchContext::build(&conn);

        let titles_inline = load_titles_map(&conn);
        let mtimes_inline = load_mtime_map(&conn);
        let graph_inline = load_link_graph(&conn);

        // Titles map semantics: same keys, same values.
        for (k, v) in &titles_inline {
            let arc_key: Arc<str> = Arc::from(k.as_str());
            let ctx_val = ctx.titles.get(&arc_key);
            let expected = v.as_deref().map(Arc::from);
            assert_eq!(ctx_val, Some(&expected));
        }
        assert_eq!(ctx.titles.len(), titles_inline.len());

        // Mtimes map semantics preserved.
        for (k, v) in &mtimes_inline {
            let arc_key: Arc<str> = Arc::from(k.as_str());
            assert_eq!(ctx.mtimes.get(&arc_key), Some(v));
        }
        assert_eq!(ctx.mtimes.len(), mtimes_inline.len());

        assert_eq!(ctx.graph.len(), graph_inline.len());
        assert_eq!(ctx.store.len(), 2);
    }

    #[test]
    fn test_refresh_picks_up_new_note() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_test_db(&[("a.md", "title a", "body a", &emb)]);
        let mut ctx = SearchContext::build(&conn);
        assert_eq!(ctx.store.len(), 1);

        let emb_bytes: Vec<u8> = emb.iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.execute(
            "INSERT INTO notes (path, title, content_hash, mtime) VALUES ('b.md', 'title b', 'hash', 1000.0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO embeddings (id, data) SELECT id, ?1 FROM notes WHERE path = 'b.md'",
            rusqlite::params![emb_bytes],
        ).unwrap();

        ctx.refresh(&conn);
        assert_eq!(ctx.store.len(), 2);
        let arc_b: Arc<str> = Arc::from("b.md");
        assert!(ctx.titles.contains_key(&arc_b));
    }

    #[test]
    fn test_data_version_is_readable() {
        let conn = create_test_db(&[]);
        let v = read_data_version(&conn);
        assert!(v >= 0, "data_version should be a non-negative integer");
        let ctx = SearchContext::build(&conn);
        let _ = ctx.is_stale(&conn);
    }

    #[test]
    fn test_query_matches_legacy_path() {
        let emb_a = norm(&[1.0, 0.0, 0.0]);
        let emb_b = norm(&[0.0, 1.0, 0.0]);
        let conn = create_test_db(&[
            ("3-permanent/sleep.md", "sleep architecture", "Deep sleep is important", &emb_a),
            ("3-permanent/diet.md", "diet and nutrition", "Protein intake matters", &emb_b),
        ]);
        let store = super::super::store::load_store(&conn);
        let query_vec = norm(&[1.0, 0.1, 0.0]);

        let all_embeddings = store.all();
        let graph = load_link_graph(&conn);
        let legacy = super::super::query::local_rrf_scores(
            &conn, &query_vec, "sleep", all_embeddings, &graph,
        );
        let mut legacy_top: Vec<(String, f64)> = legacy.into_iter().collect();
        legacy_top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        legacy_top.truncate(10);

        let ctx = SearchContext::build(&conn);
        let ctx_scores = ctx.local_rrf_scores(&conn, &query_vec, "sleep");
        let mut ctx_top: Vec<(String, f64)> = ctx_scores.into_iter().collect();
        ctx_top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ctx_top.truncate(10);

        let legacy_paths: Vec<&str> = legacy_top.iter().map(|(p, _)| p.as_str()).collect();
        let ctx_paths: Vec<&str> = ctx_top.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(legacy_paths, ctx_paths);
    }

    #[test]
    fn test_holdout_masks_gold_edges_in_ppr() {
        // Vault: source links to a + b (the eval ground truth). Eleven filler
        // notes sit between the query vector and a/b so that a/b are outside
        // the top-10 vec seeds — the regime where PPR's contribution matters.
        // Extra structure pins the holdout's exact semantics:
        //   - filler0 (a seed) links to second.md, a second-order candidate
        //     reachable WITHOUT the source's edges — it must still be found,
        //     so a total over-masking regression fails the test;
        //   - filler1 (a seed) links to source.md, so the source accumulates
        //     PPR mass via an inbound edge — it must be filtered from the
        //     output, not just dropped from the seed set.
        let emb_src = norm(&[1.0, 0.0, 0.0]);
        let emb_a = norm(&[0.0, 1.0, 0.0]);
        let emb_b = norm(&[0.0, 0.0, 1.0]);
        let emb_second = norm(&[0.0, 0.5, 0.5]);
        let fillers: Vec<Vec<f32>> = (1..=11)
            .map(|i| norm(&[1.0, 0.01 * i as f32, 0.0]))
            .collect();

        let mut notes: Vec<(String, String, String, Vec<f32>)> = vec![
            ("source.md".into(), "source note".into(), "links to a and b".into(), emb_src),
            ("a.md".into(), "note a".into(), "body a".into(), emb_a),
            ("b.md".into(), "note b".into(), "body b".into(), emb_b),
        ];
        for (i, emb) in fillers.into_iter().enumerate() {
            notes.push((
                format!("filler{i}.md"),
                format!("filler {i}"),
                "unrelated body".into(),
                emb,
            ));
        }
        notes.push(("second.md".into(), "second order".into(), "off-query body".into(), emb_second));
        let notes_ref: Vec<(&str, &str, &str, &[f32])> = notes
            .iter()
            .map(|(p, t, b, e)| (p.as_str(), t.as_str(), b.as_str(), e.as_slice()))
            .collect();
        let conn = create_test_db(&notes_ref);
        // ids: source=1, a=2, b=3, filler0=4, filler1=5, ..., second=15.
        conn.execute_batch(
            "CREATE TABLE links (id INTEGER PRIMARY KEY, source_id INTEGER, target_path TEXT NOT NULL);
             INSERT INTO links (source_id, target_path) VALUES
                 (1, 'a'), (1, 'b'), (4, 'second'), (5, 'source');",
        )
        .unwrap();

        let ctx = SearchContext::build(&conn);
        let qvec = norm(&[1.0, 0.0, 0.0]);

        let leaky = ctx.compute_signals(&conn, &qvec, "source note");
        let leaky_ppr: Vec<&str> = leaky.ppr_results.iter().map(|(p, _)| p.as_str()).collect();
        assert!(
            leaky_ppr.contains(&"a.md") && leaky_ppr.contains(&"b.md"),
            "without holdout, PPR ranks the gold targets by walking source's own edges: {leaky_ppr:?}"
        );

        let held = ctx.compute_signals_holdout(&conn, &qvec, "source note", "source.md");
        let held_ppr: Vec<&str> = held.ppr_results.iter().map(|(p, _)| p.as_str()).collect();
        assert!(
            !held_ppr.contains(&"a.md") && !held_ppr.contains(&"b.md"),
            "with holdout, the gold edges alone cannot rank a.md/b.md: {held_ppr:?}"
        );
        assert!(
            held_ppr.contains(&"second.md"),
            "holdout must not over-mask: second-order structure (filler0 -> second) still ranks: {held_ppr:?}"
        );
        assert!(
            !held_ppr.contains(&"source.md"),
            "source gains mass via inbound edges (filler1 -> source) but must be filtered from PPR output: {held_ppr:?}"
        );
    }

    #[test]
    fn test_decay_lut_matches_direct_exp() {
        let lut = DecayLut::new();
        let ln2 = std::f64::consts::LN_2;
        let half_life = 30.0 * 86_400.0; // 30 days in seconds
        // Test within domain: DECAY_LUT_NORM_MAX = 8 half-lives = 240 days.
        // Practical relevance beyond ~6 half-lives is near-zero anyway.
        for age_days in [0.0f64, 1.0, 7.0, 30.0, 90.0, 180.0] {
            let age_secs = age_days * 86_400.0;
            let direct = (-ln2 * age_secs / half_life).exp();
            let lut_val = lut.decay(age_secs, half_life);
            let rel_err = (direct - lut_val).abs() / direct.max(1e-15);
            assert!(rel_err < 0.01, "LUT relative error {rel_err:.4} at age {age_days} days");
        }
        // Ages beyond the domain return the near-zero floor; verify no panic.
        let _ = lut.decay(500.0 * 86_400.0, half_life);
    }
}
