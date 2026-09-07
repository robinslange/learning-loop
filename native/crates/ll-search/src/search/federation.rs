use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags};

use crate::config::TOP_K_FEDERATION;
use crate::sync::grants::ReadAuthority;
use crate::sync::registry;
use super::scoring::{add_ranked_rrf, dot_product, fts_bm25_query};

/// Which vault profiles a query may read.
///
/// Default: exactly the one the vault path resolves to. Widening requires
/// `--all`, because the only edges between vaults are `follow` (which is
/// already reflected in that profile's own peer cache) and `assoc`, which
/// grants no authority at all — association cannot imply read access.
pub struct QueryScope {
    pub config_dirs: Vec<PathBuf>,
}

pub fn query_scope(plugin_data: &Path, vault: &Path, all: bool) -> anyhow::Result<QueryScope> {
    if all {
        return Ok(QueryScope {
            config_dirs: registry::load(plugin_data)?.into_iter().map(|p| p.config_dir).collect(),
        });
    }
    Ok(QueryScope {
        config_dirs: vec![registry::resolve_by_vault_path(plugin_data, vault)?.config_dir],
    })
}

/// Peer indexes visible within a resolved [`QueryScope`] — the union of
/// `discover_peer_dbs` over every config dir the scope names. With the
/// default (non-`--all`) scope that's exactly one config dir, so a peer
/// cached under a different profile never enters the result.
///
/// Each config dir is asked about its own grants: authority is a property of
/// the key that holds it, and a scope spanning two profiles spans two keys.
pub fn discover_peer_dbs_for(
    scope: &QueryScope,
    local_model_id: &str,
    now: i64,
) -> Vec<(String, Connection)> {
    scope
        .config_dirs
        .iter()
        .flat_map(|dir| discover_peer_dbs(dir, local_model_id, now))
        .collect()
}

