use globset::{GlobBuilder, GlobSet, GlobSetBuilder};

/// The tiers this build understands. One list, because three places used to
/// decide it independently: `Declared::from_value`, the default-tier match in
/// `VisibilityEngine::new`, and `Disclosure::for_tier` in export.rs.
pub const TIERS: [&str; 3] = ["public", "listed", "private"];

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

#[derive(Debug)]
pub struct VisibilityEngine {
    default_tier: String,
    rules: Vec<(GlobSet, String)>,
}

impl VisibilityEngine {
    /// Compile the rules, or say which one could not be compiled.
    ///
    /// This used to be infallible, and that was the whole defect: a pattern
    /// globset refused went through `Glob::new(pattern).ok()?` inside a
    /// `filter_map` and was DROPPED. Silently, with no error anywhere, leaving
    /// a rules list shorter than the one on disk.
    ///
    /// On the config this was found in, the four rules that open folders up to
    /// `listed` sit at indices 0-3 and the forty that close specific subjects
    /// back to `private` sit at 4-43 -- separation, occupation-rent,
    /// personal-grievance, client names. Last match wins, so a single unclosed
    /// `[` anywhere in that blocklist deletes one line of it and every note it
    /// protected falls back to whichever earlier rule matched: `listed`, which
    /// ships path, title, tags and a 300-character body summary. The SKILL
    /// tells people to hand-edit this file.
    ///
    /// Tiers are checked here too. An unrecognised one fails closed --
    /// `Disclosure::for_tier` returns `None` for anything it does not know, so
    /// the note is withheld rather than leaked -- but silently: a rule written
    /// `tier: "listd"` publishes nothing and reports nothing, which is a
    /// different way to not mean what the file says.
    pub fn new(default_tier: &str, rules: &[(String, String)]) -> anyhow::Result<Self> {
        let mut compiled = Vec::with_capacity(rules.len());
        for (pattern, tier) in rules {
            if !TIERS.contains(&tier.trim()) {
                anyhow::bail!(
                    "visibility rule {pattern:?} names tier {tier:?}, which is not one of {TIERS:?}"
                );
            }
            // Case-insensitive: the vault lives on a case-insensitive
            // filesystem, so `**/*separation*` and
            // `3-permanent/Separation-agreement.md` are the same note to
            // everything except globset. No note changes tier under folding
            // today -- checked -- but a blocklist that misses the capitalised
            // spelling of its own token is one rename away from not working,
            // and the rename is the remediation someone reaches for.
            let glob = GlobBuilder::new(pattern)
                .case_insensitive(true)
                .build()
                .map_err(|e| anyhow::anyhow!("visibility rule {pattern:?} is not a valid glob: {e}"))?;
            let mut builder = GlobSetBuilder::new();
            builder.add(glob);
            let set = builder
                .build()
                .map_err(|e| anyhow::anyhow!("visibility rule {pattern:?} could not compile: {e}"))?;
            compiled.push((set, tier.trim().to_string()));
        }
        let default_tier = default_tier.trim();
        if !TIERS.contains(&default_tier) {
            anyhow::bail!(
                "visibility default is {default_tier:?}, which is not one of {TIERS:?}"
            );
        }
        Ok(VisibilityEngine {
            default_tier: default_tier.to_string(),
            rules: compiled,
        })
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

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_rule_cannot_grant_public() {
        let rules = [("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules).unwrap();
        assert_eq!(engine.evaluate("3-permanent/note.md", &Declared::Absent), "listed");
    }

    #[test]
    fn frontmatter_can_still_grant_public() {
        let rules = [("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules).unwrap();
        assert_eq!(engine.evaluate("3-permanent/note.md", &Declared::from_value("public")), "public");
    }

    #[test]
    fn glob_rule_can_still_restrict_to_private() {
        let rules = [
            ("3-permanent/**".to_string(), "public".to_string()),
            ("**/kinso-*".to_string(), "private".to_string()),
        ];
        let engine = VisibilityEngine::new("private", &rules).unwrap();
        assert_eq!(engine.evaluate("3-permanent/kinso-thing.md", &Declared::Absent), "private");
    }

    #[test]
    fn default_tier_cannot_grant_public_either() {
        let engine = VisibilityEngine::new("public", &[]).unwrap();
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
        let engine = VisibilityEngine::new("private", &rules).unwrap();
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
        let engine = VisibilityEngine::new("private", &rules).unwrap();
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
        let engine = VisibilityEngine::new("private", &rules).unwrap();
        assert_eq!(engine.evaluate("3-permanent/note.md", &Declared::Absent), "listed");
        assert_eq!(engine.evaluate("3-permanent/note.md", &Declared::Unknown), "private");
    }

    #[test]
    fn uncapped_evaluation_withholds_on_unknown_too() {
        // The backfill path has its own entry point; the fail-closed rule is
        // not allowed to hold on one of them and not the other.
        let rules = [("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules).unwrap();
        assert_eq!(engine.evaluate_uncapped("3-permanent/n.md", &Declared::Absent), "public");
        assert_eq!(engine.evaluate_uncapped("3-permanent/n.md", &Declared::Unknown), "private");
    }

    #[test]
    fn default_tier() {
        let engine = VisibilityEngine::new("private", &[]).unwrap();
        assert_eq!(engine.evaluate("any/path.md", &Declared::Absent), "private");
    }

    /// A default this build cannot act on is named, not reinterpreted.
    ///
    /// These two asserted the old behaviour: anything unrecognised silently
    /// became `private`. Safe, and still wrong -- an author who wrote
    /// `default: publik` got `private` and was told nothing, so the file did
    /// not mean what it said and nothing anywhere would ever say so. The same
    /// reasoning as the dropped globs beside it: the fix is to refuse the
    /// config, not to guess a tier for it.
    ///
    /// Refusing costs nothing here because no note is exported either way --
    /// a run that stops is strictly more informative than a run that publishes
    /// under rules the operator did not write.
    #[test]
    fn an_empty_default_is_refused_rather_than_read_as_private() {
        let err = VisibilityEngine::new("", &[]).unwrap_err().to_string();
        assert!(err.contains("visibility default"), "got {err}");
    }

    #[test]
    fn an_unknown_default_is_refused_and_names_itself() {
        let err = VisibilityEngine::new("bogus-tier", &[]).unwrap_err().to_string();
        assert!(
            err.contains("bogus-tier"),
            "the refusal must name the value so it can be found in the file: {err}"
        );
    }

    /// The finding this cluster exists for.
    ///
    /// An unclosed `[` used to go through `Glob::new(pattern).ok()?` inside a
    /// `filter_map` and vanish, leaving a rules list shorter than the file. On
    /// the live config the four `listed` rules come first and forty `private`
    /// rules follow, last-match-wins, so a dropped blocklist line does not
    /// withhold -- it lets the earlier `listed` rule win.
    #[test]
    fn a_rule_that_does_not_compile_is_refused_not_dropped() {
        let rules = vec![
            ("3-permanent/**".to_string(), "listed".to_string()),
            ("**/*separation[*".to_string(), "private".to_string()),
        ];
        let err = VisibilityEngine::new("private", &rules).unwrap_err().to_string();
        assert!(
            err.contains("separation["),
            "the refusal must name the pattern, not just the count: {err}"
        );
    }

    /// A tier nothing understands withholds, which is safe -- and silent,
    /// which is the same class of problem as the dropped glob.
    #[test]
    fn a_rule_naming_an_unknown_tier_is_refused() {
        let rules = vec![("3-permanent/**".to_string(), "listd".to_string())];
        let err = VisibilityEngine::new("private", &rules).unwrap_err().to_string();
        assert!(err.contains("listd"), "got {err}");
    }

    /// The vault is on a case-insensitive filesystem; globset is not.
    ///
    /// No note changes tier under folding today. What this closes is the next
    /// capitalised note on a blocklisted token -- and renaming a note to carry
    /// one is exactly the remediation someone reaches for when they notice it
    /// is exposed.
    #[test]
    fn a_blocklist_pattern_matches_the_capitalised_spelling_of_its_own_token() {
        let rules = vec![
            ("3-permanent/**".to_string(), "listed".to_string()),
            ("**/*separation*".to_string(), "private".to_string()),
        ];
        let engine = VisibilityEngine::new("private", &rules).unwrap();
        assert_eq!(
            engine.evaluate("3-permanent/Separation-agreement.md", &Declared::Absent),
            "private",
            "a blocklist that misses its own token capitalised is not a blocklist"
        );
    }

    #[test]
    fn rule_matching() {
        let rules = vec![
            ("3-permanent/**".to_string(), "public".to_string()),
            ("1-fleeting/**".to_string(), "listed".to_string()),
        ];
        let engine = VisibilityEngine::new("private", &rules).unwrap();
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
        let engine = VisibilityEngine::new("private", &rules).unwrap();
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
        let engine = VisibilityEngine::new("listed", &rules).unwrap();
        // The point of this test is that the LATER rule wins; unchanged.
        assert_eq!(engine.evaluate("3-permanent/secret-stuff.md", &Declared::Absent), "private");
        // The earlier `public` rule now caps to `listed`.
        assert_eq!(engine.evaluate("3-permanent/normal.md", &Declared::Absent), "listed");
    }

    #[test]
    fn evaluating_no_items_yields_no_tiers() {
        let engine = VisibilityEngine::new("private", &[]).unwrap();
        let items: Vec<(&str, Declared)> = Vec::new();
        let result: Vec<&str> =
            items.iter().map(|(p, d)| engine.evaluate(p, d)).collect();
        assert!(result.is_empty());
    }


    #[test]
    fn frontmatter_outranks_the_glob_in_both_directions() {
        let rules = vec![("3-permanent/**".to_string(), "public".to_string())];
        let engine = VisibilityEngine::new("private", &rules).unwrap();
        let items: Vec<(&str, Declared)> = vec![
            ("3-permanent/note.md", Declared::from_value("private")),
            ("0-inbox/note.md", Declared::from_value("public")),
            ("0-inbox/note.md", Declared::Absent),
        ];

        let result: Vec<&str> = items.iter().map(|(p, d)| engine.evaluate(p, d)).collect();

        assert_eq!(result, vec!["private", "public", "private"]);
    }
}
