use std::collections::HashSet;

use sha2::{Digest, Sha256};

const MAX_TEXT_LENGTH: usize = 1500;

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

    let mut text = format!("Title: {}\n\n{}", title, cleaned);
    if !tags.is_empty() {
        let tag_str = tags
            .split_whitespace()
            .map(|t| format!("#{}", t))
            .collect::<Vec<_>>()
            .join(" ");
        text.push_str(&format!("\n\nTags: {}", tag_str));
    }
    if text.len() > MAX_TEXT_LENGTH {
        let mut end = MAX_TEXT_LENGTH;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }

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
    if text.len() > MAX_TEXT_LENGTH {
        let mut end = MAX_TEXT_LENGTH;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }

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

pub fn parse_intentions(frontmatter: &str) -> Vec<Intention> {
    let mut lines = frontmatter.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("intentions:") {
            continue;
        }
        let after = trimmed.strip_prefix("intentions:").unwrap().trim();
        if after.starts_with('[') {
            return parse_intentions_inline(after);
        }
        if !after.is_empty() {
            return Vec::new();
        }
        let mut block_lines: Vec<&str> = Vec::new();
        while let Some(next) = lines.peek() {
            let next_trimmed = next.trim_end();
            if next_trimmed.is_empty() {
                lines.next();
                continue;
            }
            let leading = next.len() - next.trim_start().len();
            if leading == 0 {
                break;
            }
            block_lines.push(next);
            lines.next();
        }
        return parse_intentions_block(&block_lines);
    }
    Vec::new()
}

fn parse_intentions_inline(s: &str) -> Vec<Intention> {
    let trimmed = s.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return Vec::new();
    }
    let inner = &trimmed[1..trimmed.len() - 1];
    let mut out = Vec::new();
    let mut depth: i32 = 0;
    let mut in_str: Option<char> = None;
    let mut start = 0usize;
    let bytes = inner.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        let c = b as char;
        if let Some(q) = in_str {
            if c == q {
                in_str = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => in_str = Some(c),
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            ',' if depth == 0 => {
                let item = inner[start..i].trim();
                if !item.is_empty() {
                    if let Some(intent) = parse_inline_object(item) {
                        out.push(intent);
                    }
                }
                start = i + 1;
            }
            _ => {}
        }
    }
    let last = inner[start..].trim();
    if !last.is_empty() {
        if let Some(intent) = parse_inline_object(last) {
            out.push(intent);
        }
    }
    out
}

fn parse_inline_object(s: &str) -> Option<Intention> {
    let trimmed = s.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        let inner = &trimmed[1..trimmed.len() - 1];
        let mut context: Option<String> = None;
        let mut cue: Option<String> = None;
        for field in split_inline_fields(inner) {
            let (key, value) = match field.find(':') {
                Some(idx) => (field[..idx].trim(), field[idx + 1..].trim()),
                None => continue,
            };
            let value = unquote(value);
            match key {
                "context" => context = Some(value),
                "cue" => cue = Some(value),
                _ => {}
            }
        }
        let context = context?;
        return Some(Intention {
            context,
            cue: cue.filter(|c| !c.is_empty()),
        });
    }
    let value = unquote(trimmed);
    if value.is_empty() {
        return None;
    }
    Some(legacy_flat(&value))
}

