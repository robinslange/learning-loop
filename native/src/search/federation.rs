use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags};

use super::scoring::{add_ranked_rrf, cosine, fts_bm25_query};

pub fn discover_peer_dbs(config_dir: &Path, local_model_id: &str) -> Vec<(String, Connection)> {
    let peers_dir = config_dir.join("federation").join("data").join("peers");
    let entries = match std::fs::read_dir(&peers_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut peers = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let peer_id = entry.file_name().to_string_lossy().to_string();
        let db_path = entry.path().join("index.db");
        if !db_path.exists() {
            continue;
        }

        let conn = match Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let model_id: String = match conn.query_row(
            "SELECT value FROM meta WHERE key = 'model_id'",
            [],
            |r| r.get(0),
        ) {
            Ok(id) => id,
            Err(_) => continue,
        };

        if model_id != local_model_id {
            eprintln!("Peer {peer_id}: model mismatch ({model_id} vs {local_model_id}), BM25 fallback");
        }

        peers.push((peer_id, conn));
    }

    peers
}

pub(crate) fn add_peer_rrf_scores(
    rrf_scores: &mut HashMap<String, f64>,
    peer_id: &str,
    peer_conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    peer_embeddings: &[(i64, String, Vec<f32>)],
) {
    let mut peer_vec: Vec<(String, f64)> = peer_embeddings
        .iter()
        .map(|(_, path, emb)| {
            (format!("peer:{peer_id}/{path}"), cosine(query_vec, emb) as f64)
        })
        .collect();
    peer_vec.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    peer_vec.truncate(30);
    add_ranked_rrf(rrf_scores, peer_vec.iter().map(|(p, _)| p.as_str()));

    let peer_fts = fts_bm25_query(peer_conn, query_text, 30);
    add_ranked_rrf(
        rrf_scores,
        peer_fts.iter().map(|(_, path, _)| format!("peer:{peer_id}/{path}")).collect::<Vec<_>>().iter().map(|s| s.as_str()),
    );
}

pub(crate) fn load_title(conn: &Connection, path: &str) -> Option<String> {
    conn.query_row(
        "SELECT title FROM notes WHERE path = ?1",
        params![path],
        |r| r.get(0),
    )
    .ok()
    .flatten()
}

pub(crate) fn load_title_federated(
    path: &str,
    conn: &Connection,
    peers: &[(String, Connection)],
) -> Option<String> {
    if let Some(rest) = path.strip_prefix("peer:") {
        let slash = rest.find('/')?;
        let pid = &rest[..slash];
        let actual = &rest[slash + 1..];
        let (_, pc) = peers.iter().find(|(id, _)| id == pid)?;
        load_title(pc, actual)
    } else {
        load_title(conn, path)
    }
}

pub(crate) fn batch_load_bodies(conn: &Connection, paths: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for path in paths {
        if let Ok(body) = conn.query_row(
            "SELECT nc.body FROM notes_content nc JOIN notes n ON nc.id = n.id WHERE n.path = ?1",
            params![path],
            |row| row.get::<_, String>(0),
        ) {
            map.insert(path.clone(), body);
        }
    }
    map
}

pub fn batch_load_bodies_federated(
    conn: &Connection,
    peers: &[(String, Connection)],
    paths: &[String],
) -> HashMap<String, String> {
    let mut local_paths = Vec::new();
    let mut peer_groups: HashMap<&str, Vec<String>> = HashMap::new();

    for path in paths {
        if let Some(rest) = path.strip_prefix("peer:") {
            if let Some(slash) = rest.find('/') {
                let pid = &rest[..slash];
                let actual = &rest[slash + 1..];
                peer_groups.entry(pid).or_default().push(actual.to_string());
            }
        } else {
            local_paths.push(path.clone());
        }
    }

    let mut bodies = batch_load_bodies(conn, &local_paths);
    for (peer_id, peer_conn) in peers {
        if let Some(stripped) = peer_groups.get(peer_id.as_str()) {
            for (path, body) in batch_load_bodies(peer_conn, stripped) {
                bodies.insert(format!("peer:{peer_id}/{path}"), body);
            }
        }
    }
    bodies
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_helpers::helpers::*;
    use rusqlite::Connection;

    #[test]
    fn test_discover_peer_dbs_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let peers = discover_peer_dbs(tmp.path(), "test-model");
        assert!(peers.is_empty());
    }

    #[test]
    fn test_discover_peer_dbs_model_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let peers_dir = tmp.path().join("federation").join("data").join("peers").join("alice");
        std::fs::create_dir_all(&peers_dir).unwrap();
        let db_path = peers_dir.join("index.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta (key, value) VALUES ('model_id', 'wrong-model');",
        ).unwrap();
        drop(conn);

        let peers = discover_peer_dbs(tmp.path(), "test-model");
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].0, "alice");
    }

    #[test]
    fn test_discover_peer_dbs_valid() {
        let tmp = tempfile::tempdir().unwrap();
        let peers_dir = tmp.path().join("federation").join("data").join("peers").join("alice");
        std::fs::create_dir_all(&peers_dir).unwrap();
        let db_path = peers_dir.join("index.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta (key, value) VALUES ('model_id', 'test-model');",
        ).unwrap();
        drop(conn);

        let peers = discover_peer_dbs(tmp.path(), "test-model");
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].0, "alice");
    }

    #[test]
    fn test_batch_load_bodies_federated_routes_correctly() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let local = create_test_db(&[
            ("local.md", "local", "local body text", &emb),
        ]);
        let peer = create_peer_db(&[
            ("peer-note.md", "peer", "peer body text", &emb),
        ]);

        let peers = vec![("eve".to_string(), peer)];
        let paths = vec![
            "local.md".to_string(),
            "peer:eve/peer-note.md".to_string(),
        ];

        let bodies = batch_load_bodies_federated(&local, &peers, &paths);
        assert_eq!(bodies.get("local.md").unwrap(), "local body text");
        assert_eq!(bodies.get("peer:eve/peer-note.md").unwrap(), "peer body text");
    }

    #[test]
    fn test_batch_load_bodies_federated_missing_peer() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let local = create_test_db(&[
            ("local.md", "local", "local body", &emb),
        ]);

        let peers: Vec<(String, Connection)> = vec![];
        let paths = vec![
            "local.md".to_string(),
            "peer:unknown/note.md".to_string(),
        ];

        let bodies = batch_load_bodies_federated(&local, &peers, &paths);
        assert_eq!(bodies.len(), 1);
        assert!(bodies.contains_key("local.md"));
    }
}
