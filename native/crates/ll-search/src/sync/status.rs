//! `ll status`: the one command a person reads to find out whether federation
//! is working.
//!
//! Two outages on this client each ran for months — an upload that silently
//! skipped, and a download half talking to messages the hub had deleted — and
//! neither was visible because nothing said otherwise. `state.rs` records what
//! a cycle did; this renders it.
//!
//! Everything here comes off the local disk. Nothing in this module opens a
//! socket, reads the clock, or touches the OS keyring, so no line of the
//! output can imply a check that did not run. The one process-wide read is
//! `FederationConfig::validate`, which consults `LL_ALLOW_INSECURE_WS` —
//! deliberately, because the point of that line is to answer whether `sync`
//! would accept this config, and it must be the same answer.

use std::path::Path;

use ed25519_dalek::VerifyingKey;

use crate::b64;

use super::config::{config_path, load_config, FederationConfig};
use super::key_id::KeyId;
use super::state::{read_state, HubHolds, SyncState, OUTCOME_ERROR, OUTCOME_OK};
use super::words::fingerprint;

/// A successful sync older than this is called out. Seven days: long enough
/// that a laptop shut for a long weekend stays quiet, short enough that the
/// two-month outages this command exists to catch cannot hide inside it.
pub const STALE_AFTER_SECS: i64 = 7 * 86_400;

/// Width of the label column, so every value and every verdict starts in the
/// same place and the eye runs straight down them.
const LABEL: usize = 12;

/// Total line width. Fits an 80-column terminal with room to spare.
const WIDTH: usize = 78;

/// Render the federation status of the vault under `config_dir` as of `now`
/// (unix seconds).
///
/// Reads files and returns text: no printing, no clock, no network. `now` is
/// a parameter rather than a call to `SystemTime` because that is what makes
/// the staleness boundary testable from both sides.
pub fn render_status(config_dir: &Path, now: i64) -> anyhow::Result<String> {
    if !config_path(config_dir).exists() {
        return Ok(unconfigured());
    }
    let config = match load_config(config_dir) {
        Ok(config) => config,
        Err(e) => return Ok(unreadable_config(config_dir, &e)),
    };

    // Read once. Every block below that needs this machine's key needs the
    // same one, and on the keyring backend each read is a trip to the OS.
    let seed = seed_key(config_dir);
    let mut out = String::new();
    out.push_str(&identity_block(&config, seed.as_ref()));
    match read_state(config_dir)? {
        // `read_state` collapses a missing file and a corrupt one into the
        // same `None`, deliberately, so that a bad file cannot block the sync
        // that would rewrite it. This line must not claim which one it was.
        None => out.push_str(&row("last sync:", "no information — federation/sync-state.json is missing or unreadable. The next sync writes one.")),
        Some(state) => out.push_str(&sync_block(&state, now)),
    }
    out.push_str(&read_authority_block(config_dir, seed.as_ref(), now)?);
    out.push_str(FOOTER);
    Ok(out)
}

/// Nothing has ever been set up here. Distinct from a config that exists but
/// does not parse, and from one that parses with no sync state behind it —
/// each is a different report, and none of them is "never synced".
fn unconfigured() -> String {
    "federation not configured for this vault.\n\n\
     Run `ll join <hub> <invite-code> <vault-path>` to enroll it.\n"
        .to_string()
}

/// A `config.json` that exists but does not parse is neither "not configured"
/// nor a status: it is the single most important thing to say about this
/// vault, so say it and stop.
fn unreadable_config(config_dir: &Path, e: &anyhow::Error) -> String {
    format!(
        "federation config unreadable: {}\n  {e}\n\n\
         Nothing else can be reported until this file parses. Repair it, or \
         delete\nit and re-run `ll join`.\n",
        config_path(config_dir).display()
    )
}

fn identity_block(config: &FederationConfig, seed: Option<&KeyId>) -> String {
    let mut out = String::new();
    out.push_str(&row("vault:", config.vault_path.as_deref().unwrap_or("unknown")));
    out.push_str(&row("vault id:", config.vault_id.as_deref().unwrap_or("unknown")));
    out.push_str(&row("key:", &client_key(seed, &config.identity.pubkey)));
    out.push_str(&row("hub:", &config.hub.endpoint));
    out.push_str(&row("hub key:", &hub_key(config.hub.key_id.as_deref())));
    // `ll recover` writes the seed and deliberately leaves `config.json`
    // alone: the hub pin and `vault_id` describe an enrollment the new key
    // was never part of. So after one, the key above is this machine's and
    // the two lines above it belong to a key it no longer has — and nothing
    // else on this page would say so.
    if let Some(stale) = recovered_over(seed, &config.identity.pubkey) {
        out.push_str(&row("RECOVERED", &format!(
            "config.json still names {stale}. The key above is this machine's; the vault \
             id and hub pin are the ones that key had. Re-enroll to bring them into line."
        )));
    }
    // Ask the validator rather than restating its rules: this is the exact
    // check `sync` runs before it will talk to anything, so a config that
    // fails it cannot sync no matter how healthy the rest of the page looks.
    if let Err(e) = config.validate() {
        out.push_str(&row("BLOCKED", &format!("`ll sync` will refuse this config. {e}")));
    }
    out
}

