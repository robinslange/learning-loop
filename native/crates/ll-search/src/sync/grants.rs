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
//!
//! # The rule this file keeps rediscovering
//!
//! **A predicate built on possibly-absent information may gate KEEPING. It
//! must never gate DELETING.**
//!
//! Three pairs in this codebase are that one rule, and each was argued from
//! scratch before anyone noticed it was the same argument:
//!
//! - [`covers`] vs [`names`]. Both ask what a grant is about. `covers` admits
//!   a maybe, because an unscoped grant *might* be the reason for any cache
//!   and admitting it only ever keeps one. `names` refuses the same maybe,
//!   because its answer deletes.
//! - [`ReadAuthority`] vs [`withdraw`]. Both consult the hub's persisted
//!   list, and where in the expression is the whole of the difference. A
//!   stale list is *missing entries*. The reader ANDs it into what may be
//!   served, so missing entries serve less. The deleter uses it as a
//!   precondition on deleting, so missing entries delete less. What
//!   `withdraw` must never do is move it into its bail-out: the bail-out
//!   protects, so a missing entry there makes the bail-out false and the
//!   deletion **happen**.
//! - `read_state` vs `read_readable_vaults` (`state.rs`). Both turn an
//!   unreadable file into `None`. One is a report whose corrupt case must not
//!   block the cycle that rewrites it; the other is a read-authority record
//!   whose corrupt case must mean serve nothing.
//!
//! **Two questions with opposite safety senses are not two answers to one
//! question.** Making them agree looks like removing a duplicate and is
//! actually removing the asymmetry that keeps one of them safe. The bail-out
//! is measured — deleting it reddens
//! `a_revocation_keeps_a_cache_another_grant_still_justifies` and
//! `a_lapsed_grant_does_not_take_a_cache_another_grant_still_covers`, both of
//! which then delete a cache a live grant covers.
//!
//! Adding the list to that bail-out is a different matter and no test will
//! catch it, because since the deletion gate landed it does nothing: the only
//! inputs the extra conjunct changes are the ones the gate already refuses
//! two lines further down. Measured, not assumed — the mutant is green. The
//! reason to still not write it is that it states a rule the opposite way
//! round from the one that holds.

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
///    that produced the cache, applied later. **"This key" is a field on the
///    record, not a property of the file's location.** `ll recover` replaces
///    the seed and leaves the file, so a list matching no key on this machine
///    is a list this machine was never handed, and [`Self::load`] drops it.
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
/// **[`withdraw`] reads the same list, and the difference is where in the
/// expression, not whether.** It uses `covers` in a *protective* position —
/// it bails out of deleting when something still covers the cache — so a
/// stale list moved into that bail-out would make the bail-out false and the
/// deletion happen. It goes in as a precondition on the deletion instead,
/// where a missing entry blocks it. Same file, opposite position, because the
/// same staleness that makes a reader serve less would make a deleter destroy
/// more. See the module doc's rule.
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
        let me = link::local_key_id(config_dir)?;
        Ok(Self {
            live: verified(&link::load_grants(config_dir)?)
                .into_iter()
                .filter(|(_, _, st)| st.expires_at > now)
                .map(|(_, _, st)| st)
                .collect(),
            listed: listed_for(config_dir, &me)?,
            me,
        })
    }

    /// Whether this machine may still hold a cached copy of `vault_id`: the
    /// hub last listed it, **and** a live grant covers it.
    pub fn covers(&self, vault_id: &str) -> bool {
        self.listed.as_ref().is_some_and(|listed| listed.contains(vault_id))
            && self.live.iter().any(|st| covers(st, &self.me, vault_id))
    }
}

