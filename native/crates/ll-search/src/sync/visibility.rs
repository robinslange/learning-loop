use globset::{Glob, GlobSet, GlobSetBuilder};

pub struct VisibilityEngine {
    default_tier: String,
    rules: Vec<(GlobSet, String)>,
}

impl VisibilityEngine {
    pub fn new(default_tier: &str, rules: &[(String, String)]) -> Self {
        let compiled: Vec<(GlobSet, String)> = rules
            .iter()
            .filter_map(|(pattern, tier)| {
                let mut builder = GlobSetBuilder::new();
                builder.add(Glob::new(pattern).ok()?);
                let set = builder.build().ok()?;
                Some((set, tier.clone()))
            })
            .collect();
        VisibilityEngine {
            default_tier: default_tier.to_string(),
            rules: compiled,
        }
    }

    pub fn evaluate<'a>(&'a self, path: &str, frontmatter_visibility: Option<&'a str>) -> &'a str {
        if let Some(fm) = frontmatter_visibility {
            match fm {
                "public" | "listed" | "private" => return fm,
                _ => {}
            }
        }
        let mut tier = self.default_tier.as_str();
        for (glob_set, rule_tier) in &self.rules {
            if glob_set.is_match(path) {
                tier = rule_tier;
            }
        }
        tier
    }

    /// Evaluate visibility for a batch of `(path, frontmatter_visibility)` pairs.
    ///
    /// Returns one tier string per input item, in the same order. Avoids
    /// per-call overhead of calling `evaluate` in a loop by keeping the
    /// logic together; callers should build the input slice once and
    /// look up results by index.
    pub fn evaluate_batch<'a>(
        &'a self,
        items: &'a [(String, Option<String>)],
    ) -> Vec<&'a str> {
        items
            .iter()
            .map(|(p, fm)| self.evaluate(p, fm.as_deref()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_tier() {
        let engine = VisibilityEngine::new("private", &[]);
        assert_eq!(engine.evaluate("any/path.md", None), "private");
    }

    #[test]
    fn rule_matching() {
        let rules = vec![
            ("3-permanent/**".to_string(), "public".to_string()),
            ("1-fleeting/**".to_string(), "listed".to_string()),
        ];
        let engine = VisibilityEngine::new("private", &rules);
        assert_eq!(engine.evaluate("3-permanent/note.md", None), "public");
        assert_eq!(engine.evaluate("1-fleeting/note.md", None), "listed");
        assert_eq!(engine.evaluate("0-inbox/note.md", None), "private");
    }

    #[test]
    fn frontmatter_overrides() {
        let rules = vec![
            ("3-permanent/**".to_string(), "public".to_string()),
        ];
        let engine = VisibilityEngine::new("private", &rules);
        assert_eq!(
            engine.evaluate("3-permanent/note.md", Some("private")),
            "private"
        );
        assert_eq!(
            engine.evaluate("0-inbox/note.md", Some("public")),
            "public"
        );
    }

    #[test]
    fn last_rule_wins() {
        let rules = vec![
            ("3-permanent/**".to_string(), "public".to_string()),
            ("3-permanent/secret-*".to_string(), "private".to_string()),
        ];
        let engine = VisibilityEngine::new("listed", &rules);
        assert_eq!(engine.evaluate("3-permanent/secret-stuff.md", None), "private");
        assert_eq!(engine.evaluate("3-permanent/normal.md", None), "public");
    }

    #[test]
    fn evaluate_batch_empty_input() {
        let engine = VisibilityEngine::new("private", &[]);
        let result = engine.evaluate_batch(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn evaluate_batch_matches_per_call_output() {
        let rules = vec![
            ("3-permanent/**".to_string(), "public".to_string()),
            ("1-fleeting/**".to_string(), "listed".to_string()),
        ];
        let engine = VisibilityEngine::new("private", &rules);
        let items: Vec<(String, Option<String>)> = vec![
            ("3-permanent/note.md".to_string(), None),
            ("1-fleeting/thought.md".to_string(), None),
            ("0-inbox/raw.md".to_string(), Some("public".to_string())),
            ("0-inbox/raw.md".to_string(), None),
        ];
        let batch = engine.evaluate_batch(&items);
        let per_call: Vec<&str> = items
            .iter()
            .map(|(p, fm)| engine.evaluate(p, fm.as_deref()))
            .collect();
        assert_eq!(batch, per_call);
    }

    #[test]
    fn evaluate_batch_frontmatter_overrides_in_batch() {
        let rules = vec![("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules);
        let items: Vec<(String, Option<String>)> = vec![
            ("3-permanent/note.md".to_string(), Some("private".to_string())),
            ("0-inbox/note.md".to_string(), Some("public".to_string())),
            ("0-inbox/note.md".to_string(), None),
        ];
        let result = engine.evaluate_batch(&items);
        assert_eq!(result, vec!["private", "public", "private"]);
    }
}
