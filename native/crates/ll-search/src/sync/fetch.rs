//! The read half of a sync cycle: fetch the index of every vault a grant
//! lets this client read, and write it into the peer cache.
//!
//! v4 asked the hub to list its peers and hand each one over. The hub deleted
//! those messages on 2026-06-14 and this client kept sending them for three
//! months, so its download half has been failing on its first message ever
//! since. v5 inverts the flow: the handshake already carried every grant the
//! hub holds for this key, so the client decides what it may read and asks
//! for exactly that.
//!
//! **The client asks only for what a grant entitles it to.** Not "ask and let
//! the hub refuse" — the two produce the same visible outcome today and the
//! difference is the whole point: `assoc` joins a person's work and personal
//! identities and carries no authority at all, and a client that asks anyway
//! is one hub-side bug away from getting an answer.

use std::path::Path;

use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::client::{recv_binary, recv_json, send_json, WsStream};
use super::config::{peer_dir, peer_index_path};
use super::grant::{self, GrantKind, GrantStatement};
use super::key_id::KeyId;
use super::protocol_v5::{ClientMsg, GrantWire, HubMsg};

/// One vault whose index this cycle fetched and wrote.
#[derive(Debug, Serialize)]
pub struct Fetched {
    pub vault_id: String,
    /// The count the hub declared for the index it served. Nothing here
    /// opened the file and counted rows; this is a report, not a measurement.
    pub note_count: i64,
}

/// Whether an edge of this kind lets its holder read the issuer's vaults.
///
/// Mirrors the hub's `authz::matching` with `want_authority = false`: `link`
/// transfers full authority and so covers reading, `follow` and `peer`
/// authorise reads and nothing more, and `assoc` authorises nothing at all.
fn permits_read(kind: GrantKind) -> bool {
    kind.transfers_authority() || matches!(kind, GrantKind::Follow | GrantKind::Peer)
}

/// A `vault_id` that is safe to use as a single path component. Grant
/// statements are signed by their issuer, not by us, and this one lands in a
/// directory name.
pub(super) fn is_safe_vault_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The vaults this client may read, in the order the hub listed their grants.
///
/// Everything that decides "may we ask?" happens here, before a single byte
/// goes out. Five things disqualify a grant:
///
/// - it is not addressed to us. `SyncReady.grants` carries the grants this
///   key ISSUED as well as the ones it holds, and reading through one of
///   those would have this client fetch its own vault and file it away as a
///   peer's.
/// - its signature does not check out against the key it names as issuer.
/// - it is not `active`. A `follow` starts `pending` and is not a licence to
///   read until the followee accepts it.
/// - it has expired.
/// - its kind carries no read authority — `assoc`.
///
/// A grant with no `scope` names no vault, and this client has no way to
/// enumerate the vaults its issuer owns, so there is nothing to ask for.
fn readable_vaults(grants: &[GrantWire], me: &KeyId, now: i64) -> Vec<String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut out = Vec::new();
    for wire in grants {
        if wire.state != "active" {
            continue;
        }
        let (Ok(statement), Ok(signature)) =
            (b64.decode(&wire.statement_b64), b64.decode(&wire.signature_b64))
        else {
            eprintln!("skipping a grant that is not valid base64");
            continue;
        };
        // Self-authenticating, the same way the hub treats it: the signature
        // is checked against the key the statement names as issuer, so the
        // issuer has to be read out before it can be verified. What makes
        // that safe is the `to` check below — a statement signed by whoever
        // wrote it still has to be addressed to this key to mean anything.
        let Ok(named_from) = serde_json::from_slice::<GrantStatement>(&statement).map(|s| s.from)
        else {
            eprintln!("skipping a grant that does not parse");
            continue;
        };
        let st = match grant::verify(&statement, &signature, &named_from) {
            Ok(st) => st,
            Err(e) => {
                eprintln!("skipping a grant that does not verify: {e}");
                continue;
            }
        };
        if &st.to != me || !permits_read(st.kind) || st.expires_at <= now {
            continue;
        }
        let Some(vault_id) = st.scope else { continue };
        if !is_safe_vault_id(&vault_id) {
            eprintln!("skipping a grant naming an unusable vault_id: {vault_id:?}");
            continue;
        }
        if !out.contains(&vault_id) {
            out.push(vault_id);
        }
    }
    out
}

