//! One-shot migration: write `visibility: public` into notes that a `public`
//! glob rule currently matches, so inverting the default preserves today's
//! published set exactly rather than re-classifying it.
//!
//! This deliberately does NOT review what is in that set. Whether the existing
//! public corpus should stay public is a human decision, made once, elsewhere.

use std::path::Path;

use crate::db::index::walk_vault;
use crate::sync::config::FederationConfig;
use crate::sync::frontmatter;
use crate::sync::visibility::VisibilityEngine;

pub struct BackfillReport {
    pub scanned: usize,
    pub written: usize,
    pub already_explicit: usize,
}

pub fn backfill_public(
    vault_path: &Path,
    config: &FederationConfig,
    dry_run: bool,
) -> anyhow::Result<BackfillReport> {
    let rules: Vec<(String, String)> = config
        .visibility
        .rules
        .iter()
        .map(|r| (r.pattern.clone(), r.tier.clone()))
        .collect();
    let engine = VisibilityEngine::new(&config.visibility.default, &rules);

    let mut report = BackfillReport {
        scanned: 0,
        written: 0,
        already_explicit: 0,
    };

    for entry in walk_vault(&vault_path.to_string_lossy()) {
        report.scanned += 1;
        let full = vault_path.join(&entry.rel_path);
        let raw = match std::fs::read_to_string(&full) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("backfill: {} unreadable, skipping: {e}", entry.rel_path);
                continue;
            }
        };

        if frontmatter::read_key(&raw, "visibility").is_some() {
            report.already_explicit += 1;
            continue;
        }

        // Pre-inversion rule application: a glob may still say "public" here,
        // because that is exactly the set we are making explicit.
        if engine.evaluate_uncapped(&entry.rel_path, None) != "public" {
            continue;
        }

        report.written += 1;
        if !dry_run {
            std::fs::write(&full, frontmatter::upsert_key(&raw, "visibility", "public"))?;
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn cfg(rules: &[(&str, &str)]) -> crate::sync::config::FederationConfig {
        crate::sync::config::FederationConfig::test_fixture(
            "private",
            rules
                .iter()
                .map(|(p, t)| (p.to_string(), t.to_string()))
                .collect(),
        )
    }

    #[test]
    fn writes_public_frontmatter_only_for_public_globs() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("3-permanent")).unwrap();
        fs::create_dir_all(dir.path().join("1-fleeting")).unwrap();
        fs::write(dir.path().join("3-permanent/a.md"), "---\ntitle: A\n---\n\nBody.").unwrap();
        fs::write(dir.path().join("1-fleeting/b.md"), "---\ntitle: B\n---\n\nBody.").unwrap();

        let config = cfg(&[("3-permanent/**", "public"), ("1-fleeting/**", "listed")]);
        let report = backfill_public(dir.path(), &config, false).unwrap();

        assert_eq!(report.written, 1);
        let a = fs::read_to_string(dir.path().join("3-permanent/a.md")).unwrap();
        let b = fs::read_to_string(dir.path().join("1-fleeting/b.md")).unwrap();
        assert_eq!(
            crate::sync::frontmatter::read_key(&a, "visibility").as_deref(),
            Some("public")
        );
        assert_eq!(crate::sync::frontmatter::read_key(&b, "visibility"), None);
    }

    #[test]
    fn never_overwrites_an_explicit_visibility() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("3-permanent")).unwrap();
        fs::write(
            dir.path().join("3-permanent/secret.md"),
            "---\nvisibility: private\n---\n\nBody.",
        )
        .unwrap();

        let config = cfg(&[("3-permanent/**", "public")]);
        let report = backfill_public(dir.path(), &config, false).unwrap();

        assert_eq!(report.written, 0);
        assert_eq!(report.already_explicit, 1);
        let s = fs::read_to_string(dir.path().join("3-permanent/secret.md")).unwrap();
        assert_eq!(
            crate::sync::frontmatter::read_key(&s, "visibility").as_deref(),
            Some("private")
        );
    }

    #[test]
    fn dry_run_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("3-permanent")).unwrap();
        let p = dir.path().join("3-permanent/a.md");
        fs::write(&p, "---\ntitle: A\n---\n\nBody.").unwrap();
        let before = fs::read_to_string(&p).unwrap();

        let config = cfg(&[("3-permanent/**", "public")]);
        let report = backfill_public(dir.path(), &config, true).unwrap();

        assert_eq!(report.written, 1, "dry run still reports what it would write");
        assert_eq!(fs::read_to_string(&p).unwrap(), before);
    }

    #[test]
    fn a_later_private_rule_wins_over_an_earlier_public_one() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("3-permanent")).unwrap();
        fs::write(
            dir.path().join("3-permanent/kinso-x.md"),
            "---\ntitle: K\n---\n\nBody.",
        )
        .unwrap();

        let config = cfg(&[("3-permanent/**", "public"), ("**/kinso-*", "private")]);
        let report = backfill_public(dir.path(), &config, false).unwrap();

        assert_eq!(
            report.written, 0,
            "the blocklist rule still applies during backfill"
        );
    }
}
