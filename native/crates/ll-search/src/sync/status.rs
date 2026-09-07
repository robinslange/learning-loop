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

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use ed25519_dalek::VerifyingKey;

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

    let mut out = String::new();
    out.push_str(&identity_block(&config));
    match read_state(config_dir)? {
        // `read_state` collapses a missing file and a corrupt one into the
        // same `None`, deliberately, so that a bad file cannot block the sync
        // that would rewrite it. This line must not claim which one it was.
        None => out.push_str(&row("last sync:", "no information — federation/sync-state.json is missing or unreadable. The next sync writes one.")),
        Some(state) => out.push_str(&sync_block(&state, now)),
    }
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

fn identity_block(config: &FederationConfig) -> String {
    let mut out = String::new();
    out.push_str(&row("vault:", config.vault_path.as_deref().unwrap_or("unknown")));
    out.push_str(&row("vault id:", config.vault_id.as_deref().unwrap_or("unknown")));
    out.push_str(&row("key:", &client_key(&config.identity.pubkey)));
    out.push_str(&row("hub:", &config.hub.endpoint));
    out.push_str(&row("hub key:", &hub_key(config.hub.key_id.as_deref())));
    // A setting nobody can see is the same shape of problem as a setting
    // nobody can set, and this one decides whether a person's notes are drawn
    // on a shared graph. Both states say so in full: "opted out" alone reads
    // like a fact about the hub rather than a choice this vault made.
    out.push_str(&row("graph:", if config.graph_opt_in {
        "opted IN — this vault may be drawn on the federation-wide graph. \
         `ll-search graph-opt-in false` withdraws it."
    } else {
        "opted out — this vault is not drawn on the federation-wide graph. \
         `ll-search graph-opt-in true` publishes it."
    }));
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

/// This client's own identity, as `config.json` declares it.
///
/// Derived from the stored public key rather than from the seed: the two
/// encode the same key, and reading the config keeps `ll status` off the OS
/// keyring, which on macOS can prompt.
fn client_key(pubkey_b64: &str) -> String {
    match key_id_from_b64(pubkey_b64) {
        Some(id) => key_and_fingerprint(&id),
        None => format!("{pubkey_b64}  (not a public key this build can read)"),
    }
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
    let b64 = pubkey.strip_prefix("ed25519:").unwrap_or(pubkey);
    let bytes: [u8; 32] = B64.decode(b64).ok()?.try_into().ok()?;
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

    /// A config dir that has joined a hub. Everything `render_status` reads
    /// out of `config.json`, and nothing it does not.
    fn seeded_profile(config_dir: &Path) {
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
            graph_opt_in: false,
            vault_id: Some("0192f3c1-8a2e-7c3d-9f10-1a2b3c4d5e6f".into()),
            vault_path: Some("/Users/robin/brain/brain".into()),
            recovery_key_id: None,
        }).unwrap();
    }

    /// A setting nobody can see is the same shape of problem as a setting
    /// nobody can set, and this one decides whether a person's notes are drawn
    /// on a shared graph. Both states must be legible on the page — asserting
    /// only the opted-out line would pass against a status that never renders
    /// the value at all.
    #[test]
    fn status_shows_whether_this_vault_is_published_on_the_graph() {
        let dir = tempfile::tempdir().unwrap();
        seeded_profile(dir.path());
        let out = render_status(dir.path(), 1_100).unwrap();
        assert!(out.contains("graph:"), "got:\n{out}");
        assert!(out.contains("opted out"), "got:\n{out}");

        let mut config = crate::sync::config::load_config(dir.path()).unwrap();
        config.graph_opt_in = true;
        write_config(dir.path(), &config).unwrap();
        let out = render_status(dir.path(), 1_100).unwrap();
        assert!(out.contains("opted IN"), "got:\n{out}");
        assert!(!out.contains("opted out"), "got:\n{out}");
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

}
