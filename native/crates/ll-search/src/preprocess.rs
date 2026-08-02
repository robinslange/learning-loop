use std::collections::HashSet;

use sha2::{Digest, Sha256};

mod intentions;

pub use intentions::parse_intentions;

/// Guard bound on embedding input, in bytes.
///
/// The tokenizer is the real limit: bge-small truncates at 512 tokens and is
/// configured to do so (`model::bge_small::MAX_TOKENS`). This constant exists
/// only so a pathological file cannot hand the tokenizer megabytes, and is set
/// far above the bytes any 512-token span occupies, so it does not bind on
/// real notes.
///
/// It used to be 1500, which bound long before the model's window and cut 69%
/// of a 6,006-note vault — worst exactly where it hurts most: 93% of
/// 2-literature and 98% of 5-maps, the most source-dense and link-dense notes.
/// When two limits sit in series, the one that binds has to be the one you
/// meant.
const MAX_EMBED_BYTES: usize = 16_384;

/// Truncate in place to at most `max_bytes`, landing on a char boundary.
fn truncate_on_char_boundary(text: &mut String, max_bytes: usize) {
    if text.len() <= max_bytes {
        return;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
}

#[derive(Debug, Clone, Default)]
pub struct Intention {
    pub context: String,
    pub cue: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PreprocessedNote {
    pub title: String,
    pub tags: String,
    pub body: String,
    pub text: String,
    pub links: Vec<String>,
    pub intentions: Vec<Intention>,
}

pub fn preprocess_note(raw: &str, filename: &str) -> Option<PreprocessedNote> {
    let title = title_from_filename(filename);

    let mut tags = String::new();
    let mut intentions = Vec::new();
    if let Some(fm_cap) = find_frontmatter(raw) {
        if let Some(tag_content) = extract_tags(fm_cap) {
            tags = tag_content;
        }
        intentions = parse_intentions(fm_cap);
    }

    let body = strip_frontmatter(raw);
    if body.is_empty() {
        return None;
    }

    let links = extract_wikilinks(&body);
    let cleaned = clean_wikilinks(&body);

    // Tags lead, ahead of the body. They were appended last, which made them
    // the first thing truncation ate: the highest-signal terms on a note were
    // dropped from its vector exactly on the notes long enough to need them.
    let mut text = format!("Title: {}\n", title);
    if !tags.is_empty() {
        let tag_str = tags
            .split_whitespace()
            .map(|t| format!("#{}", t))
            .collect::<Vec<_>>()
            .join(" ");
        text.push_str(&format!("Tags: {}\n", tag_str));
    }
    text.push('\n');
    text.push_str(&cleaned);
    truncate_on_char_boundary(&mut text, MAX_EMBED_BYTES);

    Some(PreprocessedNote {
        title,
        tags,
        body: cleaned,
        text,
        links,
        intentions,
    })
}

pub fn preprocess_excalidraw(raw: &str, filename: &str) -> Option<PreprocessedNote> {
    let title = filename
        .strip_suffix(".excalidraw.md")
        .unwrap_or(filename)
        .replace('-', " ");

    let json_block = extract_json_block(raw)?;
    let data: serde_json::Value = serde_json::from_str(json_block).ok()?;

    let texts: Vec<&str> = data
        .get("elements")
        .and_then(|e| e.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|el| {
                    el.get("type").and_then(|t| t.as_str()) == Some("text")
                        && el.get("text").and_then(|t| t.as_str()).is_some()
                        && el.get("isDeleted").and_then(|d| d.as_bool()) != Some(true)
                })
                .filter_map(|el| el.get("text").and_then(|t| t.as_str()))
                .collect()
        })
        .unwrap_or_default();

    if texts.is_empty() {
        return None;
    }

    let body = texts.join("\n");
    let mut text = format!("Title: {}\n\n{}", title, body);
    truncate_on_char_boundary(&mut text, MAX_EMBED_BYTES);

    Some(PreprocessedNote {
        title,
        tags: "excalidraw".to_string(),
        body,
        text,
        links: Vec::new(),
        intentions: Vec::new(),
    })
}

pub fn preprocess_file(raw: &str, filename: &str) -> Option<PreprocessedNote> {
    if filename.ends_with(".excalidraw.md") {
        preprocess_excalidraw(raw, filename)
    } else {
        preprocess_note(raw, filename)
    }
}

pub fn content_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    hex::encode(&digest[..16])
}

