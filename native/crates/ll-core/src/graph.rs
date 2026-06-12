//! Personalized PageRank over a wikilink graph.
//!
//! The graph is represented as an adjacency map where each key is a note path
//! and each value is the list of paths that note links to (outgoing edges).

use std::collections::{HashMap, HashSet};

/// Directed adjacency map for the note wikilink graph.
///
/// Keys are note paths (e.g. `"brain/0-inbox/my-note.md"`). Values are lists
/// of paths that the key note links to (outgoing edges). Paths not present as
/// keys are sink nodes with no outgoing edges.
pub type GraphEdges = HashMap<String, Vec<String>>;

/// Rank notes reachable from `seeds` using personalized PageRank.
///
/// Seeds are the starting set (e.g. vector + FTS top results). The algorithm
/// runs `iterations` power-iteration steps with damping factor `damping`.
/// Seed nodes are excluded from the output -- only related notes are returned.
///
/// Returns at most [`crate::TOP_K`] results as `(path, score)` pairs sorted
/// by descending score. Returns an empty vec if `seeds` or `graph` is empty.
pub fn personalized_pagerank(
    graph: &GraphEdges,
    seeds: &[String],
    damping: f32,
    iterations: usize,
) -> Vec<(String, f64)> {
    personalized_pagerank_holdout(graph, seeds, damping, iterations, None)
}

/// [`personalized_pagerank`] with a held-out node (eval-only).
///
/// When `holdout` is `Some(path)`, that node's adjacency list is skipped
/// during the walk — equivalent to removing the node's edges from the graph
/// without cloning it — and the node is filtered from the output. Inbound
/// edges may still feed score into the held-out node, but it acts as a sink:
/// it never propagates and is never returned.
pub fn personalized_pagerank_holdout(
    graph: &GraphEdges,
    seeds: &[String],
    damping: f32,
    iterations: usize,
    holdout: Option<&str>,
) -> Vec<(String, f64)> {
    if seeds.is_empty() || graph.is_empty() {
        return Vec::new();
    }

    let masked = |node: &str| holdout == Some(node);

    let mut inlink_counts: HashMap<&str, usize> = HashMap::new();
    for (node, targets) in graph {
        if masked(node) {
            continue;
        }
        for t in targets {
            *inlink_counts.entry(t.as_str()).or_default() += 1;
        }
    }

    let mut seed_weights: Vec<(&str, f64)> = seeds
        .iter()
        .filter(|s| graph.contains_key(s.as_str()) && !masked(s.as_str()))
        .map(|s| {
            let inlinks = inlink_counts.get(s.as_str()).copied().unwrap_or(0);
            (s.as_str(), 1.0 / (inlinks as f64 + 1.0))
        })
        .collect();

    let total_weight: f64 = seed_weights.iter().map(|(_, w)| w).sum();
    if total_weight == 0.0 {
        return Vec::new();
    }
    for (_, w) in &mut seed_weights {
        *w /= total_weight;
    }

    let d = damping as f64;
    let mut scores: HashMap<String, f64> = HashMap::new();
    let seed_set: HashSet<&str> = seeds.iter().map(|s| s.as_str()).collect();

    for &(s, w) in &seed_weights {
        scores.insert(s.to_string(), w);
    }

    for _ in 0..iterations {
        let mut new_scores: HashMap<String, f64> = HashMap::new();

        for &(s, w) in &seed_weights {
            *new_scores.entry(s.to_string()).or_default() += (1.0 - d) * w;
        }

        for (node, score) in &scores {
            if masked(node) {
                continue;
            }
            if let Some(neighbors) = graph.get(node) {
                let share = d * score / neighbors.len() as f64;
                for neighbor in neighbors {
                    *new_scores.entry(neighbor.clone()).or_default() += share;
                }
            }
        }

        scores = new_scores;
    }

    let mut results: Vec<(String, f64)> = scores
        .into_iter()
        .filter(|(path, score)| {
            *score > 1e-6 && !seed_set.contains(path.as_str()) && !masked(path)
        })
        .collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(crate::config::TOP_K);
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ppr_empty_graph() {
        let graph: GraphEdges = HashMap::new();
        let results = personalized_pagerank(&graph, &["a.md".to_string()], 0.5, 20);
        assert!(results.is_empty());
    }

    #[test]
    fn test_ppr_empty_seeds() {
        let mut graph: GraphEdges = HashMap::new();
        graph.insert("a".into(), vec!["b".into()]);
        graph.insert("b".into(), vec!["a".into()]);
        let results = personalized_pagerank(&graph, &[], 0.5, 20);
        assert!(results.is_empty());
    }

    #[test]
    fn test_ppr_holdout_masks_edges_and_filters_node() {
        // Undirected: a <-> s, s <-> g, a <-> x. Holding out s must (1) stop
        // the walk reaching g through s's edges, (2) keep s itself out of the
        // output even though the a -> s edge still feeds it score, and
        // (3) leave second-order reachability (a -> x) intact.
        let mut graph: GraphEdges = HashMap::new();
        graph.insert("a".into(), vec!["s".into(), "x".into()]);
        graph.insert("s".into(), vec!["a".into(), "g".into()]);
        graph.insert("g".into(), vec!["s".into()]);
        graph.insert("x".into(), vec!["a".into()]);

        let seeds = vec!["a".to_string()];
        let unmasked = personalized_pagerank(&graph, &seeds, 0.5, 20);
        let unmasked_paths: Vec<&str> = unmasked.iter().map(|r| r.0.as_str()).collect();
        assert!(unmasked_paths.contains(&"s") && unmasked_paths.contains(&"g"));

        let held = personalized_pagerank_holdout(&graph, &seeds, 0.5, 20, Some("s"));
        let held_paths: Vec<&str> = held.iter().map(|r| r.0.as_str()).collect();
        assert!(!held_paths.contains(&"s"), "held-out node must not be returned: {held_paths:?}");
        assert!(!held_paths.contains(&"g"), "held-out node's edges must not propagate: {held_paths:?}");
        assert!(held_paths.contains(&"x"), "unrelated structure must survive the holdout: {held_paths:?}");
    }

    #[test]
    fn test_ppr_chain() {
        let mut graph: GraphEdges = HashMap::new();
        graph.insert("a".into(), vec!["b".into()]);
        graph.insert("b".into(), vec!["a".into(), "c".into()]);
        graph.insert("c".into(), vec!["b".into(), "d".into()]);
        graph.insert("d".into(), vec!["c".into()]);

        let results = personalized_pagerank(&graph, &["a".into()], 0.5, 20);
        assert!(!results.is_empty());
        let paths: Vec<&str> = results.iter().map(|r| r.0.as_str()).collect();
        assert!(paths.contains(&"b"));
        assert!(results[0].1 >= results.last().unwrap().1);
    }
}
