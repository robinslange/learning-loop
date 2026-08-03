use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;

use crate::config::{PRF_ALPHA, PRF_BETA, PRF_K, TOP_K_INITIAL};
use crate::embed::embed_query;
use crate::rerank::rerank_with_report;

use super::scoring::{finalize_rrf, rocchio_prf_with, PrfParams, add_ranked_rrf, FusionWeights};
use super::store::EmbeddingStore;
use super::context::{SearchContext, StageFlags};
use super::federation::batch_load_bodies_federated;

#[derive(Debug, Serialize)]
pub struct EvalResult {
    pub num_queries: usize,
    pub min_links: usize,
    pub configs: Vec<EvalConfig>,
}

#[derive(Debug, Serialize)]
pub struct EvalConfig {
    pub label: String,
    pub recall_at_5: f64,
    pub recall_at_10: f64,
    pub ndcg_at_10: f64,
    pub mrr: f64,
    pub hits_at_1: f64,
}

struct EvalQuery {
    title: String,
    path: String,
    relevant: HashSet<String>,
    /// Synthetic long natural-language query derived from the note body
    /// (wikilinks stripped). Covers the JIT injection path, whose queries are
    /// dozens of tokens — a distribution title-only queries cannot represent.
    long_query: Option<String>,
}

/// Number of leading body tokens used to build a long eval query.
const LONG_QUERY_TOKENS: usize = 40;

/// Minimum token count for a body-derived long query to be usable.
const LONG_QUERY_MIN_TOKENS: usize = 8;

/// Remove `[[wikilink]]` spans from a note body.
///
/// The eval ground truth is the note's outlink set; leaving link targets'
/// titles inside the query text would leak the answers into the query.
fn strip_wikilinks(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        rest = match rest[start + 2..].find("]]") {
            Some(end) => &rest[start + 2 + end + 2..],
            None => "",
        };
    }
    out.push_str(rest);
    out
}

fn derive_long_query(body: &str) -> Option<String> {
    let stripped = strip_wikilinks(body);
    let tokens: Vec<&str> = stripped.split_whitespace().take(LONG_QUERY_TOKENS).collect();
    if tokens.len() < LONG_QUERY_MIN_TOKENS {
        return None;
    }
    Some(tokens.join(" "))
}

fn resolve_target(conn: &Connection, basename: &str) -> Option<String> {
    let pattern = format!("%/{}.md", basename);
    conn.query_row(
        "SELECT path FROM notes WHERE path LIKE ?1 LIMIT 1",
        rusqlite::params![pattern],
        |row| row.get::<_, String>(0),
    ).ok().or_else(|| {
        let pattern2 = format!("{}.md", basename);
        conn.query_row(
            "SELECT path FROM notes WHERE path LIKE ?1 LIMIT 1",
            rusqlite::params![pattern2],
            |row| row.get::<_, String>(0),
        ).ok()
    })
}