/// Fetch every readable vault's index. Returns what was written and the ids
/// of the vaults that could not be.
///
/// One vault failing must not lose the others: a hub that refuses one read,
/// or serves one index whose bytes do not match its own header, has said
/// nothing about the rest. The failures come back so the cycle can record how
/// many there were — a read half that quietly fetched nothing is the shape of
/// the outage this whole project exists to undo.
pub async fn fetch_all(
    ws: &mut WsStream,
    config_dir: &Path,
    grants: &[GrantWire],
    me: &KeyId,
    now: i64,
) -> anyhow::Result<(Vec<Fetched>, Vec<String>)> {
    let mut fetched = Vec::new();
    let mut skipped = Vec::new();
    for vault_id in readable_vaults(grants, me, now) {
        match fetch_one(ws, config_dir, &vault_id).await {
            Ok(Some(one)) => {
                eprintln!("Fetched {} ({} notes)", one.vault_id, one.note_count);
                fetched.push(one);
            }
            Ok(None) => eprintln!("Hub holds no index for {vault_id} yet"),
            Err(e) => {
                eprintln!("Fetch for {vault_id} failed: {e}");
                skipped.push(vault_id);
            }
        }
    }
    Ok((fetched, skipped))
}

/// `Ok(None)` means the hub holds no index for this vault — a followed vault
/// that has never uploaded, which is the ordinary state of a new peer and not
/// a failure of anything.
async fn fetch_one(
    ws: &mut WsStream,
    config_dir: &Path,
    vault_id: &str,
) -> anyhow::Result<Option<Fetched>> {
    send_json(ws, &ClientMsg::FetchIndex { vault_id: vault_id.to_string() }).await?;

    let (answered, holds) = match recv_json::<HubMsg>(ws).await? {
        HubMsg::IndexHeader { vault_id, holds } => (vault_id, holds),
        HubMsg::Reject { reason } => anyhow::bail!("hub refused the read: {reason}"),
        other => anyhow::bail!("expected index-header, got: {other:?}"),
    };

    // `holds: Some(..)` promises exactly one binary frame. Read it before
    // judging anything else about the header: a header this client goes on to
    // refuse must not leave its frame in the stream for the next vault's
    // fetch to pick up as its own.
    let body = match holds {
        Some(_) => Some(recv_binary(ws).await?),
        None => None,
    };

    if answered != vault_id {
        anyhow::bail!("asked for {vault_id}, the hub answered for {answered}");
    }
    let (Some(held), Some(bytes)) = (holds, body) else { return Ok(None) };

    // The header is the hub's claim about what it is sending; the bytes are
    // what it sent. Hash them and compare — the same check the hub runs on
    // this client's uploads, deliberately symmetric. A mismatch writes
    // nothing: there is no such thing as writing it now and repairing it
    // later, because nothing would know to come back.
    let actual = hex::encode(Sha256::digest(&bytes));
    if actual != held.sha256 {
        anyhow::bail!(
            "index for {vault_id} hashes to {actual}, the header declared {}",
            held.sha256,
        );
    }

    write_index(config_dir, vault_id, bytes).await?;
    Ok(Some(Fetched { vault_id: vault_id.to_string(), note_count: held.note_count }))
}

async fn write_index(config_dir: &Path, vault_id: &str, bytes: Vec<u8>) -> anyhow::Result<()> {
    std::fs::create_dir_all(peer_dir(config_dir, vault_id))?;
    let path = peer_index_path(config_dir, vault_id);

    let write_to = path.clone();
    tokio::task::spawn_blocking(move || std::fs::write(&write_to, &bytes))
        .await
        .map_err(|e| anyhow::anyhow!("index write task panicked: {e}"))??;

    // Both rebuilds are best-effort and neither invalidates the fetch: the
    // bytes are on disk and verified either way. A missing FTS table costs
    // this peer its keyword leg on the next query, not the index.
    let fts_path = path.clone();
    if let Err(e) = tokio::task::spawn_blocking(move || ensure_fts(&fts_path))
        .await
        .map_err(|e| anyhow::anyhow!("FTS rebuild task panicked: {e}"))?
    {
        eprintln!("FTS rebuild for {vault_id} failed: {e}");
    }
    let embed_path = path;
    let embed_for = vault_id.to_string();
    if let Err(e) = tokio::task::spawn_blocking(move || ensure_embeddings(&embed_path, &embed_for))
        .await
        .map_err(|e| anyhow::anyhow!("embedding task panicked: {e}"))?
    {
        eprintln!("Embedding generation for {vault_id} failed: {e}");
    }
    Ok(())
}

