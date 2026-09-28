//! `index --force` against an index another connection holds (the watch
//! daemon mid-reindex) is an error the user can act on, not a crash. It used
//! to panic in `drop_all` with exit 101.

#[test]
fn force_reindex_of_a_locked_index_is_an_error_not_a_panic() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let db = tmp.path().join("index.db");
    let db = db.to_str().unwrap();
    let conn = ll_search::db::open_or_create_db(db).expect("create index");
    // Fail at once instead of waiting out the 5s busy timeout.
    conn.busy_timeout(std::time::Duration::ZERO).unwrap();

    let holder = rusqlite::Connection::open(db).unwrap();
    holder.execute_batch("BEGIN EXCLUSIVE;").unwrap();

    let Err(err) = ll_search::db::reindex(&conn, tmp.path().to_str().unwrap(), true) else {
        panic!("a locked index cannot be rebuilt");
    };
    assert!(
        format!("{err:#}").contains("failed to drop tables"),
        "{err:#}"
    );
}
