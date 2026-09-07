---
name: doctor
description: 'Diagnose your learning-loop installation. Runs health checks, presents issues, offers per-fix remediation, re-runs each check after the fix to confirm. Safe to run anytime; only makes changes you approve. Pass --redact to scan plugin data files for leaked credentials instead.'
---

# /learning-loop:doctor

A read-mostly diagnostic. Runs the health-check library, presents the result, and walks you through fixes one at a time.

If invoked with `--redact`, skip the normal health-check steps and run the **Redact mode** section instead.

## Paths

Resolve `PLUGIN_DATA`, `VAULT`, and the plugin root per `${CLAUDE_PLUGIN_ROOT}/skills-shared/paths-preamble.md` (read it and apply).

`fix` strings in the health-check JSON prefix paths with a user-facing `PLUGIN` shorthand for the plugin root (defined in [guide/troubleshooting.md](https://github.com/robinslange/learning-loop/blob/main/guide/troubleshooting.md); the `guide/` tree is not shipped with the plugin). Show them verbatim when the user will run the command; substitute `${CLAUDE_PLUGIN_ROOT}` for the leading `PLUGIN` segment when you execute it yourself via Bash.

## Step 1: Run all checks

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/health-check.mjs --full --json
```

Parse the JSON. The schema:

```
{
  "ts": "...",
  "ran": "full",
  "checks": [
    { "id", "name", "status": "ok" | "fail", "severity": "ok" | "warn" | "fail", "detail", "fix" }
  ]
}
```

## Step 2: Present the report

Format the dashboard like this:

```
learning-loop doctor
====================

Health checks (N passed, M warnings, F issues):

  ✓ Node.js                     v25.9.0
  ✓ Claude Code                 2.1.145
  ⚠ ~/.local/bin on PATH        not on PATH
    → Add to your shell rc: export PATH="$HOME/.local/bin:$PATH"
  ✗ ll-search binary            missing at /Users/.../bin/ll-search
    → Run /learning-loop:init to re-download the binary
  …

F issues, M warnings.
```

Icon rules:

- `✓` when `status === "ok"`
- `⚠` when `status === "fail" && severity === "warn"`
- `✗` when `status === "fail" && severity === "fail"`

## Step 3: If F + M === 0

Print `✓ All checks pass. Nothing to fix.` and exit.

## Step 4: Otherwise, iterate fails first, then warns

For each check with `status === "fail"`:

1. Show the check:
   ```
   ✗ <name>: <detail>
     Suggested fix: <fix>
   ```
2. Ask via `AskUserQuestion`:
   - Option A: `Fix this (auto-runnable)` — only when the fix is in the auto-runnable table below
   - Option A': `Run the suggested command and tell me when done` — when the fix is manual
   - Option B: `Skip — I'll handle this later`
   - Option C: `Stop the doctor session` — exits cleanly
3. On choice A: execute the corresponding fix command via Bash. After it finishes, re-run `node ${CLAUDE_PLUGIN_ROOT}/scripts/health-check.mjs --full --json` and find the same check by its `id` field. Report:
   - `✓ Fixed (new state: <detail>)` if the check now returns ok
   - `⚠ Still warning: <new detail>` if it improved to warn
   - `✗ Still failing: <new detail>` if it didn't help (don't loop — move on)
4. On choice A' (manual): print the command, then ask `Done? [Y]es / [N]o`. On Yes, re-run `node ${CLAUDE_PLUGIN_ROOT}/scripts/health-check.mjs --full --json` and find the same check by its `id` field, then report as above.
5. On choice B: track as skipped and move to next.
6. On choice C: print summary and exit.

## Auto-runnable fixes

| Check id                                              | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `binary-exists`, `binary-version-file`, `binary-runs` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/download-binary.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `shims-exist`                                         | `node ${CLAUDE_PLUGIN_ROOT}/scripts/install-shims.mjs --install`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `vault-folders`                                       | `mkdir -p` each missing folder under `<VAULT>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `vault-system-files`                                  | Write the default content defined in `${CLAUDE_PLUGIN_ROOT}/skills/init/phases/02-vault.md` §2c                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `search-index-exists`                                 | `node ${CLAUDE_PLUGIN_ROOT}/scripts/vault-search.mjs index` (resolves vault/db paths itself; bare `ll-search index` fails — the binary requires explicit `<VAULT_PATH> <DB_PATH>` positionals)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `duplicate-gate-health` (repeated timeouts)           | `ll-watch` (start the warm daemon so the duplicate gate uses the socket instead of cold-starting the model on every write)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `duplicate-gate-health` (stale daemon)                | Kill the running ll-watch process then `ll-watch` (restarts with the new binary that supports duplicate-scan)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `injection-shadow-gate` (ready for review)            | Offer two options: **Flip live** (`node -e 'const fs=require("node:fs");const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,"utf8"));c.injection_mode="live";delete c.injection_nudge;fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")' <PLUGIN_DATA>/config.json`) or **Hold in shadow** (`node -e 'const fs=require("node:fs");const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,"utf8"));c.injection_nudge="dismissed";fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")' <PLUGIN_DATA>/config.json`). Always run `node ${CLAUDE_PLUGIN_ROOT}/scripts/review-shadow.mjs` first so the user can judge injection quality. The flip is consent-gated: never apply without the user picking the flip option. If `<PLUGIN_DATA>/config.json` is missing, stop and report instead of creating a partial config. |
| `watch-daemon-status` (stale pidfile)                 | `rm <pidfile>` then `ll-watch` (no arguments — that is the background-start invocation; `start` is not a subcommand)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `abi-drift`                                           | `npm rebuild` in the affected plugin directory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Manual-only fixes (user must run; doctor reports the command):

- `episodic-memory-installed`, `learning-loop-installed` → `claude plugin install <name>@<marketplace>`
- `local-bin-on-path` → user adds to their shell rc
- `claudemd-section-present`, `claudemd-section-current` → defer to `/learning-loop:init` Phase 5
- `vault-path` → defer to `/learning-loop:init` Phase 2
- `plugin-cache-version-present` → `claude plugin install …`
- `node-version`, `claude-version` → run install.sh or upgrade manually

## Step 4.5: Federation checks

`health-check.mjs` does not cover federation — it never opens the federation
directory, so none of what follows appears in its JSON. Run these yourself, and
only when a config exists. Skip the whole step silently on an install that has
never federated.

For each vault profile in `PLUGIN_DATA/vaults.json` — or the single legacy
profile at `PLUGIN_DATA` itself when there is no registry — run:

```bash
ll-search status --config-dir <config_dir>
```

It reads local files only: no socket, no clock, no keyring beyond this
machine's own seed. Nothing it prints can imply a check that did not run.

Report each of these as a **failure**, never as "unknown":

- **"no information — federation/sync-state.json is missing or unreadable"** —
  federation is configured and no cycle has ever finished writing one. That is
  a failure. The file is also the report a corrupt copy collapses into, so the
  line cannot say which of the two it was; say both.
- **`hub holds: nothing`** — as of that cycle the hub held no index for this
  vault. The next sync re-uploads it. If it survives a successful sync, the hub
  is degraded — check its `/health`. *This is the signature of the 2026-07
  outage: the client was content, the hub was empty, and for two months nothing
  said so.*
- **`STALE`** — the last successful sync is older than seven days, or none has
  ever succeeded. Show the age the line gives.
- **`BLOCKED`** — `ll-search sync` will refuse this config. The two causes are
  an unpinned `hub.key_id` and an endpoint that is not `wss://`.
- **`RECOVERED`** — the seed and `config.json` name different keys, so the
  `vault_id` and hub pin belong to a key this machine no longer has.
- **`WARNING` on read auth** — federated search is being served on read
  authority more than seven days old. A vault the hub has stopped listing is
  still searchable here until the grant behind it expires.
- **`WARNING` on refused grants** — the hub refused N grants that cycle. They
  are still signed and still offered every sync, but retrying alone will not
  change its answer.

Then, for machines linked to this identity:

```bash
ll-search link list --config-dir <config_dir>
```

- **A grant expiring within 14 days** — grants renew on use, so an imminent
  expiry means that machine has gone quiet. Name it by its six-word
  fingerprint. This covers `link` grants only; `link list` filters to them, so
  a `follow` about to lapse is not visible from here.
- **`lodged: false`** — this machine signed its half and the hub has not taken
  it. It takes effect on the next sync that reaches the hub.

**One of these is not a fault.** The `last sync` line records the last cycle
that finished, and the watcher acts on a config change at its next federation
tick — so for up to one sync interval after a `join` or a config edit, an error
there can name a hub the `hub:` line does not. Offer the sync and re-read
rather than reporting it as a broken config.

**None of these is auto-runnable.** `ll-search sync` is the fix for most of
them and it uploads a person's notes, so offer it and never run it without
consent.

## Step 5: Summary

After all checks have been processed, print:

```
Doctor summary
==============
  Fixed:    F_fixed
  Skipped:  F_skipped
  Manual:   F_manual (commands above)
  Now-warn: F_warn  (started fail, now warn)
```

Then write the final result via:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/health-check.mjs --full --json > <PLUGIN_DATA>/last-health.json
```

(One last cache refresh so the next session-start detector reflects the post-doctor state.)

## Rules

- Never make changes without explicit per-fix consent.
- Every fix gets verified by re-running the same check function. Never assume.
- If a fix command produces unexpected output (non-zero exit, error to stderr), surface it; don't pretend it succeeded.
- Use UTF-8 indicators (`✓`, `⚠`, `✗`, `→`). No ASCII fallback.
- Exit code 0 even if some issues remain — the doctor's job is to inform + offer, not gate.

## Redact mode (--redact)

Scans persisted plugin-data text files for likely credentials. Only text files are scanned: `.jsonl`, `.json`, `.md`, `.log`, `.txt`. Binary databases (`*.db`, including `edges.db` and any federation `index.db` files) and other binary files are **never read as text or rewritten** — skip them unconditionally.

### Step 1: Locate plugin data

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs
```

Note the `PLUGIN_DATA` path. Recursively collect files under that path, then filter to those whose extension is in the text allowlist (`.jsonl`, `.json`, `.md`, `.log`, `.txt`). Skip everything else, including any `.db` files.

### Step 2: Scan for secrets

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/redact-scan.mjs <text-files...>
```

Pass only the text-allowlisted files. The script will also skip any non-text file passed to it (printing a notice to stderr). For each file with hits, the script prints one line per finding:

```
<path>: <kind> <MASKED>
```

where `<MASKED>` shows the first 4 and last 2 characters with the middle replaced by `*` (e.g. `ghp_****************************3z`). The full secret is never printed.

Detection patterns:

| kind             | matches                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `github-pat`     | `ghp_` followed by 30+ alphanumeric characters                             |
| `openai-key`     | `sk-`, optionally `sk-proj-` / `sk-svcacct-`, followed by 16+ alphanumerics |
| `anthropic-key`  | `sk-ant-api` followed by 20+ alphanumeric, underscore, or hyphen characters |
| `slack-token`    | `xox[baprs]-` followed by 8+ alphanumeric or hyphen characters             |
| `jwt`            | `eyJ` followed by 8+ base64url characters                                  |

Detection is intentionally conservative — the patterns target known credential prefixes to avoid alarm fatigue from false positives.

### Step 3: Present findings

List each file with hits, showing `kind` and the masked match. Files with no hits are not listed.

If no hits are found across all files, print `✓ No credentials found in plugin data.` and exit.

### Step 4: Offer per-file scrub

For each text file with hits, ask via `AskUserQuestion`:

- Option A: `Scrub this file — replace matching secrets with [REDACTED]`
- Option B: `Skip this file`
- Option C: `Stop`

Binary files (`.db`, `.wasm`, extensionless binaries) are never offered for scrub — they were excluded in Step 1. Scrub only runs on text-allowlisted files.

On choice A, replace each hit in the file content with `[REDACTED]` and write the file back. Re-run the scan on the file to confirm zero hits remain, then report:

- `✓ Scrubbed <path> — N secrets replaced`
- `✗ Still has hits after scrub: <path>` (surface the remaining masked matches; do not loop)

### Rules

- Never auto-scrub. Every file scrub requires explicit per-file consent.
- Never print a full secret — always mask (first 4 + last 2 chars, rest `*`).
- Never delete files. Scrub means in-place replacement with `[REDACTED]`.
- Exit code 0 even when hits are found — this is a report, not a gate.

## When to use

- After running `install.sh`, to verify setup
- When session-start shows `⚠ learning-loop: N issues — run /learning-loop:doctor`
- Before opening a support issue ("paste me your doctor output")
- As a habitual health check after a Claude Code update or plugin reinstall
- Before sharing plugin data with a third party (`/learning-loop:doctor --redact` first)
