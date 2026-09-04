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
        let default_tier = match default_tier.trim() {
            "public" | "listed" | "private" => default_tier.trim().to_string(),
            _ => "private".to_string(),
        };
        VisibilityEngine {
            default_tier,
            rules: compiled,
        }
    }

    /// The frontmatter tier, if the note declared a valid one.
    ///
    /// A present-but-invalid value (`visibility: pubic`) yields `None` so the
    /// caller falls through to the glob rules *and their cap* — never to an
    /// uncapped tier. Keying the cap on "was the key present" instead would
    /// publish a note on a typo.
    fn explicit(frontmatter_visibility: Option<&str>) -> Option<&str> {
        frontmatter_visibility.filter(|t| matches!(*t, "public" | "listed" | "private"))
    }

    pub fn evaluate<'a>(&'a self, path: &str, frontmatter_visibility: Option<&'a str>) -> &'a str {
        // Frontmatter is the ONLY route to `public`. It is an explicit act by
        // the note's author, not a consequence of which folder it landed in.
        if let Some(tier) = Self::explicit(frontmatter_visibility) {
            return tier;
        }
        let tier = self.evaluate_globs(path);
        // Path-derived tiers are capped: a glob may restrict, never publish.
        if tier == "public" { "listed" } else { tier }
    }

    /// Rule application WITHOUT the `public` clamp.
    ///
    /// Used only by the one-shot backfill, which must reproduce pre-inversion
    /// behaviour to decide which notes to make explicitly public. Not for use
    /// on the export path.
    pub fn evaluate_uncapped<'a>(&'a self, path: &str, fm: Option<&'a str>) -> &'a str {
        if let Some(tier) = Self::explicit(fm) {
            return tier;
        }
        self.evaluate_globs(path)
    }

    fn evaluate_globs(&self, path: &str) -> &str {
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
    fn glob_rule_cannot_grant_public() {
        let rules = [("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules);
        assert_eq!(engine.evaluate("3-permanent/note.md", None), "listed");
    }

    #[test]
    fn frontmatter_can_still_grant_public() {
        let rules = [("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules);
        assert_eq!(engine.evaluate("3-permanent/note.md", Some("public")), "public");
    }

    #[test]
    fn glob_rule_can_still_restrict_to_private() {
        let rules = [
            ("3-permanent/**".to_string(), "public".to_string()),
            ("**/kinso-*".to_string(), "private".to_string()),
        ];
        let engine = VisibilityEngine::new("private", &rules);
        assert_eq!(engine.evaluate("3-permanent/kinso-thing.md", None), "private");
    }

    #[test]
    fn default_tier_cannot_grant_public_either() {
        let engine = VisibilityEngine::new("public", &[]);
        assert_eq!(engine.evaluate("any.md", None), "listed");
    }

    #[test]
    fn an_invalid_frontmatter_value_does_not_bypass_the_cap() {
        // A typo like `visibility: pubic` must not fall through to an
        // uncapped glob tier. The cap keys on whether a VALID frontmatter
        // tier was applied, never on whether the key was merely present.
        let rules = [("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules);
        assert_eq!(engine.evaluate("3-permanent/note.md", Some("pubic")), "listed");
        assert_eq!(engine.evaluate("3-permanent/note.md", Some("")), "listed");
    }

    #[test]
    fn default_tier() {
        let engine = VisibilityEngine::new("private", &[]);
        assert_eq!(engine.evaluate("any/path.md", None), "private");
    }

    #[test]
    fn empty_default_resolves_private() {
        let engine = VisibilityEngine::new("", &[]);
        assert_eq!(engine.evaluate("any/path.md", None), "private");
    }

    #[test]
    fn unknown_default_resolves_private() {
        let engine = VisibilityEngine::new("bogus-tier", &[]);
        assert_eq!(engine.evaluate("any/path.md", None), "private");
    }

    #[test]
    fn rule_matching() {
        let rules = vec![
            ("3-permanent/**".to_string(), "public".to_string()),
            ("1-fleeting/**".to_string(), "listed".to_string()),
        ];
        let engine = VisibilityEngine::new("private", &rules);
        // A `public` glob is capped to `listed`: only frontmatter publishes.
        assert_eq!(engine.evaluate("3-permanent/note.md", None), "listed");
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
        // The point of this test is that the LATER rule wins; unchanged.
        assert_eq!(engine.evaluate("3-permanent/secret-stuff.md", None), "private");
        // The earlier `public` rule now caps to `listed`.
        assert_eq!(engine.evaluate("3-permanent/normal.md", None), "listed");
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
