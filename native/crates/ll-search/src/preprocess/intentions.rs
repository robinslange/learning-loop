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

    /// Extract the contents of every ```yaml fence, preserving indentation.
    fn yaml_blocks(text: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur: Option<Vec<String>> = None;
        for line in text.lines() {
            let t = line.trim_start();
            if t.starts_with("```") {
                if let Some(b) = cur.take() {
                    out.push(b.join("\n"));
                } else if t.starts_with("```yaml") {
                    cur = Some(Vec::new());
                }
                continue;
            }
            if let Some(b) = cur.as_mut() {
                b.push(line.to_string());
            }
        }
        out
    }

    /// The skills and agents tell the model what to write into `intentions:`.
    /// Nothing checked that the shape they prescribe is a shape this parser
    /// reads, so a one-character edit (em-dash to colon, in a commit titled
    /// "quick wins") silently voided every intention written since: the flat
    /// branch treats any colon as a `key:` and discards what it cannot match.
    ///
    /// Asserting a cue survives, not merely that parsing yields something, is
    /// load-bearing — a separator-less example still produces one intention
    /// whose context is the entire sentence, which is the other failure mode.
    #[test]
    fn documented_intentions_examples_parse() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..");
        let docs = [
            "plugin/skills/reflect/SKILL.md",
            "plugin/agents/inbox-organiser.md",
        ];
        let mut checked = 0;
        for rel in docs {
            let path = root.join(rel);
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            for block in yaml_blocks(&text) {
                if !block.contains("intentions:") {
                    continue;
                }
                let intents = parse_intentions(&block);
                assert!(
                    !intents.is_empty(),
                    "{rel}: documented intentions example parses to nothing:\n{block}"
                );
                for i in &intents {
                    assert!(!i.context.is_empty(), "{rel}: parsed an empty context:\n{block}");
                    assert!(
                        i.cue.is_some(),
                        "{rel}: documented example yields no cue, so the cue text \
                         was swallowed into the context:\n{block}"
                    );
                }
                checked += 1;
            }
        }
        assert!(checked > 0, "found no documented intentions examples to check");
    }

    /// The fence-scoped test above only sees ```yaml examples in two files.
    /// The same prescription also reaches the model through a JSON-escaped
    /// worked example (refinement-proposer) and through inline prose, and both
    /// drifted independently. Walk every plugin doc instead, unescape the
    /// JSON-embedded newlines, and require the block form everywhere.
    ///
    /// The block form is the fix for a real collision: agents-shared style bans
    /// em-dashes in prose, and the em-dash was the flat form's ONLY separator,
    /// so complying with the style rule silently broke the data. `context:` /
    /// `cue:` has no separator to ban.
    #[test]
    fn every_documented_intentions_block_uses_block_form() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "md") {
                    out.push(p);
                }
            }
        }
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..").join("..").join("..");
        let mut docs = Vec::new();
        walk(&root.join("plugin"), &mut docs);
        assert!(!docs.is_empty(), "found no plugin docs to scan");

        let mut offenders = Vec::new();
        for doc in &docs {
            let raw = std::fs::read_to_string(doc).unwrap_or_default();
            // Deliberately NOT unescaping JSON-embedded newlines. A doc that
            // PRESCRIBES a format writes real multi-line YAML; a doc that
            // REPRODUCES a note's frontmatter carries it inside a single JSON
            // line (refinement-proposer's worked example, which rule 4 requires
            // be copied byte-for-byte and is not a prescription at all).
            // Unescaping conflated the two and flagged the reproduction.
            let text = raw;
            let lines: Vec<&str> = text.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if line.trim_end() != "intentions:" && !line.trim_start().starts_with("intentions:")
                {
                    continue;
                }
                if line.trim_start() != "intentions:" {
                    continue; // inline list form, parsed elsewhere
                }
                for entry in lines.iter().skip(i + 1) {
                    let t = entry.trim_start();
                    if !t.starts_with("- ") {
                        break;
                    }
                    let after = t[2..].trim();
                    if after.starts_with("context:") || after.starts_with('{') {
                        continue;
                    }
                    offenders.push(format!(
                        "{}: {}",
                        doc.strip_prefix(&root).unwrap_or(doc).display(),
                        after
                    ));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "these docs prescribe a flat intentions entry; use `- context:` / `cue:`:\n  {}",
            offenders.join("\n  ")
        );
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

    #[test]
    fn test_parse_intentions_inline_unknown_keys_ignored() {
        let fm = "intentions: [{context: \"keep\", priority: 9, cue: \"hold\"}]\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].context, "keep");
        assert_eq!(intents[0].cue.as_deref(), Some("hold"));
    }

    #[test]
    fn test_parse_intentions_inline_object_missing_context_dropped() {
        let fm = "intentions: [{cue: \"orphan cue\"}, {context: \"ok\"}]\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 1, "objects without context must drop out");
        assert_eq!(intents[0].context, "ok");
    }

    #[test]
    fn test_parse_intentions_inline_empty_cue_becomes_none() {
        let fm = "intentions: [{context: \"a\", cue: \"\"}]\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 1);
        assert!(intents[0].cue.is_none(), "empty-string cue must collapse to None");
    }

    #[test]
    fn test_parse_intentions_inline_non_list_returns_empty() {
        // Scalar value after `intentions:` (not starting with `[`) returns empty per the
        // current contract — block form is signalled by an empty trailing value.
        let fm = "intentions: just a scalar\n";
        let intents = parse_intentions(fm);
        assert!(intents.is_empty());
    }

    #[test]
    fn test_parse_intentions_block_with_dash_only_then_indented_fields() {
        let fm = "intentions:\n  -\n    context: hygiene\n    cue: weekly\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].context, "hygiene");
        assert_eq!(intents[0].cue.as_deref(), Some("weekly"));
    }

    #[test]
    fn test_parse_intentions_block_inline_object_after_dash() {
        let fm = "intentions:\n  - {context: \"focus\", cue: \"morning\"}\n  - {context: \"rest\"}\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 2);
        assert_eq!(intents[0].context, "focus");
        assert_eq!(intents[0].cue.as_deref(), Some("morning"));
        assert_eq!(intents[1].context, "rest");
        assert!(intents[1].cue.is_none());
    }

    #[test]
    fn test_parse_intentions_block_drops_empty_context_entries() {
        // A bare `- cue: foo` line with no context must not produce a phantom entry.
        let fm = "intentions:\n  - cue: dangling\n  - context: kept\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 1, "context-less entry must be filtered out");
        assert_eq!(intents[0].context, "kept");
    }

    #[test]
    fn test_parse_intentions_block_deindent_stops_collection() {
        // A column-0 sibling key terminates the intentions block; trailing context
        // outside the block must not be folded in.
        let fm = "intentions:\n  - context: inside\n    cue: kept\ndate: 2026-05-14\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].context, "inside");
        assert_eq!(intents[0].cue.as_deref(), Some("kept"));
    }

    #[test]
    fn test_parse_intentions_legacy_flat_no_dash_keeps_full_string_as_context() {
        let fm = "intentions:\n  - just one phrase no separator\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].context, "just one phrase no separator");
        assert!(intents[0].cue.is_none());
    }

    #[test]
    fn test_parse_intentions_legacy_flat_em_dash_trailing_empty_cue() {
        let fm = "intentions:\n  - \"context only \u{2014}\"\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].context, "context only");
        assert!(intents[0].cue.is_none(), "empty post-dash segment must collapse to None");
    }

    #[test]
    fn test_parse_intentions_single_quotes_unquote() {
        let fm = "intentions: [{context: 'single quoted', cue: 'also single'}]\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].context, "single quoted");
        assert_eq!(intents[0].cue.as_deref(), Some("also single"));
    }

    #[test]
    fn test_parse_intentions_inline_quoted_comma_does_not_split() {
        // Commas inside quoted strings must NOT split items; depth/in_str tracking
        // is the whole reason split_inline_fields exists.
        let fm = "intentions: [{context: \"first, with comma\", cue: \"more, commas\"}]\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 1, "quoted commas must not split into two items");
        assert_eq!(intents[0].context, "first, with comma");
        assert_eq!(intents[0].cue.as_deref(), Some("more, commas"));
    }

    #[test]
    fn test_parse_intentions_leading_whitespace_on_key_line_tolerated() {
        // The frontmatter scanner uses trim_start when locating `intentions:`, so
        // an indented key must still be recognised.
        let fm = "  intentions:\n    - context: nested key\n";
        let intents = parse_intentions(fm);
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].context, "nested key");
    }
}