fn sync_block(state: &SyncState, now: i64) -> String {
    let mut out = String::new();
    out.push_str(&row("last sync:", &format!("{}  ({})", utc_minute(state.last_attempt_at), outcome(state))));
    out.push_str(&row("last ok:", &match state.last_success_at {
        Some(at) => utc_minute(at),
        None => "never".to_string(),
    }));
    out.push_str(&row("hub holds:", &holds(state.hub_holds.as_ref())));
    if let Some(v) = stale_verdict(state.last_success_at, now) {
        out.push_str(&row("STALE", &v));
    }
    if state.hub_holds == Some(HubHolds::Nothing) {
        out.push_str(&row("WARNING", "as of that sync the hub held no index for this vault. The next sync will upload it. If this persists, check the hub's /health."));
    }
    // Only when there were some. `Some(0)` is the healthy read half and has
    // nothing to say; `None` is a cycle that never reached it, and the
    // outcome line above has already said why.
    if let Some(n) = state.skipped_fetches.filter(|n| *n > 0) {
        out.push_str(&row("WARNING", &format!(
            "{n} followed vault(s) could not be read in that cycle. Their local copies are \
             whatever the last successful fetch left; the next sync retries them."
        )));
    }
    // Same `Some(0)` / `None` distinction as above, and a stronger warning:
    // a refused fetch may be a hiccup, but a refused grant is the hub's
    // decision and the next cycle gets the same answer.
    if let Some(n) = state.refused_grants.filter(|n| *n > 0) {
        out.push_str(&row("WARNING", &format!(
            "the hub refused {n} grant(s) in that cycle. They are still signed and still \
             offered on every sync, but whatever they were for — a linked machine, a \
             follow — is not in effect until the hub accepts them. Retrying alone will \
             not change its answer."
        )));
    }
    out
}

/// How old this machine's read authority is, and what that means for search.
///
/// **The one thing about federated reads a person cannot otherwise see.** The
/// reader serves a cached peer index only while the hub's last list still
/// names it and a live grant still covers it, and both of those are files.
/// Neither shows up in a search result: a peer that drops out simply returns
/// fewer rows.
///
/// A stale list is not an error and is not treated as one. There is no way to
/// be both offline-capable and instantly revocation-correct, so the client
/// keeps serving and says how old the answer is — the same choice the STALE
/// verdict above makes about the sync itself, at the same threshold and for
/// the same reason: a laptop shut for a long weekend stays quiet, and a
/// months-old answer cannot hide.
fn read_authority_block(config_dir: &Path, me: Option<&KeyId>, now: i64) -> anyhow::Result<String> {
    // `listed_for` rather than a second copy of the same filter: the count on
    // this page has to agree with what `ReadAuthority` serves, and two
    // expressions of one rule are how they stop agreeing. A machine with no
    // key of its own cannot say whose answer it holds, which is the same
    // verdict from the other direction.
    let listed = match me {
        Some(me) => super::grants::listed_for(config_dir, me)?,
        None => None,
    };
    let Some(listed) = listed else {
        // No cause is named. `read_readable_vaults` collapses absent, corrupt,
        // pre-`me` and written-by-a-newer-build into one `None`, and an
        // unreadable seed arrives here the same way — so every diagnosis this
        // line could offer would be wrong for at least three of them, and the
        // module's rule is that no line may imply a check that did not run.
        return Ok(row("read auth:",
            "none — no cached peer index is searched, which is the safe direction. Run \
             `ll sync` to record what this key may read; any warning about an existing \
             record is on stderr above."));
    };
    let mut out = row("read auth:", &format!(
        "{} vault(s), as the hub listed them at {}",
        listed.vault_ids.len(),
        utc_minute(listed.at),
    ));
    let age = listed.age(now);
    if age >= STALE_AFTER_SECS {
        out.push_str(&row("WARNING", &format!(
            "federated search is being served on read authority {} days old. A vault the hub \
             has stopped listing since then is still searchable here until the grant behind \
             it expires. Run `ll sync`.",
            age / 86_400,
        )));
    }
    Ok(out)
}

/// What the hub was last known to hold.
///
/// **The sha leads and the count hangs off it. Do not reorder this.**
/// `HubHolds::Index` carries two values whose provenance differs and the type
/// cannot tell you which you are holding: `sha256` is always the hub's own
/// word — its handshake report, or the sha it echoed in `UploadAck` after we
/// checked it against the bytes we hashed — whereas `note_count` is whoever
/// last counted the notes behind that sha, which is the hub on the skip and
/// failure paths but *us* on the upload path, because v5's `UploadAck` carries
/// no count. Leading with the count states our number as the hub's claim on
/// the cycle right after a first upload. Leading with the sha makes the count
/// a property of the index behind a hub-confirmed anchor, which is true on all
/// three paths and needs no branch. Encoding the provenance in the type was
/// considered and rejected: this renderer is the only consumer and its only
/// use for the distinction is to pick an adjective. The order is the
/// protection instead.
fn holds(holds: Option<&HubHolds>) -> String {
    match holds {
        Some(HubHolds::Index { sha256, note_count }) => {
            format!("sha {} ({note_count} notes)", short_sha(sha256))
        }
        Some(HubHolds::Nothing) => "nothing".to_string(),
        None => "unknown — the last cycle stopped before it asked".to_string(),
    }
}

