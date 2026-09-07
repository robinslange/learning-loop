//! The read half of a sync cycle: fetch the index of every vault this client
//! may read, and write it into the peer cache.
//!
//! v4 asked the hub to list its peers and hand each one over. The hub deleted
//! those messages on 2026-06-14 and this client kept sending them for three
//! months, so its download half has been failing on its first message ever
//! since. v5 inverts the flow: the handshake already named every vault this
//! key may read, so the client asks for exactly those and never asks the hub
//! to list anything.
//!
//! **Which vaults exist and who owns them is hub state.** A grant verifies
//! offline, and a scoped one names its vault — but a `link`, the grant that
//! joins a person's own machines, is unscoped. It means "any vault this
//! issuer owns", and which vaults an issuer owns is not something a grant can
//! say. A client deriving its read list from `grant.scope` reads nothing at
//! all on a machine whose only grant is the `link` that joined it, which is
//! what this one did.
//!
//! **It still asks for less than it is offered.** Not "ask and let the hub
//! refuse" — the two produce the same visible outcome today and the
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
use super::protocol_v5::{ClientMsg, GrantWire, HubMsg, VaultState};

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
pub(super) fn permits_read(kind: GrantKind) -> bool {
    kind.transfers_authority() || matches!(kind, GrantKind::Follow | GrantKind::Peer)
}

/// A `vault_id` that is safe to use as a single path component. These arrive
/// in the hub's `vault_state`, off the wire and verified by nothing, and this
/// one lands in a directory name.
pub(super) fn is_safe_vault_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The grants this client currently holds, verified and in force.
///
/// Nothing here chooses what to fetch any more — the hub's `vault_state` does
/// that. What is left for these grants is the `assoc` brace below, and every
/// one of these four checks is in the direction of NOT silencing a read the
/// hub authorised:
///
/// - it is not addressed to us. `SyncReady.grants` carries the grants this
///   key ISSUED as well as the ones it holds, and an `assoc` between two
///   other keys is not this client's reason to stay quiet.
/// - its signature does not check out against the key it names as issuer.
///   The hub carries grants; it does not vouch for them.
/// - it is not `active`. A `follow` starts `pending`.
/// - it has expired.
fn live_grants(grants: &[GrantWire], me: &KeyId, now: i64) -> Vec<GrantStatement> {
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
        if &st.to != me || st.expires_at <= now {
            continue;
        }
        out.push(st);
    }
    out
}

/// Whether the only thing this client holds bearing on `vault_id` is an
/// `assoc`.
///
/// Belt and braces. The hub computes `vault_state` through the same matcher
/// `FetchIndex` authorises with and will not list a vault reachable only
/// across an `assoc` edge — but a client that would ask for one if it were
/// listed is a client one hub bug away from asking.
///
/// **Who issued the `assoc` decides whether it may veto.** An extra layer of
/// defence has to be at least as trustworthy as the one it backs, and a bare
/// "does anyone say `assoc` about this vault" test is not: the hub lodges an
/// `assoc` as `active` with no acceptance step and does not check that the
/// issuer owns the scope, so any key at all could name a stranger's vault and
/// silence it here for good. A key that has said nothing else to us has no
/// standing over a vault we reach through somebody else's grant.
///
/// So an `assoc` naming this vault is outranked by any read grant that could
/// cover it — one scoped to it, or an unscoped one, "every vault I own" —
/// **issued by a key that is not itself vetoing it**. What is left suppressed
/// is the case the brace is for: nobody has offered us a way in but the
/// `assoc`.
///
/// One issuer saying both about the same vault is saying contradictory things
/// — `assoc` exists precisely to withhold what `link` transfers — and that
/// contradiction resolves in favour of refusing. Deliberate: this brace only
/// ever refuses, so erring costs a read and never leaks one.
///
/// The issuer test is a fact about the grant's signer, not about its shape, so
/// it sits in the filter and applies to both. It used to be written into the
/// unscoped arm of a `match` on `scope` and left off the scoped one — the
/// third finding this function has produced, and the second where a rule
/// stated in the prose above it was applied to one branch and not its sibling.
fn only_assoc_names(held: &[GrantStatement], vault_id: &str) -> bool {
    let names_it = |st: &GrantStatement| st.scope.as_deref() == Some(vault_id);
    let vetoing: Vec<&KeyId> = held
        .iter()
        .filter(|st| names_it(st) && !permits_read(st.kind))
        .map(|st| &st.from)
        .collect();
    if vetoing.is_empty() {
        return false;
    }
    !held
        .iter()
        .filter(|st| permits_read(st.kind) && !vetoing.contains(&&st.from))
        .any(|st| st.scope.is_none() || names_it(st))
}

