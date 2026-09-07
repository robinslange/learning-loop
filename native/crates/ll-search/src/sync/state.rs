//! `federation/sync-state.json`: what the last sync cycle actually did.
//!
//! Two outages on this client ran for months apiece — an upload that silently
//! skipped, and a download half talking to messages the hub had deleted —
//! and neither was visible because nothing on disk recorded the outcome of a
//! cycle. v4 planned this file and never shipped it.

use std::path::Path;

use anyhow::Context;
use serde::{Deserialize, Serialize};

use super::atomic_file;
use super::config::{readable_vaults_path, sync_state_path};

/// `SyncState::outcome` for a cycle that finished. Readers match on these
/// rather than retyping the literal, so a rename is a compile error in the
/// reader instead of a signal that silently stops being recognised.
pub const OUTCOME_OK: &str = "ok";
/// `SyncState::outcome` for a cycle that did not finish.
pub const OUTCOME_ERROR: &str = "error";

/// What we last knew the hub to hold for this vault, as of the END of the
/// cycle. One field, so "holds nothing" and "holds 3578 notes" cannot both be
/// recorded at once.
///
/// `sha256` is always the hub's own word: its handshake report, or the sha it
/// echoed in `UploadAck`, checked against the bytes we hashed before it is
/// recorded. `note_count` is whoever last counted the notes behind that sha —
/// the hub on the skip and failure paths, us on the upload path, because v5's
/// `UploadAck` carries no count.
///
/// `None` on the enclosing field means the cycle died before the handshake.
/// That is not the same as the hub holding nothing.
///
/// Recording the end of the cycle rather than the handshake is deliberate: a
/// first sync against a cold hub uploads successfully and would otherwise
/// record `Nothing`, firing the outage warning immediately after the sync
/// that fixed it. A false alarm on that warning is most of how the original
/// outage stayed invisible for two months.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HubHolds {
    Nothing,
    Index { sha256: String, note_count: i64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncState {
    pub last_attempt_at: i64,
    /// Carried forward across failures: how long an outage has been running
    /// is the question this file exists to answer.
    pub last_success_at: Option<i64>,
    pub outcome: String,
    pub detail: Option<String>,
    /// `None` means the cycle never got far enough to ask the hub.
    pub hub_holds: Option<HubHolds>,
    /// How many vaults this cycle was entitled to read and could not. `None`
    /// means the cycle never reached the read half at all, which is a
    /// different report from "none failed" and must not be rendered as one.
    ///
    /// An `Option` is also what keeps a state file written before this field
    /// existed readable: serde resolves a missing `Option` to `None` on its
    /// own, with no `#[serde(default)]` — the attribute was here and did
    /// nothing. That compatibility matters more than it looks, because
    /// `read_state` reports a parse failure as a missing file, so any field
    /// added here without a default would silently erase one vault's whole
    /// sync history rather than fail loudly. `an_old_state_file_still_reads`
    /// is what holds that for the struct as a whole.
    pub skipped_fetches: Option<usize>,
    /// How many grants the hub answered and refused in that cycle. They stay
    /// owed and the next cycle offers them again — but the hub's answer will
    /// be the same, which is what makes this worth recording where a dropped
    /// connection is not. `None` means the cycle never reached the link half,
    /// the same distinction `skipped_fetches` draws.
    pub refused_grants: Option<usize>,
}

/// The vaults the hub last named as readable by this key, and when.
///
/// **This is not a second opinion about authority — it is the authority that
/// produced the caches, written down.** A directory under
/// `federation/data/peers/` can only exist because the hub listed that vault
/// in `SyncReady.vault_state` and then served its index: `fetch.rs` asks for
/// exactly the vaults the handshake named and never asks the hub to list
/// anything. So keeping the list and filtering reads through it is the same
/// authority applied later, not a new party being trusted. It is what stops a
/// cache outliving the answer that created it.
///
/// The client cannot compute this itself, and that is the whole reason the
/// file exists. An unscoped `link` means "every vault this issuer owns", and
/// which vaults an issuer owns is hub state — so `grants::covers` has to
/// answer yes to everything for an unscoped grant, and on a linked machine
/// that is every cache on disk.
///
/// `at` is when the hub said it, not when the cycle finished. Those differ:
/// a cycle can take the handshake and then die uploading, and the list it was
/// handed is still the newest answer this machine has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadableVaults {
    pub at: i64,
    pub vault_ids: Vec<String>,
}

