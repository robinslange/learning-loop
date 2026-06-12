---
name: doctor
description: "Diagnose your learning-loop installation. Runs health checks, presents issues, offers per-fix remediation, re-runs each check after the fix to confirm. Safe to run anytime; only makes changes you approve."
---

# /learning-loop:doctor

A read-mostly diagnostic. Runs the health-check library, presents the result, and walks you through fixes one at a time.

## Paths

`PLUGIN_DATA` and `VAULT` are injected by the session-start hook; the plugin root is `${CLAUDE_PLUGIN_ROOT}` (a real env var in Bash blocks, injected as the `PLUGIN=` context line). If absent:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs
```

`fix` strings in the health-check JSON prefix paths with a user-facing `PLUGIN` shorthand for the plugin root (defined in `guide/troubleshooting.md`). Show them verbatim when the user will run the command; substitute `${CLAUDE_PLUGIN_ROOT}` for the leading `PLUGIN` segment when you execute it yourself via Bash.

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

| Check id | Action |
|---|---|
| `binary-exists`, `binary-version-file`, `binary-runs` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/download-binary.mjs` |
| `shims-exist` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/install-shims.mjs --install` |
| `vault-folders` | `mkdir -p` each missing folder under `<VAULT>` |
| `vault-system-files` | Write the default content defined in `${CLAUDE_PLUGIN_ROOT}/skills/init/phases/02-vault.md` §2c |
| `search-index-exists` | `node ${CLAUDE_PLUGIN_ROOT}/scripts/vault-search.mjs index` (resolves vault/db paths itself; bare `ll-search index` fails — the binary requires explicit `<VAULT_PATH> <DB_PATH>` positionals) |
| `nli-socket-fresh` (stale file) | `rm <path>` |
| `duplicate-gate-health` (repeated timeouts) | `ll-watch` (start the warm daemon so the duplicate gate uses the socket instead of cold-starting the model on every write) |
| `watch-daemon-status` (stale pidfile) | `rm <pidfile>` then `ll-watch` (no arguments — that is the background-start invocation; `start` is not a subcommand) |
| `abi-drift` | `npm rebuild` in the affected plugin directory |

Manual-only fixes (user must run; doctor reports the command):
- `episodic-memory-installed`, `learning-loop-installed` → `claude plugin install <name>@<marketplace>`
- `local-bin-on-path` → user adds to their shell rc
- `claudemd-section-present`, `claudemd-section-current` → defer to `/learning-loop:init` Phase 5
- `vault-path` → defer to `/learning-loop:init` Phase 2
- `plugin-cache-version-present` → `claude plugin install …`
- `node-version`, `claude-version` → run install.sh or upgrade manually

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

## When to use

- After running `install.sh`, to verify setup
- When session-start shows `⚠ learning-loop: N issues — run /learning-loop:doctor`
- Before opening a support issue ("paste me your doctor output")
- As a habitual health check after a Claude Code update or plugin reinstall
