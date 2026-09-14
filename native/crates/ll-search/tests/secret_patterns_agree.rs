//! The Rust scrubber and `secret-patterns.mjs` are one list, and this is what
//! makes that true.
//!
//! `plugin/scripts/lib/secret-patterns.mjs` is the canonical source: three JS
//! scrubbers read it, and `export.rs` holds a hand-port of the same ten
//! patterns for the `listed`-tier summary path. What kept them equal was a
//! comment asking the next editor to keep them equal. A pattern added on the
//! JS side is a credential shape the federated export would publish; a pattern
//! dropped on the Rust side is the same thing, silently.
//!
//! **Both directions.** A test that only checks "every Rust pattern is in the
//! JS file" passes when JS grows an eleventh, which is the likelier direction
//! — the JS file is the one three other consumers already edit.
//!
//! Comparing sources rather than behaviour is deliberate. Behaviour would mean
//! running node from a Rust test and agreeing on a corpus, and a corpus is a
//! list of the cases someone thought of: two regexes can agree on every sample
//! in it and disagree on the credential that matters. The sources are the
//! thing that has to be equal.

use std::collections::BTreeSet;
use std::path::PathBuf;

use ll_search::sync::export::SECRET_PATTERN_SOURCES;

/// `plugin/scripts/lib/secret-patterns.mjs`, from the manifest dir rather than
/// the test binary's location.
fn mjs_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugin/scripts/lib/secret-patterns.mjs")
}

/// The two legitimate spelling differences between a JS literal and a Rust
/// `regex` source, and nothing else.
///
/// 1. `\/` — JS must escape the `/` that would otherwise close the literal.
///    Rust has no delimiter, so it does not.
/// 2. `[\s\S]` — JS's idiom for "any character including newline", because it
///    has no inline dotall. Rust spells it `(?s:...)` around the alternation
///    and a plain `.` inside.
///
/// Anything else survives normalisation and fails the comparison, which is the
/// point: a third difference should be looked at, not absorbed.
fn canonical(src: &str) -> String {
    let s = src.replace("\\/", "/").replace("[\\s\\S]", ".");
    match s.strip_prefix("(?s:").and_then(|inner| inner.strip_suffix(')')) {
        Some(unwrapped) => unwrapped.to_string(),
        None => s,
    }
}

/// Every `re:` body in the `.mjs`, paired with the `kind` above it.
///
/// A hand-rolled scan rather than a JS parser: the file is a flat array of
/// object literals, and `the_scan_finds_every_pattern_in_the_file` pins the
/// count so a parse that quietly matches fewer is a failure, not a pass.
fn js_patterns(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut kind: Option<String> = None;
    for line in text.lines() {
        let code = line.trim();
        if let Some(rest) = code.split("kind: '").nth(1) {
            if let Some(k) = rest.split('\'').next() {
                kind = Some(k.to_string());
            }
        }
        if let Some(rest) = code.split("re: /").nth(1) {
            // Back off the trailing flags and the closing delimiter: the body
            // is everything up to the last `/` on the line.
            if let Some(end) = rest.rfind('/') {
                if let Some(k) = kind.take() {
                    out.push((k, rest[..end].to_string()));
                }
            }
        }
    }
    out
}

#[test]
fn the_scan_finds_every_pattern_in_the_file() {
    // A scan that silently matched nothing would make the set comparison below
    // agree with anything.
    let text = std::fs::read_to_string(mjs_path())
        .unwrap_or_else(|e| panic!("{} is the canonical list: {e}", mjs_path().display()));
    let found = js_patterns(&text);
    assert_eq!(
        found.len(),
        text.matches("re: /").count(),
        "the scan dropped a pattern the file declares"
    );
    assert_eq!(found.len(), 10, "found {} patterns: {found:#?}", found.len());

    // And it reads the bodies, not just the kinds.
    let aws: &(String, String) =
        found.iter().find(|(k, _)| k == "aws-key").expect("aws-key is in the file");
    assert_eq!(aws.1, "AKIA[0-9A-Z]{16}");

    // The normaliser must actually close the two gaps it claims to, or the
    // comparison is passing for the wrong reason.
    assert_eq!(canonical(r"[A-Za-z0-9._\-\/+=]{20,}"), canonical(r"[A-Za-z0-9._\-/+=]{20,}"));
    assert_eq!(canonical(r"KEY-----[\s\S]*?-----END"), canonical(r"(?s:KEY-----.*?-----END)"));
    // And must NOT absorb a real difference.
    assert_ne!(canonical(r"AKIA[0-9A-Z]{16}"), canonical(r"AKIA[0-9A-Z]{20}"));
}

#[test]
fn the_rust_and_js_secret_patterns_are_the_same_set() {
    let text = std::fs::read_to_string(mjs_path()).unwrap();

    let js: BTreeSet<(String, String)> =
        js_patterns(&text).into_iter().map(|(k, p)| (k, canonical(&p))).collect();
    let rust: BTreeSet<(String, String)> = SECRET_PATTERN_SOURCES
        .iter()
        .map(|(k, p)| (k.to_string(), canonical(p)))
        .collect();

    let only_js: Vec<_> = js.difference(&rust).collect();
    let only_rust: Vec<_> = rust.difference(&js).collect();

    assert!(
        only_js.is_empty(),
        "secret-patterns.mjs declares these and `export.rs` does not, so the federated \
         export publishes a `listed`-tier summary containing them:\n  {only_js:#?}"
    );
    assert!(
        only_rust.is_empty(),
        "`export.rs` scrubs these and secret-patterns.mjs does not, so the three JS \
         scrubbers let them through:\n  {only_rust:#?}"
    );
}
