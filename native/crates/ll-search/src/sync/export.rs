use std::collections::{HashMap, HashSet};
use std::path::Path;
use anyhow::Context;
use regex::Regex;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::LazyLock;

use super::config::FederationConfig;
use super::visibility::VisibilityEngine;

const SCHEMA_VERSION: u32 = 2;

/// Maximum notes per multi-row INSERT chunk.
///
/// 240 rows × 6 placeholders = 1440 parameters — well under both the
/// legacy SQLite 999-param ceiling and the modern 32766 ceiling.
const INSERT_CHUNK: usize = 240;

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub exported: usize,
    pub skipped: usize,
    /// Rows the SELECT below never returned, because they carry no
    /// `note_uuid`. Counted separately from `skipped`, which is a visibility
    /// decision: this one is not a decision at all, and a vault indexed before
    /// stable identity can have most of itself in here. Reporting it as zero
    /// skipped would say the export considered every note and chose to send
    /// these, when it never saw them.
    pub unindexed: usize,
    #[serde(skip)]
    pub model_id: String,
}

pub fn export_index(
    source_db_path: &Path,
    vault_path: &Path,
    export_path: &Path,
    config: &FederationConfig,
) -> anyhow::Result<ExportResult> {
    if let Some(parent) = export_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let source = Connection::open_with_flags(
        source_db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .context("failed to open source index")?;

    let model_id: String = source
        .query_row("SELECT value FROM meta WHERE key = 'model_id'", [], |r| r.get(0))
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => anyhow::anyhow!(
                "this index has never been built: it carries no model_id, so there is \
                 nothing to export. Run `ll-search index <vault-path> <db-path>` against \
                 it first, and check the db path is the one the watcher maintains \
                 (`<vault>/.vault-search/vault-index.db`) rather than an empty file."
            ),
            other => anyhow::Error::new(other).context("failed to read the source index's model_id"),
        })?;

    // Counted before the SELECT filters them out, so the caller can say how
    // much of the vault the export never considered.
    let unindexed: usize = source
        .query_row("SELECT count(*) FROM notes WHERE note_uuid IS NULL", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as usize;

    let rules: Vec<(String, String)> = config
        .visibility
        .rules
        .iter()
        .map(|r| (r.pattern.clone(), r.tier.clone()))
        .collect();
    let engine = VisibilityEngine::new(&config.visibility.default, &rules);

    if export_path.exists() {
        std::fs::remove_file(export_path)?;
    }

    let export = Connection::open(export_path)?;
    export.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE notes (
             id INTEGER PRIMARY KEY,
             note_uuid TEXT NOT NULL,
             path TEXT NOT NULL,
             title TEXT NOT NULL,
             tags TEXT,
             tier TEXT NOT NULL,
             updated_at INTEGER NOT NULL
         );
         CREATE TABLE notes_content (
             id INTEGER PRIMARY KEY,
             title TEXT,
             tags TEXT,
             body TEXT
         );
         CREATE TABLE meta (
             key TEXT PRIMARY KEY,
             value TEXT
         );
         CREATE TABLE embeddings (
             id INTEGER PRIMARY KEY,
             data BLOB NOT NULL
         );
         CREATE TABLE links (
             source_id INTEGER NOT NULL,
             target_path TEXT NOT NULL,
             UNIQUE(source_id, target_path)
         );"
    )?;

    // --- Phase 1: load all rows from source and pre-compute visibility -------
    //
    // Reading all frontmatter here (one disk pass) is cheaper than reading
    // it per-row inside the INSERT loop.  Memory cost: ~300 B/note at 10k
    // notes ≈ 3 MB — well within the 200 MB RSS budget.

    struct NoteRow {
        id: i64,
        note_uuid: String,
        path: String,
        title: String,
        tags: String,
        body: String,
    }

    let mut all_rows: Vec<NoteRow> = Vec::new();
    {
        let mut stmt = source.prepare(
            // A row without a note_uuid predates stable note identity. Export
            // nothing for it rather than a row the hub cannot address; a
            // reindex assigns one and it comes back on the next sync.
            "SELECT n.id, n.note_uuid, n.path, n.title, n.tags, nc.body
             FROM notes n
             JOIN notes_content nc ON nc.id = n.id
             WHERE n.note_uuid IS NOT NULL"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(NoteRow {
                id:        row.get::<_, i64>(0)?,
                note_uuid: row.get::<_, String>(1)?,
                path:      row.get::<_, String>(2)?,
                title:     row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                tags:      row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                body:      row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            })
        })?;
        for row in rows {
            let mut r = row?;
            r.path = r.path.replace('\\', "/");
            all_rows.push(r);
        }
    }

    // Build visibility inputs once: (path, frontmatter_visibility).
    let vis_inputs: Vec<(String, Option<String>)> = all_rows
        .iter()
        .map(|r| {
            let fm = std::fs::read_to_string(vault_path.join(&r.path))
                .ok()
                .and_then(|raw| crate::sync::frontmatter::read_key(&raw, "visibility"));
            (r.path.clone(), fm)
        })
        .collect();

    // Evaluate the whole batch — O(n) glob matching, no per-row disk I/O.
    let tiers = engine.evaluate_batch(&vis_inputs);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // --- Phase 2: INSERT exported notes in chunks ---------------------------

    export.execute("BEGIN", [])?;

    let mut exported = 0usize;
    let mut skipped = 0usize;
    // The disclosed notes, keyed the way a wikilink names them, so the target
    // end of a link can be checked against the same decision as the source.
    let mut exported_link_names: HashSet<String> = HashSet::new();
    // The one decision, per note. Every later phase reads it rather than
    // asking `tier` a second question of its own.
    let mut disclosed: HashMap<i64, Disclosure> = HashMap::new();

    for (row, tier) in all_rows.iter().zip(tiers.iter()) {
        let Some(disclosure) = Disclosure::for_tier(tier) else {
            skipped += 1;
            continue;
        };

        let export_body = match disclosure.body {
            Body::Full => row.body.clone(),
            Body::Summary => summarize(&row.body, 300),
        };

        export.prepare_cached(
            "INSERT INTO notes (id, note_uuid, path, title, tags, tier, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?
        .execute(params![row.id, row.note_uuid, row.path, row.title, row.tags, tier, now])?;

        export.prepare_cached(
            "INSERT INTO notes_content (id, title, tags, body) VALUES (?1, ?2, ?3, ?4)",
        )?
        .execute(params![row.id, row.title, row.tags, export_body])?;

        disclosed.insert(row.id, disclosure);
        if disclosure.links {
            exported_link_names.insert(crate::preprocess::wikilink_name(&row.path));
        }
        exported += 1;
    }

    // --- Phase 3: copy embeddings for exported notes in chunks --------------

    let mut emb_stmt = source.prepare(
        "SELECT e.id, e.data FROM embeddings e JOIN notes n ON e.id = n.id"
    )?;

    let emb_rows: Vec<(i64, Vec<u8>)> = emb_stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?
        .filter_map(|r| r.ok())
        .filter(|(id, _)| disclosed.get(id).is_some_and(|d| d.embedding))
        .collect();

    for chunk in emb_rows.chunks(INSERT_CHUNK) {
        for (id, data) in chunk {
            export.prepare_cached(
                "INSERT INTO embeddings (id, data) VALUES (?1, ?2)",
            )?
            .execute(params![id, data])?;
        }
    }

    // --- Phase 4: copy links for exported notes -----------------------------

    let has_links = source
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='links'",
            [],
            |_| Ok(()),
        )
        .is_ok();

    if has_links {
        let mut link_stmt = source.prepare(
            "SELECT source_id, target_path FROM links"
        )?;
        let link_rows: Vec<(i64, String)> = link_stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            // Both ends, not just the source. `target_path` is whatever the
            // author typed inside `[[...]]`, which is normally the target's
            // basename -- and in a vault whose filenames are sentences, that
            // basename IS the note's title. A row kept because its source
            // shipped would publish the title of a note the tier decision
            // withheld, through a table that decision never reached. Reducing
            // both sides through `wikilink_name` also catches the author who
            // wrote a folder into the link. A link leaves only when both of
            // its notes did; a target naming no exported note drops, so an
            // unresolvable link cannot default to sent.
            .filter(|(source_id, target_path)| {
                disclosed.get(source_id).is_some_and(|d| d.links)
                    && exported_link_names
                        .contains(&crate::preprocess::wikilink_name(target_path))
            })
            .collect();

        for chunk in link_rows.chunks(INSERT_CHUNK) {
            for (source_id, target_path) in chunk {
                export.prepare_cached(
                    "INSERT OR IGNORE INTO links (source_id, target_path) VALUES (?1, ?2)",
                )?
                .execute(params![source_id, target_path])?;
            }
        }
    }

    // --- Phase 5: meta ------------------------------------------------------

    let peer_id = &config.identity.display_name;
    let now_iso = crate::db::chrono_iso_now();
    export.execute("INSERT INTO meta (key, value) VALUES ('model_id', ?1)", params![model_id])?;
    export.execute("INSERT INTO meta (key, value) VALUES ('schema_version', ?1)", params![SCHEMA_VERSION.to_string()])?;
    export.execute("INSERT INTO meta (key, value) VALUES ('peer_id', ?1)", params![peer_id])?;
    export.execute("INSERT INTO meta (key, value) VALUES ('exported_at', ?1)", params![now_iso])?;
    export.execute("INSERT INTO meta (key, value) VALUES ('note_count', ?1)", params![exported.to_string()])?;

    export.execute("COMMIT", [])?;

    Ok(ExportResult { exported, skipped, unindexed, model_id })
}

