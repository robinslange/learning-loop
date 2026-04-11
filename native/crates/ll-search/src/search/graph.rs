use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

pub(crate) use ll_core::graph::personalized_pagerank;

pub(crate) fn load_link_graph(conn: &Connection) -> HashMap<String, Vec<String>> {
    let mut basename_to_path: HashMap<String, String> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT path FROM notes") {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            for path in rows.flatten() {
                let basename = path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&path)
                    .strip_suffix(".md")
                    .unwrap_or(&path)
                    .to_lowercase();
                basename_to_path.entry(basename).or_insert(path);
            }
        }
    }

    let mut edges: HashMap<String, HashSet<String>> = HashMap::new();
    let mut stmt = match conn.prepare(
        "SELECT n.path, l.target_path FROM links l JOIN notes n ON l.source_id = n.id",
    ) {
        Ok(s) => s,
        Err(_) => return HashMap::new(),
    };

    let rows = match stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) {
        Ok(r) => r,
        Err(_) => return HashMap::new(),
    };

    for row in rows.flatten() {
        let (source_path, target_basename) = row;
        if let Some(target_path) = basename_to_path.get(&target_basename) {
            if source_path != *target_path {
                edges.entry(source_path.clone()).or_default().insert(target_path.clone());
                edges.entry(target_path.clone()).or_default().insert(source_path.clone());
            }
        }
    }

    edges.into_iter().map(|(k, v)| (k, v.into_iter().collect())).collect()
}

pub(crate) fn tag_expand(conn: &Connection, seed_paths: &[String]) -> Vec<(String, f64)> {
    let tags_map = load_tags_map(conn);
    let total_notes = tags_map.len() as f64;
    if total_notes == 0.0 {
        return Vec::new();
    }
    let seed_set: HashSet<&str> = seed_paths.iter().map(|s| s.as_str()).collect();

    let mut seed_tags: HashSet<String> = HashSet::new();
    for path in seed_paths {
        if let Some(tags) = tags_map.get(path) {
            for tag in tags {
                seed_tags.insert(tag.clone());
            }
        }
    }

    let mut tag_freq: HashMap<&str, usize> = HashMap::new();
    for tags in tags_map.values() {
        for tag in tags {
            *tag_freq.entry(tag.as_str()).or_default() += 1;
        }
    }

    let qualifying: HashSet<&str> = seed_tags
        .iter()
        .filter_map(|t| {
            let freq = *tag_freq.get(t.as_str()).unwrap_or(&0);
            if (2..=20).contains(&freq) {
                Some(t.as_str())
            } else {
                None
            }
        })
        .collect();

    if qualifying.is_empty() {
        return Vec::new();
    }

    let mut candidate_scores: HashMap<&str, f64> = HashMap::new();
    for (path, tags) in &tags_map {
        if seed_set.contains(path.as_str()) {
            continue;
        }
        let score: f64 = tags
            .iter()
            .filter(|t| qualifying.contains(t.as_str()))
            .map(|t| {
                let freq = *tag_freq.get(t.as_str()).unwrap_or(&1) as f64;
                (total_notes / freq).ln()
            })
            .sum();
        if score > 0.0 {
            candidate_scores.insert(path.as_str(), score);
        }
    }

    let mut results: Vec<(String, f64)> = candidate_scores
        .into_iter()
        .map(|(path, score)| (path.to_string(), score))
        .collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(30);
    results
}

