//! Read-side subcommands must NOT create the database file when it's missing.
//!
//! Background: a stray `ll-search query "some text"` (db_path omitted because
//! clap's positional `db_path: String` happily eats the query string) used to
//! silently spawn an empty SQLite file at `./some text`. Combined with
//! rusqlite's default `OPEN_CREATE` flag and an unconditional
//! `fs::create_dir_all(parent)` in `open_db`, every wrong-shaped invocation
//! leaked a fresh schema-only db on disk.
//!
//! Read-side commands now fail fast when the file is missing.

use std::process::Command;

fn ll_search_bin() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_ll-search"))
}

fn assert_no_file_created(path: &std::path::Path) {
    assert!(
        !path.exists(),
        "expected NO file at {} after a read-side failure; one was created",
        path.display(),
    );
}

#[test]
fn query_with_missing_db_does_not_create_file() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let bogus_db = tmp.path().join("does-not-exist.db");

    let out = Command::new(ll_search_bin())
        .args(["query", bogus_db.to_str().unwrap(), "some text"])
        .output()
        .expect("spawn ll-search");

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !out.status.success(),
        "expected non-zero exit for query against missing db; stderr: {stderr}"
    );
    assert!(
        stderr.contains("database file does not exist"),
        "expected diagnostic about missing db; got: {stderr}"
    );
    assert_no_file_created(&bogus_db);
}

#[test]
fn status_with_missing_db_does_not_create_file() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let bogus_db = tmp.path().join("missing.db");
    let bogus_vault = tmp.path().join("vault");

    let out = Command::new(ll_search_bin())
        .args([
            "status",
            bogus_db.to_str().unwrap(),
            bogus_vault.to_str().unwrap(),
        ])
        .output()
        .expect("spawn ll-search");

    assert!(!out.status.success(), "expected non-zero exit");
    assert_no_file_created(&bogus_db);
}

#[test]
fn tags_with_missing_db_does_not_create_file() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let bogus_db = tmp.path().join("missing.db");

    let out = Command::new(ll_search_bin())
        .args(["tags", bogus_db.to_str().unwrap()])
        .output()
        .expect("spawn ll-search");

    assert!(!out.status.success(), "expected non-zero exit");
    assert_no_file_created(&bogus_db);
}

#[test]
fn query_with_query_string_only_does_not_create_file() {
    // Reproduces the exact leak that motivated this fix: a user (or wrapper)
    // omits the db_path positional and clap eats the query string as the path.
    // The leaked file appears in the *current working directory*. Use a
    // sandbox cwd so we can assert nothing was written there.
    let tmp = tempfile::tempdir().expect("tempdir");
    let leak_name = "single source of truth pattern collapse drift";
    let expected_leak = tmp.path().join(leak_name);

    let out = Command::new(ll_search_bin())
        .current_dir(tmp.path())
        .args(["query", leak_name, "second positional"])
        .output()
        .expect("spawn ll-search");

    assert!(
        !out.status.success(),
        "expected non-zero exit; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_no_file_created(&expected_leak);
}

#[test]
fn embedding_commands_check_db_before_loading_model() {
    // Regression for v1.25.6: read-side commands that use embeddings
    // (similar/cluster/discriminate/reflect-scan/rerank/eval-prf/eval-funnel/
    // tune-prf) used to call init_embedding() before open_db(). On a missing
    // db, that meant the embedding-model download path ran first; the
    // "database file does not exist" diagnostic was only reachable after the
    // model load finished. In CI (cold HuggingFace cache) the download could
    // crash mid-flight, masking the real error completely.
    //
    // Contract pinned here: every embedding-using read-side command must emit
    // the missing-db diagnostic on stderr and exit non-zero, without first
    // touching the embedding model. Asserting on the diagnostic catches a
    // regression where init_embedding() moves back ahead of open_db().
    let tmp = tempfile::tempdir().expect("tempdir");
    let bogus_db = tmp.path().join("missing.db");
    let bogus_db_str = bogus_db.to_str().unwrap();

    // Each entry: (args slice) — first arg is the subcommand, remaining are
    // placeholders chosen to satisfy clap's positional parsing.
    let cases: &[&[&str]] = &[
        &["similar", bogus_db_str, "some/note.md"],
        &["cluster", bogus_db_str],
        &["discriminate", bogus_db_str, "a.md", "b.md"],
        &["reflect-scan", bogus_db_str, "a query"],
        &["rerank", bogus_db_str, "a query"],
        &["eval-prf", bogus_db_str],
        &["eval-funnel", bogus_db_str],
        &["tune-prf", bogus_db_str, "a query"],
    ];

    for args in cases {
        let out = Command::new(ll_search_bin())
            .args(*args)
            .output()
            .expect("spawn ll-search");

        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            !out.status.success(),
            "{} should exit non-zero on missing db; stderr: {stderr}",
            args[0],
        );
        assert!(
            stderr.contains("database file does not exist"),
            "{} should emit missing-db diagnostic before any model load; \
             got stderr: {stderr}",
            args[0],
        );
        assert_no_file_created(&bogus_db);
    }
}

#[test]
fn open_or_create_db_creates_parent_dir_and_file() {
    // Sanity check: open_or_create_db is the legitimate writeable entry point.
    // It must still mkdir the parent + create the db when missing — otherwise
    // the first `ll-search index` would be impossible. This guards against an
    // over-eager fix that locks everything down.
    //
    // Tests the helper directly rather than spawning `ll-search index`, which
    // requires the ONNX runtime and embedding model — both unavailable in
    // sandboxed CI envs. The contract we care about lives one layer below the
    // subcommand: any caller of open_or_create_db gets a usable connection.
    let tmp = tempfile::tempdir().expect("tempdir");
    let fresh_db = tmp.path().join("nested").join("more-nested").join("vault-index.db");

    assert!(!fresh_db.parent().unwrap().exists(), "parent must not pre-exist");

    let conn = ll_search::db::open_or_create_db(fresh_db.to_str().unwrap())
        .expect("open_or_create_db should succeed on missing path");

    assert!(
        fresh_db.parent().unwrap().exists(),
        "open_or_create_db must create the parent dir"
    );
    assert!(
        fresh_db.exists(),
        "open_or_create_db must create the db file"
    );
    drop(conn);
}