/// Credential-shaped regexes for scrubbing `listed`-tier summaries.
///
/// Canonical source: `plugin/scripts/lib/secret-patterns.mjs` — port the 10
/// patterns from there and keep this list in sync when that file changes.
/// The PEM pattern uses `(?s:...)` so `.` matches newlines within just that
/// alternation, mirroring JS's `[\s\S]*?`.
static SECRET_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"AKIA[0-9A-Z]{16}",
        r"gh[po]_[A-Za-z0-9]{36,}",
        r"sk-ant-api[A-Za-z0-9_-]{20,}",
        r"sk_(?:live|test)_[A-Za-z0-9]{20,}",
        r"sk-[A-Za-z0-9_-]{20,}",
        r"cfpat-[A-Za-z0-9_-]{20,}",
        r"Bearer\s+[A-Za-z0-9._\-/+=]{20,}",
        r"xox[abprs]-[A-Za-z0-9-]{10,}",
        r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
        r"(?s:-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----)",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("secret pattern must compile"))
    .collect()
});

/// Replace any credential-shaped substring with `[REDACTED]`.
///
/// Applied to `listed`-tier summaries only — `public`-tier export is a
/// deliberate full-body export and stays raw.
fn scrub(text: &str) -> String {
    let mut out = text.to_string();
    for pattern in SECRET_PATTERNS.iter() {
        out = pattern.replace_all(&out, "[REDACTED]").into_owned();
    }
    out
}

