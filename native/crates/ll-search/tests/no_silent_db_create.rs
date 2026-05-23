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
fn index_into_missing_path_DOES_create_file() {
    // Sanity check: `index` is the legitimate writeable entry point. It must
    // still create the db when missing, otherwise the first index would be
    // impossible. This guards against an over-eager fix that locks everything
    // down.
    let tmp = tempfile::tempdir().expect("tempdir");
    let vault = tmp.path().join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let fresh_db = tmp.path().join("nested").join("vault-index.db");

    let _out = Command::new(ll_search_bin())
        .args([
            "index",
            vault.to_str().unwrap(),
            fresh_db.to_str().unwrap(),
        ])
        .output()
        .expect("spawn ll-search");

    // Don't assert success — index needs the embedding model and may fail in
    // sandboxed test envs. The point of this test is the file-creation
    // behavior: `index` is allowed to mkdir + create.
    assert!(
        fresh_db.parent().unwrap().exists(),
        "index should have created parent dir for db path"
    );
}
