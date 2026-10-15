//! A downstream crate cannot use a struct literal for the `#[non_exhaustive]`
//! `FtsConfig`; `FtsConfig::new` is how it names its own tables.

use ll_core::scoring::{fts_bm25_query, try_fts_bm25_query, FtsConfig};
use rusqlite::Connection;

const MAIL_FTS: FtsConfig = FtsConfig::new(
    "mail_fts",
    "mail_content",
    "mail_messages",
    "id",
    "mailbox_path",
    "5.0, 1.0",
);

fn mail_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE mail_messages (id INTEGER PRIMARY KEY, mailbox_path TEXT NOT NULL);
         CREATE TABLE mail_content (id INTEGER PRIMARY KEY);
         CREATE VIRTUAL TABLE mail_fts USING fts5(subject, body);
         INSERT INTO mail_messages VALUES (1, 'INBOX/1'), (2, 'INBOX/2'), (3, 'Sent/3');
         INSERT INTO mail_content VALUES (1), (2), (3);
         INSERT INTO mail_fts(rowid, subject, body) VALUES
           (1, 'Invoice for October', 'Please find the invoice attached'),
           (2, 'Lunch', 'Are you free on Friday for lunch'),
           (3, 'Re: Invoice', 'Paid, thanks');",
    )
    .unwrap();
    conn
}

#[test]
fn custom_config_is_usable_in_a_const() {
    assert_eq!(MAIL_FTS.fts_table, "mail_fts");
    assert_eq!(MAIL_FTS.path_column, "mailbox_path");
    assert_eq!(MAIL_FTS.bm25_weights, "5.0, 1.0");
}

#[test]
fn try_fts_bm25_query_runs_against_custom_tables() {
    let conn = mail_db();
    let hits = try_fts_bm25_query(&conn, "invoice", 10, &MAIL_FTS).unwrap();
    let mut paths: Vec<&str> = hits.iter().map(|h| h.1.as_str()).collect();
    paths.sort();
    assert_eq!(paths, ["INBOX/1", "Sent/3"]);
    assert!(hits.iter().all(|h| h.2 < 0.0), "bm25 scores are negative");
    // Best match first: scores ascend (more negative = better).
    assert!(hits[0].2 <= hits[1].2);
}

#[test]
fn infallible_variant_works_and_missing_table_is_an_error() {
    let conn = mail_db();
    assert_eq!(fts_bm25_query(&conn, "lunch", 10, &MAIL_FTS).len(), 1);

    let wrong = FtsConfig::new(
        "nope_fts",
        "mail_content",
        "mail_messages",
        "id",
        "mailbox_path",
        "1.0",
    );
    assert!(try_fts_bm25_query(&conn, "lunch", 10, &wrong).is_err());
}