fn summarize(text: &str, max_chars: usize) -> String {
    let first_para = text.split("\n\n").next().unwrap_or(text).trim();
    if first_para.chars().count() <= max_chars {
        return scrub(first_para);
    }
    let byte_end = first_para
        .char_indices()
        .nth(max_chars)
        .map(|(i, _)| i)
        .unwrap_or(first_para.len());
    let truncated = &first_para[..byte_end];
    let last_space = truncated.rfind(' ').unwrap_or(byte_end);
    scrub(&format!("{}...", &truncated[..last_space]))
}

/// Compute a SQLite patchset from `base_db` to `current_db` covering the four
/// content-bearing tables (`notes`, `notes_content`, `embeddings`, `links`).
///
/// `meta` is intentionally excluded so a re-export that only updates
/// `exported_at` doesn't generate a one-row meta patchset on every sync.
///
/// The returned blob can be applied on the hub via
/// `Connection::apply_strm` (or `rusqlite::session::Changeset::apply`)
/// to bring the hub's stored base DB up to the current state. Uses
/// `patchset_strm` (new values only) rather than `changeset_strm` (before+after)
/// to halve the wire cost on embedding updates where each row is ~1.5 KB.
pub fn compute_patchset(base_db: &Path, current_db: &Path) -> anyhow::Result<Vec<u8>> {
    use rusqlite::session::Session;
    use rusqlite::DatabaseName;

    let conn = Connection::open(current_db).context("open current db")?;
    conn.execute(
        &format!("ATTACH DATABASE '{}' AS base", base_db.display()),
        [],
    )
    .context("attach base db")?;

    let mut session = Session::new(&conn).context("create session")?;
    session.attach(None).context("attach session to all tables")?;

    let base = DatabaseName::Attached("base");
    for table in ["notes", "notes_content", "embeddings", "links"] {
        session
            .diff(base, table)
            .with_context(|| format!("session.diff for {table}"))?;
    }

    let mut buf = Vec::new();
    session.patchset_strm(&mut buf).context("patchset_strm")?;
    Ok(buf)
}