fn split_inline_fields(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth: i32 = 0;
    let mut in_str: Option<char> = None;
    let mut start = 0usize;
    let bytes = s.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        let c = b as char;
        if let Some(q) = in_str {
            if c == q {
                in_str = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => in_str = Some(c),
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            ',' if depth == 0 => {
                out.push(s[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    let tail = s[start..].trim();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

fn parse_intentions_block(lines: &[&str]) -> Vec<Intention> {
    let mut out: Vec<Intention> = Vec::new();
    let mut current: Option<Intention> = None;
    let mut item_indent: Option<usize> = None;

    for raw_line in lines {
        let line = raw_line.trim_end();
        if line.is_empty() {
            continue;
        }
        let leading = line.len() - line.trim_start().len();
        let stripped = line.trim_start();

        if stripped.starts_with("- ") || stripped == "-" {
            if let Some(intent) = current.take() {
                out.push(intent);
            }
            item_indent = Some(leading);
            let after_dash = stripped[1..].trim_start();
            if after_dash.is_empty() {
                current = Some(Intention::default());
                continue;
            }
            if after_dash.starts_with('{') {
                if let Some(intent) = parse_inline_object(after_dash) {
                    out.push(intent);
                }
                current = None;
                continue;
            }
            if let Some(idx) = after_dash.find(':') {
                let key = after_dash[..idx].trim();
                let value = unquote(after_dash[idx + 1..].trim());
                let mut intent = Intention::default();
                match key {
                    "context" => intent.context = value,
                    "cue" => intent.cue = Some(value).filter(|c| !c.is_empty()),
                    _ => {}
                }
                current = Some(intent);
            } else {
                let value = unquote(after_dash);
                if !value.is_empty() {
                    out.push(legacy_flat(&value));
                }
                current = None;
            }
            continue;
        }

        if let Some(item_lead) = item_indent {
            if leading > item_lead {
                if let Some(intent) = current.as_mut() {
                    if let Some(idx) = stripped.find(':') {
                        let key = stripped[..idx].trim();
                        let value = unquote(stripped[idx + 1..].trim());
                        match key {
                            "context" => intent.context = value,
                            "cue" => intent.cue = Some(value).filter(|c| !c.is_empty()),
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    if let Some(intent) = current.take() {
        out.push(intent);
    }

    out.into_iter().filter(|i| !i.context.is_empty()).collect()
}

fn legacy_flat(value: &str) -> Intention {
    if let Some(idx) = value.find('\u{2014}') {
        let context = value[..idx].trim().to_string();
        let cue = value[idx + '\u{2014}'.len_utf8()..].trim().to_string();
        return Intention {
            context,
            cue: if cue.is_empty() { None } else { Some(cue) },
        };
    }
    Intention {
        context: value.to_string(),
        cue: None,
    }
}

fn unquote(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.chars().next().unwrap();
        let last = trimmed.chars().last().unwrap();
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
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
        assert!(result.text.starts_with("Title: test note\n\n"));
        assert!(result.text.contains("Tags: #search #ml"));
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
    fn test_truncation() {
        let long_body = "x".repeat(2000);
        let raw = format!("---\ntags: [a]\n---\n\n{}", long_body);
        let result = preprocess_note(&raw, "long.md").unwrap();
        assert!(result.text.len() <= MAX_TEXT_LENGTH);
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

    #[test]
    fn test_parse_intentions_block_form() {
        let fm = "tags: []\nintentions:\n  - context: vault hygiene\n    cue: review weekly\n  - context: focus time\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 2);
        assert_eq!(intents[0].context, "vault hygiene");
        assert_eq!(intents[0].cue.as_deref(), Some("review weekly"));
        assert_eq!(intents[1].context, "focus time");
        assert!(intents[1].cue.is_none());
    }

    #[test]
    fn test_parse_intentions_inline_form() {
        let fm = "tags: []\nintentions: [{context: \"foo\", cue: \"bar\"}, {context: \"baz\"}]\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 2);
        assert_eq!(intents[0].context, "foo");
        assert_eq!(intents[0].cue.as_deref(), Some("bar"));
        assert_eq!(intents[1].context, "baz");
        assert!(intents[1].cue.is_none());
    }

    #[test]
    fn test_parse_intentions_legacy_flat() {
        let fm = "intentions:\n  - \"vault hygiene \u{2014} review weekly\"\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].context, "vault hygiene");
        assert_eq!(intents[0].cue.as_deref(), Some("review weekly"));
    }

    #[test]
    fn test_parse_intentions_absent() {
        let fm = "tags: [search]\ndate: 2026-01-01\n";
        let intents = parse_intentions(fm);
        assert!(intents.is_empty());
    }
}
