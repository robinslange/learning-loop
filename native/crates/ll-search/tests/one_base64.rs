//! One base64 engine for the crate, and nothing else may name one.
//!
//! The engine used to be restated at twenty-two sites across fifteen files.
//! All of them were `STANDARD`, and nothing checked that they agreed — so
//! changing one was a silent wire-format change everywhere except the site
//! that changed.
//!
//! **This asserts the complement is empty**, not that the known sites were
//! converted. An enumeration of today's sites can only agree with today's
//! code; a file that starts naming the base64 crate tomorrow fails this the
//! day it is written. That is the difference between a sweep and a list of
//! what the sweep found, and the reason the sweep is a test rather than a
//! grep somebody ran once.
//!
//! The rule is deliberately wider than "no `general_purpose::`": no file but
//! `src/b64.rs` may mention the base64 crate AT ALL. `general_purpose` is one
//! spelling of the bypass — `base64::prelude::BASE64_STANDARD` and
//! `Engine::encode(&SOME_ENGINE, ..)` are others, and a rule naming only the
//! spelling it has already seen is the wordlist mistake in a different file.

use std::path::{Path, PathBuf};

use walkdir::WalkDir;

/// The crate root, from the manifest rather than from the test binary's
/// location — a `target/` layout change must not silently empty the sweep.
fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The one file allowed to name the base64 crate.
const THE_ONE: &str = "src/b64.rs";

/// Every `.rs` file this crate owns: the library, the binary, the integration
/// tests, the benches and the examples. Benches and examples are in scope
/// because a bench that encodes with its own engine is the same defect where
/// nobody looks — and `cargo test` does not build them, which is how
/// `index_reindex.rs` sat uncompilable for a whole plan.
fn rust_sources() -> Vec<PathBuf> {
    let root = crate_root();
    let mut out = Vec::new();
    for dir in ["src", "tests", "benches", "examples"] {
        let start = root.join(dir);
        if !start.exists() {
            continue;
        }
        for entry in WalkDir::new(&start).into_iter().filter_map(Result::ok) {
            let p = entry.path();
            if p.extension().is_some_and(|e| e == "rs") {
                out.push(p.to_path_buf());
            }
        }
    }
    out
}

fn relative(p: &Path) -> String {
    p.strip_prefix(crate_root()).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

#[test]
fn the_sweep_reaches_the_crate_and_finds_the_one_file_that_is_allowed() {
    // Sweeping nothing and sweeping everything are indistinguishable from a
    // green run. Both halves are checked here rather than assumed: the
    // assertion below is worthless if `rust_sources` came back empty, or if
    // it never reached the module it is supposed to be excepting.
    let files = rust_sources();
    assert!(files.len() > 40, "swept only {} files", files.len());

    let names: Vec<String> = files.iter().map(|p| relative(p)).collect();
    for expected in [THE_ONE, "src/main.rs", "src/sync/link.rs", "tests/one_base64.rs"] {
        assert!(names.iter().any(|n| n == expected), "the sweep must reach {expected}");
    }

    // The module path, not the engine's name. Which engine it is belongs to
    // `b64::tests::the_engine_is_standard_with_padding`, which pins it as
    // bytes; naming `STANDARD` here as well would make this test fail for the
    // wrong reason when the engine changes — and `STANDARD_NO_PAD` contains
    // `STANDARD`, so it would not even fail reliably.
    let the_one = std::fs::read_to_string(crate_root().join(THE_ONE)).unwrap();
    assert!(
        the_one.contains("base64::engine::general_purpose::"),
        "{THE_ONE} must be where the engine is named, or this test excepts nothing"
    );
}

/// Whether `line` reaches the `base64` crate under any spelling.
///
/// Three doors, and the third is the one a `base64::` substring misses
/// entirely: a path through the crate (`base64::`, `::base64::`), a `use`
/// that imports from it, and a `use` that RENAMES it — after
/// `use base64 as b64x;` every call site spells `b64x::` and names the crate
/// nowhere. A rule that lists only the spelling it has already seen is the
/// wordlist mistake, and this sweep was written to avoid exactly that.
fn names_the_base64_crate(line: &str) -> bool {
    let code = line.split("//").next().unwrap_or(line);
    if code.contains("base64::") {
        return true;
    }
    // `use base64 ...` / `use base64;` / `pub use base64 as ...`
    code.split_whitespace()
        .zip(code.split_whitespace().skip(1))
        .any(|(a, b)| a == "use" && (b == "base64" || b == "base64;" || b.starts_with("base64,")))
}

#[test]
fn no_file_but_the_b64_module_names_the_base64_crate() {
    let mut offenders = Vec::new();
    for path in rust_sources() {
        let rel = relative(&path);
        if rel == THE_ONE {
            continue;
        }
        // This file quotes the crate name to say what it forbids, the same
        // exemption the dead-flow sweeps give their own fixtures. Skipped
        // whole rather than per line: a `continue` inside the line loop reads
        // as a line-level exemption and is a place a second engine could sit.
        if rel == "tests/one_base64.rs" {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        for (i, line) in text.lines().enumerate() {
            // The crate, not one spelling of it. `base64::` alone is a
            // one-item wordlist: `use base64 as b64x;` builds a path that
            // contains no `base64::` anywhere, and that is the shape this
            // sweep exists to refuse.
            if names_the_base64_crate(line) {
                offenders.push(format!("{rel}:{}: {}", i + 1, line.trim()));
            }
        }
    }
    assert_eq!(
        offenders,
        Vec::<String>::new(),
        "every base64 in this crate goes through `crate::b64`, whose engine is the only one:\n{}",
        offenders.join("\n")
    );
}
