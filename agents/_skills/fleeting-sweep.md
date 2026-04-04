# Fleeting Sweep

Scans `1-fleeting/` for notes that have been absorbed into permanent knowledge or gone stale, and offers archival.

## When to Use

- End of `/inbox` triage (after inbox processing)
- During `/health` checks (stale note detection)

## Process

Run the sweep script:

```bash
bash PLUGIN/scripts/fleeting-sweep.sh {{VAULT}}/
```

Output is TSV: `TYPE\tNAME\tDETAIL`. The script finds:
- **PROMOTED**: 2+ inbound links from `3-permanent/` (insight absorbed into permanent knowledge)
- **STALE**: project-slug filename, zero inbound links, >60 days old

It automatically skips counterpoint notes (`challenged:`/`challenges:` in frontmatter).

## Present

```
## Fleeting Sweep

| Note | Reason | Detail |
|------|--------|--------|
| bacopa-effects-grow-over-weeks | promoted | 3 permanent refs |
| solenoid-hero-copy | stale project note | 0 refs, 90 days old |

Archive these [N] notes to `_archive/1-fleeting/`? (y/n)
```

## Execute

Archival is **gated** -- wait for user approval. On approval, `mv` each file to `_archive/1-fleeting/` (create with `mkdir -p` if needed).

Report: `Fleeting: [A] notes archived, [F] active notes remain.`
