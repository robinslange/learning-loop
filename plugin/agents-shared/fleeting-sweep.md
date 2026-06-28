# Fleeting Sweep

Scans `1-fleeting/` for notes that have been absorbed into permanent knowledge or gone stale (offers archival), and for gate-demoted notes that need source repair (recommends `/deepen`).

## When to Use

- End of `/inbox` triage (after inbox processing)
- During `/health` checks (stale note detection)

## Process

Run the sweep script:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/fleeting-sweep.sh {{VAULT}}/
```

Output is TSV: `TYPE\tNAME\tDETAIL`. The script finds:
- **PROMOTED**: 2+ inbound links from `3-permanent/` (insight absorbed into permanent knowledge) — archival candidate
- **NEEDS-DEEPEN**: blocking verification markers or `source: unverified`, untouched >14 days (the class the promote-gate demotes to `1-fleeting/`; its documented repair path is `/deepen`) — repair recommendation, never archival
- **STALE**: archival candidate, two routes in:
  - project-slug filename, zero inbound links, >60 days old
  - repair budget exhausted: a marker-bearing note whose `deepen_attempts` frontmatter counter (incremented by `/deepen` on each failed repair pass) has reached 2 — no longer fixable by research, so it gets the archival exit instead of resurfacing as NEEDS-DEEPEN forever

It automatically skips counterpoint notes (`challenged:`/`challenges:` in frontmatter).

Precedence: `PROMOTED` beats everything (absorption is the best exit), and `STALE` beats `NEEDS-DEEPEN` — a note that qualifies for archival never surfaces as a repair recommendation (archival wins at end-of-life).

## Present

```
## Fleeting Sweep

| Note | Reason | Detail |
|------|--------|--------|
| bacopa-effects-grow-over-weeks | promoted | 3 permanent refs |
| creatine-loading-halves-uptake-time | needs deepen | verification markers, 30 days old |
| acme-app-hero-copy | stale project note | 0 refs, 90 days old |
```

`NEEDS-DEEPEN` notes are a repair recommendation — present them but never offer them for archival; route the user to `/deepen "<note>"`. (Precedence between TYPEs is the script's job — see above.)

**Cap at 5 (oldest first).** When the NEEDS-DEEPEN list exceeds 5 notes, surface only the 5 oldest and append a `+N more` line (e.g. `+8 more — run /health to see the full list`). This prevents a bulk backlog from dominating the report on the first /inbox run after upgrade.

## Gate

Archival is **gated** -- only the user approves it. The destination is `_archive/1-fleeting/`. How the gate clears depends on who is executing this skill:

- **Run by a subagent** (the current executor: inbox-organiser Step 8): you cannot converse with the user. Do NOT archive anything. After the table, return only `PROMOTED` and `STALE` rows as the `fleeting archival` section of the Needs-approval block (the fourth of its four gate categories; the calling skill parses it and presents for approval) -- one path per line. `NEEDS-DEEPEN` rows are NOT archival candidates; return them in a separate `fleeting repair` section so the calling skill can surface a `/deepen` recommendation (non-destructive, no approval needed):

  ```
  fleeting archival (2), to _archive/1-fleeting/:
  - 1-fleeting/bacopa-effects-grow-over-weeks.md -- promoted (3 permanent refs)
  - 1-fleeting/acme-app-hero-copy.md -- stale (0 refs, 90 days old)

  fleeting repair (1), suggest /deepen:
  - 1-fleeting/creatine-loading-halves-uptake-time.md -- verification markers, 30 days old
  ```

  Report: `Fleeting: [A] archival candidates returned, [N] need /deepen, [F] active notes remain.`

- **Run on the main thread** (e.g. a /health-style check): present the table, ask `Archive these [N] notes to _archive/1-fleeting/? (y/n)`, and wait. On approval, `mv` each `PROMOTED`/`STALE` file to `_archive/1-fleeting/` (create with `mkdir -p` if needed). `NEEDS-DEEPEN` rows are never archived — list them under a `Needs /deepen:` heading with the suggested command (`/deepen "<note>"`).

  Report: `Fleeting: [A] notes archived, [N] need /deepen, [F] active notes remain.`
