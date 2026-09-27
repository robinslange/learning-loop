//! The single place that reads and writes note frontmatter.
//!
//! Tolerances match the strictest previous caller (`export.rs`): a leading BOM,
//! and either LF or CRLF line endings. `upsert_key` round-trips everything it
//! does not touch, byte for byte.

/// Split `raw` into (bom, opening_fence, frontmatter_body, remainder).
/// Returns `None` when there is no opening fence.
///
/// The fence is returned rather than assumed so a CRLF file keeps its CRLF.
fn split(raw: &str) -> Option<(&str, &str, &str, &str)> {
    let (bom, rest) = strip_bom(raw);
    let (open, after_open) = if let Some(r) = rest.strip_prefix("---\r\n") {
        ("---\r\n", r)
    } else if let Some(r) = rest.strip_prefix("---\n") {
        ("---\n", r)
    } else {
        return None;
    };
    // The closing fence is a line that is exactly `---`, not any line starting
    // with it. `find("\n---")` was both too strict and too loose at once:
    // `---\n---\n` never matched (the search starts at index 0, past the
    // opening fence's own newline) so the scan ran into the body and read
    // prose as a declaration — federation's own SKILL.md carries a bare
    // column-zero `visibility: public` line, so a note quoting the docs is the
    // input. And a `----` rule inside a real block closed it early, dropping a
    // `private` note to whatever its glob said.
    let mut offset = 0usize;
    for line in after_open.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        let content = content.strip_suffix('\r').unwrap_or(content);
        if content == "---" {
            // The body stops before the newline that ends the last key line,
            // and the tail carries it -- the boundary `upsert_key` reassembles
            // against, and the reason an empty block yields an empty body
            // rather than a stray terminator.
            let body_end = after_open[..offset].strip_suffix('\n').map_or(0, |b| b.len());
            let body_end = after_open[..body_end].strip_suffix('\r').map_or(body_end, |b| b.len());
            return Some((bom, open, &after_open[..body_end], &after_open[body_end..]));
        }
        offset += line.len();
    }
    None
}

fn strip_bom(raw: &str) -> (&str, &str) {
    match raw.strip_prefix('\u{FEFF}') {
        Some(rest) => ("\u{FEFF}", rest),
        None => ("", raw),
    }
}

/// The terminator of `s`'s first line, so a block created above a CRLF body
/// is CRLF too. A body with no newline at all gets `\n`.
fn first_eol(s: &str) -> &'static str {
    match s.find('\n') {
        Some(i) if s[..i].ends_with('\r') => "\r\n",
        _ => "\n",
    }
}

/// Read a TOP-LEVEL frontmatter key.
///
/// The match is on the raw line, so a key must start at column zero. An earlier
/// version trimmed the line first, which erased nesting depth: `visibility:
/// public` indented under any parent key -- or inside a block scalar quoting
/// someone else's frontmatter -- read as though the note had declared it, and
/// `visibility` decides what leaves the machine. Only the value is trimmed.
pub fn read_key(raw: &str, key: &str) -> Option<String> {
    let (_, _, fm, _) = split(raw)?;
    let prefix = format!("{key}:");
    for line in fm.lines() {
        if let Some(val) = line.strip_prefix(&prefix) {
            return Some(val.trim().to_string());
        }
    }
    None
}

/// Insert or replace one frontmatter key, leaving every other byte alone.
///
/// Walks segments with `split_inclusive` so each line keeps its own terminator.
/// An earlier version rebuilt the block with `lines().join("\n")`, which
/// normalised CRLF away and silently swallowed a trailing blank line — it
/// rewrote 44 real vault notes that end their frontmatter with one.
pub fn upsert_key(raw: &str, key: &str, value: &str) -> String {
    let prefix = format!("{key}:");
    let Some((bom, open, fm, tail)) = split(raw) else {
        let (bom, body) = strip_bom(raw);
        let eol = first_eol(body);
        return format!("{bom}---{eol}{key}: {value}{eol}---{eol}{body}");
    };

    let mut new_fm = String::with_capacity(fm.len() + key.len() + value.len() + 4);
    let mut replaced = false;
    for seg in fm.split_inclusive('\n') {
        // No `trim_start`. `read_key` matches at column zero on purpose --
        // nesting depth is what tells a declaration from a quoted one -- and a
        // writer that replaced a NESTED occurrence disagreed with the reader
        // that dispatches on it. `verify_upsert` then failed its line-count
        // guard and `visibility-backfill` aborted mid-vault, on a note that was
        // not malformed.
        if !replaced && seg.starts_with(&prefix) {
            let terminator = if seg.ends_with("\r\n") {
                "\r\n"
            } else if seg.ends_with('\n') {
                "\n"
            } else {
                ""
            };
            new_fm.push_str(&format!("{key}: {value}{terminator}"));
            replaced = true;
        } else {
            new_fm.push_str(seg);
        }
    }
    if !replaced {
        // `split` ends the body before the last key line's terminator and the
        // tail carries it, so the inserted line takes that terminator from the
        // tail -- a bare `\n` re-terminated a CRLF block's last line to LF and
        // `verify_insertion` refused. An empty block's tail starts at the
        // closing fence, so there the line takes the opening fence's
        // terminator after itself instead of before.
        if fm.is_empty() {
            let eol = &open[3..];
            new_fm.push_str(&format!("{key}: {value}{eol}"));
        } else {
            let eol = if tail.starts_with("\r\n") { "\r\n" } else { "\n" };
            new_fm.push_str(&format!("{eol}{key}: {value}"));
        }
    }
    format!("{bom}{open}{new_fm}{tail}")
}