impl ReadableVaults {
    pub fn contains(&self, vault_id: &str) -> bool {
        self.vault_ids.iter().any(|id| id == vault_id)
    }

    /// How stale this answer is, as of `now`. Never negative: a clock that
    /// went backwards is not an answer from the future.
    pub fn age(&self, now: i64) -> i64 {
        (now - self.at).max(0)
    }
}

/// Read the recorded list, or `None` when there is nothing readable there.
///
/// **Unreadable reads as absent, and absent means serve nothing.** That is
/// the opposite of [`read_state`]'s rule for the report file, deliberately:
/// there, refusing to guess keeps a corrupt file from blocking the cycle that
/// would fix it; here, refusing to guess is the fail-closed direction, because
/// the only thing a caller does with this answer is decide what to hand a
/// reader. A machine that cannot say what it may read serves nothing and says
/// so, which costs a person one `ll sync`.
pub fn read_readable_vaults(config_dir: &Path) -> anyhow::Result<Option<ReadableVaults>> {
    let path = readable_vaults_path(config_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    match serde_json::from_str(&text) {
        Ok(listed) => Ok(Some(listed)),
        Err(e) => {
            eprintln!(
                "warning: {} exists but does not parse ({e}); no cached peer index will be \
                 searched until the next `ll sync` rewrites it",
                path.display()
            );
            Ok(None)
        }
    }
}

/// Record what the hub just said. Written before the upload half, for the
/// same reason `apply_revocations` runs there: a cycle that dies uploading
/// must still have stopped serving what the hub no longer lists.
pub fn write_readable_vaults(config_dir: &Path, listed: &ReadableVaults) -> anyhow::Result<()> {
    atomic_file::write_json(&readable_vaults_path(config_dir), listed)
}

/// Read the recorded state, or `None` when there is nothing readable there.
///
/// A state file we cannot parse is reported as missing, not as an error: the
/// sync that would rewrite it must not be blocked by it. The corrupt case is
/// named on stderr so it does not look identical to "never synced" to whoever
/// is reading the logs.
pub fn read_state(config_dir: &Path) -> anyhow::Result<Option<SyncState>> {
    let path = sync_state_path(config_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    match serde_json::from_str(&text) {
        Ok(state) => Ok(Some(state)),
        Err(e) => {
            eprintln!(
                "warning: {} exists but does not parse ({e}); this vault's sync history \
                 is unreadable, not absent, until the next cycle rewrites it",
                path.display()
            );
            Ok(None)
        }
    }
}

/// Write the state, creating `federation/` if the cycle failed before
/// anything else did.
///
/// The unique-temp-name rename this used to spell out inline is now
/// [`atomic_file::write_json`], because there was a second, worse copy of it
/// in `link.rs` writing into this same directory and the grant store lost
/// half its rows to it. One writer, and no second shape to forget to update.
///
/// Nothing here takes a [`atomic_file::FileLock`]: this file is written
/// whole from a value the caller already holds, never read-modify-written, so
/// the last cycle to finish is the one whose outcome should stand.
pub fn write_state(config_dir: &Path, state: &SyncState) -> anyhow::Result<()> {
    atomic_file::write_json(&sync_state_path(config_dir), state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hubs_list_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        write_readable_vaults(dir.path(), &ReadableVaults {
            at: 1_000,
            vault_ids: vec!["v-a".into(), "v-b".into()],
        }).unwrap();

        let listed = read_readable_vaults(dir.path()).unwrap().unwrap();
        assert!(listed.contains("v-a"));
        assert!(listed.contains("v-b"));
        assert!(!listed.contains("v-c"));
        assert_eq!(listed.at, 1_000);
    }

    /// **`contains` is equality, not a prefix or substring match.** The ids
    /// it is asked about are directory names read off disk, not values the
    /// hub vouched for, so a name that merely starts with a listed id was
    /// never listed. Found by mutation: `starts_with` passed every other test
    /// in this file, because no fixture used two ids where one is a prefix of
    /// the other.
    #[test]
    fn contains_matches_a_whole_id_and_never_a_prefix_of_one() {
        let listed = ReadableVaults { at: 1, vault_ids: vec!["v-a".into()] };
        assert!(listed.contains("v-a"));
        assert!(!listed.contains("v-alice"), "a longer id that starts with a listed one");
        assert!(!listed.contains("v-"), "a shorter id the listed one starts with");
        assert!(!listed.contains("V-A"), "and it is not case-insensitive either");
    }

    /// The opposite rule from [`read_state`], and the reason it is opposite:
    /// a corrupt report must not block the cycle that rewrites it, but a
    /// corrupt read-authority record must not be treated as an answer. Both
    /// collapse to `None`; what differs is what the caller does with `None`,
    /// and the caller here serves nothing.
    #[test]
    fn an_unreadable_list_reads_as_absent_rather_than_as_an_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        std::fs::write(
            dir.path().join("federation").join("readable-vaults.json"), "{not json").unwrap();

        assert!(read_readable_vaults(dir.path()).unwrap().is_none());
    }

    #[test]
    fn a_missing_list_is_none_and_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_readable_vaults(dir.path()).unwrap().is_none());
    }

    /// A clock that went backwards is not an answer from the future. Without
    /// the clamp a negative age would render as freshness.
    #[test]
    fn age_never_reads_as_negative() {
        let listed = ReadableVaults { at: 9_000, vault_ids: Vec::new() };
        assert_eq!(listed.age(9_500), 500);
        assert_eq!(listed.age(1_000), 0);
    }

    /// The record must survive a round trip through a file written by a build
    /// that had one fewer field, the same way `SyncState` does — this file is
    /// read on the query path and a parse failure there is federated search
    /// going dark, not a warning.
    #[test]
    fn a_list_file_with_only_the_two_fields_still_reads() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        std::fs::write(
            dir.path().join("federation").join("readable-vaults.json"),
            r#"{"at":1,"vault_ids":["v-a"]}"#,
        ).unwrap();

        let listed = read_readable_vaults(dir.path()).unwrap().unwrap();
        assert!(listed.contains("v-a"));
    }

    #[test]
    fn a_failed_cycle_still_writes_state() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();

        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000, last_success_at: None,
            outcome: "error".into(),
            detail: Some("hub key mismatch".into()),
            hub_holds: None,
            skipped_fetches: None,
            refused_grants: None,
        }).unwrap();

        let s = read_state(dir.path()).unwrap().unwrap();
        assert_eq!(s.outcome, "error");
        assert_eq!(s.detail.as_deref(), Some("hub key mismatch"));
        // A cycle that fails silently is the failure mode this file exists to
        // prevent. v4 planned this file and never shipped it.
    }

    #[test]
    fn state_records_that_the_hub_holds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000, last_success_at: Some(1_000),
            outcome: "ok".into(), detail: None,
            hub_holds: Some(HubHolds::Nothing),
            skipped_fetches: None,
            refused_grants: None,
        }).unwrap();
        assert_eq!(read_state(dir.path()).unwrap().unwrap().hub_holds,
                   Some(HubHolds::Nothing));
    }

    #[test]
    fn missing_state_is_reported_as_missing_not_as_healthy() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        assert!(read_state(dir.path()).unwrap().is_none());
    }

    #[test]
    fn a_corrupt_state_file_reads_as_missing_rather_than_erroring() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        std::fs::write(dir.path().join("federation/sync-state.json"), "{not json").unwrap();
        assert!(read_state(dir.path()).unwrap().is_none(),
            "a bad state file must not break the sync that would rewrite it");
    }

    #[test]
    fn a_cycle_that_fails_before_anything_creates_federation_still_records() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!dir.path().join("federation").exists(), "precondition: a cold config dir");

        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000, last_success_at: None,
            outcome: OUTCOME_ERROR.into(),
            detail: Some("no federation seed found".into()),
            hub_holds: None,
            skipped_fetches: None,
            refused_grants: None,
        }).unwrap();

        assert_eq!(read_state(dir.path()).unwrap().unwrap().outcome, OUTCOME_ERROR);
    }

    #[test]
    fn a_second_write_replaces_the_first_and_leaves_it_readable() {
        let dir = tempfile::tempdir().unwrap();
        let first = SyncState {
            last_attempt_at: 1_000, last_success_at: Some(1_000),
            outcome: OUTCOME_OK.into(), detail: None,
            hub_holds: Some(HubHolds::Index { sha256: "abc".into(), note_count: 1 }),
            skipped_fetches: None,
            refused_grants: None,
        };
        write_state(dir.path(), &first).unwrap();
        let second = SyncState {
            last_attempt_at: 2_000, last_success_at: Some(1_000),
            outcome: OUTCOME_ERROR.into(), detail: Some("hub unreachable".into()),
            hub_holds: None,
            skipped_fetches: None,
            refused_grants: None,
        };
        write_state(dir.path(), &second).unwrap();

        assert_eq!(read_state(dir.path()).unwrap().unwrap(), second);
        let left: Vec<String> = std::fs::read_dir(dir.path().join("federation"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec!["sync-state.json".to_string()],
            "each write renames its temp file into place; none is left beside the target");
    }

    /// Every other test here builds a `SyncState` in Rust and round-trips it
    /// through `write_state`, which always emits every field — so none of
    /// them can see a file that predates one. This one is written by hand.
    ///
    /// It guards the struct, not one field: `read_state` turns a parse
    /// failure into `Ok(None)`, and `sync_all_async` then reads
    /// `last_success_at` out of that `None` and drops it. So the cost of
    /// adding a field with no default is not an error, it is one vault's
    /// entire sync history, silently, on the first read after upgrade.
    #[test]
    fn an_old_state_file_still_reads() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        std::fs::write(
            sync_state_path(dir.path()),
            r#"{"last_attempt_at":1000,"last_success_at":900,"outcome":"ok",
                "detail":null,"hub_holds":null}"#,
        )
        .unwrap();

        let s = read_state(dir.path()).unwrap().expect("an old state file is not a missing one");
        assert_eq!(s.last_success_at, Some(900),
            "the history this file exists to carry survives the upgrade");
        assert_eq!(s.skipped_fetches, None,
            "a cycle that ran before the read half existed skipped an unknown number, not zero");
        assert_eq!(s.refused_grants, None,
            "and one that ran before the link half existed refused an unknown number too");
    }

    /// The file is a contract with every reader of `federation/`, not just
    /// with this module's own serde. Pin the keys and the tag.
    #[test]
    fn the_file_on_disk_carries_the_hubs_count_under_a_tagged_hub_holds() {
        let dir = tempfile::tempdir().unwrap();
        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000, last_success_at: Some(1_000),
            outcome: OUTCOME_OK.into(), detail: None,
            hub_holds: Some(HubHolds::Index { sha256: "abc123".into(), note_count: 3578 }),
            skipped_fetches: Some(2),
            refused_grants: Some(1),
        }).unwrap();

        assert!(dir.path().join("federation/sync-state.json").exists(),
            "every reader of federation/ finds this file by name; without this the \
             path helper is free to move it and only the readers would find out");
        let raw = std::fs::read_to_string(sync_state_path(dir.path())).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["outcome"], "ok");
        assert_eq!(v["hub_holds"]["kind"], "index");
        assert_eq!(v["hub_holds"]["sha256"], "abc123");
        assert_eq!(v["hub_holds"]["note_count"], 3578);
        assert_eq!(v["skipped_fetches"], 2,
            "`ll status` reads this key out of the file; a rename that only touched \
             the struct would leave every out-of-process reader behind");
        assert_eq!(v["refused_grants"], 1, "same contract, same reason");
        assert!(v.get("note_count").is_none(),
            "the count lives inside hub_holds; a loose one beside it is the field \
             that let 'holds nothing' and 'holds 3578 notes' be recorded together");

        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000, last_success_at: Some(1_000),
            outcome: OUTCOME_OK.into(), detail: None,
            hub_holds: Some(HubHolds::Nothing),
            skipped_fetches: None,
            refused_grants: None,
        }).unwrap();
        let raw = std::fs::read_to_string(sync_state_path(dir.path())).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["hub_holds"]["kind"], "nothing",
            "the outage signature is the one tag an out-of-process reader must not \
             have renamed under it");
    }
}
