use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

pub(crate) use ll_core::graph::{personalized_pagerank, personalized_pagerank_holdout};

pub(crate) fn load_link_graph(conn: &Connection) -> HashMap<String, Vec<String>> {
    let mut basename_to_path: HashMap<String, String> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT path FROM notes") {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            for path in rows.flatten() {
                let basename = crate::preprocess::wikilink_name(&path);
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