/// The last list the hub gave **this** key, or `None`.
///
/// One expression of "whose list is this", because both callers ask the same
/// question and `ll recover` is what makes the answer ever be no: the file
/// survives an identity change untouched, so a record naming another key is a
/// record this machine was never handed.
fn listed_for(config_dir: &Path, me: &KeyId) -> anyhow::Result<Option<ReadableVaults>> {
    Ok(state::read_readable_vaults(config_dir)?.filter(|listed| &listed.me == me))
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
/// also justifies it, or the hub's last list to this key never named it.
/// Returns the vault id if one was removed.
///
/// # Why `listed` gates the deletion
///
/// [`names`] returns whatever string the issuer signed into `scope`, and a
/// signature says who WROTE that string, not that they had any standing over
/// it. `apply_grants` checks only the signature, and a hub admits its members
/// to lodge grants addressed to each other — so without this gate any
/// co-member who knows this key's `KeyId` picks a `remove_dir_all` target on
/// this disk, by lodging a `peer` grant scoped to whatever it likes and then
/// revoking its own grant.
///
/// The gate is the module's rule in its permitted polarity: absence blocks
/// the delete, and can never allow one. The ordering it depends on is
/// `run_cycle`'s — `apply_revocations`, then `prune_expired`, then, six
/// statements later, `write_readable_vaults` — so what is read here is always
/// the PREVIOUS cycle's list, which still names a vault the hub is revoking
/// this cycle. Both callers have exactly one production caller each, and it
/// is that one.
///
/// **What it costs, and it is a real cost.** A revocation that arrives after
/// the hub has stopped listing the vault is now blocked permanently: the row
/// is removed on the same pass, so the revocation can never resolve again.
/// That is a new permanent under-delete, alongside the unscoped one [`names`]
/// already records. It is the direction this module chose in its own words —
/// an under-delete is a follow-up task, an over-delete is somebody's notes —
/// and the caches on both sides of this particular trade are ones
/// [`ReadAuthority`] refuses to serve, because its live-grant half is the
/// same predicate as the bail-out below and its list half is this gate. The
/// bytes stay on disk and nothing reads them. **That is not the same as the
/// deletion being authorized**, and nothing here should be read as saying a
/// stranger's grant is a reason to delete anything.
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
    listed: Option<&ReadableVaults>,
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
    if !listed.is_some_and(|listed| listed.contains(vault_id)) {
        eprintln!(
            "a withdrawn grant from {} names the cache at {vault_id}, which is not on the last \
             list the hub gave this key. This machine was never told it could read that vault, \
             so a grant naming it is not authority to delete it. Left in place.",
            gone.from.as_str()
        );
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
/// **No expiry filter here, unlike `link::reconcile` and `fetch::live_grants`,
/// and not by omission.** Those two are asking what a grant still entitles
/// this machine to, where a lapsed one must answer nothing. This is asking
/// what the store should hold, and a lapsed statement is exactly what
/// [`prune_expired`] needs to find in order to take the cache that statement
/// named — `run_cycle` runs it seven lines after this. A grant refused at the
/// door names nothing, so filtering here would leave its cache in place.
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

    let listed = listed_for(config_dir, me)?;
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
            deleted.extend(withdraw(config_dir, gone, &remaining, listed.as_ref(), me, now)?);
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
    let listed = listed_for(config_dir, me)?;
    link::update_grants(config_dir, |rows| {
        let mut deleted = Vec::new();
        loop {
            let held = verified(rows);
            let Some((idx, _, gone)) = held.iter().find(|(_, _, st)| st.expires_at <= now) else {
                break;
            };
            let remaining: Vec<GrantStatement> =
                held.iter().filter(|(i, _, _)| i != idx).map(|(_, _, st)| st.clone()).collect();
            deleted.extend(withdraw(config_dir, gone, &remaining, listed.as_ref(), me, now)?);
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
        revocation(by, &grant::grant_id(&g.statement), statement(g).scope.as_deref())
    }

    /// A peer cache with a file in it, so "the directory is gone" is a claim
    /// about content and not just about an empty directory nobody wrote to —
    /// **and the hub's list naming it, because in production the two arrive
    /// together.** `fetch.rs` is the only writer under `peers/` and it writes
    /// exactly the vaults the handshake listed, so a listed-but-uncached vault
    /// and a cached-but-unlisted one are two different machines and only one
    /// of them is ordinary. A test that planted the directory alone would be
    /// measuring `withdraw`'s deletion gate whatever else it meant to measure.
    /// Use [`unlisted_cache`] where that is the point.
    fn cache(dir: &Path, me: &KeyId, vault_id: &str) -> PathBuf {
        let path = unlisted_cache(dir, vault_id);
        listed(dir, me, vault_id);
        path
    }

    /// A directory under `peers/` that this key's list does not name: a v4
    /// display-name cache, or one whose vault the hub has stopped listing.
    fn unlisted_cache(dir: &Path, vault_id: &str) -> PathBuf {
        let path = peer_dir(dir, vault_id);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("index.db"), b"peer data").unwrap();
        path
    }

    /// Put `vault_id` on the last list the hub gave `me`, cache or no cache.
    fn listed(dir: &Path, me: &KeyId, vault_id: &str) {
        let mut list = listed_for(dir, me)
            .unwrap()
            .unwrap_or(ReadableVaults { me: me.clone(), at: NOW, vault_ids: Vec::new() });
        if !list.contains(vault_id) {
            list.vault_ids.push(vault_id.to_string());
        }
        state::write_readable_vaults(dir, &list).unwrap();
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

    fn statement(g: &SignedGrant) -> GrantStatement {
        serde_json::from_slice(&g.statement).unwrap()
    }

    // -- what a grant is about ---------------------------------------------

    /// **`covers` compares the whole scope, never a prefix or a substring.**
    /// The id it is asked about is a directory name read off disk, not a value
    /// the issuer signed, so a name that merely starts with the scope a grant
    /// carries was never that grant's business.
    ///
    /// `ReadableVaults::contains` is the other half of the same conjunction
    /// and has had this test since a mutation found it there; this comparison
    /// one file away had none.
    #[test]
    fn covers_matches_a_whole_scope_and_never_a_prefix_of_one() {
        let me = id(&key(9));
        let st = statement(&issue(&key(1), &me, GrantKind::Follow, Some("v-a"), LATER));

        assert!(covers(&st, &me, "v-a"));
        assert!(!covers(&st, &me, "v-alice"), "a longer id that starts with the scope");
        assert!(!covers(&st, &me, "v-"), "a shorter id the scope starts with");
        assert!(!covers(&st, &me, "V-A"), "and it is not case-insensitive either");
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
        cache(dir.path(), &me, "v-other");
        cache(dir.path(), &me, "v-keep");

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
        cache(dir.path(), &me, "v-other");

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
        cache(dir.path(), &me, "v-other");

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
        cache(dir.path(), &me, "v-other");
        cache(dir.path(), &me, "v-elsewhere");

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
        cache(dir.path(), &me, "v-one");
        cache(dir.path(), &me, "v-two");

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
        cache(dir.path(), &me, "v-one");
        cache(dir.path(), &me, "v-two");

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(cached(dir.path(), "v-one"));
        assert!(cached(dir.path(), "v-two"));
        assert_eq!(rows(dir.path()), 0, "the grant is still withdrawn from the store");
    }

    /// A scoped revocation must not take a cache somebody else's grant still
    /// justifies. `covers` is asked of the survivors, so an unscoped `link`
    /// from anyone counts as a reason to keep it — uncertainty protects.
    ///
    /// **Also the guard on the reader/deleter asymmetry.** There is no
    /// `readable-vaults.json` here, so adding the reader's list to this
    /// bail-out would make it false, and this cache would be deleted rather
    /// than kept. See the module doc.
    #[test]
    fn a_revocation_keeps_a_cache_another_grant_still_justifies() {
        let a = key(1);
        let c = key(2);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-two"), LATER);
        let link_from_c = issue(&c, &me, GrantKind::Link, None, LATER);
        let (dir, me) = store(&[&held, &link_from_c]);
        cache(dir.path(), &me, "v-two");

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(cached(dir.path(), "v-two"),
            "revoking one person's follow must not delete what another person's link justifies");
    }

    /// The other side of that bail-out's midpoint: the survivor has to be
    /// LIVE. Only the `covers` half was measured, and an unscoped grant
    /// covers every vault — so without the expiry half a lapsed `link` sitting
    /// in the store protects this cache from the revocation that should take
    /// it, and protects it forever: `prune_expired` runs next and names
    /// nothing for an unscoped grant, while the revoked row is already gone,
    /// so the hub's next copy of the revocation resolves against nothing.
    #[test]
    fn a_lapsed_survivor_does_not_protect_a_cache_from_a_revocation() {
        let a = key(1);
        let c = key(2);
        let me = id(&key(9));
        let revoked = issue(&a, &me, GrantKind::Follow, Some("v-x"), LATER);
        let lapsed_link = issue(&c, &me, GrantKind::Link, None, NOW - 1);
        let (dir, me) = store(&[&revoked, &lapsed_link]);
        cache(dir.path(), &me, "v-x");

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &revoked)], &me, NOW).unwrap();

        assert_eq!(deleted, vec!["v-x".to_string()]);
        assert!(!cached(dir.path(), "v-x"),
            "a grant that has stopped meaning anything cannot be a reason to keep a cache");
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
        cache(dir.path(), &me, "v-two");

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
        cache(dir.path(), &me, "v-work");

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
        let innocent = cache(dir.path(), &me, "v-other");
        // Listed, so `is_safe_vault_id` is the only thing that can refuse it.
        listed(dir.path(), &me, "../secret");
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
        cache(dir.path(), &me, "v-other");

        let deleted = apply_revocations(dir.path(), &[revoking(&mine, &held)], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(cached(dir.path(), "v-other"),
            "our own grant to somebody else was never why we held this");
        assert_eq!(rows(dir.path()), 0, "it is still withdrawn from the store");
    }

    /// The `NotFound` arm, and it is the only thing between an ordinary
    /// revocation and a sync cycle that aborts before the upload — every
    /// cycle, for good. `apply_revocations(...)?` in `run_cycle` is not
    /// best-effort, and a grant lodged for a vault this client never fetched
    /// is ordinary: the grant is issued and stored before any index is served,
    /// and `fetch_all` skips a vault the hub reports as holding nothing.
    ///
    /// **The removal has to be reachable for this to test the arm.**
    /// `applying_the_same_revocation_twice_is_idempotent` is named for the
    /// same property and never gets there: after the first call the row is
    /// gone, so the second returns at "holds no grant for" without entering
    /// `withdraw`. Here the grant is scoped, addressed to this key and a
    /// usable id, no survivor covers it, and `peers/` is on disk — so
    /// `remove_dir_all` really runs, and the one reason it fails is that this
    /// directory was never written.
    #[test]
    fn revoking_a_grant_whose_cache_was_never_written_is_not_a_failure() {
        let a = key(1);
        let me = id(&key(9));
        let never_fetched = issue(&a, &me, GrantKind::Follow, Some("v-never"), LATER);
        let (dir, me) = store(&[&never_fetched]);
        let sibling = cache(dir.path(), &me, "v-other");
        // The hub lists it and we hold the grant; nothing was ever fetched
        // because the hub reported holding nothing for it.
        listed(dir.path(), &me, "v-never");
        assert!(!peer_dir(dir.path(), "v-never").exists(),
            "precondition: nothing was ever fetched for the vault being revoked");

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &never_fetched)], &me, NOW)
            .expect("a revocation for a vault this client never read is not a failure");

        assert!(deleted.is_empty());
        assert_eq!(rows(dir.path()), 0, "and the row still goes, so the cycle settles");
        assert!(sibling.exists(), "peers/ was there to walk: the deletion was reachable");
    }

    #[test]
    fn applying_the_same_revocation_twice_is_idempotent() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-other"), LATER);
        let (dir, me) = store(&[&held]);
        cache(dir.path(), &me, "v-other");
        let rev = revoking(&a, &held);

        assert_eq!(
            apply_revocations(dir.path(), std::slice::from_ref(&rev), &me, NOW).unwrap(),
            vec!["v-other".to_string()]
        );
        assert!(apply_revocations(dir.path(), &[rev], &me, NOW).unwrap().is_empty());
    }

    // -- the deletion gate: a third party does not choose the target --------

    /// **A stranger picks the `remove_dir_all` target, and the gate is what
    /// stops it.** `apply_grants` checks a signature and nothing else, and a
    /// hub lets its members lodge grants addressed to each other — so a
    /// co-member who knows this key can sign a `peer` grant scoped to any
    /// string, get it served back to us as active, and then revoke it.
    /// `names` hands `withdraw` whatever string that was.
    ///
    /// Everything before the gate passes here: the grant is a `permits_read`
    /// kind addressed to this key, the scope is a usable id, and no surviving
    /// grant covers it — the row is dropped, which is how far the resolution
    /// got. The one thing that is not true is that the hub ever told this key
    /// it could read that vault.
    #[test]
    fn a_strangers_grant_cannot_name_a_cache_the_hub_never_listed_for_us() {
        let stranger = key(4);
        let me = id(&key(9));
        let bait = issue(&stranger, &me, GrantKind::Peer, Some("thomas_kirk"), LATER);
        let (dir, me) = store(&[&bait]);
        // A real list, naming a real vault, so the gate's answer is about
        // `thomas_kirk` and not about there being no list at all.
        cache(dir.path(), &me, "v-mine");
        let victim = unlisted_cache(dir.path(), "thomas_kirk");

        let deleted =
            apply_revocations(dir.path(), &[revoking(&stranger, &bait)], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(victim.join("index.db").exists(),
            "a signed scope says who wrote that string, not that they had any standing \
             over the directory it names");
        assert!(cached(dir.path(), "v-mine"));
        assert_eq!(rows(dir.path()), 0, "the revocation resolved: the gate is what refused");
    }

    /// The same attack on a machine with any inbound unscoped `link` — the
    /// case the code calls normal — where the survivor bail-out gets there
    /// first. The cache is LISTED, so the gate is open and the bail-out is
    /// the only thing left to refuse.
    #[test]
    fn an_unscoped_live_link_also_refuses_a_strangers_deletion() {
        let stranger = key(4);
        let c = key(2);
        let me = id(&key(9));
        let bait = issue(&stranger, &me, GrantKind::Peer, Some("v-mine"), LATER);
        let mine = issue(&c, &me, GrantKind::Link, None, LATER);
        let (dir, me) = store(&[&bait, &mine]);
        cache(dir.path(), &me, "v-mine");

        let deleted =
            apply_revocations(dir.path(), &[revoking(&stranger, &bait)], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(cached(dir.path(), "v-mine"),
            "a link this machine actually holds covers it, whatever a stranger signed");
    }

    /// The gate reads the list **this** key was handed, not whichever list is
    /// on disk. `ll recover` leaves the file in place, so without the key on
    /// the record a vault K1 was listed for would go on authorising deletions
    /// under K2 — the same stale record C-1 closed on the read side, in the
    /// direction that destroys instead of the one that serves.
    #[test]
    fn a_list_belonging_to_another_key_does_not_open_the_gate() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-other"), LATER);
        let (dir, me) = store(&[&held]);
        let stranded = unlisted_cache(dir.path(), "v-other");
        listed(dir.path(), &id(&key(8)), "v-other");

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(stranded.join("index.db").exists(),
            "the list names the vault, and it is not this key's list");
    }

    /// And the gate's other direction, which is what stops it from being a
    /// switch that turns revocation off: the hub lists the vault, the grant
    /// this key holds for it is withdrawn, and the cache goes. Without this
    /// the gate would be indistinguishable from `withdraw` never deleting.
    #[test]
    fn a_revocation_of_a_vault_the_hub_listed_still_deletes_its_cache() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-listed"), LATER);
        let (dir, me) = store(&[&held]);
        cache(dir.path(), &me, "v-listed");

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW).unwrap();

        assert_eq!(deleted, vec!["v-listed".to_string()]);
        assert!(!cached(dir.path(), "v-listed"));
    }

    /// **The cost of the gate, written down as a test rather than only as a
    /// doc comment.** A revocation that arrives after the hub stopped listing
    /// the vault is refused, and refused for good: the row goes on the same
    /// pass, so the hub's next copy of the revocation resolves against
    /// nothing. This is a new permanent under-delete, and it is the price of
    /// the case above it. What bounds it is that `ReadAuthority` will not
    /// serve the cache either — its list half is this same list.
    #[test]
    fn a_revocation_arriving_after_the_hub_stopped_listing_the_vault_is_refused() {
        let a = key(1);
        let me = id(&key(9));
        let held = issue(&a, &me, GrantKind::Follow, Some("v-dropped"), LATER);
        let (dir, me) = store(&[&held]);
        let stranded = unlisted_cache(dir.path(), "v-dropped");
        cache(dir.path(), &me, "v-still-listed");

        let deleted = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW).unwrap();

        assert!(deleted.is_empty());
        assert!(stranded.join("index.db").exists(),
            "the bytes stay, and nothing on this machine will read them again");
        assert_eq!(rows(dir.path()), 0,
            "and the row is gone, so no later cycle can resolve this revocation either");
    }

    // -- expiry, the backstop ----------------------------------------------

    #[test]
    fn a_lapsed_grant_loses_its_cache_too() {
        let a = key(1);
        let me = id(&key(9));
        let lapsed = issue(&a, &me, GrantKind::Follow, Some("v-other"), NOW - 1);
        let live = issue(&a, &me, GrantKind::Follow, Some("v-keep"), LATER);
        let (dir, me) = store(&[&lapsed, &live]);
        cache(dir.path(), &me, "v-other");
        cache(dir.path(), &me, "v-keep");

        let deleted = prune_expired(dir.path(), &me, NOW).unwrap();

        assert_eq!(deleted, vec!["v-other".to_string()]);
        assert!(!cached(dir.path(), "v-other"), "lapsing must have the same effect as revoking");
        assert!(cached(dir.path(), "v-keep"));
        assert_eq!(rows(dir.path()), 1);
    }

    /// The boundary itself. `expires_at` is the first instant the grant does
    /// not cover, not the last one it does — `prune_expired` reads
    /// `expires_at <= now`. Nothing pinned which side `now` fell on, so a
    /// comparison one second out in either direction was free.
    #[test]
    fn a_grant_that_expires_at_this_very_instant_is_lapsed() {
        let a = key(1);
        let me = id(&key(9));
        let g = issue(&a, &me, GrantKind::Follow, Some("v-other"), NOW);
        let (dir, me) = store(&[&g]);
        cache(dir.path(), &me, "v-other");

        assert_eq!(prune_expired(dir.path(), &me, NOW).unwrap(), vec!["v-other".to_string()]);
        assert!(!cached(dir.path(), "v-other"));
        assert_eq!(rows(dir.path()), 0);
    }

    /// And the other side of it, one second out.
    #[test]
    fn a_grant_that_expires_one_second_from_now_is_not_pruned_yet() {
        let a = key(1);
        let me = id(&key(9));
        let g = issue(&a, &me, GrantKind::Follow, Some("v-other"), NOW + 1);
        let (dir, me) = store(&[&g]);
        cache(dir.path(), &me, "v-other");

        assert!(prune_expired(dir.path(), &me, NOW).unwrap().is_empty());
        assert!(cached(dir.path(), "v-other"));
        assert_eq!(rows(dir.path()), 1);
    }

    #[test]
    fn an_active_grant_keeps_its_cache() {
        let a = key(1);
        let me = id(&key(9));
        let live = issue(&a, &me, GrantKind::Follow, Some("v-other"), LATER);
        let (dir, me) = store(&[&live]);
        cache(dir.path(), &me, "v-other");

        assert!(prune_expired(dir.path(), &me, NOW).unwrap().is_empty());
        assert!(cached(dir.path(), "v-other"));
        assert_eq!(rows(dir.path()), 1);
    }

    /// Two grants covering one vault, one lapsed and one not. Expiry is a
    /// backstop, not a sweep: it removes the reason that ran out, and the
    /// cache goes only when no reason is left.
    ///
    /// The other guard on the reader/deleter asymmetry, for the same reason
    /// as `a_revocation_keeps_a_cache_another_grant_still_justifies`.
    #[test]
    fn a_lapsed_grant_does_not_take_a_cache_another_grant_still_covers() {
        let a = key(1);
        let c = key(2);
        let me = id(&key(9));
        let lapsed = issue(&a, &me, GrantKind::Follow, Some("v-other"), NOW - 1);
        let live = issue(&c, &me, GrantKind::Follow, Some("v-other"), LATER);
        let (dir, me) = store(&[&lapsed, &live]);
        cache(dir.path(), &me, "v-other");

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
        cache(dir.path(), &me, "v-other");

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
        cache(dir.path(), &me, "v-one");
        cache(dir.path(), &me, "v-two");

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
        cache(dir.path(), &me, "v-one");
        cache(dir.path(), &me, "v-two");

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
        cache(dir.path(), &me, "v-one");
        let v4 = cache(dir.path(), &me, "thomas_kirk");
        let unrelated = cache(dir.path(), &me, "v-two");
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
        let v4 = cache(dir.path(), &me, "thomas_kirk");

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
        let cache_dir = cache(dir.path(), &me, "v-other");
        std::fs::set_permissions(&cache_dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let outcome = apply_revocations(dir.path(), &[revoking(&a, &held)], &me, NOW);

        std::fs::set_permissions(&cache_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(outcome.is_err(), "best-effort deletion would make revocation theatre");
        assert!(cached(dir.path(), "v-other"), "the cache is still there, so the reason must be");
        assert_eq!(rows(dir.path()), 1, "the next cycle can still resolve this revocation");
    }
}
