//! The local grant store, and the deletion a withdrawn grant obliges.
//!
//! `link.rs` owns the file — `federation/grants.json`, verbatim statement
//! bytes plus `lodged`, every write through one locked read-modify-write.
//! This module adopts that file rather than opening a second one, and adds
//! the three things a sync cycle does to it: fold in what the hub served,
//! act on what the hub says was withdrawn, and act on what has simply
//! lapsed.
//!
//! **A signed revocation is not self-sufficient, and the mistake is an easy
//! one.** A signature proves *someone* signed those bytes; only the stored
//! grant says who was entitled to. So: **the revocation says which grant is
//! withdrawn; the stored grant says what that means on disk.**
//!
//! **Nothing here enumerates `federation/data/peers/`.** That is the whole
//! containment, and it is structural rather than a rule anyone has to keep:
//! the only directory this module can name is the one a withdrawn grant's own
//! `scope` names, so there is no expression of "every cache that is no longer
//! justified" for a bug to reach. A cache directory nothing named cannot be
//! removed from here, whatever else goes wrong.
//!
//! That is also why an unscoped withdrawal deletes nothing — see [`names`].

use std::path::Path;

use base64::Engine;

use super::config::peer_dir;
use super::fetch::{is_safe_vault_id, permits_read};
use super::grant::{self, GrantStatement};
use super::key_id::KeyId;
use super::link::{self, SignedGrant, StoredGrant};
use super::state::{self, ReadableVaults};
use super::protocol_v5::{GrantWire, RevocationWire};

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Whether `st` could be this key's reason to hold a cached copy of
/// `vault_id`. Used to decide what **survives** a withdrawal, and by
/// [`ReadAuthority`] to decide what may still be read.
///
/// An unscoped grant — "every vault I own" — could be the reason for any of
/// them, so it answers true for all. On the deletion side that only ever
/// protects a cache, which is the safe direction to be uncertain in. On the
/// read side the same uncertainty is the permissive one, and [`ReadAuthority`]
/// says what that costs.
fn covers(st: &GrantStatement, me: &KeyId, vault_id: &str) -> bool {
    &st.to == me
        && permits_read(st.kind)
        && st.scope.as_deref().is_none_or(|scope| scope == vault_id)
}

/// What this machine may still read, as a question rather than a list.
///
/// It cannot be a list. An unscoped grant means "every vault this issuer
/// owns", and which vaults an issuer owns is hub state this client has never
/// held — so the covered ids are not enumerable from anything on this disk.
/// They can only be put to a candidate, which is exactly what the reader has:
/// a directory name it found under `peers/`.
///
/// Loaded once per config dir and then asked repeatedly. Re-reading the store
/// per candidate would let it change mid-sweep, and half a sweep against each
/// of two stores is an answer neither of them gave.
///
/// # The two questions a cache has to answer, and neither is enough alone.
///
/// 1. **Did the hub last say this key may read that vault?** — the persisted
///    [`ReadableVaults`] list. This is not a second opinion about authority:
///    a cache exists on disk only because the hub listed that vault and served
///    its index, so filtering on the hub's latest list is the same authority
///    that produced the cache, applied later.
/// 2. **Does a live grant cover it?** — [`covers`], over the local store.
///
/// **Neither alone is a boundary, and the pair is not belt-and-braces — each
/// bounds the other's exact failure.**
///
/// `covers` alone is over-permissive: an unscoped grant answers true for every
/// `vault_id`, a `link` is unscoped, and `link.rs::reconcile` stores one
/// addressed to this key for every machine that has ever linked to it — so on
/// a linked machine one row would cover every directory under `peers/`, and
/// multi-machine is the normal case. The list is the fact `covers` is
/// approximating and does not have: which vaults the issuer actually owns.
///
/// The list alone is over-permissive the other way: it does not expire, so a
/// client that has been offline for a year would go on serving from an answer
/// a year old. Grant expiry is what bounds that, and it needs no hub —
/// `grant.rs` refuses a statement whose `expires_at` is not after its
/// `issued_at`, so every grant lapses on a schedule an offline machine can
/// evaluate for itself. **No staleness timer over the list, deliberately.**
/// A second clock would be an arbitrary constant standing in for one that
/// already exists, a second thing to tune, and a second answer to reconcile
/// when the two disagree. The list says which vaults; the grants say for how
/// long.
///
/// What neither closes: a long-lived grant plus a client offline past a
/// revocation it never received. Nothing local can close that — it is the
/// CRL/OCSP problem — so `ll status` says how old this machine's read
/// authority is rather than pretending the question does not exist.
///
/// **Absence is not permission.** No identity, no readable store, no live
/// grant, and no list all end in nothing served. A machine that has never
/// completed a handshake has never been told it may read anything, and any
/// cache it holds is from before this rule — which is exactly the orphan this
/// exists to hide.
///
/// Loaded once per config dir and then asked repeatedly. Re-reading per
/// candidate would let the answer change mid-sweep, and half a sweep against
/// each of two answers is an answer neither of them gave.
///
/// **[`withdraw`] deliberately still asks only [`covers`].** A stale list
/// makes a reader serve less, which is unavailability and recoverable by one
/// `ll sync`; it would make a deleter destroy more, which is not recoverable
/// at all. The asymmetry is the same one that makes `covers` a safe "maybe"
/// for deletion and an unsafe one for reading, pointing the other way.
pub struct ReadAuthority {
    me: KeyId,
    live: Vec<GrantStatement>,
    listed: Option<ReadableVaults>,
}