pub(crate) fn load_tags_map(conn: &Connection) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT path, tags FROM notes") {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        }) {
            for row in rows.flatten() {
                let tags = row
                    .1
                    .unwrap_or_default()
                    .split_whitespace()
                    .map(String::from)
                    .collect();
                map.insert(row.0, tags);
            }
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_helpers::helpers::*;
    use rusqlite::params;

    #[test]
    fn test_ppr_single_seed_chain() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_graph_db(
            &[
                ("a.md", "a", "content a", &emb),
                ("b.md", "b", "content b", &emb),
                ("c.md", "c", "content c", &emb),
                ("d.md", "d", "content d", &emb),
            ],
            &[("a.md", "b"), ("b.md", "c"), ("c.md", "d")],
        );

        let graph = load_link_graph(&conn);
        assert!(!graph.is_empty());

        let results = personalized_pagerank(&graph, &["a.md".to_string()], 0.5, 20);
        assert!(!results.is_empty());
        let paths: Vec<&str> = results.iter().map(|r| r.0.as_str()).collect();
        assert!(paths.contains(&"b.md"));
        if results.len() >= 2 {
            assert!(results[0].1 >= results[1].1);
        }
    }

    #[test]
    fn test_ppr_bridge_node() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_graph_db(
            &[
                ("a.md", "a", "content", &emb),
                ("b.md", "b", "content", &emb),
                ("bridge.md", "bridge", "content", &emb),
                ("c.md", "c", "content", &emb),
                ("d.md", "d", "content", &emb),
            ],
            &[
                ("a.md", "b"), ("b.md", "bridge"),
                ("bridge.md", "c"), ("c.md", "d"),
            ],
        );

        let graph = load_link_graph(&conn);
        let results = personalized_pagerank(
            &graph,
            &["a.md".to_string(), "d.md".to_string()],
            0.5,
            20,
        );

        let bridge_score = results.iter().find(|(p, _)| p == "bridge.md").map(|(_, s)| *s);
        assert!(bridge_score.is_some(), "bridge node should appear in results");
    }

    #[test]
    fn test_ppr_empty_graph() {
        let graph: HashMap<String, Vec<String>> = HashMap::new();
        let results = personalized_pagerank(&graph, &["a.md".to_string()], 0.5, 20);
        assert!(results.is_empty());
    }

    #[test]
    fn test_tag_expand_idf_filtering() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_test_db(&[
            ("a.md", "a", "content", &emb),
            ("b.md", "b", "content", &emb),
            ("c.md", "c", "content", &emb),
        ]);
        conn.execute("UPDATE notes SET tags = 'rare' WHERE path = 'a.md'", []).unwrap();
        conn.execute("UPDATE notes SET tags = 'rare' WHERE path = 'b.md'", []).unwrap();
        conn.execute("UPDATE notes SET tags = 'common' WHERE path = 'c.md'", []).unwrap();

        let results = tag_expand(&conn, &["a.md".to_string()]);
        let paths: Vec<&str> = results.iter().map(|r| r.0.as_str()).collect();
        assert!(paths.contains(&"b.md"));
        assert!(!paths.contains(&"c.md"));
        assert!(!paths.contains(&"a.md"));
    }

    #[test]
    fn test_tag_expand_excludes_high_freq() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let mut notes: Vec<(&str, &str, &str, &[f32])> = Vec::new();
        let paths: Vec<String> = (0..25).map(|i| format!("note{i}.md")).collect();
        let titles: Vec<String> = (0..25).map(|i| format!("note{i}")).collect();
        for i in 0..25 {
            notes.push((&paths[i], &titles[i], "content", &emb));
        }
        let conn = create_test_db(&notes);
        for i in 0..25 {
            conn.execute(
                "UPDATE notes SET tags = 'popular' WHERE path = ?1",
                params![paths[i]],
            ).unwrap();
        }

        let results = tag_expand(&conn, &["note0.md".to_string()]);
        assert!(results.is_empty());
    }

    #[test]
    fn test_load_link_graph_undirected() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_graph_db(
            &[("a.md", "a", "content", &emb), ("b.md", "b", "content", &emb)],
            &[("a.md", "b")],
        );
        let graph = load_link_graph(&conn);
        assert!(graph.get("a.md").unwrap().contains(&"b.md".to_string()));
        assert!(graph.get("b.md").unwrap().contains(&"a.md".to_string()));
    }

    #[test]
    fn test_load_link_graph_no_table() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let graph = load_link_graph(&conn);
        assert!(graph.is_empty());
    }
}