/// The vaults this client may read, in the order the hub listed them.
///
/// The hub decides this, not the client: `SyncReady.vault_state` carries
/// exactly the vaults this key owns or may read, computed through the same
/// matcher `FetchIndex` authorises with. Three things disqualify an entry:
///
/// - it is this client's own vault. The hub lists it because we own it, the
///   upload half already has it, and filing our own index under
///   `data/peers/` is the bug the old grant-direction check caught.
/// - its id is not usable as a single path component. These ids now arrive
///   off the wire rather than out of a grant this client verified itself, and
///   `config.rs`'s path helpers assume a validated id and do not check one.
/// - every grant we hold that names it is an `assoc`.
pub(super) fn readable_vaults(
    vault_state: &[VaultState],
    grants: &[GrantWire],
    me: &KeyId,
    my_vault_id: &str,
    now: i64,
) -> Vec<String> {
    let held = live_grants(grants, me, now);
    let mut out = Vec::new();
    for state in vault_state {
        let vault_id = &state.vault_id;
        if vault_id == my_vault_id {
            continue;
        }
        if !is_safe_vault_id(vault_id) {
            eprintln!("skipping a listed vault whose id is unusable: {vault_id:?}");
            continue;
        }
        if only_assoc_names(&held, vault_id) {
            eprintln!("not asking for {vault_id}: assoc carries no read authority");
            continue;
        }
        if !out.contains(vault_id) {
            out.push(vault_id.clone());
        }
    }
    out
}

/// What one cycle's read half did, per vault.
///
/// Three outcomes, three fields, because three things can happen to a vault
/// and a caller needs to tell them apart: `watch.rs` recomputes sessions over
/// the local database when a peer index actually changes, and folding
/// "already current" in with "written" would have it recompute on every tick
/// forever.
#[derive(Debug, Default)]
pub struct FetchOutcome {
    /// Vaults whose local index this cycle replaced.
    pub fetched: Vec<Fetched>,
    /// Vaults the hub served an index for that is byte-identical to the copy
    /// already on disk. Nothing was written and nothing was reindexed.
    pub unchanged: Vec<String>,
    /// Vaults this client was entitled to read and could not.
    pub skipped: Vec<String>,
}

/// Fetch every readable vault's index.
///
/// One vault failing must not lose the others: a hub that refuses one read,
/// or serves one index whose bytes do not match its own header, has said
/// nothing about the rest. The failures come back so the cycle can record how
/// many there were — a read half that quietly fetched nothing is the shape of
/// the outage this whole project exists to undo.
pub async fn fetch_all(
    ws: &mut WsStream,
    config_dir: &Path,
    vault_state: &[VaultState],
    grants: &[GrantWire],
    me: &KeyId,
    my_vault_id: &str,
    now: i64,
) -> anyhow::Result<FetchOutcome> {
    let mut out = FetchOutcome::default();
    for vault_id in readable_vaults(vault_state, grants, me, my_vault_id, now) {
        match fetch_one(ws, config_dir, &vault_id).await {
            Ok(Outcome::Written(one)) => {
                eprintln!("Fetched {} ({} notes)", one.vault_id, one.note_count);
                out.fetched.push(one);
            }
            Ok(Outcome::AlreadyCurrent) => {
                eprintln!("Local copy of {vault_id} is already the index the hub holds");
                out.unchanged.push(vault_id);
            }
            Ok(Outcome::HubHoldsNothing) => eprintln!("Hub holds no index for {vault_id} yet"),
            Err(e) => {
                eprintln!("Fetch for {vault_id} failed: {e}");
                out.skipped.push(vault_id);
            }
        }
    }
    Ok(out)
}