impl ReadAuthority {
    /// Both halves as of `now`: the hub's last list, and every stored grant
    /// that verifies and has not expired.
    ///
    /// Fails when this machine has no identity. That is not a machine with
    /// nothing to read — it is a machine that cannot tell whether a grant is
    /// addressed to it, so it must be treated as no authority at all rather
    /// than as an empty one.
    pub fn load(config_dir: &Path, now: i64) -> anyhow::Result<Self> {
        Ok(Self {
            me: link::local_key_id(config_dir)?,
            live: verified(&link::load_grants(config_dir)?)
                .into_iter()
                .filter(|(_, _, st)| st.expires_at > now)
                .map(|(_, _, st)| st)
                .collect(),
            listed: state::read_readable_vaults(config_dir)?,
        })
    }

    /// Whether this machine may still hold a cached copy of `vault_id`: the
    /// hub last listed it, **and** a live grant covers it.
    pub fn covers(&self, vault_id: &str) -> bool {
        self.listed.as_ref().is_some_and(|listed| listed.contains(vault_id))
            && self.live.iter().any(|st| covers(st, &self.me, vault_id))
    }

    /// How old the hub's answer is, as of `now`. `None` when there is no
    /// answer — which is not a fresh one, and callers must not render it as
    /// one.
    pub fn age(&self, now: i64) -> Option<i64> {
        self.listed.as_ref().map(|listed| listed.age(now))
    }
}

/// The one cache `st` **names**, which is the only one its withdrawal may
/// remove. `None` when it names none.
///
/// Deliberately narrower than [`covers`], and the gap between them is the
/// honest one. `covers` answers "could this grant justify that cache?" —
/// a maybe is enough, because the answer only ever keeps data. This answers
/// "which cache did this grant justify?", and a maybe is not enough, because
/// the answer deletes. For an unscoped grant there is no answer to give:
/// `scope: None` means "every vault this issuer owns", and which vaults an
/// issuer owns is hub state this client has never held.
///
/// So an unscoped withdrawal removes nothing, and says so. **A `link` is
/// exactly that case**, which means the second-machine story currently leaves
/// its caches in place — an under-deletion, recorded and reported rather than
/// papered over. The alternative on offer was to delete every cache no
/// surviving grant justifies, and that is a garbage collector wearing a
/// revocation's clothes: it would silently dispose of directories written by
/// a previous protocol version, which is a migration decision and not this
/// one's to make. An under-delete is a follow-up task. An over-delete is
/// somebody's notes.
///
/// `assoc` names nothing either, by `permits_read` — it carries no read
/// authority, so it never justified a cache and its withdrawal takes none.
fn names<'a>(st: &'a GrantStatement, me: &KeyId) -> Option<&'a str> {
    if &st.to != me || !permits_read(st.kind) {
        return None;
    }
    st.scope.as_deref()
}

/// Remove the cache `gone` named, unless a still-live grant among `remaining`
/// also justifies it. Returns the vault id if one was removed.
///
/// Deletion is not best-effort. Spec:334 makes removing
/// `federation/data/peers/<vault_id>/` a hard requirement, and a client that
/// keeps serving material it no longer has a grant for is the failure the
/// requirement exists to prevent — so a failure here propagates.
///
/// The failure it must not produce is a dropped row beside a surviving cache:
/// the hub serves the same revocation next cycle, but with no local grant
/// behind it there is nothing left to say which directory it meant, and the
/// cache is orphaned for good. Every caller runs this **inside** the store's
/// lock, and `update_grants` writes nothing when the closure returns `Err` —
/// so the deletion and the row removal are one transaction and the order
/// between them inside the closure carries no weight. Mutating that order
/// kills no test, correctly: it is the lock and the write-on-success that
/// hold this, not a sequence anyone has to remember.
fn withdraw(
    config_dir: &Path,
    gone: &GrantStatement,
    remaining: &[GrantStatement],
    me: &KeyId,
    now: i64,
) -> anyhow::Result<Option<String>> {
    let Some(vault_id) = names(gone, me) else {
        if &gone.to == me && permits_read(gone.kind) {
            eprintln!(
                "a withdrawn unscoped grant from {} names no cache to remove — \"every vault \
                 this issuer owns\" is hub state this client has never held. Anything cached \
                 only because of it is left in place.",
                gone.from.as_str()
            );
        }
        return Ok(None);
    };
    // This id came out of a signed statement and is about to become a path
    // component. `config.rs`'s helpers assume a validated one and do not
    // check.
    if !is_safe_vault_id(vault_id) {
        eprintln!("refusing to act on a grant whose scope is not a usable vault id");
        return Ok(None);
    }
    if remaining.iter().any(|st| st.expires_at > now && covers(st, me, vault_id)) {
        return Ok(None);
    }
    let dir = peer_dir(config_dir, vault_id);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(Some(vault_id.to_string())),
        // Nothing cached for it. Applying the same revocation twice, or one
        // for a vault this client never read, is not a failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow::Error::new(e)
            .context(format!("removing the peer cache at {}", dir.display()))),
    }
}