/// Build a SOURCE index in the shape `db/schema.rs` produces.
///
/// Lives outside `mod tests` because `sync::client`'s tests need a real
/// export to read metadata back out of, and a second copy of this schema
/// there would be free to drift from the one `export_index` actually reads.
/// What one note discloses, derived once from its tier.
///
/// Every phase of the export asks this instead of re-testing `tier` itself.
/// That is not tidiness: `links` and `embeddings` each re-derived the rule on
/// their own and each got it wrong -- the links table published the titles of
/// withheld notes, and a listed note shipped a vector computed over the body
/// its summary had just truncated. A phase that must name a field cannot
/// silently default to shipping, and a new table added to the export has to
/// answer the question to compile.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Disclosure {
    /// The note's own body, as this tier sends it.
    pub body: Body,
    /// The vector, which is computed over the WHOLE body regardless of tier.
    pub embedding: bool,
    /// Whether this note may appear as a link source. A link also needs its
    /// target disclosed; that is the other end of the same rule.
    pub links: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Body {
    Full,
    Summary,
}

impl Disclosure {
    /// `None` means nothing about this note leaves the machine.
    pub(crate) fn for_tier(tier: &str) -> Option<Self> {
        match tier {
            "public" => Some(Disclosure { body: Body::Full, embedding: true, links: true }),
            // A listed note sends a summary, so its full-body vector would
            // disclose exactly what the summary withheld.
            "listed" => Some(Disclosure { body: Body::Summary, embedding: false, links: true }),
            _ => None,
        }
    }
}

#[cfg(test)]
pub(crate) fn build_source_db(path: &Path, note_uuid: Option<&str>) {
    let c = Connection::open(path).unwrap();
    c.execute_batch(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE notes (
             id INTEGER PRIMARY KEY,
             path TEXT UNIQUE NOT NULL,
             content_hash TEXT NOT NULL,
             mtime REAL NOT NULL,
             title TEXT,
             tags TEXT,
             visibility TEXT DEFAULT 'private',
             note_uuid TEXT
         );
         CREATE TABLE notes_content (
             id INTEGER PRIMARY KEY, title TEXT, tags TEXT, body TEXT
         );
         CREATE TABLE embeddings (id INTEGER PRIMARY KEY, data BLOB NOT NULL);
         CREATE TABLE links (
             source_id INTEGER NOT NULL, target_path TEXT NOT NULL,
             UNIQUE(source_id, target_path)
         );
         INSERT INTO meta (key, value) VALUES ('model_id', 'test-model');",
    )
    .unwrap();
    c.execute(
        "INSERT INTO notes (id, path, content_hash, mtime, title, tags, note_uuid)
         VALUES (1, 'n.md', 'h', 0.0, 'N', '', ?1)",
        rusqlite::params![note_uuid],
    )
    .unwrap();
    c.execute(
        "INSERT INTO notes_content (id, title, tags, body) VALUES (1, 'N', '', 'Body.')",
        [],
    )
    .unwrap();
}