enum Outcome {
    Written(Fetched),
    AlreadyCurrent,
    /// A followed vault that has never uploaded — the ordinary state of a new
    /// peer, and not a failure of anything.
    HubHoldsNothing,
}

async fn fetch_one(
    ws: &mut WsStream,
    config_dir: &Path,
    vault_id: &str,
) -> anyhow::Result<Outcome> {
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
    let (Some(held), Some(bytes)) = (holds, body) else { return Ok(Outcome::HubHoldsNothing) };

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

    // v4 skipped a peer whose cached timestamp matched before it asked for
    // anything. v5 cannot: the hub sends the header and the frame back to
    // back, so by the time this client knows the sha it is already holding
    // the bytes. What it can still decline is the expensive half — the
    // truncating overwrite of a good file, and the full FTS5 rebuild over
    // every note behind it, on a 1500 ms debounce.
    //
    // Hashing the file on disk rather than trusting a recorded sha beside it:
    // a sidecar can disagree with the file it describes, and the thing being
    // decided is whether these exact bytes are already there.
    if on_disk_sha(config_dir, vault_id).await? == Some(actual) {
        return Ok(Outcome::AlreadyCurrent);
    }

    write_index(config_dir, vault_id, bytes).await?;
    Ok(Outcome::Written(Fetched {
        vault_id: vault_id.to_string(),
        note_count: held.note_count,
    }))
}