/// Change-detection hash over everything an indexed row depends on.
///
/// Must NOT be taken over the embedding text: that is truncated, so an edit
/// past the cut produced an identical hash and the note was skipped entirely,
/// leaving BOTH the vector and the full-text body stale with no error. On a
/// vault where most notes exceed the old cap, that made late edits invisible
/// to search.
pub fn content_hash_parts(title: &str, tags: &str, body: &str) -> String {
    let mut hasher = Sha256::new();
    // Length-prefixed so ("ab", "c") and ("a", "bc") cannot collide.
    for part in [title, tags, body] {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    hex::encode(&hasher.finalize()[..16])
}

fn title_from_filename(filename: &str) -> String {
    filename
        .strip_suffix(".md")
        .unwrap_or(filename)
        .replace('-', " ")
}

fn find_frontmatter(raw: &str) -> Option<&str> {
    if !raw.starts_with("---\n") {
        return None;
    }
    let rest = &raw[4..];
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

fn extract_tags(frontmatter: &str) -> Option<String> {
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("tags:") {
            let after = trimmed.strip_prefix("tags:")?;
            let after = after.trim();
            if after.starts_with('[') && after.ends_with(']') {
                let inner = &after[1..after.len() - 1];
                let cleaned: String = inner
                    .split(',')
                    .map(|s| s.trim())
                    .collect::<Vec<_>>()
                    .join(" ");
                let cleaned = cleaned.trim().to_string();
                if cleaned.is_empty() {
                    return None;
                }
                return Some(cleaned);
            }
        }
    }
    None
}

fn strip_frontmatter(raw: &str) -> String {
    if !raw.starts_with("---\n") {
        return raw.trim().to_string();
    }
    let rest = &raw[4..];
    if let Some(end) = rest.find("\n---") {
        let after = &rest[end + 4..];
        let after = after.strip_prefix('\n').unwrap_or(after);
        after.trim().to_string()
    } else {
        raw.trim().to_string()
    }
}

pub fn extract_wikilinks(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut links = Vec::new();
    let mut remaining = text;

    while let Some(pos) = remaining.find("[[") {
        let after_open = &remaining[pos + 2..];
        if let Some(end) = after_open.find("]]") {
            let inner = &after_open[..end];
            let target = inner.split('|').next().unwrap_or("");
            let target = target.split('#').next().unwrap_or("");
            let target = target.trim().to_lowercase();
            if !target.is_empty() && seen.insert(target.clone()) {
                links.push(target);
            }
            remaining = &after_open[end + 2..];
        } else {
            break;
        }
    }

    links
}

fn clean_wikilinks(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut remaining = text;

    while let Some(pos) = remaining.find("[[") {
        result.push_str(&remaining[..pos]);
        let after_open = &remaining[pos + 2..];
        if let Some(end) = after_open.find("]]") {
            let inner = &after_open[..end];
            if let Some(pipe) = inner.find('|') {
                result.push_str(&inner[pipe + 1..]);
            } else {
                result.push_str(inner);
            }
            remaining = &after_open[end + 2..];
        } else {
            result.push_str("[[");
            remaining = after_open;
        }
    }
    result.push_str(remaining);
    result
}

fn extract_json_block(raw: &str) -> Option<&str> {
    let start_marker = "```json\n";
    let start = raw.find(start_marker)?;
    let json_start = start + start_marker.len();
    let rest = &raw[json_start..];
    let end = rest.find("\n```")?;
    Some(&rest[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_frontmatter_extraction() {
        let raw = "---\ntags: [search, ml]\ndate: 2026-01-01\n---\n\nBody text here.";
        let result = preprocess_note(raw, "test-note.md").unwrap();
        assert_eq!(result.body, "Body text here.");
        assert_eq!(result.tags, "search ml");
        assert_eq!(result.title, "test note");
        // Tags sit between the title and the body so truncation cannot reach
        // them before the body it is meant to be trimming.
        assert_eq!(
            result.text,
            "Title: test note\nTags: #search #ml\n\nBody text here."
        );
    }

    #[test]
    fn test_wikilink_cleaning() {
        let raw = "---\ntags: []\n---\n\nSee [[some-note]] and [[other|display text]] for details.";
        let result = preprocess_note(raw, "links.md").unwrap();
        assert_eq!(
            result.body,
            "See some-note and display text for details."
        );
    }

    #[test]
    fn test_empty_body_returns_none() {
        let raw = "---\ntags: [test]\n---\n\n";
        let result = preprocess_note(raw, "empty.md");
        assert!(result.is_none());
    }

    #[test]
    fn test_note_title_from_filename() {
        assert_eq!(title_from_filename("test-note.md"), "test note");
        assert_eq!(title_from_filename("simple.md"), "simple");
        assert_eq!(
            title_from_filename("multi-word-title.md"),
            "multi word title"
        );
    }

    #[test]
    fn test_no_frontmatter() {
        let raw = "Just a body with no frontmatter.";
        let result = preprocess_note(raw, "simple.md").unwrap();
        assert_eq!(result.body, "Just a body with no frontmatter.");
        assert_eq!(result.tags, "");
    }

    #[test]
    fn test_excalidraw() {
        let raw = r#"---
excalidraw-plugin: parsed
---

## Drawing
```json
{
  "type": "excalidraw",
  "elements": [
    {"type": "text", "text": "Box A", "isDeleted": false},
    {"type": "rectangle", "isDeleted": false},
    {"type": "text", "text": "Box B", "isDeleted": false},
    {"type": "text", "text": "Deleted", "isDeleted": true}
  ]
}
```"#;
        let result = preprocess_excalidraw(raw, "diagram.excalidraw.md").unwrap();
        assert_eq!(result.body, "Box A\nBox B");
        assert_eq!(result.title, "diagram");
    }

    #[test]
    fn test_content_hash_stability() {
        let h1 = content_hash("hello world");
        let h2 = content_hash("hello world");
        let h3 = content_hash("hello world!");
        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
    }

    #[test]
    fn test_truncation_guard_binds_only_far_past_the_token_window() {
        let long_body = "x".repeat(MAX_EMBED_BYTES * 2);
        let raw = format!("---\ntags: [a]\n---\n\n{}", long_body);
        let result = preprocess_note(&raw, "long.md").unwrap();
        assert!(result.text.len() <= MAX_EMBED_BYTES);
        // The guard must sit well above any 512-token span, or it — not the
        // tokenizer — becomes the limit that decides what the model sees.
        assert!(MAX_EMBED_BYTES >= 512 * 8);
    }

    #[test]
    fn test_tags_survive_truncation_on_a_long_note() {
        let long_body = "consensus ".repeat(1000); // ~10KB, far past the old cap
        let raw = format!("---\ntags: [distributed, raft]\n---\n\n{}", long_body);
        let result = preprocess_note(&raw, "long.md").unwrap();
        // Tags were appended after the body, so on exactly the notes long
        // enough to need them they were the first thing cut.
        assert!(result.text.contains("#distributed"), "tags must reach the encoder");
        assert!(result.text.contains("#raft"));
    }

    #[test]
    fn test_hash_changes_when_only_the_tail_changes() {
        // The regression that made late edits invisible: the hash was taken
        // over the truncated embedding text, so appending past the cut left it
        // identical and the indexer skipped the note, staling the vector AND
        // the full-text body.
        let head = "y".repeat(4000);
        let a = content_hash_parts("t", "tag", &head);
        let b = content_hash_parts("t", "tag", &format!("{head}\nZANZIBAR"));
        assert_ne!(a, b, "an edit past the embedding cut must change the hash");
    }

    #[test]
    fn test_hash_parts_are_unambiguous() {
        assert_ne!(
            content_hash_parts("ab", "c", "d"),
            content_hash_parts("a", "bc", "d"),
            "field boundaries must be encoded, not just concatenated"
        );
    }

    #[test]
    fn test_preprocess_file_routing() {
        let md_raw = "Some content.";
        let result = preprocess_file(md_raw, "note.md").unwrap();
        assert_eq!(result.title, "note");

        let excalidraw_raw = r#"```json
{"type":"excalidraw","elements":[{"type":"text","text":"Hi","isDeleted":false}]}
```"#;
        let result = preprocess_file(excalidraw_raw, "draw.excalidraw.md").unwrap();
        assert_eq!(result.title, "draw");
        assert_eq!(result.tags, "excalidraw");
    }

    #[test]
    fn test_extract_wikilinks_basic() {
        let links = extract_wikilinks("See [[note-a]] and [[note-b]] for details.");
        assert_eq!(links, vec!["note-a", "note-b"]);
    }

    #[test]
    fn test_extract_wikilinks_aliased() {
        let links = extract_wikilinks("Read [[target-note|display text]] here.");
        assert_eq!(links, vec!["target-note"]);
    }

    #[test]
    fn test_extract_wikilinks_anchored() {
        let links = extract_wikilinks("See [[target#heading]] for details.");
        assert_eq!(links, vec!["target"]);
    }

    #[test]
    fn test_extract_wikilinks_combined() {
        let links = extract_wikilinks("See [[target#section|alias]].");
        assert_eq!(links, vec!["target"]);
    }

    #[test]
    fn test_extract_wikilinks_dedup() {
        let links = extract_wikilinks("[[a]] and [[a]] again.");
        assert_eq!(links, vec!["a"]);
    }

    #[test]
    fn test_extract_wikilinks_unclosed() {
        let links = extract_wikilinks("broken [[link without close");
        assert!(links.is_empty());
    }

    #[test]
    fn test_preprocess_note_has_links() {
        let raw = "---\ntags: []\n---\n\nSee [[some-note]] and [[other|display]].\n";
        let result = preprocess_note(raw, "test.md").unwrap();
        assert_eq!(result.links, vec!["some-note", "other"]);
    }
}
