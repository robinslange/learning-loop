//! The two readers of `sync-state.json` answer two questions, and both of them
//! have to mean the same thing in both languages.
//!
//! `ll status` and the JS health check both read `last_success_at`, and both
//! used to call what they found "stale": 7 days on one side, 6 sync intervals
//! (30 minutes) on the other. 336x apart, from one field. A user who saw
//! `Federation sync FAIL` and ran `ll status` to find out more was told
//! everything was fine.
//!
//! They are two questions -- is my federated copy old, and is the thing that
//! refreshes it still running -- and they are named separately now. This holds
//! the SHORT one, the daemon-liveness window, equal across the two
//! implementations, because that is the one both sides report.
//!
//! Same shape as `secret_patterns_agree.rs`, for the same reason: a comment
//! asking the next editor to change both is not what keeps them equal.

use std::path::PathBuf;

use ll_search::sync::status::DAEMON_SILENT_AFTER_SECS;

fn quick_mjs() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugin/scripts/lib/health-checks/quick.mjs")
}

/// The JS side's default sync interval and its multiplier, read out of the
/// source rather than restated here.
fn js_window_secs(text: &str) -> i64 {
    let interval: i64 = text
        .split("syncIntervalSecs = ")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|n| n.parse().ok())
        .expect("quick.mjs must default syncIntervalSecs to a number");

    let multiplier: i64 = text
        .split("> ")
        .find(|rest| rest.starts_with(|c: char| c.is_ascii_digit()) && rest.contains("syncIntervalSecs"))
        .and_then(|rest| rest.split(' ').next())
        .and_then(|n| n.parse().ok())
        .expect("quick.mjs must compare against <n> * syncIntervalSecs");

    interval * multiplier
}

#[test]
fn the_scan_reads_both_numbers_out_of_the_javascript() {
    // A scan that silently found nothing would make the comparison below agree
    // with anything.
    let text = std::fs::read_to_string(quick_mjs()).unwrap();
    assert_eq!(js_window_secs(&text), 1800, "expected 6 * 300s from quick.mjs");

    // And it must be reading, not guessing: a changed interval has to move it.
    let edited = text.replace("syncIntervalSecs = 300", "syncIntervalSecs = 60");
    assert_eq!(js_window_secs(&edited), 360, "the interval is read, not assumed");
}

#[test]
fn the_daemon_silence_window_is_the_same_on_both_sides() {
    let text = std::fs::read_to_string(quick_mjs()).unwrap();
    assert_eq!(
        DAEMON_SILENT_AFTER_SECS,
        js_window_secs(&text),
        "`ll status` and the health check report the same silence, so they must agree on \
         how long silence is. Change both, or they tell one user two things."
    );
}