fn build_eval_set(conn: &Connection, min_links: usize) -> Vec<EvalQuery> {
    let mut stmt = conn.prepare(
        "SELECT l.source_id, n.path, n.title, l.target_path
         FROM links l
         JOIN notes n ON n.id = l.source_id
         ORDER BY l.source_id"
    ).expect("failed to prepare eval query");

    let rows: Vec<(i64, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .expect("query failed")
        .filter_map(|r| r.ok())
        .collect();

    let mut grouped: HashMap<i64, (String, String, Vec<String>)> = HashMap::new();
    for (id, path, title, target) in rows {
        grouped.entry(id)
            .or_insert_with(|| (path, title, Vec::new()))
            .2.push(target);
    }

    let mut queries: Vec<EvalQuery> = Vec::new();
    for (id, (path, title, targets)) in grouped {
        let mut relevant = HashSet::new();
        for t in &targets {
            if let Some(resolved) = resolve_target(conn, t) {
                if resolved != path {
                    relevant.insert(resolved);
                }
            }
        }
        if relevant.len() >= min_links {
            let body: Option<String> = conn
                .query_row(
                    "SELECT body FROM notes_content WHERE id = ?1",
                    rusqlite::params![id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .ok()
                .flatten();
            let long_query = body.as_deref().and_then(derive_long_query);
            queries.push(EvalQuery { title, path, relevant, long_query });
        }
    }

    queries.sort_by(|a, b| a.path.cmp(&b.path));
    queries
}

fn eval_ranking(
    ctx: &SearchContext,
    conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    source_path: &str,
    prf_params: Option<&PrfParams>,
) -> Vec<String> {
    let all_embeddings = ctx.store.all();
    let signals = ctx.compute_signals_holdout(conn, query_vec, query_text, source_path);

    let mut rrf = ctx.rrf_from_signals(&signals, None);

    if let Some(params) = prf_params {
        let mut initial: Vec<(String, f64)> = rrf.iter().map(|(p, s)| (p.clone(), *s)).collect();
        initial.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        initial.truncate(30);
        let prf_results = rocchio_prf_with(query_vec, &initial, all_embeddings, params);
        add_ranked_rrf(&mut rrf, prf_results.iter().map(|(p, _)| p.as_str()));
    }

    finalize_rrf(rrf, 10).into_iter().map(|(p, _)| p).collect()
}

fn score_ranking(results: &[String], relevant: &HashSet<String>, source_path: &str) -> (f64, f64, f64, f64, f64) {
    let filtered: Vec<&String> = results.iter().filter(|p| *p != source_path).collect();

    let recall_5 = filtered.iter().take(5).filter(|p| relevant.contains(p.as_str())).count() as f64
        / relevant.len().max(1) as f64;
    let recall_10 = filtered.iter().take(10).filter(|p| relevant.contains(p.as_str())).count() as f64
        / relevant.len().max(1) as f64;

    let dcg_10: f64 = filtered.iter().take(10).enumerate()
        .map(|(i, p)| if relevant.contains(p.as_str()) {
            1.0 / ((i + 2) as f64).log2()
        } else {
            0.0
        })
        .sum();
    let idcg_10: f64 = (0..relevant.len().min(10))
        .map(|i| 1.0 / ((i + 2) as f64).log2())
        .sum();
    let ndcg_10 = if idcg_10 > 0.0 { dcg_10 / idcg_10 } else { 0.0 };

    let mrr = filtered.iter().enumerate()
        .find(|(_, p)| relevant.contains(p.as_str()))
        .map(|(i, _)| 1.0 / (i as f64 + 1.0))
        .unwrap_or(0.0);

    let hit_1 = if filtered.first().map(|p| relevant.contains(p.as_str())).unwrap_or(false) { 1.0 } else { 0.0 };

    (recall_5, recall_10, ndcg_10, mrr, hit_1)
}

pub fn eval_prf(conn: &Connection, _store: &EmbeddingStore, min_links: usize) -> EvalResult {
    let queries = build_eval_set(conn, min_links);
    let ctx = SearchContext::build(conn);

    eprintln!("Eval set: {} queries with {}+ resolved links", queries.len(), min_links);

    let param_grid = vec![
        ("no-prf", None),
        ("a=0.5 k=1", Some(PrfParams { alpha: 0.5, beta: 0.5, k: 1 })),
        ("a=0.5 k=3", Some(PrfParams { alpha: 0.5, beta: 0.5, k: 3 })),
        ("a=0.7 k=1", Some(PrfParams { alpha: 0.7, beta: 0.3, k: 1 })),
        ("a=0.7 k=3", Some(PrfParams { alpha: 0.7, beta: 0.3, k: 3 })),
        ("a=0.8 k=1", Some(PrfParams { alpha: 0.8, beta: 0.2, k: 1 })),
        ("a=0.8 k=3", Some(PrfParams { alpha: 0.8, beta: 0.2, k: 3 })),
        ("a=0.9 k=1", Some(PrfParams { alpha: 0.9, beta: 0.1, k: 1 })),
        ("a=0.9 k=3", Some(PrfParams { alpha: 0.9, beta: 0.1, k: 3 })),
        ("a=0.9 k=5", Some(PrfParams { alpha: 0.9, beta: 0.1, k: 5 })),
    ];

    let mut configs = Vec::new();

    for (label, params) in &param_grid {
        let mut total_r5 = 0.0;
        let mut total_r10 = 0.0;
        let mut total_ndcg = 0.0;
        let mut total_mrr = 0.0;
        let mut total_h1 = 0.0;
        let n = queries.len() as f64;

        for q in &queries {
            let qvec = embed_query(&q.title);
            let results = eval_ranking(&ctx, conn, &qvec, &q.title, &q.path, params.as_ref());
            let (r5, r10, ndcg, mrr, h1) = score_ranking(&results, &q.relevant, &q.path);
            total_r5 += r5;
            total_r10 += r10;
            total_ndcg += ndcg;
            total_mrr += mrr;
            total_h1 += h1;
        }

        configs.push(EvalConfig {
            label: label.to_string(),
            recall_at_5: total_r5 / n,
            recall_at_10: total_r10 / n,
            ndcg_at_10: total_ndcg / n,
            mrr: total_mrr / n,
            hits_at_1: total_h1 / n,
        });

        eprintln!("  {} done", label);
    }

    EvalResult {
        num_queries: queries.len(),
        min_links,
        configs,
    }
}

/// Run the funnel-ablation eval: each stage added cumulatively, scored on the
/// same wikilink-grounded query set as `eval_prf`. Produces a table showing
/// the marginal contribution of vec, BM25, PPR, tag-expand, PRF, and rerank.
///
/// Each cascade stage is scored on two query distributions: the note title
/// (`[title]` labels — short, precision-shaped queries) and a long
/// natural-language query derived from the note body (`[long]` labels —
/// matches the JIT injection path). The evaluated note is held out of the
/// PPR/tag seeds and its edges are masked (see
/// `SearchContext::compute_signals_holdout`), so the graph stages must find
/// relevant notes through second-order structure, not the gold edges.
pub fn eval_funnel(
    conn: &Connection,
    _store: &EmbeddingStore,
    min_links: usize,
    limit: Option<usize>,
) -> EvalResult {
    let mut queries = build_eval_set(conn, min_links);
    if let Some(cap) = limit {
        if queries.len() > cap {
            let stride = queries.len() / cap;
            queries = queries.into_iter().step_by(stride.max(1)).take(cap).collect();
        }
    }
    let ctx = SearchContext::build(conn);

    eprintln!("Funnel eval: {} queries with {}+ resolved links", queries.len(), min_links);

    let cascade: Vec<(&str, StageFlags)> = vec![
        ("vec",                  StageFlags { vec_search: true, bm25: false, ppr: false, tag_expand: false, prf: false, rerank: false }),
        ("vec+bm25",             StageFlags { vec_search: true, bm25: true,  ppr: false, tag_expand: false, prf: false, rerank: false }),
        ("vec+bm25+ppr",         StageFlags { vec_search: true, bm25: true,  ppr: true,  tag_expand: false, prf: false, rerank: false }),
        ("vec+bm25+ppr+tag",     StageFlags { vec_search: true, bm25: true,  ppr: true,  tag_expand: true,  prf: false, rerank: false }),
        ("+prf",                 StageFlags { vec_search: true, bm25: true,  ppr: true,  tag_expand: true,  prf: true,  rerank: false }),
        ("+rerank",              StageFlags { vec_search: true, bm25: true,  ppr: true,  tag_expand: true,  prf: true,  rerank: true  }),
    ];

    let n = queries.len() as f64;
    let no_peers: Vec<(String, Connection)> = Vec::new();
    let mut totals_title: Vec<[f64; 5]> = vec![[0.0; 5]; cascade.len()];
    let mut totals_long: Vec<[f64; 5]> = vec![[0.0; 5]; cascade.len()];
    let mut n_long = 0usize;

    for (qi, q) in queries.iter().enumerate() {
        let qvec = embed_query(&q.title);
        let signals = ctx.compute_signals_holdout(conn, &qvec, &q.title, &q.path);

        for (ci, (_, flags)) in cascade.iter().enumerate() {
            let results = funnel_with_signals(&ctx, conn, &no_peers, &signals, &qvec, &q.title, flags);
            let (r5, r10, ndcg, mrr, h1) = score_ranking(&results, &q.relevant, &q.path);
            let t = &mut totals_title[ci];
            t[0] += r5; t[1] += r10; t[2] += ndcg; t[3] += mrr; t[4] += h1;
        }

        if let Some(long_query) = &q.long_query {
            n_long += 1;
            let long_vec = embed_query(long_query);
            let long_signals = ctx.compute_signals_holdout(conn, &long_vec, long_query, &q.path);

            for (ci, (_, flags)) in cascade.iter().enumerate() {
                let results = funnel_with_signals(&ctx, conn, &no_peers, &long_signals, &long_vec, long_query, flags);
                let (r5, r10, ndcg, mrr, h1) = score_ranking(&results, &q.relevant, &q.path);
                let t = &mut totals_long[ci];
                t[0] += r5; t[1] += r10; t[2] += ndcg; t[3] += mrr; t[4] += h1;
            }
        }

        if (qi + 1) % 50 == 0 || qi + 1 == queries.len() {
            eprintln!("  {}/{} queries", qi + 1, queries.len());
        }
    }

    eprintln!("  {} of {} queries had a body-derived long query", n_long, queries.len());

    let mut configs: Vec<EvalConfig> = cascade.iter().enumerate().map(|(i, (label, _))| {
        let t = &totals_title[i];
        EvalConfig {
            label: format!("{label} [title]"),
            recall_at_5: t[0] / n,
            recall_at_10: t[1] / n,
            ndcg_at_10: t[2] / n,
            mrr: t[3] / n,
            hits_at_1: t[4] / n,
        }
    }).collect();

    if n_long > 0 {
        let nl = n_long as f64;
        configs.extend(cascade.iter().enumerate().map(|(i, (label, _))| {
            let t = &totals_long[i];
            EvalConfig {
                label: format!("{label} [long]"),
                recall_at_5: t[0] / nl,
                recall_at_10: t[1] / nl,
                ndcg_at_10: t[2] / nl,
                mrr: t[3] / nl,
                hits_at_1: t[4] / nl,
            }
        }));
    }

    EvalResult {
        num_queries: queries.len(),
        min_links,
        configs,
    }
}

fn funnel_with_signals(
    ctx: &SearchContext,
    conn: &Connection,
    peers: &[(String, Connection)],
    signals: &super::context::Signals,
    query_vec: &[f32],
    query_text: &str,
    flags: &StageFlags,
) -> Vec<String> {
    let all_embeddings = ctx.store.all();

    let mut rrf = ctx.rrf_from_signals_gated(signals, flags, None);

    if flags.prf {
        let mut initial: Vec<(String, f64)> = rrf.iter().map(|(p, s)| (p.clone(), *s)).collect();
        initial.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        initial.truncate(TOP_K_INITIAL);
        let prf_params = PrfParams { alpha: PRF_ALPHA, beta: PRF_BETA, k: PRF_K };
        let prf_results = rocchio_prf_with(query_vec, &initial, all_embeddings, &prf_params);
        add_ranked_rrf(&mut rrf, prf_results.iter().map(|(p, _)| p.as_str()));
    }

    let fused = finalize_rrf(rrf, 20);

    if flags.rerank {
        let paths: Vec<String> = fused.iter().map(|(p, _)| p.clone()).collect();
        let bodies = batch_load_bodies_federated(conn, peers, &paths);
        let docs: Vec<(String, String)> = fused
            .iter()
            .filter_map(|(p, _)| bodies.get(p).map(|b| (p.clone(), b.clone())))
            .collect();
        if docs.is_empty() {
            return fused.into_iter().take(10).map(|(p, _)| p).collect();
        }
        let report = rerank_with_report(query_text, &docs, 10);
        report.scored.into_iter().map(|r| r.path).collect()
    } else {
        fused.into_iter().take(10).map(|(p, _)| p).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_wikilinks_removes_targets() {
        assert_eq!(
            strip_wikilinks("see [[gold target]] and [[another]] for context"),
            "see  and  for context"
        );
        assert_eq!(strip_wikilinks("no links here"), "no links here");
        assert_eq!(strip_wikilinks("unclosed [[link"), "unclosed ");
    }

    #[test]
    fn test_derive_long_query_caps_tokens_and_excludes_link_titles() {
        let body = (0..100).map(|i| format!("word{i}")).collect::<Vec<_>>().join(" ");
        let q = derive_long_query(&body).expect("long body yields a query");
        assert_eq!(q.split_whitespace().count(), LONG_QUERY_TOKENS);

        let linked = "intro text mentioning [[secret gold note]] then more body words follow here today";
        let q = derive_long_query(linked).expect("enough tokens");
        assert!(!q.contains("secret"), "gold link titles must not leak into the query");
    }

    #[test]
    fn test_derive_long_query_rejects_short_bodies() {
        assert!(derive_long_query("too short").is_none());
        assert!(derive_long_query("").is_none());
        assert!(derive_long_query("[[only]] [[links]] [[here]]").is_none());
    }
}

/// Grid-search fusion weights against the wikilink eval set.
///
/// Signals do not depend on weights, so they are computed once per query and
/// every configuration is scored against the same cached signals: the sweep
/// costs one embedding pass, not one per configuration.
///
/// Queries are split train/holdout on an even/odd stride. The winner is chosen
/// on train and reported on holdout, because a grid search that picks and
/// reports on the same queries measures the search, not the weights.
pub fn tune_weights(
    conn: &Connection,
    _store: &EmbeddingStore,
    min_links: usize,
    limit: Option<usize>,
) -> Vec<(FusionWeights, f64, f64)> {
    let mut queries = build_eval_set(conn, min_links);
    if let Some(cap) = limit {
        if queries.len() > cap {
            let stride = queries.len() / cap;
            queries = queries.into_iter().step_by(stride.max(1)).take(cap).collect();
        }
    }
    let ctx = SearchContext::build(conn);
    eprintln!("Tuning on {} queries", queries.len());

    // Tune on TITLE queries, not the body-derived long ones.
    //
    // A long query is 40 tokens lifted verbatim from a note, and
    // `fts_bm25_query` runs AND-mode first and only falls back to OR when AND
    // returns nothing. Over 25+ terms AND matches exactly the note the text
    // came from — 1 result where OR would give 5929 — and `score_ranking`
    // filters that note out as the query's own source. The sparse lane
    // therefore contributes nothing on that distribution, and any sweep over
    // it is really measuring a vector-only pipeline: vec weights 0.2, 1.0 and
    // 3.0 all scored identically to four decimals, while vec 0.0 collapsed to
    // 0.1055.
    struct Cached {
        signals: super::context::Signals,
        relevant: HashSet<String>,
        path: String,
    }
    let mut cached: Vec<Cached> = Vec::new();
    for (i, q) in queries.iter().enumerate() {
        let text = q.title.as_str();
        let qvec = embed_query(text);
        cached.push(Cached {
            signals: ctx.compute_signals_holdout(conn, &qvec, text, &q.path),
            relevant: q.relevant.clone(),
            path: q.path.clone(),
        });
        if (i + 1) % 50 == 0 {
            eprintln!("  signals {}/{}", i + 1, queries.len());
        }
    }

    let flags = StageFlags::default();
    // PRF is applied in `local_rrf_scores`, downstream of the fusion this
    // sweep exercises, so varying it here changes nothing. Sweeping it anyway
    // would print a column of identical numbers and imply the harness had
    // tested it. Tune PRF with `tune-prf`, which does drive that stage.
    // Only the ratio between lanes matters, so bm25 is pinned at 1.0 and the
    // others move against it.
    let grid_vec = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0];
    let grid_ppr = [0.0, 0.05, 0.1, 0.25];
    let grid_tag = [0.0, 0.05, 0.1, 0.25];

    let score_on = |w: &FusionWeights, idxs: &[usize]| -> f64 {
        let mut total = 0.0;
        for &i in idxs {
            let c = &cached[i];
            let rrf = ctx.rrf_from_signals_weighted(&c.signals, &flags, w, None);
            let ranked: Vec<String> =
                finalize_rrf(rrf, 10).into_iter().map(|(p, _)| p).collect();
            let (_, _, ndcg, _, _) = score_ranking(&ranked, &c.relevant, &c.path);
            total += ndcg;
        }
        total / idxs.len().max(1) as f64
    };

    let train: Vec<usize> = (0..cached.len()).filter(|i| i % 2 == 0).collect();
    let holdout: Vec<usize> = (0..cached.len()).filter(|i| i % 2 == 1).collect();

    let mut results: Vec<(FusionWeights, f64, f64)> = Vec::new();
    for &v in &grid_vec {
        for &ppr in &grid_ppr {
            for &tag in &grid_tag {
                let w = FusionWeights {
                    vec: v,
                    bm25: 1.0,
                    ppr,
                    tag,
                    prf: FusionWeights::default().prf,
                };
                results.push((w, score_on(&w, &train), score_on(&w, &holdout)));
            }
        }
    }
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results
}

/// Per-lane, per-query statistics for the two query distributions that differ
/// only in whether the dense lane has seen the text.
///
/// Query-adaptive weighting is only buildable if some statistic observable at
/// query time separates a lane that found the answer from one that is guessing.
/// This reports the candidates — top score, gap to rank 2, spread across the
/// top 10 — alongside where the gold note actually landed in each lane, so the
/// question can be settled before any weighting rule is written.
#[derive(Debug, Serialize)]
pub struct LaneStat {
    pub set: String,
    pub vec_top: f64,
    pub vec_gap: f64,
    pub vec_spread: f64,
    pub vec_gold_rank: i64,
    pub bm25_top: f64,
    pub bm25_gap: f64,
    pub bm25_gold_rank: i64,
}

fn top_gap_spread(scores: &[f64]) -> (f64, f64, f64) {
    // Lists arrive best-first; magnitudes let the BM25 convention (negative,
    // more negative is better) and cosine share one code path.
    if scores.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let top = scores[0].abs();
    let gap = if scores.len() > 1 { (scores[0] - scores[1]).abs() } else { 0.0 };
    let last = scores[scores.len() - 1].abs();
    (top, gap, (top - last).abs())
}

pub fn lane_diagnostics(conn: &Connection, probes: &[(String, String, String)]) -> Vec<LaneStat> {
    let ctx = SearchContext::build(conn);
    let mut out = Vec::new();
    for (set, gold_path, text) in probes {
        if text.trim().is_empty() {
            continue;
        }
        let qvec = embed_query(text);
        let sig = ctx.compute_signals(conn, &qvec, text);

        let vec_scores: Vec<f64> = sig.vec_scored.iter().map(|(_, s)| *s).take(10).collect();
        let bm_scores: Vec<f64> = sig.fts_results.iter().map(|(_, _, s)| *s).take(10).collect();
        let (vt, vg, vsp) = top_gap_spread(&vec_scores);
        let (bt, bg, _) = top_gap_spread(&bm_scores);

        out.push(LaneStat {
            set: set.clone(),
            vec_top: vt,
            vec_gap: vg,
            vec_spread: vsp,
            vec_gold_rank: sig
                .vec_scored
                .iter()
                .position(|(p, _)| p == gold_path)
                .map(|r| r as i64)
                .unwrap_or(-1),
            bm25_top: bt,
            bm25_gap: bg,
            bm25_gold_rank: sig
                .fts_results
                .iter()
                .position(|(_, p, _)| p == gold_path)
                .map(|r| r as i64)
                .unwrap_or(-1),
        });
    }
    out
}
