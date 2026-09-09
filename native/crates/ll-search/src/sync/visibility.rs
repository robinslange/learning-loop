use globset::{Glob, GlobSet, GlobSetBuilder};

/// What a note's own frontmatter said about its visibility.
///
/// Three states, because the export path has three genuinely different
/// situations and the previous `Option<&str>` could only hold two. Both
/// "the value is not a tier I know" and "I could not read the file at all"
/// collapsed into `None`, which is the same value as "the author declared
/// nothing" — and `None` falls through to the glob rules. For a note whose
/// frontmatter says `private` while its folder says `listed`, that fall-through
/// is the difference between withholding it and publishing its path, title,
/// tags and a body summary.
///
/// So the type no longer has a way to say "something went wrong" that also
/// reads as "the author chose nothing". `Unknown` covers every cause —
/// unreadable file, unparseable value, a tier a newer build understands and
/// this one does not — and every cause withholds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Declared {
    /// No `visibility:` key. The glob rules decide, under their `public` cap.
    Absent,
    /// A declaration exists but this build cannot act on it. Withholds.
    Unknown,
    /// A recognised tier, taken at face value.
    Tier(String),
}

impl Declared {
    /// Read a raw frontmatter value into a decision.
    ///
    /// Normalises before matching, because the spellings people actually
    /// produce are not the bare word: Obsidian's property editor quotes
    /// values, and a trailing comment is ordinary YAML. Matching only the
    /// bare lowercase word made `visibility: "private"` an unrecognised
    /// value, and unrecognised used to mean "fall through to the globs".
    ///
    /// Anything still unrecognised after normalising is `Unknown`, not a
    /// guess. A tier is a small closed set; if this does not match it, the
    /// honest answer is that the note's intent is not known here.
    pub fn from_value(raw: &str) -> Self {
        let mut v = raw.trim();
        // A trailing `# comment`, but only when it is not inside quotes —
        // stripping first would eat the `#` of a quoted value containing one.
        if !v.starts_with('"') && !v.starts_with('\'') {
            if let Some((before, _)) = v.split_once('#') {
                v = before.trim();
            }
        }
        // Matched quotes only. A single leading quote is malformed, and
        // trimming it would invent a value the author did not write.
        for q in ['"', '\''] {
            if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
                v = &v[1..v.len() - 1];
                break;
            }
        }
        match v.trim().to_ascii_lowercase().as_str() {
            "public" => Declared::Tier("public".to_string()),
            "listed" => Declared::Tier("listed".to_string()),
            "private" => Declared::Tier("private".to_string()),
            _ => Declared::Unknown,
        }
    }

    /// The decision for a note whose frontmatter was read successfully:
    /// `None` from the reader means the key was absent.
    pub fn from_frontmatter(value: Option<String>) -> Self {
        match value {
            Some(v) => Declared::from_value(&v),
            None => Declared::Absent,
        }
    }
}

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

    pub fn evaluate<'a>(&'a self, path: &str, declared: &'a Declared) -> &'a str {
        match declared {
            // Frontmatter is the ONLY route to `public`. It is an explicit act
            // by the note's author, not a consequence of which folder it
            // landed in.
            Declared::Tier(tier) => tier,
            // A declaration this build cannot act on is still a declaration.
            // Falling through to the globs here is what published a note the
            // author had marked private: the glob tier is *more* disclosing
            // than the intent it was standing in for.
            Declared::Unknown => "private",
            Declared::Absent => {
                let tier = self.evaluate_globs(path);
                // Path-derived tiers are capped: a glob may restrict, never publish.
                if tier == "public" { "listed" } else { tier }
            }
        }
    }

    /// Rule application WITHOUT the `public` clamp.
    ///
    /// Used only by the one-shot backfill, which must reproduce pre-inversion
    /// behaviour to decide which notes to make explicitly public. Not for use
    /// on the export path.
    pub fn evaluate_uncapped<'a>(&'a self, path: &str, declared: &'a Declared) -> &'a str {
        match declared {
            Declared::Tier(tier) => tier,
            Declared::Unknown => "private",
            Declared::Absent => self.evaluate_globs(path),
        }
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
    pub fn evaluate_batch<'a>(&'a self, items: &'a [(String, Declared)]) -> Vec<&'a str> {
        items
            .iter()
            .map(|(p, declared)| self.evaluate(p, declared))
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
        assert_eq!(engine.evaluate("3-permanent/note.md", &Declared::Absent), "listed");
    }

    #[test]
    fn frontmatter_can_still_grant_public() {
        let rules = [("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules);
        assert_eq!(engine.evaluate("3-permanent/note.md", &Declared::from_value("public")), "public");
    }

    #[test]
    fn glob_rule_can_still_restrict_to_private() {
        let rules = [
            ("3-permanent/**".to_string(), "public".to_string()),
            ("**/kinso-*".to_string(), "private".to_string()),
        ];
        let engine = VisibilityEngine::new("private", &rules);
        assert_eq!(engine.evaluate("3-permanent/kinso-thing.md", &Declared::Absent), "private");
    }

    #[test]
    fn default_tier_cannot_grant_public_either() {
        let engine = VisibilityEngine::new("public", &[]);
        assert_eq!(engine.evaluate("any.md", &Declared::Absent), "listed");
    }

    #[test]
    fn an_unparseable_value_withholds_rather_than_falling_through() {
        // This test used to assert "listed", on the reasoning that an invalid
        // value must not reach an UNCAPPED tier. True, and it missed the other
        // direction: falling through to the capped glob tier is still more
        // disclosing than the `private` the author was trying to write. A typo
        // in a withholding instruction must not publish.
        let rules = [("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules);
        for value in ["pubic", "", "yes", "true", "[private]", "publi c"] {
            assert_eq!(
                engine.evaluate("3-permanent/note.md", &Declared::from_value(value)),
                "private",
                "`visibility: {value}` must withhold, not fall through to the glob tier"
            );
        }
    }

    #[test]
    fn the_spellings_an_editor_produces_are_understood() {
        // Obsidian's property editor quotes values, and a trailing comment is
        // ordinary YAML. Before normalisation every one of these was an
        // unrecognised value, and unrecognised meant "use the globs" — so
        // `visibility: "private"` on a 3-permanent note published it.
        let rules = [("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules);
        for value in ["\"private\"", "'private'", "Private", "PRIVATE", "private # off the hub"] {
            assert_eq!(
                engine.evaluate("3-permanent/note.md", &Declared::from_value(value)),
                "private",
                "`visibility: {value}` should read as private"
            );
        }
        for value in ["\"public\"", "'public'", "Public", "public   "] {
            assert_eq!(
                engine.evaluate("0-inbox/note.md", &Declared::from_value(value)),
                "public",
                "`visibility: {value}` should read as public"
            );
        }
    }

    #[test]
    fn a_half_quoted_value_is_not_repaired_into_a_tier() {
        // Trimming an unmatched quote would invent a declaration the author
        // did not write. Unknown is the honest answer, and Unknown withholds.
        assert_eq!(Declared::from_value("\"public"), Declared::Unknown);
        assert_eq!(Declared::from_value("public\""), Declared::Unknown);
        assert_eq!(Declared::from_value("\"public'"), Declared::Unknown);
    }

    #[test]
    fn a_hash_inside_a_quoted_value_is_not_a_comment() {
        // Stripping `#` before unquoting would truncate a quoted value that
        // legitimately contains one, turning it into a different string.
        assert_eq!(Declared::from_value("\"private#1\""), Declared::Unknown);
        assert_eq!(Declared::from_value("\"private\""), Declared::Tier("private".into()));
    }

    #[test]
    fn an_unreadable_note_is_not_a_note_that_declared_nothing() {
        // The export path maps an I/O error to `Unknown`. The two must not
        // resolve alike: `Absent` consults the globs, `Unknown` never does.
        let rules = [("3-permanent/**".to_string(), "listed".to_string())];
        let engine = VisibilityEngine::new("private", &rules);
        assert_eq!(engine.evaluate("3-permanent/note.md", &Declared::Absent), "listed");
        assert_eq!(engine.evaluate("3-permanent/note.md", &Declared::Unknown), "private");
    }

    #[test]
    fn uncapped_evaluation_withholds_on_unknown_too() {
        // The backfill path has its own entry point; the fail-closed rule is
        // not allowed to hold on one of them and not the other.
        let rules = [("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules);
        assert_eq!(engine.evaluate_uncapped("3-permanent/n.md", &Declared::Absent), "public");
        assert_eq!(engine.evaluate_uncapped("3-permanent/n.md", &Declared::Unknown), "private");
    }

    #[test]
    fn default_tier() {
        let engine = VisibilityEngine::new("private", &[]);
        assert_eq!(engine.evaluate("any/path.md", &Declared::Absent), "private");
    }

    #[test]
    fn empty_default_resolves_private() {
        let engine = VisibilityEngine::new("", &[]);
        assert_eq!(engine.evaluate("any/path.md", &Declared::Absent), "private");
    }

    #[test]
    fn unknown_default_resolves_private() {
        let engine = VisibilityEngine::new("bogus-tier", &[]);
        assert_eq!(engine.evaluate("any/path.md", &Declared::Absent), "private");
    }

    #[test]
    fn rule_matching() {
        let rules = vec![
            ("3-permanent/**".to_string(), "public".to_string()),
            ("1-fleeting/**".to_string(), "listed".to_string()),
        ];
        let engine = VisibilityEngine::new("private", &rules);
        // A `public` glob is capped to `listed`: only frontmatter publishes.
        assert_eq!(engine.evaluate("3-permanent/note.md", &Declared::Absent), "listed");
        assert_eq!(engine.evaluate("1-fleeting/note.md", &Declared::Absent), "listed");
        assert_eq!(engine.evaluate("0-inbox/note.md", &Declared::Absent), "private");
    }

    #[test]
    fn frontmatter_overrides() {
        let rules = vec![
            ("3-permanent/**".to_string(), "public".to_string()),
        ];
        let engine = VisibilityEngine::new("private", &rules);
        assert_eq!(
            engine.evaluate("3-permanent/note.md", &Declared::from_value("private")),
            "private"
        );
        assert_eq!(
            engine.evaluate("0-inbox/note.md", &Declared::from_value("public")),
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
        assert_eq!(engine.evaluate("3-permanent/secret-stuff.md", &Declared::Absent), "private");
        // The earlier `public` rule now caps to `listed`.
        assert_eq!(engine.evaluate("3-permanent/normal.md", &Declared::Absent), "listed");
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
        let items: Vec<(String, Declared)> = vec![
            ("3-permanent/note.md".to_string(), Declared::Absent),
            ("1-fleeting/thought.md".to_string(), Declared::Absent),
            ("0-inbox/raw.md".to_string(), Declared::from_value("public")),
            ("0-inbox/raw.md".to_string(), Declared::Absent),
        ];
        let batch = engine.evaluate_batch(&items);
        let per_call: Vec<&str> = items
            .iter()
            .map(|(p, d)| engine.evaluate(p, d))
            .collect();
        assert_eq!(batch, per_call);
    }

    #[test]
    fn evaluate_batch_frontmatter_overrides_in_batch() {
        let rules = vec![("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules);
        let items: Vec<(String, Declared)> = vec![
            ("3-permanent/note.md".to_string(), Declared::from_value("private")),
            ("0-inbox/note.md".to_string(), Declared::from_value("public")),
            ("0-inbox/note.md".to_string(), Declared::Absent),
        ];
        let result = engine.evaluate_batch(&items);
        assert_eq!(result, vec!["private", "public", "private"]);
    }
}