/// Verify that `after` is `before` with exactly one line inserted, and nothing
/// else moved, edited, or re-terminated.
///
/// This is the guard the writer should have had. Unit tests only pin the cases
/// their author thought of; this checks the *shape of the transformation* on
/// every real file, so a mutation nobody anticipated still fails closed.
///
/// It caught nothing when written — because the bug it exists for had already
/// been fixed — which is the point: it fires on the next one.
pub fn verify_insertion(
    before: &str,
    after: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let entry = format!("{key}: {value}");

    // A note with no frontmatter gains a whole block; the body must survive.
    if split(before).is_none() {
        let (bom, body) = strip_bom(before);
        let eol = first_eol(body);
        let expected = format!("{bom}---{eol}{entry}{eol}---{eol}{body}");
        return if after == expected {
            Ok(())
        } else {
            Err(format!("block creation altered the note beyond inserting {entry:?}"))
        };
    }

    let b: Vec<&str> = before.split_inclusive('\n').collect();
    let a: Vec<&str> = after.split_inclusive('\n').collect();

    if a.len() != b.len() + 1 {
        return Err(format!(
            "line count went {} -> {}, expected exactly one more; \
             a line was lost or merged",
            b.len(),
            a.len()
        ));
    }

    let mut i = 0;
    while i < b.len() && a[i] == b[i] {
        i += 1;
    }

    if a[i].trim_end_matches(['\r', '\n']) != entry {
        return Err(format!(
            "first difference at line {} is {:?}, expected the inserted {entry:?}",
            i + 1,
            a[i]
        ));
    }

    if b[i..] != a[i + 1..] {
        return Err(format!(
            "content after the insertion point differs; \
             {} line(s) were changed as well",
            b[i..]
                .iter()
                .zip(&a[i + 1..])
                .filter(|(x, y)| x != y)
                .count()
        ));
    }

    Ok(())
}

/// Verify a `upsert_key` write, whichever of its two modes applied.
///
/// `upsert_key` inserts when the key is absent and replaces when it is
/// present. A guard covering only one mode refuses correct writes in the
/// other — which is exactly what happened the first time this was wired into
/// the duplicate-id path.
pub fn verify_upsert(before: &str, after: &str, key: &str, value: &str) -> Result<(), String> {
    if read_key(before, key).is_some() {
        verify_replacement(before, after, key, value)
    } else {
        verify_insertion(before, after, key, value)
    }
}

