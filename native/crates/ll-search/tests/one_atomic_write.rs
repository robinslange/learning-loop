//! One implementation of "replace this file", and nothing else may name a
//! staging file of its own.
//!
//! Writing a payload to a temp path and renaming it into place was restated
//! four times across the federation code, each choosing its own temp name.
//! Two of them chose a FIXED one — `config.json.tmp`, `.seed-meta.json.tmp` —
//! and `config.json` has three writers, so two of them racing shared a single
//! staging path and took turns clobbering each other's half-written file.
//! `atomic_file` was added to end exactly that, with a module doc saying so,
//! and `write_config` was then written again underneath it.
//!
//! **This asserts the complement is empty**, not that the four known sites
//! were converted. A list of today's sites can only agree with today's code,
//! and the defect here IS reintroduction: the module existed, was documented,
//! and a later writer hand-rolled the same pair anyway. A file that starts
//! naming a staging file tomorrow fails this the day it is written.
//!
//! **What it does not catch**, stated rather than implied: a hand-rolled write
//! that stages under some name other than `.tmp` — `config.json.staging`, say.
//! The cause is targeted instead of the `fs::rename` that follows it, because
//! test code renames files legitimately (a fixture moving a vault note is how
//! a rename-detection test arranges its input) and separating those textually
//! needs a Rust parser in a test. `.tmp` is the convention every one of the
//! four sites reached for, so it is where a fifth will land.

use std::path::{Path, PathBuf};

use walkdir::WalkDir;

/// The crate root, from the manifest rather than from the test binary's
/// location — a `target/` layout change must not silently empty the sweep.
fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The implementation itself.
const THE_ONE: &str = "src/sync/atomic_file.rs";

/// The one real exception. `download` renames a file **curl** wrote, so there
/// are no bytes in hand to pass to `write_bytes` — and the payload is a ~100 MB
/// model, which is the reason not to put them in hand. A different shape, not
/// a second copy of this one.
const CURL_WRITES_IT: &str = "src/model/loader.rs";

/// Every `.rs` file under `src/`. Test modules included: a fixture that stages
/// its own file is a second implementation in the place nobody looks.
fn library_sources() -> Vec<PathBuf> {
    WalkDir::new(crate_root().join("src"))
        .into_iter()
        .filter_map(Result::ok)
        .map(|e| e.path().to_path_buf())
        .filter(|p| p.extension().is_some_and(|e| e == "rs"))
        .collect()
}

fn relative(p: &Path) -> String {
    p.strip_prefix(crate_root()).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// Whether `line` names a staging file.
///
/// The trailing quote is what keeps this off the 130-odd `tmp` variables
/// holding a `tempfile::TempDir` in this crate's tests: those are bindings,
/// and this is a filename — `with_extension("json.tmp")`, `"tmp"`,
/// `format!("{base}.tmp")`. Comments are stripped so that naming the
/// convention in prose does not count as using it.
fn names_a_staging_file(line: &str) -> bool {
    let code = line.split("//").next().unwrap_or(line);
    code.contains("tmp\"")
}

#[test]
fn the_sweep_reaches_the_crate_and_the_exception_still_needs_its_exemption() {
    // Sweeping nothing and sweeping everything are indistinguishable from a
    // green run, so both halves are checked rather than assumed.
    let files = library_sources();
    assert!(files.len() > 30, "swept only {} files", files.len());

    let names: Vec<String> = files.iter().map(|p| relative(p)).collect();
    for expected in [THE_ONE, CURL_WRITES_IT, "src/main.rs", "src/sync/config.rs"] {
        assert!(names.iter().any(|n| n == expected), "the sweep must reach {expected}");
    }

    // An exemption for a file that no longer needs one is not cover, it is a
    // hole with a comment over it.
    for allowed in [THE_ONE, CURL_WRITES_IT] {
        let text = std::fs::read_to_string(crate_root().join(allowed)).unwrap();
        assert!(
            text.lines().any(names_a_staging_file),
            "{allowed} is exempted from a rule it no longer needs"
        );
    }

    // And the detector has to fire on what it is looking for, or an empty
    // offender list means only that it fires on nothing.
    assert!(names_a_staging_file(r#"    let tmp = path.with_extension("json.tmp");"#));
    assert!(names_a_staging_file(r#"    let tmp = dest.with_extension("tmp");"#));
    assert!(!names_a_staging_file(r#"    let tmp = tempfile::tempdir().unwrap();"#));
    assert!(!names_a_staging_file(r#"    // a fixed "json.tmp" is what this replaced"#));
}

#[test]
fn no_file_but_atomic_file_names_a_staging_file() {
    let mut offenders = Vec::new();
    for path in library_sources() {
        let rel = relative(&path);
        if rel == THE_ONE || rel == CURL_WRITES_IT {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        for (i, line) in text.lines().enumerate() {
            if names_a_staging_file(line) {
                offenders.push(format!("{rel}:{}: {}", i + 1, line.trim()));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "these stage a file under a name of their own. `atomic_file` is the one \
         implementation — `write_json`, `write_bytes` (which lets a caller post-process \
         the staged file before it is published) or `write_private_bytes` — and it is \
         what gives every write a temp name nothing else can collide with:\n  {}",
        offenders.join("\n  ")
    );
}
