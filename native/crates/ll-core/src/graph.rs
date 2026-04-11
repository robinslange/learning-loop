use std::collections::{HashMap, HashSet};

pub type GraphEdges = HashMap<String, Vec<String>>;

pub fn personalized_pagerank(
    graph: &GraphEdges,
    seeds: &[String],
    damping: f32,
    iterations: usize,
) -> Vec<(String, f64)> {
    if seeds.is_empty() || graph.is_empty() {
        return Vec::new();
    }

    let mut inlink_counts: HashMap<&str, usize> = HashMap::new();
    for targets in graph.values() {
        for t in targets {
            *inlink_counts.entry(t.as_str()).or_default() += 1;
        }
    }

    let mut seed_weights: Vec<(&str, f64)> = seeds
        .iter()
        .filter(|s| graph.contains_key(s.as_str()))
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
        .filter(|(path, score)| *score > 1e-6 && !seed_set.contains(path.as_str()))
        .collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(30);
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