/// Every stored row that parses and verifies, with its `grant_id` and its
/// index in the store.
///
/// A row that does not verify is skipped and left in place, the same way
/// `link.rs` treats one: this file is the machine's own record of what it
/// holds, and one unreadable row must not decide what gets deleted — in
/// either direction.
fn verified(rows: &[StoredGrant]) -> Vec<(usize, String, GrantStatement)> {
    rows.iter()
        .enumerate()
        .filter_map(|(i, row)| {
            let signed = row.signed().ok()?;
            let st = link::verify_grant(&signed).ok()?;
            Some((i, grant::grant_id(&signed.statement), st))
        })
        .collect()
}

/// Fold the grants `SyncReady` served into the store.
///
/// **Everything it served, not only the links.** `link.rs::reconcile` keeps
/// `link` rows alone because a link is all it acts on, and a store holding
/// only links has nothing to resolve a revoked `follow` against — the grant
/// is absent from `SyncReady.grants` by then and present only as a signed
/// revocation, so if it was never stored it can never be resolved, and every
/// `follow` and `peer` revocation would correctly-but-uselessly delete
/// nothing forever.
///
/// Lodged on arrival: the hub has these by definition, it just sent them.
///
/// Creates no peer cache. Nothing here touches `federation/data/`, which is
/// what makes an `assoc` unable to produce one — not a check that could be
/// forgotten, but that caching is somebody else's job entirely.
pub fn apply_grants(config_dir: &Path, grants: &[GrantWire]) -> anyhow::Result<usize> {
    let mut fresh: Vec<(String, SignedGrant)> = Vec::new();
    for wire in grants {
        if wire.state != "active" {
            continue;
        }
        let (Ok(statement), Ok(signature)) =
            (B64.decode(&wire.statement_b64), B64.decode(&wire.signature_b64))
        else {
            eprintln!("skipping a grant that is not valid base64");
            continue;
        };
        let signed = SignedGrant { statement, signature };
        // Self-authenticating, exactly as `reconcile` and the hub treat one:
        // the signature is checked against the key the statement names as
        // issuer. The hub carries grants; it does not vouch for them.
        if let Err(e) = link::verify_grant(&signed) {
            eprintln!("skipping a grant that does not verify: {e}");
            continue;
        }
        fresh.push((grant::grant_id(&signed.statement), signed));
    }
    link::update_grants(config_dir, |rows| {
        let mut added = 0;
        for (id, signed) in &fresh {
            match rows.iter_mut().find(|row| link::has_id(row, id)) {
                Some(existing) => existing.lodged = true,
                None => {
                    rows.push(link::stored(signed, true));
                    added += 1;
                }
            }
        }
        Ok(added)
    })
}

/// Apply the revocations `SyncReady` served, deleting what they withdraw.
///
/// The rule, and every line of it is load-bearing:
///
/// - **no stored grant with this `grant_id`** — delete nothing. There is no
///   grant to say who could revoke it, nor what it justified.
/// - **not signed by that grant's `from`** — reject. Only the issuer may
///   withdraw its own statement. This is not written as a branch: the stored
///   grant's `from` is what gets passed to `verify_revocation` as
///   `expected_by`, so a revocation signed by anyone else simply matches no
///   row, and the line above stops being a rule anyone has to remember.
/// - **`scope` disagrees with the stored grant's `scope`** — refuse, and do
///   *not* fall back to the broader reading. An issuer signing a revocation
///   naming a scope its grant never carried is either a bug or an attempt to
///   widen a withdrawal into vaults it was never owed, and "when in doubt,
///   delete more" is not a safe default when the two readings differ by
///   "every vault on this disk".
/// - **otherwise** — delete the cache the *stored* grant names, if any.
///
/// One locked section over the whole list: resolving a revocation against a
/// store another writer is appending to gives an answer that has already
/// stopped being true.
pub fn apply_revocations(
    config_dir: &Path,
    revocations: &[RevocationWire],
    me: &KeyId,
    now: i64,
) -> anyhow::Result<Vec<String>> {
    let mut parsed: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for wire in revocations {
        let (Ok(statement), Ok(signature)) =
            (B64.decode(&wire.statement_b64), B64.decode(&wire.signature_b64))
        else {
            eprintln!("skipping a revocation that is not valid base64");
            continue;
        };
        parsed.push((statement, signature));
    }

    link::update_grants(config_dir, |rows| {
        let mut deleted = Vec::new();
        for (statement, signature) in &parsed {
            let held = verified(rows);
            let found = held.iter().find_map(|(i, id, st)| {
                let rev = grant::verify_revocation(statement, signature, &st.from).ok()?;
                (&rev.grant_id == id).then_some((*i, st, rev))
            });
            let Some((idx, gone, rev)) = found else {
                eprintln!(
                    "ignoring a revocation this machine holds no grant for: deleting nothing"
                );
                continue;
            };
            if rev.scope != gone.scope {
                eprintln!(
                    "refusing a revocation of {}: it names scope {:?}, the grant it withdraws \
                     carries {:?}",
                    rev.grant_id, rev.scope, gone.scope
                );
                continue;
            }
            let remaining: Vec<GrantStatement> =
                held.iter().filter(|(i, _, _)| *i != idx).map(|(_, _, st)| st.clone()).collect();
            deleted.extend(withdraw(config_dir, gone, &remaining, me, now)?);
            rows.remove(idx);
        }
        Ok(deleted)
    })
}

