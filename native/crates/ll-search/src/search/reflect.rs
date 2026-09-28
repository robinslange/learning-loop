use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;

use crate::db::load_all_embeddings;
use crate::embed::embed_query;
use crate::rerank::RerankReport;

use super::scoring::{dot_product, finalize_rrf};
use super::query::{SearchResult, load_titles_map};
use super::federation::{add_peer_rrf_scores_guarded, batch_load_bodies_federated};
use super::cluster::discriminate_pairs;
use super::context::SearchContext;

#[derive(Serialize)]
pub struct ReflectQueryResult {
    pub query: String,
    pub top_match_similarity: f64,
    pub results: Vec<SearchResult>,
}

#[derive(Serialize)]
pub struct ReflectScanResult {
    pub queries: Vec<ReflectQueryResult>,
    pub confusable_pairs: Vec<super::cluster::DiscriminatePair>,
}

/// Rerank each query's fused candidates, report how close its best match is,
/// then find the confusable pairs among the local results. `peers` may be
/// empty, and then this is the local scan.
pub fn reflect_scan(
    ctx: &SearchContext,
    conn: &Connection,
    peers: &[(String, Connection)],
    queries: &[String],
    top_n: usize,
    candidates_n: usize,
    discriminate_threshold: f32,
) -> anyhow::Result<ReflectScanResult> {
    let embedded = queries
        .iter()
        .map(|q| Ok((q.clone(), embed_query(q)?)))
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(reflect_scan_inner(
        ctx,
        conn,
        peers,
        &embedded,
        top_n,
        candidates_n,
        discriminate_threshold,
        crate::rerank::rerank_with_report,
    ))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn reflect_scan_inner(
    ctx: &SearchContext,
    conn: &Connection,
    peers: &[(String, Connection)],
    queries: &[(String, Vec<f32>)],
    top_n: usize,
    candidates_n: usize,
    discriminate_threshold: f32,
    rerank: impl Fn(&str, &[(String, String)], usize) -> RerankReport,
) -> ReflectScanResult {
    // Each peer's embeddings and titles, read once for every query.
    let peer_embeddings: Vec<Vec<(i64, String, Vec<f32>)>> =
        peers.iter().map(|(_, pc)| load_all_embeddings(pc)).collect();
    let mut peer_titles: HashMap<String, Option<String>> = HashMap::new();
    for (pid, pc) in peers {
        for (path, title) in load_titles_map(pc) {
            peer_titles.insert(format!("peer:{pid}/{path}"), title);
        }
    }

    let title_for = |p: &str| -> Option<String> {
        if p.starts_with("peer:") {
            peer_titles.get(p).cloned().flatten()
        } else {
            ctx.titles.get(p).cloned().flatten().map(|a| a.to_string())
        }
    };
    let embedding_for = |p: &str| -> Option<&[f32]> {
        let (embeddings, path) = match p.strip_prefix("peer:") {
            Some(rest) => {
                let (pid, actual) = rest.split_once('/')?;
                let i = peers.iter().position(|(id, _)| id == pid)?;
                (peer_embeddings[i].as_slice(), actual)
            }
            None => (ctx.store.all(), p),
        };
        embeddings.iter().find(|(_, q, _)| q == path).map(|(_, _, e)| e.as_slice())
    };

    let mut all_candidate_paths: Vec<String> = Vec::new();
    let mut per_query: Vec<(&str, &[f32], Vec<SearchResult>)> = Vec::new();

    for (query_text, query_vec) in queries {
        let mut rrf = ctx.local_rrf_scores(conn, query_vec, query_text);
        for ((peer_id, peer_conn), embs) in peers.iter().zip(&peer_embeddings) {
            add_peer_rrf_scores_guarded(&mut rrf, peer_id, peer_conn, query_vec, query_text, embs);
        }

        let candidate_results: Vec<SearchResult> = finalize_rrf(rrf, candidates_n)
            .into_iter()
            .map(|(path, score)| SearchResult {
                title: title_for(&path),
                mtime: None,
                path,
                score,
            })
            .collect();

        for r in &candidate_results {
            all_candidate_paths.push(r.path.clone());
        }

        per_query.push((query_text, query_vec, candidate_results));
    }

    all_candidate_paths.sort();
    all_candidate_paths.dedup();
    let bodies = batch_load_bodies_federated(conn, peers, &all_candidate_paths);

    let mut local_result_paths: Vec<String> = Vec::new();
    let mut query_results: Vec<ReflectQueryResult> = Vec::new();

    for (query_text, query_vec, candidate_results) in &per_query {
        let docs: Vec<(String, String)> = candidate_results
            .iter()
            .filter_map(|r| {
                let body = bodies.get(&r.path)?;
                Some((r.path.clone(), body.clone()))
            })
            .collect();

        let report = rerank(query_text, &docs, top_n);
        if !report.failed.is_empty() {
            eprintln!(
                "rerank (reflect_scan): {} of {} documents failed to score (first: path={} reason={})",
                report.failed.len(),
                report.failed.len() + report.scored.len(),
                report.failed[0].path,
                report.failed[0].reason,
            );
        }

        let results: Vec<SearchResult> = report
            .scored
            .iter()
            .map(|r| SearchResult {
                path: r.path.clone(),
                score: r.score,
                title: title_for(&r.path),
                mtime: None,
            })
            .collect();

        let top_sim = results
            .first()
            .and_then(|best| embedding_for(&best.path))
            .map(|emb| dot_product(query_vec, emb) as f64)
            .unwrap_or(0.0);

        local_result_paths.extend(
            results.iter().filter(|r| !r.path.starts_with("peer:")).map(|r| r.path.clone()),
        );

        query_results.push(ReflectQueryResult {
            query: query_text.to_string(),
            top_match_similarity: top_sim,
            results,
        });
    }

    local_result_paths.sort();
    local_result_paths.dedup();
    // An empty list means "the whole vault" to discriminate_pairs.
    let confusable_pairs = if local_result_paths.is_empty() {
        Vec::new()
    } else {
        discriminate_pairs(conn, &local_result_paths, discriminate_threshold, &ctx.store)
    };

    ReflectScanResult {
        queries: query_results,
        confusable_pairs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_helpers::helpers::*;
    use crate::rerank::RerankResult;

    const THRESHOLD: f32 = 0.85;

    /// A cross-encoder that likes a document exactly when it contains the query.
    fn contains_query(query: &str, docs: &[(String, String)], top_n: usize) -> RerankReport {
        let mut scored: Vec<RerankResult> = docs
            .iter()
            .enumerate()
            .map(|(index, (path, body))| RerankResult {
                index,
                score: if body.contains(query) { 1.0 } else { 0.0 },
                path: path.clone(),
            })
            .collect();
        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        scored.truncate(top_n);
        RerankReport { scored, failed: Vec::new() }
    }

    /// a/b are near-duplicates about sleep; d/e are near-duplicates about
    /// something else, so only a/b should ever come back as a confusable pair.
    fn local_vault() -> Connection {
        create_test_db(&[
            ("a.md", "sleep stages", "sleep stages", &norm(&[1.0, 0.0, 0.0])),
            ("b.md", "sleep cycles", "sleep cycles", &norm(&[0.99, 0.1, 0.0])),
            ("d.md", "protein", "protein", &norm(&[0.0, 1.0, 0.0])),
            ("e.md", "protein intake", "protein intake", &norm(&[0.0, 0.99, 0.1])),
        ])
    }

    fn query() -> Vec<(String, Vec<f32>)> {
        vec![("sleep".to_string(), norm(&[1.0, 0.0, 0.0]))]
    }

    fn pairs(result: &ReflectScanResult) -> Vec<(&str, &str)> {
        result
            .confusable_pairs
            .iter()
            .map(|p| (p.note_a.as_str(), p.note_b.as_str()))
            .collect()
    }

    #[test]
    fn a_local_scan_reranks_the_candidates_and_pairs_its_results() {
        let conn = local_vault();
        let ctx = SearchContext::build(&conn);

        let result = reflect_scan_inner(&ctx, &conn, &[], &query(), 2, 10, THRESHOLD, contains_query);

        let scan = &result.queries[0];
        let mut paths: Vec<&str> = scan.results.iter().map(|r| r.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, ["a.md", "b.md"]);
        for r in &scan.results {
            assert_eq!(r.title.as_deref(), Some(if r.path == "a.md" { "sleep stages" } else { "sleep cycles" }));
            assert_eq!(r.mtime, None);
        }
        let best = ctx.store.get_arc_by_path(&scan.results[0].path).unwrap();
        assert_eq!(scan.top_match_similarity, dot_product(&query()[0].1, &best) as f64);
        assert_eq!(pairs(&result), [("a.md", "b.md")]);
    }

    #[test]
    fn a_peer_result_is_reranked_but_never_paired() {
        let conn = local_vault();
        let ctx = SearchContext::build(&conn);
        let peer = create_peer_db(&[("c.md", "sleep and light", "sleep and light", &norm(&[0.98, 0.2, 0.0]))]);
        let peers = vec![("alice".to_string(), peer)];

        let result = reflect_scan_inner(&ctx, &conn, &peers, &query(), 3, 10, THRESHOLD, contains_query);

        let scan = &result.queries[0];
        let mut paths: Vec<&str> = scan.results.iter().map(|r| r.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, ["a.md", "b.md", "peer:alice/c.md"]);
        let peer_result = scan.results.iter().find(|r| r.path == "peer:alice/c.md").unwrap();
        assert_eq!(peer_result.title.as_deref(), Some("sleep and light"));
        assert_eq!(pairs(&result), [("a.md", "b.md")]);
    }

    /// `discriminate_pairs` reads an empty path list as "the whole vault". A
    /// scan with no local result has nothing to pair, and must not hand back
    /// every near-duplicate in the vault as though the queries had found them.
    #[test]
    fn a_scan_with_no_local_result_pairs_nothing() {
        let conn = local_vault();
        let ctx = SearchContext::build(&conn);
        let peer = create_peer_db(&[("c.md", "sleep and light", "sleep and light", &norm(&[0.98, 0.2, 0.0]))]);
        let peers = vec![("alice".to_string(), peer)];
        let light = vec![("light".to_string(), norm(&[1.0, 0.0, 0.0]))];

        let result = reflect_scan_inner(&ctx, &conn, &peers, &light, 1, 10, THRESHOLD, contains_query);

        let paths: Vec<&str> = result.queries[0].results.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["peer:alice/c.md"], "precondition: the only result is the peer's");
        assert_eq!(pairs(&result), Vec::<(&str, &str)>::new());
    }
}
