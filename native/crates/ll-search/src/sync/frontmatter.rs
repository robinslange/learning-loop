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
    let end = after_open.find("\n---")?;
    Some((bom, open, &after_open[..end], &after_open[end..]))
}

fn strip_bom(raw: &str) -> (&str, &str) {
    match raw.strip_prefix('\u{FEFF}') {
        Some(rest) => ("\u{FEFF}", rest),
        None => ("", raw),
    }
}

pub fn read_key(raw: &str, key: &str) -> Option<String> {
    let (_, _, fm, _) = split(raw)?;
    let prefix = format!("{key}:");
    for line in fm.lines() {
        if let Some(val) = line.trim().strip_prefix(&prefix) {
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
        return format!("{bom}---\n{key}: {value}\n---\n{body}");
    };

    let mut new_fm = String::with_capacity(fm.len() + key.len() + value.len() + 4);
    let mut replaced = false;
    for seg in fm.split_inclusive('\n') {
        if !replaced && seg.trim_start().starts_with(&prefix) {
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
        new_fm.push('\n');
        new_fm.push_str(&format!("{key}: {value}"));
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
        let expected = format!("{bom}---\n{entry}\n---\n{body}");
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn upsert_preserves_bom_and_is_idempotent() {
        let raw = "\u{FEFF}---\ntitle: X\n---\n\nBody.";
        let once = upsert_key(raw, "id", "019abc");
        assert!(once.starts_with('\u{FEFF}'));
        assert_eq!(upsert_key(&once, "id", "019abc"), once);
    }
}