/// Expiry is the backstop: a grant nobody withdrew still stops meaning
/// anything, and the cache it named has to go with it (spec:332).
///
/// The lapsed rows go too. A grant that can never again justify a read is
/// dead weight in a file every sync reads, and `link.rs` already treats an
/// expired row as absent everywhere it looks.
pub fn prune_expired(config_dir: &Path, me: &KeyId, now: i64) -> anyhow::Result<Vec<String>> {
    link::update_grants(config_dir, |rows| {
        let mut deleted = Vec::new();
        loop {
            let held = verified(rows);
            let Some((idx, _, gone)) = held.iter().find(|(_, _, st)| st.expires_at <= now) else {
                break;
            };
            let remaining: Vec<GrantStatement> =
                held.iter().filter(|(i, _, _)| i != idx).map(|(_, _, st)| st.clone()).collect();
            deleted.extend(withdraw(config_dir, gone, &remaining, me, now)?);
            rows.remove(*idx);
        }
        Ok(deleted)
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicI64, Ordering};

    use ed25519_dalek::{Signer, SigningKey};
    use tempfile::TempDir;

    use super::super::config::peers_dir;
    use super::super::grant::{GrantKind, RevocationStatement};
    use super::*;

    const NOW: i64 = 5_000;
    const LATER: i64 = 9_000;

    /// Every statement in a test needs a nonce of its own, or two grants of
    /// the same shape hash to one `grant_id` and the store dedupes them.
    static NONCE: AtomicI64 = AtomicI64::new(0);

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn id(k: &SigningKey) -> KeyId {
        KeyId::from_pubkey(&k.verifying_key())
    }

    fn sign(k: &SigningKey, statement: Vec<u8>) -> SignedGrant {
        let signature = k.sign(&statement).to_bytes().to_vec();
        SignedGrant { statement, signature }
    }

    fn issue(
        from: &SigningKey,
        to: &KeyId,
        kind: GrantKind,
        scope: Option<&str>,
        expires_at: i64,
    ) -> SignedGrant {
        sign(
            from,
            grant::canonical_bytes(&GrantStatement {
                v: 5,
                kind,
                from: id(from),
                to: to.clone(),
                scope: scope.map(str::to_string),
                issued_at: 1,
                expires_at,
                nonce: format!("nonce-{}", NONCE.fetch_add(1, Ordering::Relaxed)),
            }),
        )
    }

    fn wire(g: &SignedGrant) -> GrantWire {
        GrantWire {
            statement_b64: B64.encode(&g.statement),
            signature_b64: B64.encode(&g.signature),
            state: "active".to_string(),
        }
    }

    /// A revocation of `grant_id`, signed by `by`, naming `scope`. Every
    /// argument is independently wrong-able, which is the point: the three
    /// ways a revocation can fail to resolve are three of these arguments.
    fn revocation(by: &SigningKey, grant_id: &str, scope: Option<&str>) -> RevocationWire {
        let statement = grant::canonical_bytes(&RevocationStatement {
            v: 5,
            kind: "revoke",
            grant_id: grant_id.to_string(),
            by: id(by),
            scope: scope.map(str::to_string),
            at: 2,
        });
        let signature = by.sign(&statement).to_bytes().to_vec();
        RevocationWire {
            statement_b64: B64.encode(&statement),
            signature_b64: B64.encode(&signature),
        }
    }

    fn revoking(by: &SigningKey, g: &SignedGrant) -> RevocationWire {
        let st: GrantStatement = serde_json::from_slice(&g.statement).unwrap();
        revocation(by, &grant::grant_id(&g.statement), st.scope.as_deref())
    }

    /// A peer cache with a file in it, so "the directory is gone" is a claim
    /// about content and not just about an empty directory nobody wrote to.
    fn cache(dir: &Path, vault_id: &str) -> PathBuf {
        let path = peer_dir(dir, vault_id);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("index.db"), b"peer data").unwrap();
        path
    }

    fn cached(dir: &Path, vault_id: &str) -> bool {
        peer_dir(dir, vault_id).join("index.db").exists()
    }

    /// A store holding exactly `grants`, and the key they are addressed to.
    fn store(grants: &[&SignedGrant]) -> (TempDir, KeyId) {
        let dir = tempfile::tempdir().unwrap();
        let wires: Vec<GrantWire> = grants.iter().map(|g| wire(g)).collect();
        apply_grants(dir.path(), &wires).unwrap();
        (dir, id(&key(9)))
    }

    fn rows(dir: &Path) -> usize {
        link::load_grants(dir).unwrap().len()
    }

    // -- the store ---------------------------------------------------------

    /// `link.rs::reconcile` keeps `link` rows and drops the rest. A store
    /// that did the same could never resolve a revoked `follow`, because by
    /// the time the revocation arrives the grant is gone from `SyncReady`.
    #[test]
    fn every_kind_is_stored_not_only_the_links() {
        let me = id(&key(9));
        let a = key(1);
        let grants = [
            issue(&a, &me, GrantKind::Link, None, LATER),
            issue(&a, &me, GrantKind::Follow, Some("v-follow"), LATER),
            issue(&a, &me, GrantKind::Peer, Some("v-peer"), LATER),
            issue(&a, &me, GrantKind::Assoc, Some("v-work"), LATER),
        ];
        let dir = tempfile::tempdir().unwrap();
        let wires: Vec<GrantWire> = grants.iter().map(wire).collect();

        assert_eq!(apply_grants(dir.path(), &wires).unwrap(), 4);
        assert_eq!(rows(dir.path()), 4, "a revocation can only resolve against a grant we kept");
    }

    #[test]
    fn a_grant_already_in_the_store_is_not_stored_twice() {
        let me = id(&key(9));
        let g = issue(&key(1), &me, GrantKind::Follow, Some("v-other"), LATER);
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(apply_grants(dir.path(), &[wire(&g)]).unwrap(), 1);
        assert_eq!(apply_grants(dir.path(), &[wire(&g)]).unwrap(), 0);
        assert_eq!(rows(dir.path()), 1);
    }

    /// A `follow` is lodged `pending` and becomes active only once its `to`
    /// key has decided. `fetch.rs` and `link.rs::reconcile` both refuse a row
    /// the hub does not call active, and a store that kept one would hand a
    /// later revocation something to resolve against that was never in force.
    #[test]
    fn a_grant_the_hub_does_not_call_active_is_not_stored() {
        let me = id(&key(9));
        let g = issue(&key(1), &me, GrantKind::Follow, Some("v-other"), LATER);
        let pending = GrantWire { state: "pending".to_string(), ..wire(&g) };
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(apply_grants(dir.path(), &[pending]).unwrap(), 0);
        assert_eq!(rows(dir.path()), 0);
    }

    /// The hub carries grants; it does not vouch for them.
    #[test]
    fn a_grant_whose_signature_does_not_check_out_is_not_stored() {
        let me = id(&key(9));
        let g = issue(&key(1), &me, GrantKind::Follow, Some("v-other"), LATER);
        let forged = GrantWire {
            statement_b64: B64.encode(&g.statement),
            signature_b64: B64.encode(key(2).sign(&g.statement).to_bytes()),
            state: "active".to_string(),
        };
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(apply_grants(dir.path(), &[forged]).unwrap(), 0);
        assert_eq!(rows(dir.path()), 0);
    }

    /// `assoc` is attribution only. Nothing in `apply_grants` writes under
    /// `federation/data/`, so storing one cannot produce the read access the
    /// model deliberately withholds.
    #[test]
    fn an_assoc_grant_never_produces_a_peer_cache() {
        let me = id(&key(9));
        let g = issue(&key(1), &me, GrantKind::Assoc, Some("v-work"), LATER);
        let dir = tempfile::tempdir().unwrap();

        apply_grants(dir.path(), &[wire(&g)]).unwrap();

        assert!(!peer_dir(dir.path(), "v-work").exists());
        assert!(!peers_dir(dir.path()).exists(), "nothing under data/ was touched at all");
    }

    // -- revocation: the resolution rule -----------------------------------

    #[test]
    fn a_revocation_deletes_the_cache_its_grant_justified() {
        let a = key(1);
        let c = key(2);
        let me = id(&key(9));
        let revoked = issue(&a, &me, GrantKind::Follow, Some("v-other"), LATER);
        let kept = issue(&c, &me, GrantKind::Follow, Some("v-keep"), LATER);
        let (dir, me) = store(&[&revoked, &kept]);
        cache(dir.path(), "v-other");
        cache(dir.path(), "v-keep");

        let deleted =
            apply_revocations(dir.path(), &[revoking(&a, &revoked)], &me, NOW).unwrap();

        assert_eq!(deleted, vec!["v-other".to_string()]);
        assert!(!cached(dir.path(), "v-other"),
            "data already read cannot be recalled, but continuing to serve it is not revocation");
        assert!(cached(dir.path(), "v-keep"), "a cache another grant justifies is untouched");
        assert_eq!(rows(dir.path()), 1, "the withdrawn grant is gone from the store");
    }

    /// The first line of the rule. A signature proves someone signed those
    /// bytes, not that the right someone did — and with no stored grant there
    /// is nobody it could be checked against.
    #[test]
    fn a_revocation_this_machine_holds_no_grant_for_deletes_nothing() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-other"), LATER);
        let (dir, me) = store(&[&held]);
        cache(dir.path(), "v-other");

        // Correctly signed by A, correctly scoped — and naming a grant id
        // this machine has never seen.
        let stray = revocation(&a, &"ab".repeat(32), Some("v-other"));
        let deleted = apply_revocations(dir.path(), &[stray], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(cached(dir.path(), "v-other"));
        assert_eq!(rows(dir.path()), 1);
    }

    /// The second line. Only the issuer may withdraw its own statement, and
    /// the stored grant is the only thing that says who the issuer was.
    #[test]
    fn a_revocation_signed_by_anyone_but_the_issuer_deletes_nothing() {
        let a = key(1);
        let stranger = key(3);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-other"), LATER);
        let (dir, me) = store(&[&held]);
        cache(dir.path(), "v-other");

        let forged = revoking(&stranger, &held);
        let deleted = apply_revocations(dir.path(), &[forged], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(cached(dir.path(), "v-other"), "a stranger cannot revoke A's grant");
        assert_eq!(rows(dir.path()), 1);
    }

    /// The third line, in the direction that matters most: a scoped grant
    /// revoked by an UNSCOPED revocation. Falling back to the broader reading
    /// would turn "withdraw this one vault" into "delete every cache on this
    /// disk", which is why the mismatch refuses rather than widens.
    #[test]
    fn an_unscoped_revocation_of_a_scoped_grant_is_refused_not_widened() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-other"), LATER);
        let (dir, me) = store(&[&held]);
        cache(dir.path(), "v-other");
        cache(dir.path(), "v-elsewhere");

        let widened = revocation(&a, &grant::grant_id(&held.statement), None);
        let deleted = apply_revocations(dir.path(), &[widened], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(cached(dir.path(), "v-other"), "the narrow reading is not applied either");
        assert!(cached(dir.path(), "v-elsewhere"));
        assert_eq!(rows(dir.path()), 1, "and the grant is not withdrawn on a refusal");
        assert_eq!(rows(dir.path()), 1);
    }

    /// The same line in the opposite direction: an unscoped grant revoked by
    /// a revocation that names one vault. Narrowing is as wrong as widening —
    /// it would leave every other cache the link justified in place.
    #[test]
    fn a_scoped_revocation_of_an_unscoped_grant_is_refused_not_narrowed() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Link, None, LATER);
        let (dir, me) = store(&[&held]);
        cache(dir.path(), "v-one");
        cache(dir.path(), "v-two");

        let narrowed = revocation(&a, &grant::grant_id(&held.statement), Some("v-one"));
        let deleted = apply_revocations(dir.path(), &[narrowed], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(cached(dir.path(), "v-one"));
        assert!(cached(dir.path(), "v-two"));
        assert_eq!(rows(dir.path()), 1);
    }

    /// The fourth line, in the case that has no answer. `scope: None` means
    /// "every vault this issuer owns", and ownership is hub state this client
    /// has never held — so an unscoped withdrawal names no cache and removes
    /// none.
    ///
    /// This is a deliberate under-deletion and it is the `link` case, which
    /// is to say the second-machine story. The alternative was to delete
    /// every cache no surviving grant justifies; that is a garbage collector
    /// wearing a revocation's clothes, and revoking a link is an arbitrary
    /// moment to run one over directories a previous protocol version wrote.
    #[test]
    fn an_unscoped_revocation_names_no_cache_and_removes_none() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Link, None, LATER);
        let (dir, me) = store(&[&held]);
        cache(dir.path(), "v-one");
        cache(dir.path(), "v-two");

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(cached(dir.path(), "v-one"));
        assert!(cached(dir.path(), "v-two"));
        assert_eq!(rows(dir.path()), 0, "the grant is still withdrawn from the store");
    }

    /// A scoped revocation must not take a cache somebody else's grant still
    /// justifies. `covers` is asked of the survivors, so an unscoped `link`
    /// from anyone counts as a reason to keep it — uncertainty protects.
    #[test]
    fn a_revocation_keeps_a_cache_another_grant_still_justifies() {
        let a = key(1);
        let c = key(2);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-two"), LATER);
        let link_from_c = issue(&c, &me, GrantKind::Link, None, LATER);
        let (dir, me) = store(&[&held, &link_from_c]);
        cache(dir.path(), "v-two");

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(cached(dir.path(), "v-two"),
            "revoking one person's follow must not delete what another person's link justifies");
    }

    /// The other half of the `assoc` rule. It carries no read authority, so
    /// it cannot be the reason a cache survives a revocation that would
    /// otherwise take it.
    #[test]
    fn an_assoc_never_keeps_a_cache_alive() {
        let a = key(1);
        let c = key(2);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-two"), LATER);
        let assoc = issue(&c, &me, GrantKind::Assoc, Some("v-two"), LATER);
        let (dir, me) = store(&[&held, &assoc]);
        cache(dir.path(), "v-two");

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW).unwrap();

        assert_eq!(deleted, vec!["v-two".to_string()]);
        assert!(!cached(dir.path(), "v-two"), "an assoc is not a reason to keep a cache");
    }

    /// The `assoc` rule on the withdrawal side, which is the side the
    /// survivor test cannot reach. An `assoc` scoped to a vault names it
    /// perfectly well — and still removes nothing, because it never produced
    /// that cache and so was never the reason for it. Whatever wrote it, an
    /// `assoc` being withdrawn is not the event that should take it away.
    #[test]
    fn revoking_an_assoc_removes_no_cache() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Assoc, Some("v-work"), LATER);
        let (dir, me) = store(&[&held]);
        cache(dir.path(), "v-work");

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(cached(dir.path(), "v-work"), "assoc carries no read authority in either direction");
    }

    /// The scope reaches `withdraw` out of a signed statement and lands in a
    /// path component, and `config.rs`'s helpers assume a validated id. An
    /// issuer can sign whatever it likes into that field — `grant::verify`
    /// has no opinion on it — so a scope that escapes `peers/` must be
    /// refused before it reaches `remove_dir_all`.
    ///
    /// **`peers/` has to exist for this to test anything.** `remove_dir_all`
    /// really does resolve `peers/../secret` and delete through it — measured,
    /// not assumed — but only when `peers/` is there for the kernel to walk.
    /// Without it the call fails `NotFound`, `withdraw` reports nothing
    /// removed, and the test passes with the guard deleted. It did exactly
    /// that for one round: a test that fails to delete for an incidental
    /// reason is indistinguishable from a guard doing its job.
    #[test]
    fn a_scope_that_is_not_a_usable_vault_id_removes_nothing() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("../secret"), LATER);
        let (dir, me) = store(&[&held]);
        let innocent = cache(dir.path(), "v-other");
        let outside = super::super::config::data_dir(dir.path()).join("secret");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.db"), b"not a peer cache").unwrap();

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(outside.join("keep.db").exists(),
            "a signed statement does not get to name a path outside the peer cache");
        assert!(innocent.exists(), "and the traversal was reachable: peers/ was there to walk");
    }

    /// A grant this machine ISSUED gives this machine no read, so it is not
    /// the reason for any cache and revoking it deletes none.
    #[test]
    fn revoking_a_grant_this_machine_issued_deletes_no_cache_of_its_own() {
        let mine = key(9);
        let other = id(&key(1));
        let held = issue(&mine, &other, GrantKind::Follow, Some("v-other"), LATER);
        let (dir, me) = store(&[&held]);
        cache(dir.path(), "v-other");

        let deleted = apply_revocations(dir.path(), &[revoking(&mine, &held)], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(cached(dir.path(), "v-other"),
            "our own grant to somebody else was never why we held this");
        assert_eq!(rows(dir.path()), 0, "it is still withdrawn from the store");
    }

    #[test]
    fn applying_the_same_revocation_twice_is_idempotent() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-other"), LATER);
        let (dir, me) = store(&[&held]);
        cache(dir.path(), "v-other");
        let rev = revoking(&a, &held);

        assert_eq!(
            apply_revocations(dir.path(), std::slice::from_ref(&rev), &me, NOW).unwrap(),
            vec!["v-other".to_string()]
        );
        assert!(apply_revocations(dir.path(), &[rev], &me, NOW).unwrap().is_empty());
    }

    // -- expiry, the backstop ----------------------------------------------

    #[test]
    fn a_lapsed_grant_loses_its_cache_too() {
        let a = key(1);
        let me = id(&key(9));
        let lapsed = issue(&a, &me, GrantKind::Follow, Some("v-other"), NOW - 1);
        let live = issue(&a, &me, GrantKind::Follow, Some("v-keep"), LATER);
        let (dir, me) = store(&[&lapsed, &live]);
        cache(dir.path(), "v-other");
        cache(dir.path(), "v-keep");

        let deleted = prune_expired(dir.path(), &me, NOW).unwrap();

        assert_eq!(deleted, vec!["v-other".to_string()]);
        assert!(!cached(dir.path(), "v-other"), "lapsing must have the same effect as revoking");
        assert!(cached(dir.path(), "v-keep"));
        assert_eq!(rows(dir.path()), 1);
    }

    #[test]
    fn an_active_grant_keeps_its_cache() {
        let a = key(1);
        let me = id(&key(9));
        let live = issue(&a, &me, GrantKind::Follow, Some("v-other"), LATER);
        let (dir, me) = store(&[&live]);
        cache(dir.path(), "v-other");

        assert!(prune_expired(dir.path(), &me, NOW).unwrap().is_empty());
        assert!(cached(dir.path(), "v-other"));
        assert_eq!(rows(dir.path()), 1);
    }

    /// Two grants covering one vault, one lapsed and one not. Expiry is a
    /// backstop, not a sweep: it removes the reason that ran out, and the
    /// cache goes only when no reason is left.
    #[test]
    fn a_lapsed_grant_does_not_take_a_cache_another_grant_still_covers() {
        let a = key(1);
        let c = key(2);
        let me = id(&key(9));
        let lapsed = issue(&a, &me, GrantKind::Follow, Some("v-other"), NOW - 1);
        let live = issue(&c, &me, GrantKind::Follow, Some("v-other"), LATER);
        let (dir, me) = store(&[&lapsed, &live]);
        cache(dir.path(), "v-other");

        assert!(prune_expired(dir.path(), &me, NOW).unwrap().is_empty());
        assert!(cached(dir.path(), "v-other"));
        assert_eq!(rows(dir.path()), 1, "the lapsed row still goes");
    }

    /// Expiry names what a revocation names — no more. A lapsed `link` is
    /// unscoped, so it takes nothing, for the reason `names` gives.
    #[test]
    fn a_lapsed_unscoped_grant_takes_no_cache_either() {
        let a = key(1);
        let me = id(&key(9));
        let lapsed = issue(&a, &me, GrantKind::Link, None, NOW - 1);
        let (dir, me) = store(&[&lapsed]);
        cache(dir.path(), "v-other");

        assert!(prune_expired(dir.path(), &me, NOW).unwrap().is_empty());
        assert!(cached(dir.path(), "v-other"));
        assert_eq!(rows(dir.path()), 0, "the lapsed row still goes");
    }

    /// Two lapsed grants, one cache each. Stopping after the first would
    /// leave the second being served with nothing behind it.
    #[test]
    fn every_lapsed_grant_is_pruned_not_just_the_first() {
        let a = key(1);
        let me = id(&key(9));
        let one = issue(&a, &me, GrantKind::Follow, Some("v-one"), NOW - 1);
        let two = issue(&a, &me, GrantKind::Follow, Some("v-two"), NOW - 1);
        let (dir, me) = store(&[&one, &two]);
        cache(dir.path(), "v-one");
        cache(dir.path(), "v-two");

        let mut deleted = prune_expired(dir.path(), &me, NOW).unwrap();
        deleted.sort();

        assert_eq!(deleted, vec!["v-one".to_string(), "v-two".to_string()]);
        assert_eq!(rows(dir.path()), 0);
    }

    /// Two revocations in one `SyncReady`. Same reason.
    #[test]
    fn every_revocation_in_a_batch_is_applied_not_just_the_first() {
        let a = key(1);
        let me = id(&key(9));
        let one = issue(&a, &me, GrantKind::Follow, Some("v-one"), LATER);
        let two = issue(&a, &me, GrantKind::Follow, Some("v-two"), LATER);
        let (dir, me) = store(&[&one, &two]);
        cache(dir.path(), "v-one");
        cache(dir.path(), "v-two");

        let deleted = apply_revocations(
            dir.path(),
            &[revoking(&a, &one), revoking(&a, &two)],
            &me,
            NOW,
        )
        .unwrap();

        assert_eq!(deleted, vec!["v-one".to_string(), "v-two".to_string()]);
        assert_eq!(rows(dir.path()), 0);
    }

    // -- the first remove_dir_all in this crate ----------------------------

    /// The only directory a withdrawal can name is the one its own grant
    /// named. Everything else in `peers/` is untouchable from here, because
    /// nothing in this module enumerates the directory at all.
    ///
    /// **The v4 display-name cache is the one that matters**, and it is the
    /// regression test for the ruling rather than for the code: a v4
    /// directory is content from a different protocol version, and disposing
    /// of it is a migration decision with a different blast radius from a
    /// revocation. The instinct to "also clean up the obviously stale one"
    /// is exactly what this forbids.
    #[test]
    fn a_withdrawal_removes_the_cache_its_grant_named_and_nothing_else() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-one"), LATER);
        let (dir, me) = store(&[&held]);
        cache(dir.path(), "v-one");
        let v4 = cache(dir.path(), "thomas_kirk");
        let unrelated = cache(dir.path(), "v-two");
        let stray = peers_dir(dir.path()).join("not a vault id");
        std::fs::create_dir_all(&stray).unwrap();
        let sibling = super::super::config::data_dir(dir.path()).join("local-export.db");
        std::fs::write(&sibling, b"not a peer").unwrap();
        let loose = peers_dir(dir.path()).join("loose-file");
        std::fs::write(&loose, b"not a directory").unwrap();

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW).unwrap();

        assert_eq!(deleted, vec!["v-one".to_string()]);
        assert!(v4.exists(),
            "a v4 display-name cache is a migration decision, not a revocation's to make");
        assert!(unrelated.exists(), "no grant named it, so nothing may remove it");
        assert!(stray.exists());
        assert!(sibling.exists(), "nothing outside peers/ is reachable");
        assert!(loose.exists(), "a file is not a peer cache");
    }

    /// The same, for the widest thing a revocation can be. An unscoped
    /// withdrawal is the case an earlier draft answered by deleting every
    /// unjustified cache; here it must leave a directory it cannot name.
    #[test]
    fn an_unscoped_withdrawal_leaves_a_v4_display_name_cache_alone() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Link, None, LATER);
        let (dir, me) = store(&[&held]);
        let v4 = cache(dir.path(), "thomas_kirk");

        assert!(apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW).unwrap().is_empty());
        assert!(v4.exists(), "revoking a link is an arbitrary moment to run a garbage collector");
    }

    /// A deletion and its row removal are one transaction. The failure this
    /// forbids is a dropped row beside a surviving cache: the hub serves the
    /// same revocation next cycle, but with the grant gone there is nothing
    /// left to say which directory it meant, and the cache is orphaned for
    /// good.
    ///
    /// Proved by making the deletion fail rather than by reading the code's
    /// order: the cache directory is made read-only, so nothing inside it can
    /// be unlinked and `remove_dir_all` fails with the index still in place.
    ///
    /// The read-only bit goes on the cache and not on `peers/` above it
    /// deliberately. A read-only parent also fails, but only at the last
    /// step — `remove_dir_all` has emptied the directory by then and left an
    /// empty husk. It is not atomic, and a test that chose that spot would
    /// have been asserting the wrong thing survived.
    #[cfg(unix)]
    #[test]
    fn a_deletion_that_fails_leaves_the_grant_in_the_store() {
        use std::os::unix::fs::PermissionsExt;

        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-other"), LATER);
        let (dir, me) = store(&[&held]);
        let cache_dir = cache(dir.path(), "v-other");
        std::fs::set_permissions(&cache_dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let outcome = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW);

        std::fs::set_permissions(&cache_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(outcome.is_err(), "best-effort deletion would make revocation theatre");
        assert!(cached(dir.path(), "v-other"), "the cache is still there, so the reason must be");
        assert_eq!(rows(dir.path()), 1, "the next cycle can still resolve this revocation");
    }
}
