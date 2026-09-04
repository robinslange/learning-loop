//! The single place that reads and writes note frontmatter.
//!
//! Tolerances match the strictest previous caller (`export.rs`): a leading BOM,
//! and either LF or CRLF line endings. `upsert_key` round-trips everything it
//! does not touch, byte for byte.

/// Split `raw` into (bom, frontmatter_body, remainder_including_closing_fence).
/// Returns `None` when there is no opening fence.
fn split(raw: &str) -> Option<(&str, &str, &str)> {
    let (bom, rest) = strip_bom(raw);
    let after_open = rest
        .strip_prefix("---\n")
        .or_else(|| rest.strip_prefix("---\r\n"))?;
    let end = after_open.find("\n---")?;
    Some((bom, &after_open[..end], &after_open[end..]))
}

fn strip_bom(raw: &str) -> (&str, &str) {
    match raw.strip_prefix('\u{FEFF}') {
        Some(rest) => ("\u{FEFF}", rest),
        None => ("", raw),
    }
}

pub fn read_key(raw: &str, key: &str) -> Option<String> {
    let (_, fm, _) = split(raw)?;
    let prefix = format!("{key}:");
    for line in fm.lines() {
        if let Some(val) = line.trim().strip_prefix(&prefix) {
            return Some(val.trim().to_string());
        }
    }
    None
}

pub fn upsert_key(raw: &str, key: &str, value: &str) -> String {
    let prefix = format!("{key}:");
    let Some((bom, fm, tail)) = split(raw) else {
        let (bom, body) = strip_bom(raw);
        return format!("{bom}---\n{key}: {value}\n---\n{body}");
    };

    let mut replaced = false;
    let mut lines: Vec<String> = Vec::new();
    for line in fm.lines() {
        if line.trim().starts_with(&prefix) {
            lines.push(format!("{key}: {value}"));
            replaced = true;
        } else {
            lines.push(line.to_string());
        }
    }
    if !replaced {
        lines.push(format!("{key}: {value}"));
    }
    format!("{bom}---\n{}{tail}", lines.join("\n"))
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
    fn upsert_preserves_bom_and_is_idempotent() {
        let raw = "\u{FEFF}---\ntitle: X\n---\n\nBody.";
        let once = upsert_key(raw, "id", "019abc");
        assert!(once.starts_with('\u{FEFF}'));
        assert_eq!(upsert_key(&once, "id", "019abc"), once);
    }
}