/// Every cached peer index under `config_dir` that a live grant still
/// justifies holding, as of `now`.
///
/// **The question is "is this covered?", not "was this deleted?".** A cache
/// directory on disk used to be enough: this function read `peers/`, opened
/// whatever it found, and handed it to federated search having consulted no
/// grant and no key. That made deletion the read-authorization boundary — a
/// `remove_dir_all` that is not atomic, that an unscoped withdrawal declines
/// to run (and a `link` is unscoped, which is the main case), and that a
/// recovered identity can never reach, because a revocation removes only what
/// a *matching local grant* names and after a recovery no grant matches.
///
/// Asking the grant store instead makes an orphaned cache invisible without
/// being deleted, and demotes deletion to disk hygiene. It fails closed on
/// absence: no identity, no readable store, or no live grant all end in
/// nothing served.
///
/// **It does not fail closed in general, and the steady state is the case it
/// misses.** An unscoped grant covers every vault, a `link` is unscoped, and
/// `link.rs::reconcile` stores a `link` addressed to this key for every
/// machine that has ever linked to it — so on a linked machine one row covers
/// every directory here and nothing is filtered out. This is a narrowing, not
/// an authorization boundary, and the next person to read it needs to know
/// that before they treat spec:334 as satisfied. The predicate that closes it
/// is the hub's `vault_state`; [`ReadAuthority`] carries the argument for why
/// persisting that is safe, and what a stale copy of it has to do.
///
/// Nothing here reads the seed unless there is a cache to decide about. A
/// keyring read can prompt on macOS, and a query on a machine with no cached
/// peer must not be the thing that prompts.
pub fn discover_peer_dbs(
    config_dir: &Path,
    local_model_id: &str,
    now: i64,
) -> Vec<(String, Connection)> {
    // A missing `peers/` and an empty one are the same answer and take the
    // same path out: `read_dir`'s error flattens away with the entries'.
    let cached: Vec<String> = std::fs::read_dir(crate::sync::config::peers_dir(config_dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    if cached.is_empty() {
        return Vec::new();
    }

    let authority = match ReadAuthority::load(config_dir, now) {
        Ok(a) => a,
        Err(e) => {
            eprintln!(
                "Serving no peer index from {}: this machine cannot say what it may read ({e:#})",
                config_dir.display()
            );
            return Vec::new();
        }
    };

    let mut peers = Vec::new();
    for peer_id in cached {
        // Not "is this read authorized" — see `ReadAuthority`. On a linked
        // machine an unscoped `link` says yes to every id that reaches here.
        if !authority.covers(&peer_id) {
            eprintln!(
                "Peer {peer_id}: no live grant covers this cache, so it is not searched. \
                 `ll sync` refreshes what this machine holds; `ll status` shows its key."
            );
            continue;
        }
        let db_path = crate::sync::config::peer_index_path(config_dir, &peer_id);
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

/// Score a peer into the RRF map, guarding the vector path on dimension match.
///
/// `dot_product` zips to the shorter vector, so a dimension-mismatched peer
/// would silently mis-rank on the embedding leg. When the peer's embedding dim
/// doesn't match the local query dim (or the peer has no embeddings), fall back
/// to BM25-only — the same policy the hybrid search path enforces. Both the
/// hybrid and reflect paths call this so the check lives in one place.
pub(crate) fn add_peer_rrf_scores_guarded(
    rrf_scores: &mut HashMap<String, f64>,
    peer_id: &str,
    peer_conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    peer_embeddings: &[(i64, String, Vec<f32>)],
) {
    let local_dim = query_vec.len();
    let peer_dim = peer_embeddings.first().map(|(_, _, e)| e.len()).unwrap_or(0);
    if peer_dim == local_dim && peer_dim > 0 {
        add_peer_rrf_scores(rrf_scores, peer_id, peer_conn, query_vec, query_text, peer_embeddings);
    } else {
        let peer_fts = fts_bm25_query(peer_conn, query_text, TOP_K_FEDERATION);
        add_ranked_rrf(
            rrf_scores,
            peer_fts
                .iter()
                .map(|(_, path, _)| format!("peer:{peer_id}/{path}"))
                .collect::<Vec<_>>()
                .iter()
                .map(|s| s.as_str()),
        );
    }
}

pub(crate) fn add_peer_rrf_scores(
    rrf_scores: &mut HashMap<String, f64>,
    peer_id: &str,
    peer_conn: &Connection,
    query_vec: &[f32],
    query_text: &str,
    peer_embeddings: &[(i64, String, Vec<f32>)],
) {
    // Score by index first; format! only for survivors (TOP_K_FEDERATION entries),
    // not for all N peer embeddings.
    let mut peer_scored: Vec<(usize, f64)> = peer_embeddings
        .iter()
        .enumerate()
        .map(|(i, (_, _, emb))| (i, dot_product(query_vec, emb) as f64))
        .collect();
    peer_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    peer_scored.truncate(TOP_K_FEDERATION);
    let peer_vec: Vec<(String, f64)> = peer_scored
        .into_iter()
        .map(|(i, s)| (format!("peer:{peer_id}/{}", peer_embeddings[i].1), s))
        .collect();
    add_ranked_rrf(rrf_scores, peer_vec.iter().map(|(p, _)| p.as_str()));

    let peer_fts = fts_bm25_query(peer_conn, query_text, TOP_K_FEDERATION);
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
    let mut result = HashMap::new();
    if paths.is_empty() {
        return result;
    }

    for chunk in paths.chunks(500) {
        let placeholders: String = (0..chunk.len())
            .map(|i| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT n.path, nc.body FROM notes_content nc JOIN notes n ON nc.id = n.id WHERE n.path IN ({})",
            placeholders
        );

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let params: Vec<&dyn rusqlite::types::ToSql> =
            chunk.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
        let rows = match stmt.query_map(params.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            Ok(r) => r,
            Err(_) => continue,
        };

        for row in rows.flatten() {
            result.insert(row.0, row.1);
        }
    }

    result
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
            local_paths.push(path.to_owned());
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
    use std::sync::atomic::{AtomicI64, Ordering};

    use base64::Engine as _;
    use ed25519_dalek::{Signer, SigningKey};
    use rusqlite::Connection;

    use super::*;
    use super::super::test_helpers::helpers::*;
    use crate::sync::grant::{self, GrantKind, GrantStatement};
    use crate::sync::key_id::KeyId;
    use crate::sync::protocol_v5::GrantWire;
    use crate::sync::state::ReadableVaults;
    use crate::sync::{grants, seed_store, state, test_hub};

    const B64: base64::engine::general_purpose::GeneralPurpose =
        base64::engine::general_purpose::STANDARD;

    /// The clock every test in this module reads. `LATER` is after it, so a
    /// grant expiring at `LATER` is live at `NOW` and lapsed at `MUCH_LATER`.
    const NOW: i64 = 5_000;
    const LATER: i64 = 9_000;
    const MUCH_LATER: i64 = 20_000;

    /// Two grants of the same shape hash to one `grant_id` and the store
    /// dedupes them, so every statement gets a nonce of its own.
    static NONCE: AtomicI64 = AtomicI64::new(0);

    /// Give `config_dir` an identity of its own, and hand back its key.
    ///
    /// Planted rather than generated so a test can name the same key twice —
    /// once to address a grant to it and once as the seed the reader loads.
    /// `write_encrypted` is the backend `force_encrypted_seed_backend` pins
    /// the whole binary to, so nothing here reaches the OS keyring.
    fn plant_seed(config_dir: &Path, seed: u8) -> KeyId {
        test_hub::force_encrypted_seed_backend();
        std::fs::create_dir_all(config_dir.join("federation")).unwrap();
        seed_store::write_encrypted(config_dir, &[seed; 32]).unwrap();
        KeyId::from_pubkey(&SigningKey::from_bytes(&[seed; 32]).verifying_key())
    }

    /// Lodge a grant in `config_dir`'s store the way a sync cycle does —
    /// through `apply_grants`, so it is a grant that verified rather than a
    /// row a test wrote by hand.
    fn plant_grant(
        config_dir: &Path,
        from_seed: u8,
        to: &KeyId,
        kind: GrantKind,
        scope: Option<&str>,
        expires_at: i64,
    ) {
        let signer = SigningKey::from_bytes(&[from_seed; 32]);
        let statement = grant::canonical_bytes(&GrantStatement {
            v: 5,
            kind,
            from: KeyId::from_pubkey(&signer.verifying_key()),
            to: to.clone(),
            scope: scope.map(str::to_string),
            issued_at: 1,
            expires_at,
            nonce: format!("nonce-{}", NONCE.fetch_add(1, Ordering::Relaxed)),
        });
        let signature = signer.sign(&statement).to_bytes().to_vec();
        grants::apply_grants(config_dir, &[GrantWire {
            statement_b64: B64.encode(&statement),
            signature_b64: B64.encode(&signature),
            state: "active".to_string(),
        }])
        .unwrap();
    }

    /// Record the hub's answer: these are the vaults it last said this key
    /// may read, as of `NOW`.
    ///
    /// Every test that expects a cache to be HIDDEN for some *other* reason
    /// lists it here anyway. A cache missing from the list is hidden by the
    /// list, and a test where two reasons apply at once pins neither.
    fn plant_listed(config_dir: &Path, vault_ids: &[&str]) {
        state::write_readable_vaults(config_dir, &ReadableVaults {
            at: NOW,
            vault_ids: vault_ids.iter().map(|s| s.to_string()).collect(),
        })
        .unwrap();
    }

    /// A peer index (model_id "test-model") on disk under `config_dir`, with
    /// no grant behind it. What an orphaned cache looks like.
    fn plant_cache(config_dir: &Path, peer_id: &str) {
        let dir = crate::sync::config::peer_dir(config_dir, peer_id);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("index.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta (key, value) VALUES ('model_id', 'test-model');",
        )
        .unwrap();
    }

    /// A config dir holding an identity, one cached peer, the live `follow`
    /// that justifies it, and the hub's list naming it. **All three**, which
    /// is what a servable cache costs.
    ///
    /// The servable baseline every test that asserts a cache is HIDDEN has to
    /// be able to reach first — a cache that was never servable proves nothing
    /// about the filter.
    fn served_setup(peer_id: &str) -> (tempfile::TempDir, KeyId) {
        let dir = tempfile::tempdir().unwrap();
        let me = plant_seed(dir.path(), 1);
        plant_cache(dir.path(), peer_id);
        plant_grant(dir.path(), 2, &me, GrantKind::Follow, Some(peer_id), LATER);
        plant_listed(dir.path(), &[peer_id]);
        (dir, me)
    }

    fn ids(peers: &[(String, Connection)]) -> Vec<String> {
        peers.iter().map(|(id, _)| id.clone()).collect()
    }

    /// Registers two independent vault profiles, each with its own config
    /// dir and empty peer-cache directory, under a shared plugin_data root.
    fn two_profiles(plugin_data: &Path, personal_vault: &str, work_vault: &str) {
        for (seed, id, vault) in [(1u8, "personal", personal_vault), (2, "work", work_vault)] {
            let config_dir = plugin_data.join(id);
            std::fs::create_dir_all(config_dir.join("federation").join("data").join("peers")).unwrap();
            // A key each. Authority belongs to the key, so two profiles that
            // shared one would make "the work profile's cache is out of
            // scope" and "the work profile's grant is not ours" the same
            // assertion, and neither would be pinned.
            plant_seed(&config_dir, seed);
            registry::add(plugin_data, registry::VaultProfile {
                id: id.to_string(),
                config_dir,
                vault_path: PathBuf::from(vault),
            }).unwrap();
        }
    }

    /// Records an `assoc` grant from one registered profile to another.
    ///
    /// No production code reads this file — nothing in v5 models `assoc`
    /// yet. It exists purely so `an_assoc_edge_alone_never_widens_the_scope`
    /// pins a real on-disk artifact a future implementation might be
    /// tempted to consult, rather than asserting against nothing.
    fn add_assoc_grant(plugin_data: &Path, from_id: &str, to_id: &str) {
        let profiles = registry::load(plugin_data).unwrap();
        let from = profiles.iter().find(|p| p.id == from_id).unwrap();
        std::fs::write(
            from.config_dir.join("federation").join("assoc.json"),
            serde_json::json!({"assoc": [to_id]}).to_string(),
        ).unwrap();
    }

    /// Seeds a peer index (model_id "model-x") into one profile's peer cache,
    /// **and the live grant that justifies it**.
    ///
    /// Both halves, because the scoping tests below assert a cache is absent
    /// and a cache no grant covers is absent for a second reason. Planting
    /// the grant is what makes those tests say something about scope.
    fn seed_peer_cache(plugin_data: &Path, profile_id: &str, peer_id: &str) {
        let profiles = registry::load(plugin_data).unwrap();
        let profile = profiles.iter().find(|p| p.id == profile_id).unwrap();
        let peer_dir = profile.config_dir.join("federation").join("data").join("peers").join(peer_id);
        std::fs::create_dir_all(&peer_dir).unwrap();
        let conn = Connection::open(peer_dir.join("index.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta (key, value) VALUES ('model_id', 'model-x');",
        ).unwrap();
        drop(conn);
        let me = seed_store::load_only(&profile.config_dir)
            .unwrap()
            .map(|r| KeyId::from_pubkey(&r.signing_key.verifying_key()))
            .expect("two_profiles plants a seed in every profile");
        plant_grant(&profile.config_dir, 9, &me, GrantKind::Follow, Some(peer_id), LATER);
        plant_listed(&profile.config_dir, &[peer_id]);
    }

    #[test]
    fn query_resolves_to_one_profile_and_searches_only_it() {
        let d = tempfile::tempdir().unwrap();
        two_profiles(d.path(), "/v/personal", "/v/work");
        let scope = query_scope(d.path(), Path::new("/v/personal"), false).unwrap();
        assert_eq!(scope.config_dirs.len(), 1);
        assert!(scope.config_dirs[0].ends_with("personal") || scope.config_dirs[0] == d.path());
    }

    #[test]
    fn the_all_flag_widens_to_every_registered_profile() {
        let d = tempfile::tempdir().unwrap();
        two_profiles(d.path(), "/v/personal", "/v/work");
        let scope = query_scope(d.path(), Path::new("/v/personal"), true).unwrap();
        assert_eq!(scope.config_dirs.len(), 2);
    }

    #[test]
    fn an_assoc_edge_alone_never_widens_the_scope() {
        let d = tempfile::tempdir().unwrap();
        two_profiles(d.path(), "/v/personal", "/v/work");
        add_assoc_grant(d.path(), "personal", "work");
        let scope = query_scope(d.path(), Path::new("/v/personal"), false).unwrap();
        assert_eq!(scope.config_dirs.len(), 1,
            "assoc is attribution only — if it widened queries, an agent composing \
             a work artifact could silently surface personal notes");
    }

    #[test]
    fn peer_indexes_come_only_from_the_resolved_profile() {
        let d = tempfile::tempdir().unwrap();
        two_profiles(d.path(), "/v/personal", "/v/work");
        seed_peer_cache(d.path(), "work", "v-someone");
        let scope = query_scope(d.path(), Path::new("/v/personal"), false).unwrap();
        let peers = discover_peer_dbs_for(&scope, "model-x", NOW);
        assert!(peers.is_empty(), "the work profile's peer cache is out of scope");
    }

    #[test]
    fn discover_peer_dbs_for_unions_every_config_dir_in_an_all_scope() {
        let d = tempfile::tempdir().unwrap();
        two_profiles(d.path(), "/v/personal", "/v/work");
        seed_peer_cache(d.path(), "work", "v-someone");
        let scope = query_scope(d.path(), Path::new("/v/personal"), true).unwrap();
        let peers = discover_peer_dbs_for(&scope, "model-x", NOW);
        assert_eq!(peers.len(), 1, "--all must still surface the work profile's peer cache");
        assert_eq!(peers[0].0, "v-someone");
    }

    #[test]
    fn test_discover_peer_dbs_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let peers = discover_peer_dbs(tmp.path(), "test-model", NOW);
        assert!(peers.is_empty());
    }

    #[test]
    fn test_discover_peer_dbs_model_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let me = plant_seed(tmp.path(), 1);
        let peers_dir = tmp.path().join("federation").join("data").join("peers").join("alice");
        std::fs::create_dir_all(&peers_dir).unwrap();
        let db_path = peers_dir.join("index.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta (key, value) VALUES ('model_id', 'wrong-model');",
        ).unwrap();
        drop(conn);
        plant_grant(tmp.path(), 2, &me, GrantKind::Follow, Some("alice"), LATER);
        plant_listed(tmp.path(), &["alice"]);

        let peers = discover_peer_dbs(tmp.path(), "test-model", NOW);
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].0, "alice");
    }

    #[test]
    fn test_discover_peer_dbs_valid() {
        let (dir, _me) = served_setup("alice");
        let peers = discover_peer_dbs(dir.path(), "test-model", NOW);
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].0, "alice");
    }

    // -- the reader filters by live grant -----------------------------------
    //
    // Every test below that asserts a cache is HIDDEN starts from
    // `served_setup`, which is the same cache being served in
    // `test_discover_peer_dbs_valid` above. A cache that was never reachable
    // is indistinguishable from a filter working.

    /// The property. spec:334 says a client must not go on serving content it
    /// no longer has a grant for, and this is where that stops depending on a
    /// deletion having run: the directory is untouched, and invisible.
    #[test]
    fn a_cache_no_live_grant_covers_is_not_searched_and_is_still_on_disk() {
        let (dir, _me) = served_setup("alice");
        std::fs::remove_file(dir.path().join("federation").join("grants.json")).unwrap();

        assert!(discover_peer_dbs(dir.path(), "test-model", NOW).is_empty(),
            "a cache the grant store does not cover must not reach federated search");
        assert!(crate::sync::config::peer_index_path(dir.path(), "alice").exists(),
            "and it is hidden without being deleted — deletion is disk hygiene now, \
             not the boundary");
    }

    /// The four-month-old cache nobody could delete: a directory under
    /// `peers/` that no grant ever named, on a machine with a healthy store.
    #[test]
    fn a_cache_nothing_ever_granted_is_not_searched_beside_one_that_was() {
        let (dir, _me) = served_setup("alice");
        plant_cache(dir.path(), "thomas-kirk");
        // Listed, so the ONLY thing keeping it out is that no grant covers it.
        plant_listed(dir.path(), &["alice", "thomas-kirk"]);

        assert_eq!(ids(&discover_peer_dbs(dir.path(), "test-model", NOW)), ["alice"],
            "the granted cache is served and the orphan beside it is not");
    }

    /// `covers` reads `scope`. A filter that only asked "does this machine
    /// hold any live read grant?" would serve both.
    #[test]
    fn a_grant_scoped_to_another_vault_does_not_cover_this_cache() {
        let (dir, me) = served_setup("alice");
        plant_cache(dir.path(), "bob");
        plant_grant(dir.path(), 2, &me, GrantKind::Follow, Some("carol"), LATER);
        // Both listed. `bob` is out on scope alone, not on the hub's list.
        plant_listed(dir.path(), &["alice", "bob"]);

        assert_eq!(ids(&discover_peer_dbs(dir.path(), "test-model", NOW)), ["alice"]);
    }

    /// Expiry is not a sync-time sweep the reader can assume ran. spec:332
    /// says a lapsed grant stops meaning anything; here it stops meaning
    /// anything on the read, whether or not `prune_expired` has been reached.
    #[test]
    fn a_grant_that_has_lapsed_stops_covering_its_cache() {
        let (dir, _me) = served_setup("alice");

        assert_eq!(ids(&discover_peer_dbs(dir.path(), "test-model", NOW)), ["alice"],
            "live at NOW");
        assert!(discover_peer_dbs(dir.path(), "test-model", MUCH_LATER).is_empty(),
            "the same grant, the same store, read after it expired");
    }

    /// `to == me`. A grant addressed to someone else is on this disk all the
    /// time — `SyncReady` serves the grants this key ISSUED as well as the
    /// ones it holds — and none of them is a reason to read anything.
    #[test]
    fn a_grant_addressed_to_another_key_covers_nothing_here() {
        let dir = tempfile::tempdir().unwrap();
        plant_seed(dir.path(), 1);
        plant_cache(dir.path(), "alice");
        let someone_else = KeyId::from_pubkey(&SigningKey::from_bytes(&[7u8; 32]).verifying_key());
        plant_grant(dir.path(), 2, &someone_else, GrantKind::Follow, Some("alice"), LATER);
        plant_listed(dir.path(), &["alice"]);

        assert!(discover_peer_dbs(dir.path(), "test-model", NOW).is_empty());
    }

    /// `assoc` carries no read authority at all, and the pair is the point:
    /// swap the kind and the same cache is served, so this pins `permits_read`
    /// rather than some other reason the store came up empty.
    #[test]
    fn an_assoc_grant_covers_no_cache_where_a_follow_would() {
        for (kind, expected) in [(GrantKind::Assoc, 0), (GrantKind::Follow, 1)] {
            let dir = tempfile::tempdir().unwrap();
            let me = plant_seed(dir.path(), 1);
            plant_cache(dir.path(), "alice");
            plant_grant(dir.path(), 2, &me, kind, Some("alice"), LATER);
            plant_listed(dir.path(), &["alice"]);
            assert_eq!(discover_peer_dbs(dir.path(), "test-model", NOW).len(), expected,
                "{kind:?} should have produced {expected} peer(s)");
        }
    }

    /// Finding #3, closed. After `ll recover` the seed holds a different key
    /// and `config.json` is deliberately left alone, so every stored grant
    /// names an identity this machine no longer has. Nothing deletes those
    /// caches — a revocation can only remove what a *matching* local grant
    /// names — and before this filter they stayed searchable forever.
    #[test]
    fn a_recovered_identity_reads_none_of_the_old_identitys_caches() {
        let (dir, _old) = served_setup("alice");
        assert_eq!(ids(&discover_peer_dbs(dir.path(), "test-model", NOW)), ["alice"],
            "servable under the identity the grant names");

        plant_seed(dir.path(), 42);

        assert!(discover_peer_dbs(dir.path(), "test-model", NOW).is_empty(),
            "every grant in the store is addressed to the key the recovery replaced");
        assert!(crate::sync::config::peer_index_path(dir.path(), "alice").exists(),
            "and the deletion path could never have reached them");
    }

    /// The case that made this urgent. A `link` is unscoped, so its
    /// withdrawal names no cache and `withdraw` correctly deletes nothing —
    /// but `apply_revocations` still drops the row, and with the row gone
    /// nothing covers the cache. Revoked link, caches on disk, none served.
    #[test]
    fn a_revoked_link_stops_covering_the_caches_it_was_the_only_reason_for() {
        let dir = tempfile::tempdir().unwrap();
        let me = plant_seed(dir.path(), 1);
        plant_cache(dir.path(), "alice");
        let issuer = SigningKey::from_bytes(&[2u8; 32]);
        plant_grant(dir.path(), 2, &me, GrantKind::Link, None, LATER);
        plant_listed(dir.path(), &["alice"]);

        assert_eq!(ids(&discover_peer_dbs(dir.path(), "test-model", NOW)), ["alice"],
            "an unscoped link covers every cache — which is exactly why its \
             withdrawal has to be visible here");

        let stored = crate::sync::link::load_grants(dir.path()).unwrap();
        assert_eq!(stored.len(), 1);
        let statement = B64.decode(&stored[0].statement_b64).unwrap();
        let revocation = grant::canonical_bytes(&crate::sync::grant::RevocationStatement {
            v: 5,
            kind: "revoke",
            grant_id: grant::grant_id(&statement),
            by: KeyId::from_pubkey(&issuer.verifying_key()),
            scope: None,
            at: 2,
        });
        let swept = grants::apply_revocations(
            dir.path(),
            &[crate::sync::protocol_v5::RevocationWire {
                statement_b64: B64.encode(&revocation),
                signature_b64: B64.encode(issuer.sign(&revocation).to_bytes()),
            }],
            &me,
            NOW,
        )
        .unwrap();

        assert!(swept.is_empty(), "an unscoped withdrawal names no cache to delete");
        assert!(crate::sync::config::peer_index_path(dir.path(), "alice").exists(),
            "so the cache is still there");
        assert!(discover_peer_dbs(dir.path(), "test-model", NOW).is_empty(),
            "and it is no longer served — the reader is what makes the revocation \
             mean something");
    }

    /// The half `covers` cannot supply. The grant is live and covers this
    /// vault — it is the same `served_setup` that serves it two tests up —
    /// and the hub has simply stopped listing it. That is the revoked-`follow`
    /// and removed-from-a-vault case, and it is invisible to the grant store,
    /// because the grant the hub withdrew is absent from `SyncReady.grants`
    /// rather than present as something to check.
    #[test]
    fn a_cache_the_hub_no_longer_lists_is_not_searched() {
        let (dir, _me) = served_setup("alice");
        assert_eq!(ids(&discover_peer_dbs(dir.path(), "test-model", NOW)), ["alice"]);

        plant_listed(dir.path(), &["someone-else"]);

        assert!(discover_peer_dbs(dir.path(), "test-model", NOW).is_empty(),
            "the grant still covers it; the hub no longer lists it, and that is enough");
        assert!(crate::sync::config::peer_index_path(dir.path(), "alice").exists(),
            "hidden without being deleted, the same as every other reason here");
    }

    /// The case an unscoped `link` made unreachable for `covers` alone: the
    /// link says yes to every vault, so before the list this cache was served
    /// on a machine that had simply been linked to another. Now the list is
    /// what says which vaults that link was ever about.
    #[test]
    fn an_unscoped_link_no_longer_covers_a_vault_the_hub_never_listed() {
        let dir = tempfile::tempdir().unwrap();
        let me = plant_seed(dir.path(), 1);
        plant_cache(dir.path(), "mine");
        plant_cache(dir.path(), "thomas-kirk");
        plant_grant(dir.path(), 2, &me, GrantKind::Link, None, LATER);
        plant_listed(dir.path(), &["mine"]);

        assert_eq!(ids(&discover_peer_dbs(dir.path(), "test-model", NOW)), ["mine"],
            "the link covers both caches; only one of them is a vault the hub listed");
    }

    /// And the same distinction on disk. The directory names under `peers/`
    /// are whatever is there — an orphan from an older build, a rename, a
    /// hand-made directory — not ids the hub vouched for, so being a prefix
    /// of something the hub listed cannot be enough. The unscoped link covers
    /// both caches here, which leaves the list as the only discriminator.
    #[test]
    fn a_cache_whose_id_merely_starts_with_a_listed_one_is_not_searched() {
        let dir = tempfile::tempdir().unwrap();
        let me = plant_seed(dir.path(), 1);
        plant_cache(dir.path(), "v-a");
        plant_cache(dir.path(), "v-alice");
        plant_grant(dir.path(), 2, &me, GrantKind::Link, None, LATER);
        plant_listed(dir.path(), &["v-a"]);

        assert_eq!(ids(&discover_peer_dbs(dir.path(), "test-model", NOW)), ["v-a"],
            "`v-alice` starts with a listed id and was never listed");
    }

    /// A machine that has never completed a handshake has never been told it
    /// may read anything. Whatever is under `peers/` predates the rule, which
    /// is exactly the orphan this filter exists to hide. Absence is not
    /// permission.
    #[test]
    fn a_machine_that_has_never_synced_serves_nothing() {
        let (dir, _me) = served_setup("alice");
        std::fs::remove_file(
            crate::sync::config::readable_vaults_path(dir.path())).unwrap();

        assert!(discover_peer_dbs(dir.path(), "test-model", NOW).is_empty());
    }

    /// And an unreadable list is absent, not ignored. The opposite rule from
    /// `sync-state.json`, whose corrupt case must NOT block the cycle that
    /// rewrites it — here refusing to guess is the fail-closed direction.
    #[test]
    fn an_unreadable_list_serves_nothing() {
        let (dir, _me) = served_setup("alice");
        std::fs::write(
            crate::sync::config::readable_vaults_path(dir.path()), "{not json").unwrap();

        assert!(discover_peer_dbs(dir.path(), "test-model", NOW).is_empty());
    }

    /// **The staleness answer, pinned: the list carries no expiry of its own,
    /// and the grants do.** An offline machine can evaluate `expires_at`
    /// without a hub, and `grant.rs` refuses a statement that does not have
    /// one — so every stored grant lapses on a schedule, and a machine offline
    /// long enough goes dark by itself. No second clock over the list, and no
    /// constant invented for the purpose.
    ///
    /// A `follow` is 90 days. A month shut takes nothing.
    #[test]
    fn a_follow_keeps_serving_for_its_ninety_days_and_then_stops() {
        const DAY: i64 = 86_400;
        let dir = tempfile::tempdir().unwrap();
        let me = plant_seed(dir.path(), 1);
        plant_cache(dir.path(), "followed");
        plant_grant(dir.path(), 2, &me, GrantKind::Follow, Some("followed"),
            NOW + GrantKind::Follow.default_ttl_secs());
        plant_listed(dir.path(), &["followed"]);

        assert_eq!(ids(&discover_peer_dbs(dir.path(), "test-model", NOW + 30 * DAY)), ["followed"],
            "a laptop shut for a month must not lose federated search");
        assert!(discover_peer_dbs(dir.path(), "test-model", NOW + 120 * DAY).is_empty(),
            "and past the follow's own TTL it goes dark with no hub consulted");
    }

    /// **The worst case, stated rather than wished away.** An unscoped `link`
    /// covers every vault, so on a linked machine the offline set decays at
    /// the pace of the LINK — 365 days — not of the individual `follow` whose
    /// vault it happens to be. The list bounds *which* vaults survive; it does
    /// not say which grant justified each, because which vaults an issuer owns
    /// is still hub state.
    ///
    /// The knob for that worst case is `GrantKind::Link.default_ttl_secs()`,
    /// which already exists. Adding a staleness timer over the list would be a
    /// second answer to the same question, and the two would disagree.
    #[test]
    fn a_live_link_holds_the_whole_listed_set_open_until_the_link_itself_lapses() {
        const DAY: i64 = 86_400;
        let dir = tempfile::tempdir().unwrap();
        let me = plant_seed(dir.path(), 1);
        plant_cache(dir.path(), "followed");
        plant_cache(dir.path(), "linked");
        plant_grant(dir.path(), 2, &me, GrantKind::Follow, Some("followed"),
            NOW + GrantKind::Follow.default_ttl_secs());
        plant_grant(dir.path(), 3, &me, GrantKind::Link, None,
            NOW + GrantKind::Link.default_ttl_secs());
        plant_listed(dir.path(), &["followed", "linked"]);

        let mut past_the_follow =
            ids(&discover_peer_dbs(dir.path(), "test-model", NOW + 120 * DAY));
        past_the_follow.sort();
        assert_eq!(past_the_follow, ["followed", "linked"],
            "the follow lapsed, and the live link still covers its vault — the residual \
             an unscoped grant leaves, now bounded to vaults the hub actually listed");

        assert!(discover_peer_dbs(dir.path(), "test-model", NOW + 400 * DAY).is_empty(),
            "past the link's TTL there is nothing left to cover anything");
    }

    /// A machine with caches and no identity cannot tell whether any grant is
    /// addressed to it, so it serves nothing. Fail closed, not open.
    #[test]
    fn a_machine_with_no_identity_serves_no_cache() {
        let dir = tempfile::tempdir().unwrap();
        plant_cache(dir.path(), "alice");
        assert!(discover_peer_dbs(dir.path(), "test-model", NOW).is_empty());
    }

    #[test]
    fn test_batch_load_bodies_multiple_paths() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let conn = create_test_db(&[
            ("a.md", "a", "body a", &emb),
            ("b.md", "b", "body b", &emb),
            ("c.md", "c", "body c", &emb),
        ]);

        let paths = vec!["a.md".to_string(), "c.md".to_string()];
        let bodies = batch_load_bodies(&conn, &paths);
        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies.get("a.md").unwrap(), "body a");
        assert_eq!(bodies.get("c.md").unwrap(), "body c");
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

    // These tests must distinguish the vector path from the BM25 fallback. A naive
    // `contains_key` assertion cannot: the vector path (add_peer_rrf_scores) ALSO
    // runs fts_bm25_query and emits the same key, so a text-matching note scores
    // under both branches and the guard could be `if true`/`if false` without any
    // test failing. The discriminator is a note that matches by VECTOR but NOT by
    // query text ("zzzznomatch") — its key appears only when the vector path runs.
    #[test]
    fn guarded_matched_dim_uses_vector_path() {
        let emb = norm(&[1.0, 0.0, 0.0]);
        let peer = create_peer_db(&[("p.md", "p", "totally unrelated prose", &emb)]);
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let mut rrf = HashMap::new();
        add_peer_rrf_scores_guarded(
            &mut rrf,
            "eve",
            &peer,
            &query_vec,
            "zzzznomatch",
            &[(1, "p.md".to_string(), emb.clone())],
        );
        assert!(
            rrf.contains_key("peer:eve/p.md"),
            "matched-dim peer scored via the vector path even with no text match"
        );
    }

    #[test]
    fn guarded_mismatched_dim_falls_back_to_bm25() {
        // Same vector-only note, but the peer embedding is dim 2 vs the query's
        // dim 3. The guard must route to BM25, which finds nothing for a no-text
        // query — so the key must be ABSENT. Under `if true` (always vector) this
        // note would wrongly score; its absence pins the guard condition.
        let emb = norm(&[1.0, 0.0, 0.0]);
        let peer = create_peer_db(&[("p.md", "p", "totally unrelated prose", &emb)]);
        let query_vec = norm(&[1.0, 0.0, 0.0]); // dim 3
        let mismatched = vec![(1i64, "p.md".to_string(), vec![1.0f32, 0.0])]; // dim 2
        let mut rrf = HashMap::new();
        add_peer_rrf_scores_guarded(&mut rrf, "eve", &peer, &query_vec, "zzzznomatch", &mismatched);
        assert!(
            !rrf.contains_key("peer:eve/p.md"),
            "mismatched-dim peer must NOT score a vector-only note (BM25 fallback)"
        );
    }

    #[test]
    fn guarded_mismatched_dim_still_scores_a_text_match_via_bm25() {
        // The BM25 fallback must still work (not a silent no-op) and not panic on
        // the dim mismatch: a note that DOES match the query text scores even
        // though the peer's embedding dim is wrong.
        let peer = create_peer_db(&[("p.md", "p", "sticky positioning breaks", &norm(&[1.0, 0.0, 0.0]))]);
        let query_vec = norm(&[1.0, 0.0, 0.0]); // dim 3
        let mismatched = vec![(1i64, "p.md".to_string(), vec![1.0f32, 0.0])]; // dim 2
        let mut rrf = HashMap::new();
        add_peer_rrf_scores_guarded(&mut rrf, "eve", &peer, &query_vec, "sticky", &mismatched);
        assert!(
            rrf.contains_key("peer:eve/p.md"),
            "text-matching note still scored via the BM25 fallback"
        );
    }

    #[test]
    fn guarded_empty_embeddings_falls_back_to_bm25() {
        // No peer embeddings at all → BM25-only. A vector-only note must be absent;
        // a text-matching note must be present. Both together pin the else branch.
        let emb = norm(&[1.0, 0.0, 0.0]);
        let peer = create_peer_db(&[
            ("vec.md", "vec", "totally unrelated prose", &emb),
            ("txt.md", "txt", "sticky positioning", &emb),
        ]);
        let query_vec = norm(&[1.0, 0.0, 0.0]);
        let mut rrf = HashMap::new();
        add_peer_rrf_scores_guarded(&mut rrf, "eve", &peer, &query_vec, "sticky", &[]);
        assert!(
            !rrf.contains_key("peer:eve/vec.md"),
            "vector-only note must NOT score with no embeddings (BM25-only)"
        );
        assert!(
            rrf.contains_key("peer:eve/txt.md"),
            "text-matching note scored via BM25 with no embeddings"
        );
    }
}