/// Verify that `after` is `before` with exactly one line's value changed —
/// same line count, same terminators, one differing line, and that line is the
/// key we asked for.
pub fn verify_replacement(
    before: &str,
    after: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let entry = format!("{key}: {value}");
    let b: Vec<&str> = before.split_inclusive('\n').collect();
    let a: Vec<&str> = after.split_inclusive('\n').collect();

    if a.len() != b.len() {
        return Err(format!(
            "line count went {} -> {}, expected no change on a replacement",
            b.len(),
            a.len()
        ));
    }

    let differing: Vec<usize> = (0..b.len()).filter(|&i| a[i] != b[i]).collect();
    if differing.len() != 1 {
        return Err(format!(
            "{} line(s) differ, expected exactly one",
            differing.len()
        ));
    }

    let i = differing[0];
    if a[i].trim_end_matches(['\r', '\n']) != entry {
        return Err(format!(
            "the changed line is {:?}, expected {entry:?}",
            a[i]
        ));
    }

    let term_of = |seg: &str| {
        if seg.ends_with("\r\n") {
            "\r\n"
        } else if seg.ends_with('\n') {
            "\n"
        } else {
            ""
        }
    };
    if term_of(a[i]) != term_of(b[i]) {
        return Err(format!(
            "line terminator changed from {:?} to {:?}",
            term_of(b[i]),
            term_of(a[i])
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {

    /// `visibility` decides what leaves the machine, so a nested key that reads
    /// as top-level is a publish primitive. Indented under any parent, or
    /// quoted inside a block scalar, it must not be seen.
    #[test]
    fn an_indented_key_is_not_a_top_level_key() {
        let nested = "---\nmeta:\n  visibility: public\n---\n\nBody.";
        assert_eq!(read_key(nested, "visibility"), None, "indented key was read as top-level");

        let quoted = "---\nnote: |\n  visibility: public\n---\n\nBody.";
        assert_eq!(read_key(quoted, "visibility"), None, "block scalar content was read as a key");

        // Not vacuous: a real top-level key still reads, value trimmed.
        let top = "---\nvisibility: public\n---\n\nBody.";
        assert_eq!(read_key(top, "visibility"), Some("public".to_string()));
    }
    use super::*;

    /// The closing fence is a line that is exactly `---`.
    ///
    /// `find("\n---")` searched from index 0, so an EMPTY block never matched
    /// its own closing fence and the scan ran on into the body. federation's
    /// SKILL.md carries a bare column-zero `visibility: public` line, so a note
    /// quoting the docs is the input, and the note would have been published at
    /// `public` on the strength of prose.
    #[test]
    fn an_empty_block_closes_and_the_body_below_it_is_not_frontmatter() {
        let note = "---\n---\n\nthe stamp reads\nvisibility: public\nin the docs\n";
        assert_eq!(read_key(note, "visibility"), None, "body prose is not a declaration");
    }

    /// The converse. A horizontal rule inside a real block used to close it
    /// early, so every key below the rule vanished -- including a `private`
    /// that was the only thing holding the note back from its glob tier.
    #[test]
    fn a_longer_rule_does_not_close_the_block_early() {
        let note = "---\ntitle: N\n----\nvisibility: private\n---\n\nBody.\n";
        assert_eq!(
            read_key(note, "visibility").as_deref(),
            Some("private"),
            "a `----` line is not the fence, and the key below it still counts"
        );
    }

    /// The reader matches at column zero so that nesting depth tells a
    /// declaration from a quotation. The writer used `trim_start`, so it
    /// replaced a NESTED occurrence the reader would never have read --
    /// `verify_upsert` dispatches on `read_key`, so the disagreement failed
    /// its line-count guard and aborted `visibility-backfill` mid-vault on a
    /// note that was not malformed.
    #[test]
    fn the_writer_and_the_reader_agree_on_what_a_top_level_key_is() {
        let note = "---\ntitle: N\nquoted:\n  visibility: public\n---\n\nBody.\n";
        assert_eq!(read_key(note, "visibility"), None, "precondition: nested is not read");

        let after = upsert_key(note, "visibility", "private");

        assert_eq!(
            read_key(&after, "visibility").as_deref(),
            Some("private"),
            "the writer must add the top-level key the reader looks for"
        );
        assert!(
            after.contains("  visibility: public"),
            "and must leave the nested one alone; got:\n{after}"
        );
    }


    #[test]
    fn reads_key_with_bom_and_crlf() {
        let raw = "\u{FEFF}---\r\nvisibility:  listed  \r\n---\r\n\r\nBody.";
        assert_eq!(read_key(raw, "visibility").as_deref(), Some("listed"));
    }

    #[test]
    fn read_key_absent_returns_none() {
        assert_eq!(read_key("---\ntitle: X\n---\n\nBody.", "id"), None);
        assert_eq!(read_key("No frontmatter at all.", "id"), None);
    }

    #[test]
    fn upsert_adds_key_to_existing_block_preserving_others() {
        let raw = "---\ntitle: X\ntags: [a, b]\n---\n\nBody.";
        let out = upsert_key(raw, "id", "019abc");
        assert!(out.contains("title: X"));
        assert!(out.contains("tags: [a, b]"));
        assert_eq!(read_key(&out, "id").as_deref(), Some("019abc"));
        assert!(out.ends_with("\n\nBody."));
    }

    #[test]
    fn upsert_replaces_existing_key_without_duplicating() {
        let raw = "---\nid: old\ntitle: X\n---\n\nBody.";
        let out = upsert_key(raw, "id", "new");
        assert_eq!(read_key(&out, "id").as_deref(), Some("new"));
        assert_eq!(out.matches("id:").count(), 1);
    }

    #[test]
    fn upsert_creates_block_when_absent() {
        let out = upsert_key("Just a body.", "id", "019abc");
        assert!(out.starts_with("---\nid: 019abc\n---\n"));
        assert!(out.ends_with("Just a body."));
    }

    #[test]
    fn upsert_creates_a_crlf_block_above_a_crlf_body() {
        let raw = "\u{FEFF}# Title\r\n\r\nBody.\r\n";
        let out = upsert_key(raw, "id", "019abc");
        assert_eq!(out, "\u{FEFF}---\r\nid: 019abc\r\n---\r\n# Title\r\n\r\nBody.\r\n");
        assert!(verify_upsert(raw, &out, "id", "019abc").is_ok(), "guard refused: {out:?}");
        assert_eq!(read_key(&out, "id").as_deref(), Some("019abc"));
    }



    #[test]
    fn guard_accepts_a_clean_single_line_insertion() {
        let before = "---\ntitle: X\n---\n\nBody.";
        let after = upsert_key(before, "visibility", "public");
        assert!(verify_insertion(before, &after, "visibility", "public").is_ok());
    }

    #[test]
    fn guard_accepts_insertion_after_a_trailing_blank_line() {
        let before = "---\nfoo: bar\n\n---\n\nBody.";
        let after = upsert_key(before, "visibility", "public");
        assert!(verify_insertion(before, &after, "visibility", "public").is_ok());
    }

    #[test]
    fn guard_rejects_a_swallowed_blank_line() {
        // Exactly the regression that rewrote 44 vault notes: the key was
        // inserted, but a blank line vanished, so the line count did not grow.
        let before = "---\nfoo: bar\n\n---\n\nBody.";
        let buggy = "---\nfoo: bar\nvisibility: public\n---\n\nBody.";
        let err = verify_insertion(before, buggy, "visibility", "public").unwrap_err();
        assert!(err.contains("line count"), "got: {err}");
    }

    #[test]
    fn guard_rejects_crlf_normalisation() {
        let before = "---\r\na: 1\r\nb: 2\r\n---\r\n\r\nBody.";
        let normalised = "---\na: 1\nb: 2\nvisibility: public\n---\n\nBody.";
        assert!(verify_insertion(before, normalised, "visibility", "public").is_err());
    }

    #[test]
    fn guard_rejects_a_reordered_or_edited_neighbour() {
        let before = "---\na: 1\nb: 2\n---\n\nBody.";
        let tampered = "---\nb: 2\na: 1\nvisibility: public\n---\n\nBody.";
        assert!(verify_insertion(before, tampered, "visibility", "public").is_err());
    }

    #[test]
    fn guard_rejects_a_changed_body() {
        let before = "---\na: 1\n---\n\nBody.";
        let tampered = "---\na: 1\nvisibility: public\n---\n\nDifferent body.";
        assert!(verify_insertion(before, tampered, "visibility", "public").is_err());
    }

    #[test]
    fn guard_accepts_block_creation_on_a_note_with_no_frontmatter() {
        let before = "Just a body.";
        let after = upsert_key(before, "visibility", "public");
        assert!(verify_insertion(before, &after, "visibility", "public").is_ok());
    }

    #[test]
    fn guard_rejects_block_creation_that_mangles_the_body() {
        let before = "Just a body.";
        let tampered = "---\nvisibility: public\n---\nJust a BODY.";
        assert!(verify_insertion(before, tampered, "visibility", "public").is_err());
    }


    #[test]
    fn guard_accepts_a_clean_value_replacement() {
        let before = "---\nid: old\ntitle: X\n---\n\nBody.";
        let after = upsert_key(before, "id", "new");
        assert!(verify_upsert(before, &after, "id", "new").is_ok());
    }

    #[test]
    fn guard_rejects_a_replacement_that_changes_a_neighbour() {
        let before = "---\nid: old\ntitle: X\n---\n\nBody.";
        let tampered = "---\nid: new\ntitle: Y\n---\n\nBody.";
        assert!(verify_upsert(before, tampered, "id", "new").is_err());
    }

    #[test]
    fn guard_rejects_a_replacement_that_drops_a_line() {
        let before = "---\nid: old\ntitle: X\n---\n\nBody.";
        let tampered = "---\nid: new\n---\n\nBody.";
        assert!(verify_upsert(before, tampered, "id", "new").is_err());
    }

    #[test]
    fn guard_rejects_a_replacement_that_reterminates_the_line() {
        let before = "---\r\nid: old\r\ntitle: X\r\n---\r\n\r\nBody.";
        let tampered = "---\r\nid: new\ntitle: X\r\n---\r\n\r\nBody.";
        assert!(verify_upsert(before, tampered, "id", "new").is_err());
    }

    #[test]
    fn verify_upsert_dispatches_on_whether_the_key_was_present() {
        let absent = "---\ntitle: X\n---\n\nBody.";
        assert!(verify_upsert(absent, &upsert_key(absent, "id", "v"), "id", "v").is_ok());
        let present = "---\nid: old\n---\n\nBody.";
        assert!(verify_upsert(present, &upsert_key(present, "id", "v"), "id", "v").is_ok());
    }

    #[test]
    fn upsert_preserves_a_trailing_blank_line_in_the_block() {
        // 44 real vault notes end their frontmatter with a blank line.
        // Rebuilding via lines().join() silently swallowed it.
        let raw = "---\nfoo: bar\n\n---\n\nBody.";
        let out = upsert_key(raw, "visibility", "public");
        assert!(out.contains("foo: bar\n\nvisibility: public"), "got: {out:?}");
        assert_eq!(read_key(&out, "visibility").as_deref(), Some("public"));
    }

    #[test]
    fn upsert_preserves_every_untouched_byte() {
        let raw = "---\na: 1\n\nb: 2\n   \nc: 3\n---\n\nBody.";
        let out = upsert_key(raw, "z", "9");
        for fragment in ["a: 1", "\n\nb: 2", "   \nc: 3"] {
            assert!(out.contains(fragment), "lost {fragment:?} in {out:?}");
        }
    }

    #[test]
    fn upsert_replace_preserves_crlf_terminators() {
        let raw = "---\r\nid: old\r\ntitle: X\r\n---\r\n\r\nBody.";
        let out = upsert_key(raw, "id", "new");
        assert!(out.contains("id: new\r\n"), "terminator not preserved: {out:?}");
        assert!(out.contains("title: X\r\n"));
    }

    /// The Claude Code memory writer rewrites a name-less note as `name: ""`
    /// plus a `metadata:` block, nests the existing `id:` under it, and saves
    /// with CRLF. `read_key` rightly sees no top-level id, so the writer
    /// INSERTS one. `split` hands back a body that stops before the last key
    /// line's `\r\n`; inserting with a bare `\n` re-terminated that line to LF,
    /// `verify_insertion` refused, and the panic aborted the whole reindex.
    #[test]
    fn upsert_inserts_into_a_crlf_block_with_crlf_and_leaves_the_nested_id() {
        let nested = "  id: 01a0c459-71da-7000-8000-000000000001\r\n";
        let raw = format!(
            "---\r\nname: \"\"\r\ndescription: \"\"\r\nmetadata:\r\n  node_type: memory\r\n\
             {nested}  modified: 2026-09-24T00:00:00.000Z\r\n---\r\n\r\n# Project index\r\n"
        );
        assert_eq!(read_key(&raw, "id"), None, "precondition: nested is not read");

        let out = upsert_key(&raw, "id", "019abc");

        assert!(verify_upsert(&raw, &out, "id", "019abc").is_ok(), "guard refused: {out:?}");
        assert_eq!(read_key(&out, "id").as_deref(), Some("019abc"));
        assert!(out.contains(&format!("\r\n{nested}")), "nested id line changed: {out:?}");
        assert_eq!(out.lines().filter(|l| l.starts_with("id:")).count(), 1);
        assert!(
            out.split_inclusive('\n').all(|l| l.ends_with("\r\n") || !l.ends_with('\n')),
            "a line lost its CR: {out:?}"
        );
    }

    /// An empty block's body is empty and its tail starts at the closing
    /// fence, so the inserted line needs its own terminator, not a leading one.
    #[test]
    fn upsert_inserts_into_an_empty_block() {
        for raw in ["---\n---\n\nBody.\n", "---\r\n---\r\n\r\nBody.\r\n"] {
            let out = upsert_key(raw, "id", "019abc");
            assert!(verify_upsert(raw, &out, "id", "019abc").is_ok(), "guard refused: {out:?}");
            assert_eq!(read_key(&out, "id").as_deref(), Some("019abc"));
        }
    }

    #[test]
    fn upsert_preserves_bom_and_is_idempotent() {
        let raw = "\u{FEFF}---\ntitle: X\n---\n\nBody.";
        let once = upsert_key(raw, "id", "019abc");
        assert!(once.starts_with('\u{FEFF}'));
        assert_eq!(upsert_key(&once, "id", "019abc"), once);
    }
}