/// The sha256 of the index already cached for `vault_id`, or `None` when
/// there is no readable file there. An unreadable one is `None` rather than
/// an error: the fetch that would replace it is in hand.
async fn on_disk_sha(config_dir: &Path, vault_id: &str) -> anyhow::Result<Option<String>> {
    let path = peer_index_path(config_dir, vault_id);
    tokio::task::spawn_blocking(move || {
        std::fs::read(&path).ok().map(|bytes| hex::encode(Sha256::digest(&bytes)))
    })
    .await
    .map_err(|e| anyhow::anyhow!("cached-index hash task panicked: {e}"))
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

    /// A key with no relationship to this client and none to any vault it
    /// reads. Anyone can lodge a grant naming anyone's vault.
    fn stranger() -> (SigningKey, KeyId) {
        pair(7)
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

    /// A grant that names no vault. What `ll link` issues: "any vault this
    /// issuer owns", a set only the hub can enumerate.
    fn unscoped(kind: GrantKind) -> GrantFixture {
        GrantFixture { kind, scope: None, ..follow("unused") }
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

    /// This client's own vault. The hub lists it because we own it, and the
    /// read half must leave it to the upload half.
    const MY_VAULT: &str = "v-mine";

    /// Run `fetch_all` against a hub that listed `listed` at the handshake and
    /// is scripted with `answers`, and return what it produced alongside
    /// everything the hub recorded — every `vault_id` it was asked for, and
    /// any complaint of its own.
    ///
    /// `listed` is the fact under test in most of what follows: it is the
    /// hub's ruling on what this key may read, and the client's job is to ask
    /// for exactly it.
    async fn run(
        dir: &Path,
        listed: &[&str],
        grants: Vec<GrantWire>,
        answers: Vec<(&'static str, FetchAnswer)>,
    ) -> (FetchOutcome, Vec<String>) {
        let vault_state: Vec<VaultState> = listed
            .iter()
            .map(|id| VaultState { vault_id: id.to_string(), holds: None })
            .collect();
        let (hub, asked) = spawn_fetch_hub(answers).await;
        let mut ws = connect(hub.addr).await;
        let out = fetch_all(&mut ws, dir, &vault_state, &grants, &me().1, MY_VAULT, NOW)
            .await
            .unwrap();
        // Close so the hub's recorder stops before the assertion reads it.
        let _ = futures_util::SinkExt::close(&mut ws).await;
        let asked = asked.lock().unwrap().clone();
        (out, asked)
    }

    #[tokio::test]
    async fn an_active_follow_is_fetched_and_written() {
        let dir = tempfile::tempdir().unwrap();
        let body = index_bytes("v-other");
        let (out, asked) = run(
            dir.path(),
            &["v-other"],
            vec![to_me(follow("v-other"))],
            vec![("v-other", FetchAnswer::Index(body.clone()))],
        )
        .await;

        assert_eq!(asked, vec!["v-other".to_string()]);
        assert_eq!(out.skipped, Vec::<String>::new());
        assert_eq!(out.fetched.len(), 1);
        assert_eq!(out.fetched[0].vault_id, "v-other");
        assert_eq!(out.fetched[0].note_count, 42);
        assert_eq!(
            std::fs::read(peer_index_path(dir.path(), "v-other")).unwrap(),
            body,
            "the bytes on disk are the bytes off the wire",
        );
    }

    /// R-B, and the belt-and-braces case. The hub here LISTS `v-work` — a
    /// real one would not, because it computes the list through the same
    /// matcher `FetchIndex` authorises with, and `assoc` authorises nothing.
    /// This is the hub bug, and the client must not be one bug away from
    /// asking. The assertion is on nothing having been SENT: a client that
    /// asks and leans on the hub to refuse produces the same visible outcome
    /// and is still wrong.
    #[tokio::test]
    async fn an_assoc_only_vault_is_not_asked_for_even_when_the_hub_lists_it() {
        let dir = tempfile::tempdir().unwrap();
        let (out, asked) = run(
            dir.path(),
            &["v-work"],
            vec![to_me(of_kind(GrantKind::Assoc, "v-work"))],
            vec![("v-work", FetchAnswer::Index(index_bytes("v-work")))],
        )
        .await;

        assert!(asked.is_empty(), "assoc carries no authority: the client must not ask, {asked:?}");
        assert!(out.fetched.is_empty());
        assert!(out.skipped.is_empty(), "not asking is not a failure to report");
        assert!(!peer_dir(dir.path(), "v-work").exists());
    }

    /// The other side of the same boundary. An implementation that asks for
    /// nothing satisfies the `assoc` test above on its own.
    #[tokio::test]
    async fn every_kind_that_authorises_a_read_is_asked_for_and_assoc_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let (out, asked) = run(
            dir.path(),
            &["v-follow", "v-link", "v-peer", "v-assoc"],
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
        assert_eq!(out.fetched.len(), 3);
    }

    /// The property the whole of Plan 7 exists for: link a second machine and
    /// see the first one's notes.
    ///
    /// The grant is a `link` and a `link` is unscoped — it says "any vault
    /// this issuer owns", which is a set no grant can enumerate and only the
    /// hub knows. A client deriving its read list from `grant.scope` asks for
    /// nothing here, which is what a freshly linked machine used to do.
    #[tokio::test]
    async fn an_unscoped_link_on_a_vault_the_hub_lists_is_fetched() {
        let dir = tempfile::tempdir().unwrap();
        let body = index_bytes("v-other");
        let (out, asked) = run(
            dir.path(),
            &["v-other"],
            vec![to_me(unscoped(GrantKind::Link))],
            vec![("v-other", FetchAnswer::Index(body.clone()))],
        )
        .await;

        assert_eq!(asked, vec!["v-other".to_string()],
            "the hub listed it; the grant naming no vault is not a reason to stay quiet");
        assert_eq!(out.fetched.len(), 1);
        assert_eq!(std::fs::read(peer_index_path(dir.path(), "v-other")).unwrap(), body);
    }

    /// The brace must not be a veto anyone can exercise. The hub lodges an
    /// `assoc` as `active` with no acceptance step and does not check that the
    /// issuer owns the scope, so this grant costs a stranger nothing — and
    /// without the issuer test it would silence a linked machine's read of
    /// somebody else's vault for good.
    #[tokio::test]
    async fn an_assoc_from_a_stranger_cannot_veto_a_vault_the_hub_listed() {
        let dir = tempfile::tempdir().unwrap();
        let body = index_bytes("v-other");
        let (out, asked) = run(
            dir.path(),
            &["v-other"],
            vec![
                to_me(unscoped(GrantKind::Link)),
                wire(&stranger(), &me().1, &of_kind(GrantKind::Assoc, "v-other")),
            ],
            vec![("v-other", FetchAnswer::Index(body.clone()))],
        )
        .await;

        assert_eq!(asked, vec!["v-other".to_string()],
            "a key that has said nothing else to us has no say over what we read");
        assert_eq!(out.fetched.len(), 1);
    }

    /// The other side of the issuer test, and the deliberate half. One issuer
    /// saying both `assoc(v)` and "any vault I own" is contradicting itself —
    /// `assoc` exists to withhold exactly what `link` transfers — and the
    /// brace resolves that in favour of refusing. It only ever refuses, so
    /// erring here costs a read and never leaks one.
    #[tokio::test]
    async fn an_assoc_and_an_unscoped_grant_from_one_issuer_resolve_to_refusing() {
        let dir = tempfile::tempdir().unwrap();
        let (out, asked) = run(
            dir.path(),
            &["v-work"],
            vec![to_me(unscoped(GrantKind::Link)), to_me(of_kind(GrantKind::Assoc, "v-work"))],
            vec![("v-work", FetchAnswer::Index(index_bytes("v-work")))],
        )
        .await;

        assert!(asked.is_empty(), "the issuer withheld this vault by name: {asked:?}");
        assert!(out.fetched.is_empty());
    }

    /// The scoped half of the issuer test, and the direction the code was
    /// missing: the rule stated above this function applied to the unscoped
    /// arm of a `match` and not to its sibling.
    ///
    /// One issuer saying `read(v-work)` and `assoc(v-work)` is contradicting
    /// itself about the same vault by name — a sharper contradiction than the
    /// unscoped case, where a general permission and a specific withholding
    /// can at least be read as a carve-out. It resolves the same way. The
    /// brace only ever refuses, so erring costs a read and never leaks one.
    #[tokio::test]
    async fn a_scoped_read_from_the_issuer_that_assocs_it_does_not_outrank_the_assoc() {
        let dir = tempfile::tempdir().unwrap();
        let (out, asked) = run(
            dir.path(),
            &["v-work"],
            vec![
                to_me(follow("v-work")),
                to_me(of_kind(GrantKind::Assoc, "v-work")),
            ],
            vec![("v-work", FetchAnswer::Index(index_bytes("v-work")))],
        )
        .await;

        assert!(asked.is_empty(), "the issuer withheld this vault by name: {asked:?}");
        assert!(out.fetched.is_empty());
    }

    /// The opposite direction on the same decision, and the reason it cannot
    /// simply be "a scoped read never outranks an `assoc`". The vetoer here is
    /// a stranger, which costs it nothing to be — the hub lodges an `assoc` as
    /// `active` with no acceptance step and does not check the issuer owns the
    /// scope. A key that has said nothing else to us must not silence a vault
    /// somebody we actually read from granted us by name.
    #[tokio::test]
    async fn a_stranger_assoc_cannot_veto_a_vault_we_hold_a_scoped_read_for() {
        let dir = tempfile::tempdir().unwrap();
        let body = index_bytes("v-work");
        let (out, asked) = run(
            dir.path(),
            &["v-work"],
            vec![
                to_me(follow("v-work")),
                wire(&stranger(), &me().1, &of_kind(GrantKind::Assoc, "v-work")),
            ],
            vec![("v-work", FetchAnswer::Index(body.clone()))],
        )
        .await;

        assert_eq!(asked, vec!["v-work".to_string()],
            "the key that named this vault to us is not the key vetoing it");
        assert_eq!(out.fetched.len(), 1);
    }

    /// The hub lists this client's own vault, because it owns it. The upload
    /// half already has it, and a copy of our own index under `data/peers/`
    /// would be searched as somebody else's.
    #[tokio::test]
    async fn the_vault_this_client_owns_is_not_fetched_into_peers() {
        let dir = tempfile::tempdir().unwrap();
        let (out, asked) = run(
            dir.path(),
            &[MY_VAULT, "v-other"],
            vec![to_me(unscoped(GrantKind::Link))],
            vec![("v-other", FetchAnswer::Index(index_bytes("v-other")))],
        )
        .await;

        assert_eq!(asked, vec!["v-other".to_string()], "our own vault is not ours to fetch");
        assert!(!peer_dir(dir.path(), MY_VAULT).exists());
        assert_eq!(out.fetched.len(), 1, "the vault that is not ours still lands");
    }

    /// The hub's list is the authority in both directions. A grant this
    /// client still holds for a vault the hub no longer lists — revoked at
    /// the hub, or issued by a key that has since given the vault up — is not
    /// a licence to ask.
    #[tokio::test]
    async fn a_vault_the_hub_does_not_list_is_not_asked_for_even_with_a_grant() {
        let dir = tempfile::tempdir().unwrap();
        let (_out, asked) = run(
            dir.path(),
            &["v-listed"],
            vec![to_me(follow("v-stale")), to_me(follow("v-listed"))],
            vec![
                ("v-stale", FetchAnswer::Index(index_bytes("v-stale"))),
                ("v-listed", FetchAnswer::Index(index_bytes("v-listed"))),
            ],
        )
        .await;

        assert_eq!(asked, vec!["v-listed".to_string()],
            "a grant the hub did not back with a listing buys nothing: {asked:?}");
        assert!(!peer_dir(dir.path(), "v-stale").exists());
    }

    /// The `assoc` brace only ever refuses, so what it accepts as an `assoc`
    /// matters: a grant that is not this client's live one must not silence a
    /// read the hub authorised. Four ways a grant fails to be ours, all
    /// naming the listed vault, and none of them may suppress it.
    #[tokio::test]
    async fn a_grant_that_is_not_this_clients_live_assoc_does_not_silence_a_listed_vault() {
        let dir = tempfile::tempdir().unwrap();
        let b64 = base64::engine::general_purpose::STANDARD;
        let assoc = || of_kind(GrantKind::Assoc, "v-listed");
        let mut forged = to_me(assoc());
        forged.signature_b64 = b64.encode([0u8; 64]);

        let (out, asked) = run(
            dir.path(),
            &["v-listed"],
            vec![
                to_me(GrantFixture { state: "pending", ..assoc() }),
                to_me(GrantFixture { expires_at: NOW, ..assoc() }),
                wire(&me(), &them().1, &assoc()),
                forged,
            ],
            vec![("v-listed", FetchAnswer::Index(index_bytes("v-listed")))],
        )
        .await;

        assert_eq!(asked, vec!["v-listed".to_string()],
            "pending, expired, addressed elsewhere, unsigned: none of these is our assoc");
        assert_eq!(out.fetched.len(), 1);
    }

    #[tokio::test]
    async fn a_hub_holding_nothing_writes_nothing_and_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let (out, asked) = run(
            dir.path(),
            &["v-empty"],
            vec![to_me(follow("v-empty"))],
            vec![("v-empty", FetchAnswer::Nothing)],
        )
        .await;

        assert_eq!(asked, vec!["v-empty".to_string()], "it is asked for");
        assert!(out.fetched.is_empty());
        assert!(out.skipped.is_empty(),
            "a peer that has never uploaded is the ordinary state of a new peer, not a failure");
        assert!(!peer_dir(dir.path(), "v-empty").exists());
    }

    /// v4 skipped a peer whose cached timestamp matched. v5 cannot decline
    /// the download — the hub sends the header and frame back to back — but
    /// it can decline the overwrite and the FTS rebuild behind it, which is
    /// the expensive half on a 1500 ms debounce.
    ///
    /// The cached file is made read-only, so "it was not rewritten" is proved
    /// rather than inferred: a `write_index` that ran would fail on EACCES
    /// and land the vault in `skipped`. An mtime comparison would be the
    /// obvious alternative and a weaker one — filesystem timestamp
    /// granularity decides whether it can tell a same-second rewrite apart.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_index_identical_to_the_cached_copy_is_not_rewritten() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let body = index_bytes("v-same");
        std::fs::create_dir_all(peer_dir(dir.path(), "v-same")).unwrap();
        let path = peer_index_path(dir.path(), "v-same");
        std::fs::write(&path, &body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();

        let (out, asked) = run(
            dir.path(),
            &["v-same"],
            vec![to_me(follow("v-same"))],
            vec![("v-same", FetchAnswer::Index(body.clone()))],
        )
        .await;

        assert_eq!(asked, vec!["v-same".to_string()], "it is still asked for and still verified");
        assert_eq!(out.unchanged, vec!["v-same".to_string()]);
        assert!(out.fetched.is_empty(), "nothing was written, so nothing downstream should rerun");
        assert!(out.skipped.is_empty(),
            "an already-current vault is not a failure — and a write that was attempted \
             would have failed on the read-only file and landed here");
        assert_eq!(std::fs::read(&path).unwrap(), body);
    }

    /// The other side. A gate that reports everything as already-current
    /// would satisfy the test above and quietly stop updating peer indexes
    /// altogether.
    #[tokio::test]
    async fn an_index_that_differs_from_the_cached_copy_replaces_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(peer_dir(dir.path(), "v-moved")).unwrap();
        std::fs::write(peer_index_path(dir.path(), "v-moved"), index_bytes("old")).unwrap();
        let fresh = index_bytes("new");

        let (out, _asked) = run(
            dir.path(),
            &["v-moved"],
            vec![to_me(follow("v-moved"))],
            vec![("v-moved", FetchAnswer::Index(fresh.clone()))],
        )
        .await;

        assert!(out.unchanged.is_empty());
        assert_eq!(out.fetched.len(), 1);
        assert_eq!(std::fs::read(peer_index_path(dir.path(), "v-moved")).unwrap(), fresh);
    }

    /// R-C. The header is a claim; the bytes are the fact.
    #[tokio::test]
    async fn a_frame_that_does_not_match_the_header_is_refused_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let (out, asked) = run(
            dir.path(),
            &["v-liar"],
            vec![to_me(follow("v-liar"))],
            vec![("v-liar", FetchAnswer::IndexUnderADifferentSha(index_bytes("v-liar")))],
        )
        .await;

        assert_eq!(asked, vec!["v-liar".to_string()]);
        assert!(out.fetched.is_empty());
        assert_eq!(out.skipped, vec!["v-liar".to_string()]);
        assert!(!peer_index_path(dir.path(), "v-liar").exists(),
            "written and repaired later is not a thing: nothing would know to come back");
    }

    /// R-D. Two vaults, the first refused. The second must still land, and
    /// the first must be counted rather than lost.
    #[tokio::test]
    async fn one_failed_fetch_does_not_lose_the_others() {
        let dir = tempfile::tempdir().unwrap();
        let body = index_bytes("v-good");
        let (out, asked) = run(
            dir.path(),
            &["v-bad", "v-good"],
            vec![to_me(follow("v-bad")), to_me(follow("v-good"))],
            vec![
                ("v-bad", FetchAnswer::Reject("not authorized to read this vault")),
                ("v-good", FetchAnswer::Index(body.clone())),
            ],
        )
        .await;

        assert_eq!(asked, vec!["v-bad".to_string(), "v-good".to_string()],
            "the second vault is still asked for");
        assert_eq!(out.skipped, vec!["v-bad".to_string()]);
        assert_eq!(out.fetched.len(), 1);
        assert_eq!(out.fetched[0].vault_id, "v-good");
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
        let (out, _asked) = run(
            dir.path(),
            &["v-liar", "v-good"],
            vec![to_me(follow("v-liar")), to_me(follow("v-good"))],
            vec![
                ("v-liar", FetchAnswer::IndexUnderADifferentSha(index_bytes("v-liar"))),
                ("v-good", FetchAnswer::Index(body.clone())),
            ],
        )
        .await;

        assert_eq!(out.skipped, vec!["v-liar".to_string()]);
        assert_eq!(out.fetched.len(), 1, "the rejected frame was consumed, not left in the stream");
        assert_eq!(std::fs::read(peer_index_path(dir.path(), "v-good")).unwrap(), body);
    }

    /// Every assertion here except `asked` and the trailing good vault is
    /// satisfied by any failure at all, including the mock never having
    /// started — which is what a hub that panicked in its spawned task looks
    /// like from the client. So the record and the vault after it are what
    /// make this test about the header rather than about something going
    /// wrong.
    #[tokio::test]
    async fn a_header_naming_a_different_vault_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let good = index_bytes("v-good");
        let (out, asked) = run(
            dir.path(),
            &["v-asked", "v-good"],
            vec![to_me(follow("v-asked")), to_me(follow("v-good"))],
            vec![
                ("v-asked", FetchAnswer::HeaderFor("v-else", index_bytes("v-else"))),
                ("v-good", FetchAnswer::Index(good.clone())),
            ],
        )
        .await;

        assert_eq!(asked, vec!["v-asked".to_string(), "v-good".to_string()],
            "the hub answered both and complained about neither");
        assert_eq!(out.skipped, vec!["v-asked".to_string()]);
        assert_eq!(out.fetched.len(), 1, "the misdirected frame was consumed, not left in the stream");
        assert_eq!(std::fs::read(peer_index_path(dir.path(), "v-good")).unwrap(), good);
        assert!(!peer_dir(dir.path(), "v-else").exists(),
            "an answer for a vault nobody asked for must not create a cache for it");
        assert!(!peer_dir(dir.path(), "v-asked").exists());
    }

    /// The id now arrives off the wire rather than out of a grant this client
    /// verified itself, and it lands in a directory name: `config.rs`'s path
    /// helpers document that they assume a validated id and do not check one.
    #[tokio::test]
    async fn a_listed_vault_id_that_is_not_a_safe_path_component_is_never_asked_for() {
        let dir = tempfile::tempdir().unwrap();
        let (_out, asked) =
            run(dir.path(), &["../../escaped"], vec![to_me(unscoped(GrantKind::Link))], vec![])
                .await;
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

    /// A grant's `scope` names ONE vault, and `only_assoc_names` compares it
    /// whole on both sides of its own rule — the `assoc` that vetoes and the
    /// read grant that outranks it.
    ///
    /// Weaken either comparison to a prefix or a case-insensitive one and the
    /// brace stops refusing what it exists to refuse: an `assoc` naming
    /// `v-alice` is outranked by a read grant for the unrelated vault `v-a`,
    /// or vetoes a vault nobody named. Ids are UUIDv7 today and no two of them
    /// are prefixes of each other, which is exactly what was true of
    /// `ReadableVaults::contains` before the same rule was found missing
    /// there.
    ///
    /// Both wrong directions, one assertion each: a scope that is a prefix of
    /// the vault id and a vault id that is a prefix of the scope.
    #[test]
    fn an_assoc_and_the_read_that_outranks_it_both_name_a_whole_vault_id() {
        let (_, a) = them();
        let (_, b) = stranger();
        let held = |from: &KeyId, kind: GrantKind, scope: &str| GrantStatement {
            v: 5,
            kind,
            from: from.clone(),
            to: me().1,
            scope: Some(scope.to_string()),
            issued_at: NOW - 1,
            expires_at: NOW + 1_000,
            nonce: "ZmFrZS1ub25jZQ".into(),
        };
        let assoc = held(&a, GrantKind::Assoc, "v-alice");

        // The veto side: it silences the vault it names, and no other.
        assert!(only_assoc_names(std::slice::from_ref(&assoc), "v-alice"));
        assert!(!only_assoc_names(std::slice::from_ref(&assoc), "v-a"),
            "a vault whose id the scope starts with is a different vault");
        assert!(!only_assoc_names(std::slice::from_ref(&assoc), "v-alice-2"),
            "and so is one that starts with the scope");
        assert!(!only_assoc_names(std::slice::from_ref(&assoc), "V-ALICE"),
            "and the comparison is not case-insensitive either");

        // The outranking side: only a read grant naming this vault, or naming
        // none at all, may lift the veto.
        assert!(!only_assoc_names(&[assoc.clone(), held(&b, GrantKind::Follow, "v-alice")], "v-alice"),
            "a read grant for this vault outranks a stranger's assoc");
        for near_miss in ["v-a", "v-alice-2", "V-ALICE"] {
            assert!(
                only_assoc_names(&[assoc.clone(), held(&b, GrantKind::Follow, near_miss)], "v-alice"),
                "a read grant for {near_miss:?} says nothing about v-alice"
            );
        }
    }

    #[test]
    fn only_assoc_authorises_no_read() {
        assert!(permits_read(GrantKind::Follow));
        assert!(permits_read(GrantKind::Link));
        assert!(permits_read(GrantKind::Peer));
        assert!(!permits_read(GrantKind::Assoc));
    }
}