#[cfg(test)]
/// Two addressable notes and one link between them. `shared.md` is published
/// by the caller's rules; `secret.md` is withheld. `shared` links to both, so
/// the export must carry the link to `other` and drop the link to `secret`.
pub(crate) fn build_linked_source_db(path: &Path, vault: &Path) {
    let c = Connection::open(path).unwrap();
    c.execute_batch(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE notes (
             id INTEGER PRIMARY KEY,
             path TEXT UNIQUE NOT NULL,
             content_hash TEXT NOT NULL,
             mtime REAL NOT NULL,
             title TEXT,
             tags TEXT,
             visibility TEXT DEFAULT 'private',
             note_uuid TEXT
         );
         CREATE TABLE notes_content (
             id INTEGER PRIMARY KEY, title TEXT, tags TEXT, body TEXT
         );
         CREATE TABLE embeddings (id INTEGER PRIMARY KEY, data BLOB NOT NULL);
         CREATE TABLE links (
             source_id INTEGER NOT NULL, target_path TEXT NOT NULL,
             UNIQUE(source_id, target_path)
         );
         INSERT INTO meta (key, value) VALUES ('model_id', 'test-model');
         INSERT INTO notes (id, path, content_hash, mtime, title, tags, note_uuid) VALUES
             (1, 'shared.md', 'h', 0.0, 'Shared', '', '01926d7e-0000-7000-8000-000000000001'),
             (2, 'secret.md', 'h', 0.0, 'Secret', '', '01926d7e-0000-7000-8000-000000000002'),
             (3, 'other.md',  'h', 0.0, 'Other',  '', '01926d7e-0000-7000-8000-000000000003');
         INSERT INTO notes_content (id, title, tags, body) VALUES
             (1, 'Shared', '', 'Links [[secret]] and [[other]].'),
             (2, 'Secret', '', 'Private body.'),
             (3, 'Other',  '', 'Other body.');
         INSERT INTO links (source_id, target_path) VALUES (1, 'secret'), (1, 'other');",
    )
    .unwrap();
    std::fs::create_dir_all(vault).unwrap();
    std::fs::write(vault.join("shared.md"), "---\ntitle: Shared\n---\n\nLinks [[secret]] and [[other]].").unwrap();
    std::fs::write(vault.join("secret.md"), "---\ntitle: Secret\n---\n\nPrivate body.").unwrap();
    std::fs::write(vault.join("other.md"),  "---\ntitle: Other\n---\n\nOther body.").unwrap();
}