fn ensure_fts(db_path: &Path) -> anyhow::Result<()> {
    let conn = rusqlite::Connection::open(db_path)?;
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            title, tags, body,
            content='notes_content',
            content_rowid='id',
            tokenize='porter unicode61 remove_diacritics 1'
        );
        INSERT INTO notes_fts(notes_fts) VALUES('rebuild');",
    )?;
    Ok(())
}

/// Exports carry their own embeddings, so this normally finds them and
/// returns. It earns its keep for an index exported by a peer whose embedding
/// pipeline had produced none.
fn ensure_embeddings(db_path: &Path, vault_id: &str) -> anyhow::Result<()> {
    let conn = rusqlite::Connection::open(db_path)?;

    let has_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='embeddings'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    let has_data = has_table
        && conn
            .query_row("SELECT COUNT(*) FROM embeddings", [], |row| row.get::<_, i64>(0))
            .unwrap_or(0)
            > 0;

    if has_data {
        return Ok(());
    }

    let mut stmt = conn.prepare(
        "SELECT nc.id, nc.body FROM notes_content nc WHERE nc.body IS NOT NULL AND nc.body != ''",
    )?;
    let notes: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    if notes.is_empty() {
        return Ok(());
    }

    eprintln!("Generating embeddings for {} ({} notes)...", vault_id, notes.len());

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS embeddings (id INTEGER PRIMARY KEY, data BLOB NOT NULL);",
    )?;

    let batch_size = 32;
    let mut embedded = 0;

    for chunk in notes.chunks(batch_size) {
        let texts: Vec<String> = chunk.iter().map(|(_, body)| body.clone()).collect();
        let vecs = crate::embed::try_embed_documents(&texts)?;

        conn.execute_batch("BEGIN TRANSACTION;")?;
        for ((id, _), vec) in chunk.iter().zip(vecs.iter()) {
            let blob: Vec<u8> = vec.iter().flat_map(|f| f.to_le_bytes()).collect();
            conn.execute(
                "INSERT OR REPLACE INTO embeddings (id, data) VALUES (?1, ?2)",
                rusqlite::params![id, blob],
            )?;
        }
        conn.execute_batch("COMMIT;")?;

        embedded += chunk.len();
        eprintln!("  Embedded {}/{}", embedded, notes.len());
    }

    eprintln!("Embeddings for {vault_id} complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::grant::canonical_bytes;
    use crate::sync::test_hub::{spawn_fetch_hub, FetchAnswer};
    use ed25519_dalek::{Signer, SigningKey};

    const NOW: i64 = 1_757_000_000;

    fn pair(byte: u8) -> (SigningKey, KeyId) {
        let sk = SigningKey::from_bytes(&[byte; 32]);
        let id = KeyId::from_pubkey(&sk.verifying_key());
        (sk, id)
    }

    /// The client's own identity in every test here. Grants are addressed to
    /// it; the ones that are not are the point of their own tests.
    fn me() -> (SigningKey, KeyId) {
        pair(11)
    }

    fn them() -> (SigningKey, KeyId) {
        pair(9)
    }

    struct GrantFixture {
        kind: GrantKind,
        scope: Option<&'static str>,
        state: &'static str,
        expires_at: i64,
    }

    fn follow(scope: &'static str) -> GrantFixture {
        GrantFixture {
            kind: GrantKind::Follow,
            scope: Some(scope),
            state: "active",
            expires_at: NOW + 1_000,
        }
    }

    fn of_kind(kind: GrantKind, scope: &'static str) -> GrantFixture {
        GrantFixture { kind, ..follow(scope) }
    }

    /// Sign `fixture` as a grant from `from` to `to`, in the wire shape the
    /// handshake delivers.
    fn wire(from: &(SigningKey, KeyId), to: &KeyId, fixture: &GrantFixture) -> GrantWire {
        let b64 = base64::engine::general_purpose::STANDARD;
        let statement = GrantStatement {
            v: 5,
            kind: fixture.kind,
            from: from.1.clone(),
            to: to.clone(),
            scope: fixture.scope.map(str::to_string),
            issued_at: NOW - 1,
            expires_at: fixture.expires_at,
            nonce: "ZmFrZS1ub25jZQ".into(),
        };
        let bytes = canonical_bytes(&statement);
        let sig = from.0.sign(&bytes);
        GrantWire {
            statement_b64: b64.encode(&bytes),
            signature_b64: b64.encode(sig.to_bytes()),
            state: fixture.state.to_string(),
        }
    }

    /// A grant issued TO this client by `them()`, the ordinary case.
    fn to_me(fixture: GrantFixture) -> GrantWire {
        wire(&them(), &me().1, &fixture)
    }

    async fn connect(addr: std::net::SocketAddr) -> WsStream {
        tokio_tungstenite::connect_async(format!("ws://{addr}")).await.unwrap().0
    }

    fn index_bytes(marker: &str) -> Vec<u8> {
        format!("pretend-this-is-a-sqlite-file-{marker}").into_bytes()
    }

    /// Run `fetch_all` against a hub scripted with `answers`, and return what
    /// it produced alongside every `vault_id` the hub was actually asked for.
    async fn run(
        dir: &Path,
        grants: Vec<GrantWire>,
        answers: Vec<(&'static str, FetchAnswer)>,
    ) -> ((Vec<Fetched>, Vec<String>), Vec<String>) {
        let (hub, asked) = spawn_fetch_hub(answers).await;
        let mut ws = connect(hub.addr).await;
        let out = fetch_all(&mut ws, dir, &grants, &me().1, NOW).await.unwrap();
        // Close so the hub's recorder stops before the assertion reads it.
        let _ = futures_util::SinkExt::close(&mut ws).await;
        let asked = asked.lock().unwrap().clone();
        (out, asked)
    }

    #[tokio::test]
    async fn an_active_follow_is_fetched_and_written() {
        let dir = tempfile::tempdir().unwrap();
        let body = index_bytes("v-other");
        let ((fetched, skipped), asked) = run(
            dir.path(),
            vec![to_me(follow("v-other"))],
            vec![("v-other", FetchAnswer::Index(body.clone()))],
        )
        .await;

        assert_eq!(asked, vec!["v-other".to_string()]);
        assert_eq!(skipped, Vec::<String>::new());
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].vault_id, "v-other");
        assert_eq!(fetched[0].note_count, 42);
        assert_eq!(
            std::fs::read(peer_index_path(dir.path(), "v-other")).unwrap(),
            body,
            "the bytes on disk are the bytes off the wire",
        );
    }

    /// R-B. The assertion is on nothing having been SENT. A filter that
    /// admits `assoc` and leans on the hub to refuse produces the same
    /// visible outcome and is still wrong.
    #[tokio::test]
    async fn an_assoc_grant_is_never_even_asked_about() {
        let dir = tempfile::tempdir().unwrap();
        let ((fetched, skipped), asked) = run(
            dir.path(),
            vec![to_me(of_kind(GrantKind::Assoc, "v-work"))],
            vec![("v-work", FetchAnswer::Index(index_bytes("v-work")))],
        )
        .await;

        assert!(asked.is_empty(), "assoc carries no authority: the client must not ask, {asked:?}");
        assert!(fetched.is_empty());
        assert!(skipped.is_empty(), "not asking is not a failure to report");
        assert!(!peer_dir(dir.path(), "v-work").exists());
    }

    /// The other side of the same boundary. An implementation that asks for
    /// nothing satisfies the `assoc` test above on its own.
    #[tokio::test]
    async fn every_kind_that_authorises_a_read_is_asked_for_and_assoc_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let ((fetched, _), asked) = run(
            dir.path(),
            vec![
                to_me(of_kind(GrantKind::Follow, "v-follow")),
                to_me(of_kind(GrantKind::Link, "v-link")),
                to_me(of_kind(GrantKind::Peer, "v-peer")),
                to_me(of_kind(GrantKind::Assoc, "v-assoc")),
            ],
            vec![
                ("v-follow", FetchAnswer::Index(index_bytes("f"))),
                ("v-link", FetchAnswer::Index(index_bytes("l"))),
                ("v-peer", FetchAnswer::Index(index_bytes("p"))),
                ("v-assoc", FetchAnswer::Index(index_bytes("a"))),
            ],
        )
        .await;

        assert_eq!(asked, vec!["v-follow", "v-link", "v-peer"],
            "link transfers full authority, follow and peer authorise reads, assoc nothing");
        assert_eq!(fetched.len(), 3);
    }

    #[tokio::test]
    async fn a_pending_follow_is_not_a_licence_to_read() {
        let dir = tempfile::tempdir().unwrap();
        let pending = GrantFixture { state: "pending", ..follow("v-other") };
        let ((_, _), asked) = run(
            dir.path(),
            vec![to_me(pending)],
            vec![("v-other", FetchAnswer::Index(index_bytes("v-other")))],
        )
        .await;
        assert!(asked.is_empty(), "a follow is pending until the followee accepts it: {asked:?}");
    }

    #[tokio::test]
    async fn an_expired_grant_is_not_asked_about() {
        let dir = tempfile::tempdir().unwrap();
        let lapsed = GrantFixture { expires_at: NOW, ..follow("v-other") };
        let ((_, _), asked) = run(
            dir.path(),
            vec![to_me(lapsed)],
            vec![("v-other", FetchAnswer::Index(index_bytes("v-other")))],
        )
        .await;
        assert!(asked.is_empty(), "expiry is a boundary, not a suggestion: {asked:?}");
    }

    /// `SyncReady.grants` carries both directions. A grant this client issued
    /// grants the OTHER key a read, and following it back would fetch our own
    /// vault and file it away as somebody else's.
    #[tokio::test]
    async fn a_grant_this_client_issued_is_not_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let issued_by_me = wire(&me(), &them().1, &follow("v-mine"));
        let ((_, _), asked) = run(
            dir.path(),
            vec![issued_by_me],
            vec![("v-mine", FetchAnswer::Index(index_bytes("v-mine")))],
        )
        .await;
        assert!(asked.is_empty(), "this grant is addressed to somebody else: {asked:?}");
    }

    #[tokio::test]
    async fn a_grant_whose_signature_does_not_check_out_is_not_asked_about() {
        let dir = tempfile::tempdir().unwrap();
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut forged = to_me(follow("v-other"));
        forged.signature_b64 = b64.encode([0u8; 64]);

        let ((_, _), asked) = run(
            dir.path(),
            vec![forged],
            vec![("v-other", FetchAnswer::Index(index_bytes("v-other")))],
        )
        .await;
        assert!(asked.is_empty(), "the hub carries grants, it does not vouch for them: {asked:?}");
    }

    /// An unscoped grant names no vault, and this client cannot enumerate the
    /// vaults its issuer owns, so there is nothing to ask for. See the report:
    /// unscoped `link` grants are unreachable from the client for this reason.
    #[tokio::test]
    async fn an_unscoped_grant_names_no_vault_to_ask_for() {
        let dir = tempfile::tempdir().unwrap();
        let unscoped = GrantFixture { scope: None, ..follow("unused") };
        let ((_, _), asked) = run(dir.path(), vec![to_me(unscoped)], vec![]).await;
        assert!(asked.is_empty(), "{asked:?}");
    }

    #[tokio::test]
    async fn a_hub_holding_nothing_writes_nothing_and_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let ((fetched, skipped), asked) = run(
            dir.path(),
            vec![to_me(follow("v-empty"))],
            vec![("v-empty", FetchAnswer::Nothing)],
        )
        .await;

        assert_eq!(asked, vec!["v-empty".to_string()], "it is asked for");
        assert!(fetched.is_empty());
        assert!(skipped.is_empty(),
            "a peer that has never uploaded is the ordinary state of a new peer, not a failure");
        assert!(!peer_dir(dir.path(), "v-empty").exists());
    }

    /// R-C. The header is a claim; the bytes are the fact.
    #[tokio::test]
    async fn a_frame_that_does_not_match_the_header_is_refused_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let ((fetched, skipped), asked) = run(
            dir.path(),
            vec![to_me(follow("v-liar"))],
            vec![("v-liar", FetchAnswer::IndexUnderADifferentSha(index_bytes("v-liar")))],
        )
        .await;

        assert_eq!(asked, vec!["v-liar".to_string()]);
        assert!(fetched.is_empty());
        assert_eq!(skipped, vec!["v-liar".to_string()]);
        assert!(!peer_index_path(dir.path(), "v-liar").exists(),
            "written and repaired later is not a thing: nothing would know to come back");
    }

    /// R-D. Two vaults, the first refused. The second must still land, and
    /// the first must be counted rather than lost.
    #[tokio::test]
    async fn one_failed_fetch_does_not_lose_the_others() {
        let dir = tempfile::tempdir().unwrap();
        let body = index_bytes("v-good");
        let ((fetched, skipped), asked) = run(
            dir.path(),
            vec![to_me(follow("v-bad")), to_me(follow("v-good"))],
            vec![
                ("v-bad", FetchAnswer::Reject("not authorized to read this vault")),
                ("v-good", FetchAnswer::Index(body.clone())),
            ],
        )
        .await;

        assert_eq!(asked, vec!["v-bad".to_string(), "v-good".to_string()],
            "the second vault is still asked for");
        assert_eq!(skipped, vec!["v-bad".to_string()]);
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].vault_id, "v-good");
        assert_eq!(std::fs::read(peer_index_path(dir.path(), "v-good")).unwrap(), body);
    }

    /// A refused vault leaves no frame in the stream, so the vault after it
    /// reads its own header. The test above proves the sequencing survives a
    /// reject; this one proves it survives the case where a frame WAS sent
    /// and then refused.
    #[tokio::test]
    async fn a_refused_frame_does_not_desynchronise_the_vault_after_it() {
        let dir = tempfile::tempdir().unwrap();
        let body = index_bytes("v-good");
        let ((fetched, skipped), _) = run(
            dir.path(),
            vec![to_me(follow("v-liar")), to_me(follow("v-good"))],
            vec![
                ("v-liar", FetchAnswer::IndexUnderADifferentSha(index_bytes("v-liar"))),
                ("v-good", FetchAnswer::Index(body.clone())),
            ],
        )
        .await;

        assert_eq!(skipped, vec!["v-liar".to_string()]);
        assert_eq!(fetched.len(), 1, "the rejected frame was consumed, not left in the stream");
        assert_eq!(std::fs::read(peer_index_path(dir.path(), "v-good")).unwrap(), body);
    }

    #[tokio::test]
    async fn a_header_naming_a_different_vault_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let ((fetched, skipped), _) = run(
            dir.path(),
            vec![to_me(follow("v-asked"))],
            vec![("v-asked", FetchAnswer::HeaderFor("v-else", index_bytes("v-else")))],
        )
        .await;

        assert!(fetched.is_empty());
        assert_eq!(skipped, vec!["v-asked".to_string()]);
        assert!(!peer_dir(dir.path(), "v-else").exists(),
            "an answer for a vault nobody asked for must not create a cache for it");
        assert!(!peer_dir(dir.path(), "v-asked").exists());
    }

    #[tokio::test]
    async fn a_vault_id_that_is_not_a_safe_path_component_is_never_asked_for() {
        let dir = tempfile::tempdir().unwrap();
        let traversal = GrantFixture { scope: Some("../../escaped"), ..follow("unused") };
        let ((_, _), asked) = run(dir.path(), vec![to_me(traversal)], vec![]).await;
        assert!(asked.is_empty(), "{asked:?}");
        assert!(!dir.path().join("../../escaped").exists());
    }

    #[test]
    fn is_safe_vault_id_accepts_valid() {
        assert!(is_safe_vault_id("abc123"));
        assert!(is_safe_vault_id("019abc-de"));
        assert!(is_safe_vault_id("vault_01"));
        assert!(is_safe_vault_id(&"a".repeat(128)));
    }

    #[test]
    fn is_safe_vault_id_rejects_traversal_and_separators() {
        assert!(!is_safe_vault_id("../etc"));
        assert!(!is_safe_vault_id(".."));
        assert!(!is_safe_vault_id("foo/bar"));
        assert!(!is_safe_vault_id("foo\\bar"));
        assert!(!is_safe_vault_id(""));
        assert!(!is_safe_vault_id("foo bar"));
        assert!(!is_safe_vault_id(&"a".repeat(129)));
        assert!(!is_safe_vault_id("peer\u{200B}id"));
        assert!(!is_safe_vault_id("café"));
    }

    #[test]
    fn only_assoc_authorises_no_read() {
        assert!(permits_read(GrantKind::Follow));
        assert!(permits_read(GrantKind::Link));
        assert!(permits_read(GrantKind::Peer));
        assert!(!permits_read(GrantKind::Assoc));
    }
}
