//! Frontmatter intentions parsing.
//!
//! Three accepted forms in YAML frontmatter:
//!
//! ```yaml
//! # block form
//! intentions:
//!   - context: vault hygiene
//!     cue: review weekly
//!   - context: focus time
//!
//! # inline-list form
//! intentions: [{context: "foo", cue: "bar"}, {context: "baz"}]
//!
//! # legacy flat: "<context> — <cue>"
//! intentions:
//!   - "vault hygiene — review weekly"
//! ```

use super::Intention;

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

#[cfg(test)]
mod tests {
    use super::*;

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