#[cfg(test)]
pub(crate) fn public_vault_with_note(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("n.md"), "---\nvisibility: public\n---\n\nBody.").unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn summarize_short_text_unchanged() {
        let text = "A short note.";
        assert_eq!(summarize(text, 300), "A short note.");
    }

    #[test]
    fn summarize_uses_first_paragraph_only() {
        let text = "First paragraph content.\n\nSecond paragraph that should be excluded.";
        let result = summarize(text, 300);
        assert_eq!(result, "First paragraph content.");
        assert!(!result.contains("Second"));
    }

    #[test]
    fn summarize_truncates_at_word_boundary() {
        let text = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10";
        let result = summarize(text, 20);
        assert!(result.ends_with("..."), "should end with ellipsis");
        let without_ellipsis = result.trim_end_matches("...");
        assert!(!without_ellipsis.ends_with(' '), "no trailing space before ellipsis");
        assert!(without_ellipsis.len() < 20, "truncated portion fits within limit");
    }

    #[test]
    fn summarize_exact_length_not_truncated() {
        let text = "hello";
        assert_eq!(summarize(text, 5), "hello");
    }

    #[test]
    fn summarize_empty_string() {
        assert_eq!(summarize("", 100), "");
    }

    #[test]
    fn summarize_scrubs_aws_key() {
        let text = "The key AKIAIOSFODNN7EXAMPLE rotates.\n\nMore.";
        let result = summarize(text, 300);
        assert!(!result.contains("AKIA"), "AWS key shape leaked: {result}");
    }

    #[test]
    fn summarize_scrubs_on_the_truncated_path() {
        // Secret sits early in a first paragraph that overflows max_chars, so the
        // truncating branch of summarize (not the short-circuit) must still scrub.
        let mut text = String::from("Key AKIAIOSFODNN7EXAMPLE then ");
        text.push_str(&"padding ".repeat(60));
        let result = summarize(&text, 40);
        assert!(result.ends_with("..."), "expected the truncated branch: {result}");
        assert!(!result.contains("AKIA"), "AWS key shape leaked on truncated path: {result}");
    }


    #[test]
    fn export_carries_note_uuid() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.db");
        let out = tmp.path().join("export.db");
        let vault = tmp.path().join("vault");
        build_source_db(&source, Some("01926d7e-0000-7000-8000-00000000000a"));
        public_vault_with_note(&vault);

        let config = FederationConfig::test_fixture("private", vec![]);
        export_index(&source, &vault, &out, &config).unwrap();

        let c = Connection::open(&out).unwrap();
        let got: String = c
            .query_row("SELECT note_uuid FROM notes LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(got, "01926d7e-0000-7000-8000-00000000000a");
    }

    /// A `listed` note sends a 300-character summary, and its embedding is
    /// computed over the whole body. Shipping the vector publishes a
    /// derivation of the text the summary withheld.
    #[test]
    fn a_listed_note_ships_no_embedding() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.db");
        let out = tmp.path().join("export.db");
        let vault = tmp.path().join("vault");
        build_linked_source_db(&source, &vault);
        {
            let c = Connection::open(&source).unwrap();
            for id in 1..=3 {
                c.execute(
                    "INSERT INTO embeddings (id, data) VALUES (?1, ?2)",
                    rusqlite::params![id, vec![0u8; 16]],
                )
                .unwrap();
            }
        }
        // `shared` publishes itself; `other` stays listed; `secret` is withheld.
        std::fs::write(
            vault.join("shared.md"),
            "---\nvisibility: public\n---\n\nLinks [[secret]] and [[other]].",
        )
        .unwrap();

        let config = FederationConfig::test_fixture(
            "listed",
            vec![("**/secret*".to_string(), "private".to_string())],
        );
        export_index(&source, &vault, &out, &config).unwrap();

        let c = Connection::open(&out).unwrap();
        let ids: Vec<i64> = c
            .prepare("SELECT id FROM embeddings").unwrap()
            .query_map([], |r| r.get::<_, i64>(0)).unwrap()
            .filter_map(|r| r.ok()).collect();
        assert!(!ids.contains(&3), "a listed note shipped a full-body vector: {ids:?}");
        assert!(!ids.contains(&2), "a withheld note shipped a vector: {ids:?}");
        // Not vacuous: the public note keeps its embedding, or peer search over
        // public notes would silently lose its vector path.
        assert_eq!(ids, vec![1], "the public note must keep its embedding");
    }

    /// The control that decides what leaves the machine. Deleting the `private`
    /// branch published every withheld note, body and all, and the suite stayed
    /// green: the assertion that looked like cover was `exported + skipped == 1`,
    /// a sum over a partition that both branches satisfy. This one names the
    /// artefact instead of the counters.
    #[test]
    fn a_private_note_is_absent_from_the_export_artefact() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.db");
        let out = tmp.path().join("export.db");
        let vault = tmp.path().join("vault");
        build_linked_source_db(&source, &vault);

        let config = FederationConfig::test_fixture(
            "listed",
            vec![("**/secret*".to_string(), "private".to_string())],
        );
        export_index(&source, &vault, &out, &config).unwrap();

        let c = Connection::open(&out).unwrap();
        let paths: Vec<String> = c
            .prepare("SELECT path FROM notes").unwrap()
            .query_map([], |r| r.get::<_, String>(0)).unwrap()
            .filter_map(|r| r.ok()).collect();
        assert!(!paths.iter().any(|p| p == "secret.md"), "withheld note in notes: {paths:?}");

        // Its body must not be reachable by id either: the row and its content
        // are separate tables, and only one of them is what a peer reads.
        let bodies: Vec<String> = c
            .prepare("SELECT body FROM notes_content").unwrap()
            .query_map([], |r| r.get::<_, String>(0)).unwrap()
            .filter_map(|r| r.ok()).collect();
        assert!(
            !bodies.iter().any(|b| b.contains("Private body")),
            "withheld body in notes_content: {bodies:?}"
        );
        // Not vacuous: the notes that were meant to ship are still there.
        assert_eq!(paths.len(), 2, "shared and other must still export: {paths:?}");
    }

    /// `listed` is documented as title, tags and a summary. Removing the cap
    /// shipped the whole body under that tier and no test noticed, so the tier
    /// distinction existed only in the docs.
    #[test]
    fn a_listed_note_ships_a_summary_not_its_body() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.db");
        let out = tmp.path().join("export.db");
        let vault = tmp.path().join("vault");
        let long = "x".repeat(2000);
        build_source_db(&source, Some("01926d7e-0000-7000-8000-00000000000b"));
        {
            let c = Connection::open(&source).unwrap();
            c.execute("UPDATE notes_content SET body = ?1 WHERE id = 1", [&long]).unwrap();
        }
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(vault.join("n.md"), format!("---\ntitle: N\n---\n\n{long}")).unwrap();

        let config = FederationConfig::test_fixture("listed", vec![]);
        export_index(&source, &vault, &out, &config).unwrap();

        let c = Connection::open(&out).unwrap();
        let body: String = c
            .query_row("SELECT body FROM notes_content WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert!(
            body.len() < long.len(),
            "a listed note shipped its whole body: {} chars", body.len()
        );
        assert!(body.len() <= 320, "summary should be capped near 300: {} chars", body.len());
    }

    /// A wikilink names its target by filename, and in this vault filenames are
    /// whole sentences, so a link row IS the target's title. Copying one whose
    /// target was withheld publishes a private note's title through a table the
    /// visibility decision never looked at.
    #[test]
    fn a_link_whose_target_is_withheld_is_not_exported() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.db");
        let out = tmp.path().join("export.db");
        let vault = tmp.path().join("vault");
        build_linked_source_db(&source, &vault);

        // Everything listed except `secret.md`, which the last rule withholds.
        let config = FederationConfig::test_fixture(
            "listed",
            vec![("**/secret*".to_string(), "private".to_string())],
        );
        let result = export_index(&source, &vault, &out, &config).unwrap();
        assert_eq!(result.exported, 2, "shared and other ship");
        assert_eq!(result.skipped, 1, "secret is withheld");

        let c = Connection::open(&out).unwrap();
        let targets: Vec<String> = c
            .prepare("SELECT target_path FROM links")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(
            !targets.iter().any(|t| t == "secret"),
            "the withheld note's title left the machine in the links table: {targets:?}"
        );
        // Not vacuous: the link between two published notes must survive, or a
        // filter that dropped every row would pass this test.
        assert!(
            targets.iter().any(|t| t == "other"),
            "a link between two exported notes must still be carried: {targets:?}"
        );
    }

    #[test]
    fn a_note_without_a_uuid_is_not_exported() {
        // An index predating note ids exports nothing rather than rows the hub
        // cannot address. Reindexing populates them.
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.db");
        let out = tmp.path().join("export.db");
        let vault = tmp.path().join("vault");
        build_source_db(&source, None);
        public_vault_with_note(&vault);

        let config = FederationConfig::test_fixture("private", vec![]);
        let result = export_index(&source, &vault, &out, &config).unwrap();

        assert_eq!(result.exported, 0);
        // The row is not `skipped` either: skipping is a visibility decision
        // and this one was never offered to it. Counting it as zero-of-both
        // would report an export that considered the whole vault.
        assert_eq!(result.skipped, 0, "a missing id is not a visibility decision");
        assert_eq!(result.unindexed, 1, "the row the SELECT never returned must still be counted");
        let c = Connection::open(&out).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    /// The count is of rows the export could not address, not of rows it chose
    /// not to send — so an index where every note has an id reports zero even
    /// when notes are held back for being `private`.
    #[test]
    fn an_indexed_note_held_back_by_visibility_is_skipped_and_not_unindexed() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.db");
        let out = tmp.path().join("export.db");
        let vault = tmp.path().join("vault");
        build_source_db(&source, Some("01926d7e-0000-7000-8000-00000000000a"));
        public_vault_with_note(&vault);

        // Default `private` with no rule that lifts it: the note is addressable
        // and withheld, which is the other column.
        let config = FederationConfig::test_fixture("private", vec![]);
        let result = export_index(&source, &vault, &out, &config).unwrap();

        assert_eq!(result.unindexed, 0, "every row had an id; nothing was unaddressable");
        assert_eq!(
            result.exported + result.skipped,
            1,
            "an addressable note is either exported or skipped, and counted exactly once"
        );
    }

    fn build_minimal_export_db(path: &Path) {
        let c = Connection::open(path).unwrap();
        c.execute_batch(
            "CREATE TABLE notes (
                 id INTEGER PRIMARY KEY,
                 path TEXT NOT NULL,
                 title TEXT NOT NULL,
                 tags TEXT,
                 tier TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE notes_content (
                 id INTEGER PRIMARY KEY,
                 title TEXT,
                 tags TEXT,
                 body TEXT
             );
             CREATE TABLE embeddings (
                 id INTEGER PRIMARY KEY,
                 data BLOB NOT NULL
             );
             CREATE TABLE links (
                 source_id INTEGER NOT NULL,
                 target_path TEXT NOT NULL,
                 UNIQUE(source_id, target_path)
             );
             INSERT INTO notes (id, path, title, tags, tier, updated_at)
               VALUES (1, 'a.md', 'A', '', 'public', 0),
                      (2, 'b.md', 'B', '', 'public', 0);
             INSERT INTO notes_content (id, title, tags, body)
               VALUES (1, 'A', '', 'body a'),
                      (2, 'B', '', 'body b');",
        )
        .unwrap();
    }

    #[test]
    fn compute_patchset_returns_nonempty_for_insert_and_update() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base.db");
        let cur = dir.path().join("cur.db");

        build_minimal_export_db(&base);
        std::fs::copy(&base, &cur).unwrap();

        {
            let c = Connection::open(&cur).unwrap();
            c.execute(
                "INSERT INTO notes (id, path, title, tags, tier, updated_at) \
                 VALUES (3, 'c.md', 'C', '', 'public', 0)",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO notes_content (id, title, tags, body) VALUES (3, 'C', '', 'body c')",
                [],
            )
            .unwrap();
            c.execute("UPDATE notes_content SET body = 'body a v2' WHERE id = 1", [])
                .unwrap();
        }

        let patch = compute_patchset(&base, &cur).unwrap();
        assert!(
            !patch.is_empty(),
            "expected non-empty patchset for 2 inserts + 1 update"
        );
        assert!(
            patch.len() < 4096,
            "small change shouldn't produce >4KB patchset, got {}",
            patch.len()
        );
    }

    #[test]
    fn compute_patchset_empty_when_dbs_identical() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base.db");
        let cur = dir.path().join("cur.db");

        build_minimal_export_db(&base);
        std::fs::copy(&base, &cur).unwrap();

        let patch = compute_patchset(&base, &cur).unwrap();
        assert!(
            patch.is_empty(),
            "identical DBs should produce empty patchset, got {} bytes",
            patch.len()
        );
    }
}
