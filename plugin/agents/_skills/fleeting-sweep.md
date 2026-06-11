# Fleeting Sweep

Scans `1-fleeting/` for notes that have been absorbed into permanent knowledge or gone stale, and offers archival.

## When to Use

- End of `/inbox` triage (after inbox processing)
- During `/health` checks (stale note detection)

## Process

Run the sweep script:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/fleeting-sweep.sh {{VAULT}}/
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
| acme-app-hero-copy | stale project note | 0 refs, 90 days old |
```

## Gate

Archival is **gated** -- only the user approves it. The destination is `_archive/1-fleeting/`. How the gate clears depends on who is executing this skill:

- **Run by a subagent** (the current executor: inbox-organiser Step 8): you cannot converse with the user. Do NOT archive anything. After the table, return a machine-readable candidates list the calling skill can parse and present for approval -- one path per line:

  ```
  ### Archival candidates
  1-fleeting/bacopa-effects-grow-over-weeks.md -- promoted (3 permanent refs)
  1-fleeting/acme-app-hero-copy.md -- stale (0 refs, 90 days old)
  ```

  Report: `Fleeting: [A] archival candidates returned, [F] active notes remain.`

- **Run on the main thread** (e.g. a /health-style check): present the table, ask `Archive these [N] notes to _archive/1-fleeting/? (y/n)`, and wait. On approval, `mv` each file to `_archive/1-fleeting/` (create with `mkdir -p` if needed).

  Report: `Fleeting: [A] notes archived, [F] active notes remain.`