/// `None` when the last good sync is inside the threshold. Never having
/// succeeded is the far side of stale, not the near one, so it shares the
/// verdict rather than getting a quiet branch of its own.
fn stale_verdict(last_success_at: Option<i64>, now: i64) -> Option<String> {
    let Some(at) = last_success_at else {
        return Some("no sync has ever succeeded on this vault.".to_string());
    };
    let age = now - at;
    (age >= STALE_AFTER_SECS).then(|| {
        format!(
            "the last successful sync was {} days ago; anything past {} days is called out here. Run `ll sync`.",
            age / 86_400,
            STALE_AFTER_SECS / 86_400,
        )
    })
}

fn outcome(state: &SyncState) -> String {
    // Matched against the constants `state.rs` exports, never against the
    // literals: a rename is then a compile error here rather than a status
    // line that silently stops recognising what it was written to report.
    if state.outcome == OUTCOME_OK {
        return OUTCOME_OK.to_string();
    }
    let label = if state.outcome == OUTCOME_ERROR { OUTCOME_ERROR } else { &state.outcome };
    match state.detail.as_deref() {
        Some(detail) => format!("{label}: {detail}"),
        None => label.to_string(),
    }
}

/// This machine's identity, out of the seed.
///
/// **The seed IS the identity; `config.json`'s `identity.pubkey` is a copy of
/// it, and a copy that can disagree with its source is the bug.** `ll recover`
/// replaces the seed and touches nothing else, so after one the copy is a key
/// this machine cannot sign with — while `ll link code` derives its six words
/// from the seed (`link.rs::pending_offline`). Two commands on one machine
/// printing two different fingerprints is precisely the false mismatch
/// `words.rs` exists to prevent, and a person comparing words down a phone
/// line has no way to tell that kind of mismatch from the kind that means an
/// impostor.
///
/// This costs `ll status` a seed read, which on the keyring backend can prompt
/// on macOS. That is the price of the line being true.
///
/// With no readable seed the config copy is all there is, and it is printed
/// saying so rather than as a key this machine still holds.
fn client_key(seed: Option<&KeyId>, pubkey_b64: &str) -> String {
    if let Some(id) = seed {
        return key_and_fingerprint(id);
    }
    match key_id_from_b64(pubkey_b64) {
        Some(id) => format!("{}  (from config.json — no seed on this machine)",
            key_and_fingerprint(&id)),
        None => format!("{pubkey_b64}  (not a public key this build can read)"),
    }
}

/// This machine's key, or `None` when there is no seed here to read one from.
///
/// An unreadable seed is `None` too, and on purpose: `ll status` reports, it
/// does not fail. A locked keyring must not turn the one page a person reads
/// to find out what is wrong into an error.
fn seed_key(config_dir: &Path) -> Option<KeyId> {
    super::seed_store::load_only(config_dir)
        .ok()
        .flatten()
        .map(|r| KeyId::from_pubkey(&r.signing_key.verifying_key()))
}

/// The key `config.json` names, when a seed is here and names a different one.
/// `None` whenever they agree, or whenever there is nothing to compare.
fn recovered_over(seed: Option<&KeyId>, pubkey_b64: &str) -> Option<String> {
    let seed = seed?;
    let config = key_id_from_b64(pubkey_b64)?;
    (&config != seed).then(|| elide(config.as_str()))
}

/// The pinned hub identity. States the pin, and nothing about whether the hub
/// is reachable or currently presenting it — `render_status` never connects.
/// Why an absent pin blocks a sync is the validator's line to say, not this
/// one's.
fn hub_key(key_id: Option<&str>) -> String {
    let Some(raw) = key_id.filter(|s| !s.is_empty()) else {
        return "not pinned".to_string();
    };
    match KeyId::parse(raw) {
        Ok(id) => format!("{}  (pinned)", key_and_fingerprint(&id)),
        Err(_) => format!("{raw}  (pinned, but not a readable key_id)"),
    }
}

fn key_and_fingerprint(id: &KeyId) -> String {
    format!("{}  {}", elide(id.as_str()), fingerprint(id))
}

/// Both encodings that exist on disk: v5 `join` writes bare base64, and
/// pre-v5 configs still in the wild carry the same bytes behind an `ed25519:`
/// prefix. Refusing the older one would report a perfectly readable key as
/// unreadable on exactly the installs most likely to be broken.
fn key_id_from_b64(pubkey: &str) -> Option<KeyId> {
    let encoded = pubkey.strip_prefix("ed25519:").unwrap_or(pubkey);
    let bytes: [u8; 32] = b64::decode(encoded).ok()?.try_into().ok()?;
    Some(KeyId::from_pubkey(&VerifyingKey::from_bytes(&bytes).ok()?))
}

/// `z6MkvDqG…v5T3Z`. Enough to recognise beside the fingerprint, and the `…`
/// says plainly that it is not a value to copy.
fn elide(s: &str) -> String {
    const HEAD: usize = 8;
    const TAIL: usize = 5;
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= HEAD + TAIL + 1 {
        return s.to_string();
    }
    let head: String = chars[..HEAD].iter().collect();
    let tail: String = chars[chars.len() - TAIL..].iter().collect();
    format!("{head}…{tail}")
}

/// A sha short enough to compare by eye. Only ellipsised when something was
/// actually dropped — a `…` on a sha that is printed whole is a lie about the
/// value.
fn short_sha(sha: &str) -> String {
    const KEEP: usize = 12;
    let chars: Vec<char> = sha.chars().collect();
    if chars.len() <= KEEP {
        return sha.to_string();
    }
    let head: String = chars[..KEEP].iter().collect();
    format!("{head}…")
}

