use rusqlite::Connection;

pub use ll_core::rerank::{rerank, rerank_with_report, RerankFailure, RerankReport, RerankResult};

use crate::search::{batch_load_bodies_federated, hybrid_query_with_ctx, SearchContext, TemporalParams};

/// Run the rerank pipeline: hybrid query for `candidates`, batch-load bodies
/// across peers, score with the cross-encoder, return the top `top` scored
/// results. A document that fails to score is logged to stderr and skipped; a
/// query that cannot be embedded is an error.
pub fn run(
    ctx: &SearchContext,
    conn: &Connection,
    peers: &[(String, Connection)],
    query: &str,
    top: usize,
    candidates: usize,
) -> anyhow::Result<Vec<RerankResult>> {
    let candidate_results =
        hybrid_query_with_ctx(ctx, conn, query, candidates, peers, &TemporalParams::default())?;
    if candidate_results.is_empty() {
        return Ok(Vec::new());
    }
    let paths: Vec<String> = candidate_results.iter().map(|r| r.path.clone()).collect();
    let bodies = batch_load_bodies_federated(conn, peers, &paths);
    let docs: Vec<(String, String)> = candidate_results
        .iter()
        .filter_map(|r| {
            let body = bodies.get(&r.path)?;
            Some((r.path.clone(), body.clone()))
        })
        .collect();
    let report = rerank_with_report(query, &docs, top);
    if !report.failed.is_empty() {
        eprintln!(
            "rerank (run): {} of {} documents failed to score (first: path={} reason={})",
            report.failed.len(),
            report.failed.len() + report.scored.len(),
            report.failed[0].path,
            report.failed[0].reason,
        );
    }
    Ok(report.scored)
}