/// `2026-09-04 09:12 UTC`. Minute resolution: seconds are noise on a line
/// read to answer "recently, or not".
fn utc_minute(unix_secs: i64) -> String {
    let Ok(secs) = u64::try_from(unix_secs) else {
        return format!("{unix_secs} (not a time)");
    };
    let (y, m, d) = crate::db::days_to_ymd(secs / 86_400);
    let rem = secs % 86_400;
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02} UTC", rem / 3600, (rem % 3600) / 60)
}

/// One labelled row, wrapped to [`WIDTH`] and indented under the label so the
/// label column stays readable. Every message in this file is written as one
/// unbroken string and wrapped here — a hand-placed newline is a guess about
/// how long the value beside it turned out to be, and the values that most
/// need wrapping (a hub's failure detail, the validator's refusal) are the
/// ones whose length this file does not choose.
///
/// A single word longer than the budget goes out over-length rather than
/// broken: a key_id or a URL split across two lines is worse than a long line.
fn row(label: &str, value: &str) -> String {
    let budget = WIDTH - LABEL;
    let mut out = String::new();
    let mut prefix = format!("{label:<LABEL$}");
    let mut line = String::new();
    let mut width = 0usize;
    let mut rest = value;
    loop {
        let trimmed = rest.trim_start();
        // Runs of spaces inside a value are column separators, not padding,
        // so carry the gap across rather than collapsing it.
        let gap = rest[..rest.len() - trimmed.len()].chars().count();
        rest = trimmed;
        if rest.is_empty() {
            break;
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let (word, tail) = rest.split_at(end);
        rest = tail;
        // Char counts, not bytes: the elision and em dashes in these messages
        // are multibyte, and a byte budget would wrap them short.
        let w = word.chars().count();
        if width > 0 && width + gap + w > budget {
            out.push_str(&format!("{prefix}{line}\n"));
            prefix = " ".repeat(LABEL);
            line.clear();
            width = 0;
        } else if width > 0 {
            line.push_str(&" ".repeat(gap));
            width += gap;
        }
        line.push_str(word);
        width += w;
    }
    out.push_str(&format!("{prefix}{line}\n"));
    out
}

const FOOTER: &str = "\nRead from local files. Nothing here contacted the hub; `ll sync` does that.\n";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::auth::pubkey_b64;
    use crate::sync::config::{write_config, FederationConfig, HubEndpoint, Identity, VisibilityConfig};
    use crate::sync::key_id::KeyId;
    use crate::sync::state::{write_state, HubHolds, SyncState, OUTCOME_ERROR, OUTCOME_OK};
    use ed25519_dalek::SigningKey;
    use std::path::Path;

    const HUB_SEED: [u8; 32] = [9u8; 32];
    const CLIENT_SEED: [u8; 32] = [7u8; 32];

    fn hub_key_id() -> String {
        KeyId::from_pubkey(&SigningKey::from_bytes(&HUB_SEED).verifying_key())
            .as_str()
            .to_string()
    }

    /// Plant a seed in `config_dir` and hand back the key it encodes.
    ///
    /// `write_encrypted` is the backend `force_encrypted_seed_backend` pins
    /// this binary to, so no test here reaches the OS keyring and stomps the
    /// developer's real identity.
    fn plant_seed(config_dir: &Path, seed: [u8; 32]) -> KeyId {
        crate::sync::test_hub::force_encrypted_seed_backend();
        std::fs::create_dir_all(config_dir.join("federation")).unwrap();
        crate::sync::seed_store::write_encrypted(config_dir, &seed).unwrap();
        KeyId::from_pubkey(&SigningKey::from_bytes(&seed).verifying_key())
    }

    /// A config dir that has joined a hub. Everything `render_status` reads
    /// out of `config.json`, and nothing it does not.
    ///
    /// Pins the seed backend even though it plants no seed: `render_status`
    /// now reads one, and on an unpinned backend the read order starts at the
    /// OS keyring. A test that reaches it can stall on a prompt or stomp the
    /// developer's real federation seed, and which test gets there first is a
    /// property of thread scheduling.
    fn seeded_profile(config_dir: &Path) {
        crate::sync::test_hub::force_encrypted_seed_backend();
        write_config(config_dir, &FederationConfig {
            identity: Identity {
                display_name: "brain".into(),
                pubkey: pubkey_b64(&SigningKey::from_bytes(&CLIENT_SEED)),
            },
            visibility: VisibilityConfig { default: "private".into(), rules: Vec::new() },
            hub: HubEndpoint {
                endpoint: "wss://hub.interchange.live".into(),
                key_id: Some(hub_key_id()),
            },
            vault_id: Some("0192f3c1-8a2e-7c3d-9f10-1a2b3c4d5e6f".into()),
            vault_path: Some("/Users/robin/brain/brain".into()),
            recovery_key_id: None,
        }).unwrap();
    }

    #[test]
    fn status_reports_when_the_hub_holds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000,
            last_success_at: Some(1_000),
            outcome: OUTCOME_OK.into(),
            detail: None,
            hub_holds: Some(HubHolds::Nothing),
            skipped_fetches: None,
            refused_grants: None,
        }).unwrap();

        let out = render_status(dir.path(), 1_100).unwrap();
        assert!(out.contains("hub holds:  nothing"), "got:\n{out}");
        assert!(out.contains("WARNING"),
            "'the hub holds nothing' is the outage signature and must be loud; got:\n{out}");
    }

    #[test]
    fn status_says_how_many_grants_the_hub_refused() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000,
            last_success_at: Some(1_000),
            outcome: OUTCOME_OK.into(),
            detail: None,
            hub_holds: Some(HubHolds::Index { sha256: "abc123".into(), note_count: 10 }),
            skipped_fetches: Some(0),
            refused_grants: Some(1),
        }).unwrap();

        let out = render_status(dir.path(), 1_100).unwrap();
        assert!(out.contains("refused 1 grant(s)"),
            "the cycle succeeded overall — this line is the only place a refused grant \
             is ever visible, and without it the user meets it as a machine that never \
             finishes linking; got:\n{out}");
    }

    /// The other side, and the reason it needs saying: a check on `> 0` that
    /// was written as `is_some()` would report a refusal on every healthy
    /// cycle, and a warning that is always on is one nobody reads.
    #[test]
    fn status_says_nothing_when_the_hub_refused_nothing() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        for refused_grants in [Some(0), None] {
            write_state(dir.path(), &SyncState {
                last_attempt_at: 1_000,
                last_success_at: Some(1_000),
                outcome: OUTCOME_OK.into(),
                detail: None,
                hub_holds: Some(HubHolds::Index { sha256: "abc123".into(), note_count: 10 }),
                skipped_fetches: Some(0),
                refused_grants,
            }).unwrap();
            let out = render_status(dir.path(), 1_100).unwrap();
            assert!(!out.contains("refused"),
                "refused_grants={refused_grants:?} got:\n{out}");
        }
    }

    #[test]
    fn status_names_the_followed_vaults_the_last_cycle_could_not_read() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000,
            last_success_at: Some(1_000),
            outcome: OUTCOME_OK.into(),
            detail: None,
            hub_holds: Some(HubHolds::Index { sha256: "abc123".into(), note_count: 10 }),
            skipped_fetches: Some(2),
            refused_grants: None,
        }).unwrap();

        let out = render_status(dir.path(), 1_100).unwrap();
        assert!(out.contains("2 followed vault(s) could not be read"),
            "the cycle succeeded overall, so this is the only place it shows; got:\n{out}");
    }

    /// The other side of it. A renderer that prints the line unconditionally
    /// would satisfy the test above and report an outage on every healthy
    /// cycle — which is most of how the original one went unread.
    #[test]
    fn status_says_nothing_when_every_followed_vault_was_read() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        for skipped_fetches in [Some(0), None] {
            write_state(dir.path(), &SyncState {
                last_attempt_at: 1_000,
                last_success_at: Some(1_000),
                outcome: OUTCOME_OK.into(),
                detail: None,
                hub_holds: Some(HubHolds::Index { sha256: "abc123".into(), note_count: 10 }),
                skipped_fetches,
                refused_grants: None,
            }).unwrap();
            let out = render_status(dir.path(), 1_100).unwrap();
            assert!(!out.contains("could not be read"),
                "skipped_fetches={skipped_fetches:?} got:\n{out}");
        }
    }

    #[test]
    fn status_flags_a_stale_sync() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000,
            last_success_at: Some(1_000),
            outcome: OUTCOME_OK.into(),
            detail: None,
            hub_holds: Some(HubHolds::Index { sha256: "abc123".into(), note_count: 10 }),
            skipped_fetches: None,
            refused_grants: None,
        }).unwrap();
        let out = render_status(dir.path(), 1_000 + 8 * 86_400).unwrap();
        assert!(out.contains("STALE"), "got:\n{out}");
    }

    /// The other side of the boundary, in absolute days rather than in terms
    /// of the constant. Without it an implementation that calls every sync
    /// stale passes the test above; stated in terms of `STALE_AFTER_SECS` it
    /// would follow the constant anywhere and pin nothing. The pair fixes the
    /// threshold into (7 days - 60s, 8 days].
    #[test]
    fn a_sync_just_inside_the_threshold_is_not_flagged_stale() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000,
            last_success_at: Some(1_000),
            outcome: OUTCOME_OK.into(),
            detail: None,
            hub_holds: Some(HubHolds::Index { sha256: "abc123".into(), note_count: 10 }),
            skipped_fetches: None,
            refused_grants: None,
        }).unwrap();
        let out = render_status(dir.path(), 1_000 + 7 * 86_400 - 60).unwrap();
        assert!(!out.contains("STALE"),
            "a sync one second inside the threshold is fine; got:\n{out}");
    }

    #[test]
    fn status_on_an_unconfigured_profile_says_so_plainly() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        let out = render_status(dir.path(), 1_000).unwrap();
        assert!(out.contains("federation not configured"), "got:\n{out}");
        assert!(out.contains("ll join"), "tell the reader what to do next; got:\n{out}");
    }

    /// R-A. `sha256` is always the hub's own word; `note_count` is whoever
    /// last counted the notes behind it, which on the cycle after a first
    /// upload is us. Leading with the count states our number as the hub's.
    #[test]
    fn the_hub_confirmed_sha_leads_and_the_count_hangs_off_it() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000,
            last_success_at: Some(1_000),
            outcome: OUTCOME_OK.into(),
            detail: None,
            hub_holds: Some(HubHolds::Index {
                sha256: "9f2b1c0d4e5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e".into(),
                note_count: 3578,
            }),
            skipped_fetches: None,
            refused_grants: None,
        }).unwrap();
        let out = render_status(dir.path(), 1_100).unwrap();
        assert!(out.contains("hub holds:  sha 9f2b1c0d4e5a… (3578 notes)"), "got:\n{out}");
    }

    /// R-C. `read_state` returns `Ok(None)` for a missing file AND for a
    /// corrupt one, so this line cannot claim which it was.
    #[test]
    fn a_configured_profile_with_no_readable_state_reports_no_information() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        let out = render_status(dir.path(), 1_000).unwrap();
        assert!(out.contains("no information"), "got:\n{out}");
        assert!(!out.contains("STALE"), "no information is not a verdict; got:\n{out}");
        assert!(!out.contains("WARNING"), "no information is not a verdict; got:\n{out}");
        assert!(!out.contains("never synced"),
            "the file may be sitting right there unparseable; got:\n{out}");
    }

    /// R-C, and the same on a file that exists but does not parse: the two
    /// are indistinguishable to `read_state` and must render identically.
    #[test]
    fn a_corrupt_state_file_renders_the_same_as_a_missing_one() {
        let missing = tempfile::tempdir().unwrap();
        seeded_profile(missing.path());
        let corrupt = tempfile::tempdir().unwrap();
        seeded_profile(corrupt.path());
        std::fs::write(corrupt.path().join("federation/sync-state.json"), "{not json").unwrap();

        assert_eq!(render_status(missing.path(), 1_000).unwrap(),
                   render_status(corrupt.path(), 1_000).unwrap());
    }

    /// R-F. Every value on this page came off the disk.
    #[test]
    fn nothing_in_the_output_implies_the_hub_was_contacted() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000,
            last_success_at: Some(1_000),
            outcome: OUTCOME_OK.into(),
            detail: None,
            hub_holds: Some(HubHolds::Index { sha256: "abc123".into(), note_count: 10 }),
            skipped_fetches: None,
            refused_grants: None,
        }).unwrap();
        let out = render_status(dir.path(), 1_100).unwrap();
        assert!(out.contains("Nothing here contacted the hub"), "got:\n{out}");
        assert!(out.contains("(pinned)"),
            "the hub key is a pin read from config, not a key the hub just presented; got:\n{out}");
    }

    /// The fingerprints are the whole point of the key lines: they are what a
    /// human compares against the hub's own screen.
    #[test]
    fn both_key_lines_carry_the_six_word_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        let out = render_status(dir.path(), 1_000).unwrap();
        let client = KeyId::from_pubkey(&SigningKey::from_bytes(&CLIENT_SEED).verifying_key());
        let hub = KeyId::parse(&hub_key_id()).unwrap();
        assert!(out.contains(&crate::sync::words::fingerprint(&client)), "got:\n{out}");
        assert!(out.contains(&crate::sync::words::fingerprint(&hub)), "got:\n{out}");
        assert!(!out.contains(client.as_str()),
            "the key_id is elided beside the fingerprint, not printed whole; got:\n{out}");
    }

    /// A failed cycle names what failed, and says when the last good one was
    /// rather than leaving the reader to assume it was recent.
    #[test]
    fn a_failed_cycle_names_the_failure_and_the_last_good_sync() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000 + 9 * 86_400,
            last_success_at: Some(1_000),
            outcome: OUTCOME_ERROR.into(),
            detail: Some("hub key mismatch".into()),
            hub_holds: None,
            skipped_fetches: None,
            refused_grants: None,
        }).unwrap();
        let out = render_status(dir.path(), 1_000 + 9 * 86_400).unwrap();
        assert!(out.contains("error: hub key mismatch"), "got:\n{out}");
        assert!(out.contains("STALE"), "nine days without a good sync is stale; got:\n{out}");
        assert!(out.contains("hub holds:  unknown"),
            "a cycle that died before the handshake learnt nothing about the hub; got:\n{out}");
    }

    /// `last_success_at: None` is worse than stale, not better, and the old
    /// outage is exactly the shape that renders as a blank if unhandled.
    #[test]
    fn a_vault_that_has_never_synced_successfully_is_loud_about_it() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        write_state(dir.path(), &SyncState {
            last_attempt_at: 1_000,
            last_success_at: None,
            outcome: OUTCOME_ERROR.into(),
            detail: Some("hub unreachable".into()),
            hub_holds: None,
            skipped_fetches: None,
            refused_grants: None,
        }).unwrap();
        let out = render_status(dir.path(), 1_100).unwrap();
        assert!(out.contains("last ok:    never"), "got:\n{out}");
        assert!(out.contains("STALE"), "got:\n{out}");
    }

    /// An unpinned hub cannot be told from an impostor. `validate` already
    /// refuses to sync on one; the status page must not render it as normal.
    #[test]
    fn an_unpinned_hub_is_reported_rather_than_left_blank() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        let mut config = crate::sync::config::load_config(dir.path()).unwrap();
        config.hub.key_id = None;
        write_config(dir.path(), &config).unwrap();
        let out = render_status(dir.path(), 1_000).unwrap();
        assert!(out.contains("not pinned"), "got:\n{out}");
        assert!(out.contains("ll join"), "got:\n{out}");
    }


    /// Found by running this against the real profile on disk: `join` writes
    /// bare base64, and pre-v5 configs carry the same bytes behind an
    /// `ed25519:` prefix. Both are the same key and must fingerprint alike.
    #[test]
    fn a_pre_v5_prefixed_pubkey_reads_as_the_same_key_as_the_bare_one() {
        let bare = tempfile::tempdir().unwrap();
        seeded_profile(bare.path());
        let prefixed = tempfile::tempdir().unwrap();
        seeded_profile(prefixed.path());
        let mut config = crate::sync::config::load_config(prefixed.path()).unwrap();
        config.identity.pubkey = format!("ed25519:{}", config.identity.pubkey);
        write_config(prefixed.path(), &config).unwrap();

        let expected = crate::sync::words::fingerprint(
            &KeyId::from_pubkey(&SigningKey::from_bytes(&CLIENT_SEED).verifying_key()));
        let out = render_status(prefixed.path(), 1_000).unwrap();
        assert!(out.contains(&expected), "got:\n{out}");
        assert!(!out.contains("not a public key"), "got:\n{out}");
    }

    /// R-F, the other half: say what is not working. A config `sync` will
    /// refuse must not render as a page of healthy-looking lines.
    #[test]
    fn a_config_sync_would_refuse_says_so_in_the_validators_own_words() {
        // `validate` consults LL_ALLOW_INSECURE_WS, and a test binary is one
        // process: without the lock this passes alone and fails in the suite,
        // which is how it first failed here.
        let _env = crate::sync::test_hub::env_lock();
        std::env::remove_var("LL_ALLOW_INSECURE_WS");
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        let mut config = crate::sync::config::load_config(dir.path()).unwrap();
        config.hub.endpoint = "ws://100.64.0.2:9473/ws".into();
        write_config(dir.path(), &config).unwrap();

        let expected = crate::sync::config::load_config(dir.path()).unwrap()
            .validate().unwrap_err().to_string();
        let out = render_status(dir.path(), 1_000).unwrap();
        // Compared with whitespace flattened: the reason is wrapped into the
        // label column, so the words are what must match, not the line breaks.
        let flat = out.split_whitespace().collect::<Vec<_>>().join(" ");
        let expected = expected.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(out.contains("BLOCKED"), "got:\n{out}");
        assert!(flat.contains(&expected),
            "the reason is the validator's to give, so it cannot drift from what \
             sync enforces; got:\n{out}");
    }

    /// The seed IS the identity, and this is the test that says so against
    /// the other command: `ll link code` derives its six words from the seed,
    /// `ll status` prints these, and a person comparing them down a phone
    /// line is comparing two renderings of one key or they are comparing
    /// nothing.
    #[test]
    fn the_key_line_is_the_seeds_and_matches_what_ll_link_code_shows() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        plant_seed(dir.path(), CLIENT_SEED);

        let pending = crate::sync::link::pending_offline(dir.path()).unwrap();
        let out = render_status(dir.path(), 1_000).unwrap();
        assert!(out.contains(&pending.fingerprint),
            "status and `ll link code` must show one machine one fingerprint; got:\n{out}");
    }

    /// `ll recover` writes the seed and leaves `config.json` alone. Reading
    /// the config copy prints a key this machine cannot sign with, next to
    /// six words that no longer match the ones `ll link code` shows — the
    /// exact false mismatch `words.rs` exists to prevent.
    #[test]
    fn after_a_recovery_the_key_line_follows_the_seed_and_not_config_json() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        let recovered = plant_seed(dir.path(), [42u8; 32]);
        let stale = KeyId::from_pubkey(&SigningKey::from_bytes(&CLIENT_SEED).verifying_key());

        let out = render_status(dir.path(), 1_000).unwrap();
        assert!(out.contains(&crate::sync::words::fingerprint(&recovered)),
            "the seed's fingerprint is the machine's; got:\n{out}");
        assert!(!out.contains(&crate::sync::words::fingerprint(&stale)),
            "config.json's copy must not be printed as this machine's key; got:\n{out}");
    }

    /// And it says the enrollment beside it is the old key's. `recover`
    /// deliberately does not rewrite `vault id` or the hub pin — they
    /// describe an enrollment the new key never had — so the page has to,
    /// or a recovered machine reads as a healthy one.
    #[test]
    fn a_recovered_machine_says_its_enrollment_belongs_to_the_replaced_key() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        plant_seed(dir.path(), [42u8; 32]);

        let out = render_status(dir.path(), 1_000).unwrap();
        assert!(out.contains("RECOVERED"), "got:\n{out}");
        assert!(out.contains("config.json still names"), "got:\n{out}");
    }

    /// The other side of it, and the reason it needs saying: a line printed
    /// unconditionally would satisfy the test above and cry recovery on every
    /// healthy machine, which is one more warning nobody reads.
    #[test]
    fn a_machine_whose_seed_and_config_agree_says_nothing_about_recovery() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        plant_seed(dir.path(), CLIENT_SEED);

        let out = render_status(dir.path(), 1_000).unwrap();
        assert!(!out.contains("RECOVERED"), "got:\n{out}");
    }

    /// No seed at all is its own answer. The config copy is the only key
    /// left to print and it must not be presented as one this machine holds
    /// — a status page that showed it plain would report a machine that
    /// cannot sign anything as fully enrolled.
    #[test]
    fn with_no_seed_the_config_copy_is_printed_as_a_copy() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());

        let out = render_status(dir.path(), 1_000).unwrap();
        assert!(out.contains("no seed on this machine"), "got:\n{out}");
        assert!(!out.contains("RECOVERED"),
            "nothing to compare is not a disagreement; got:\n{out}");
    }
    /// The invisible property, made visible. A person whose peer results have
    /// gone quiet has no other way to find out whether this machine still
    /// believes it may read them.
    #[test]
    fn status_says_how_many_vaults_this_machine_may_read_and_when_it_was_told() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        let me = plant_seed(dir.path(), CLIENT_SEED);
        crate::sync::state::write_readable_vaults(dir.path(),
            &crate::sync::state::ReadableVaults {
                me,
                at: 1_000,
                vault_ids: vec!["v-a".into(), "v-b".into()],
            }).unwrap();

        let out = render_status(dir.path(), 1_100).unwrap();
        assert!(out.contains("read auth:"), "got:\n{out}");
        assert!(out.contains("2 vault(s)"), "got:\n{out}");
        assert!(!out.contains("WARNING"),
            "a list a hundred seconds old is not a warning; got:\n{out}");
    }

    /// A stale list keeps serving — there is no way to be both
    /// offline-capable and instantly revocation-correct — so the page says how
    /// old the answer is instead of pretending the question does not exist.
    /// Same threshold as the sync verdict, and for the same reason.
    #[test]
    fn a_read_authority_older_than_the_stale_threshold_is_called_out() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        let me = plant_seed(dir.path(), CLIENT_SEED);
        crate::sync::state::write_readable_vaults(dir.path(),
            &crate::sync::state::ReadableVaults {
                me,
                at: 1_000,
                vault_ids: vec!["v-a".into()],
            }).unwrap();

        let fresh = render_status(dir.path(), 1_000 + STALE_AFTER_SECS - 60).unwrap();
        assert!(!fresh.contains("read authority"),
            "one second inside the threshold is fine; got:\n{fresh}");

        let out = render_status(dir.path(), 1_000 + 41 * 86_400).unwrap();
        assert!(out.contains("read authority 41 days old"), "got:\n{out}");
        assert!(out.contains("until the grant behind it expires"),
            "the reader keeps serving; say what still bounds it; got:\n{out}");
    }

    /// **The count on this page has to agree with what the reader serves, and
    /// a listing another key earned parses perfectly.** `ReadAuthority::covers`
    /// refuses every vault in it, so a page that printed the count would be
    /// the only thing here saying federated search works.
    ///
    /// Reachable without anyone copying anything: a `recover` by a build that
    /// records `me` but predates the unlink leaves exactly this state, as does
    /// a `federation/` restored from backup onto a rotated identity.
    #[test]
    fn a_listing_another_key_earned_is_not_counted_as_this_machines() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        let me = plant_seed(dir.path(), CLIENT_SEED);
        let other = KeyId::from_pubkey(&SigningKey::from_bytes(&[42u8; 32]).verifying_key());
        assert_ne!(me, other, "the fixture must plant a listing this key did not earn");
        crate::sync::state::write_readable_vaults(dir.path(),
            &crate::sync::state::ReadableVaults {
                me: other,
                at: 1_000,
                vault_ids: vec!["v-a".into(), "v-b".into()],
            }).unwrap();
        // The dangerous state has to be reachable, or the assertion below
        // passes against a file nothing could read.
        assert!(crate::sync::state::read_readable_vaults(dir.path()).unwrap().is_some(),
            "the listing must parse, or this tests the parse and not the key");

        let out = render_status(dir.path(), 1_100).unwrap();
        assert!(!out.contains("vault(s)"),
            "a listing this key did not earn is not a count it can give; got:\n{out}");
        // The renderer wraps at `WIDTH`, so a literal `contains` over the row
        // would be asserting the column count.
        let flowed = out.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(flowed.contains("no cached peer index is searched"), "got:\n{out}");
        assert!(!flowed.contains("as the hub listed them"),
            "the count row must not render for a listing this key did not earn; got:\n{out}");
    }

    /// The same verdict from the other direction: a machine holding no key
    /// cannot say whose answer the listing is, and the reader already refuses
    /// to serve one. Printing a count here would contradict it.
    #[test]
    fn a_machine_with_no_key_gives_no_count_for_a_listing_it_cannot_claim() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        crate::sync::state::write_readable_vaults(dir.path(),
            &crate::sync::state::ReadableVaults {
                me: KeyId::from_pubkey(&SigningKey::from_bytes(&CLIENT_SEED).verifying_key()),
                at: 1_000,
                vault_ids: vec!["v-a".into()],
            }).unwrap();
        assert!(crate::sync::seed_store::load_only(dir.path()).unwrap().is_none(),
            "no seed is what makes this the other direction");

        let out = render_status(dir.path(), 1_100).unwrap();
        assert!(!out.contains("vault(s)"), "got:\n{out}");
    }

    /// No record is not a fresh record. A machine that has never been told
    /// what it may read serves nothing, and the page must say that rather
    /// than leaving the line blank or reading as healthy.
    #[test]
    fn a_machine_with_no_recorded_read_authority_says_it_searches_no_peer() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());

        let out = render_status(dir.path(), 1_100).unwrap();
        assert!(out.contains("read auth:"), "got:\n{out}");
        assert!(out.contains("no cached peer index is searched"), "got:\n{out}");
        assert!(!out.contains("vault(s)"), "there is no count to give; got:\n{out}");
    }
}
