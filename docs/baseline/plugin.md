# plugin baseline conventions

Conventions for `hooks/`, `scripts/`, and `scripts/lib/`. Read this before touching any JS or MJS file. See `docs/baseline/rust.md` for ll-core and ll-search, `docs/baseline/cross-cutting.md` for versioning, perf budgets, and observability.

*Phase status: Phase 0C creates the shared primitives. Phase 1I adopts them across all hooks and scripts and flips ESLint rules to error. Until track 1I merges, these rules are enforced by code review only.*

---

## directory layout

```
learning-loop/
  plugin/
    hooks/
      <hook>.js            -- entry: stdin -> dispatch -> exit. Target: <100 LOC each.
      <hook>/              -- submodules for hooks needing decomposition
      lib/                 -- hook-shared helpers (common, inject, snapshot, io, dream-gate)
      modules/             -- post-tool modules (autolink, edge-infer, provenance, reflect-track)
    scripts/
      <command>.mjs        -- entry: CLI parse -> dispatch. Target: <150 LOC each.
      <command>/           -- submodules for commands needing decomposition
      lib/                 -- shared primitives -- the ONLY place these live
        env.mjs            -- the only file that reads process.env
        config.mjs         -- config.json + schema validation
        file-lock.mjs      -- O_EXCL-based locking, used everywhere
        jsonl.mjs          -- safe append/read with corruption recovery
        markdown-parse.mjs -- frontmatter, tags, wikilinks
        plugin-meta.mjs    -- manifest version, cache paths, plugin id
        hook-config.mjs    -- numeric ceilings (timeouts, thresholds)
        safe-load.mjs      -- safeLoad(path, schema) wrapper
        log.mjs            -- logError() gated on LL_HOOK_DEBUG
  tests/                   -- flat: tests/<name>.test.mjs
    fixtures/              -- shared fixtures
    helpers/               -- shared test helpers
    install/               -- installer tests
    sources/               -- source-resolver adapter tests
```

The 7 primitives in `scripts/lib/` are created by track 0C. Before they exist, equivalent logic is scattered: `process.env` reads appear in 23 files, `JSON.parse(readFileSync(...))` appears at 22 sites, and timeout values are hardcoded magic numbers across 16 locations (see `.planning/inventory/plugin-patterns.md:103-128`, `.planning/inventory/coverage-and-magic.md:177-195`).

---

## per-rule conventions

### `process.env.X` only in `scripts/lib/env.mjs`

**Bad:**

```js
// hooks/session-label.js
const threshold = process.env.LEARNING_LOOP_INJECTION_THRESHOLD ?? '0.35';
```

**Good:**

```js
// scripts/lib/env.mjs  (the only place)
export const env = Object.freeze({
  VAULT_PATH: process.env.VAULT_PATH ?? null,
  LL_HOOK_DEBUG: process.env.LL_HOOK_DEBUG === '1',
  INJECTION_THRESHOLD: parseFloat(process.env.LEARNING_LOOP_INJECTION_THRESHOLD ?? '0.35'),
  CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA ?? null,
  // ...
});

// hooks/session-label.js
import { env } from '../scripts/lib/env.mjs';
const threshold = env.INJECTION_THRESHOLD;
```

The inventory found 26 distinct env vars across 23 files, most undocumented (`.planning/inventory/plugin-patterns.md:103-128`). `env.mjs` centralises them with defaults and types so a missing env var fails at startup rather than mid-hook.

After track 1I, ESLint rule `no-process-env-outside-env-module` runs at `"error"`. It does not run yet.

### `JSON.parse(fs.readFileSync(...))` only via `safe-load.mjs`

**Bad:**

```js
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
```

**Good:**

```js
import { safeLoad } from '../lib/safe-load.mjs';
const data = await safeLoad(path);              // returns null on missing/corrupt
const data = await safeLoad(path, mySchema);    // validates shape, throws on mismatch
```

The inventory found 22 direct `JSON.parse(readFileSync(...))` sites (`.planning/inventory/plugin-patterns.md:132-184`). `safe-load.mjs` adds: UTF-8 BOM stripping, a `null` return on missing files, schema validation, and a structured error log rather than a silent `catch {}`.

After track 1I, ESLint rule `no-direct-jsonparse` runs at `"error"`. It does not run yet.

### every hook declares `HOOK_BUDGET_MS` at the top

Every hook must time-bound its work with `Promise.race`:

```js
const HOOK_BUDGET_MS = 500; // from HookConfig if available

async function main() {
  const result = await Promise.race([
    doWork(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('hook budget exceeded')), HOOK_BUDGET_MS)),
  ]);
  process.stdout.write(JSON.stringify(result) + '\n');
}
```

The inventory found 16 timeout values scattered across hooks with no shared ceiling (`.planning/inventory/coverage-and-magic.md:177-195`). Track 0C creates `scripts/lib/hook-config.mjs` with named constants; track 1I adopts them. Until then, declare `HOOK_BUDGET_MS` as a local constant at the top of every hook file.

### file locks via `file-lock.mjs` only

**Bad:**

```js
fs.writeFileSync(lockPath, process.pid.toString(), { flag: 'wx' }); // session-start.js:282
```

**Good:**

```js
import { withLock } from '../lib/file-lock.mjs';
await withLock(lockPath, async () => {
  // protected section
});
```

The inventory catalogued 9 distinct lock implementations. Four used O_EXCL correctly. One in `scripts/lib/edges.mjs` was confirmed unsafe at baseline: it relied on `writeFileSync` with `{ flag: 'wx' }` rather than `openSync(O_EXCL)`, creating a race window between the existence check and the write (`.planning/inventory/plugin-patterns.md:223-253`). That has since been fixed: `edges.mjs` keeps its path-keyed `acquireLock(dbPath)` / `releaseLock(dbPath)` contract but delegates the actual O_EXCL + stale-recovery machinery to `lib/file-lock.mjs`.

`file-lock.mjs` uses `fs.openSync` with `O_CREAT | O_EXCL | O_WRONLY` + PID + a retry loop with exponential backoff. Everything that creates a `.lock` file must go through it. After track 1I, `grep CI` pattern `writeFileSync.*\.lock` is a CI failure.

### `logError()` not bare `catch {}`

**Bad:**

```js
try {
  data = JSON.parse(raw);
} catch {}  // silent; no trace
```

**Good:**

```js
import { logError } from '../lib/log.mjs';
try {
  data = JSON.parse(raw);
} catch (err) {
  logError('session-start:snapshot', err);
  data = null;
}
```

`logError(scope, err)` writes to stderr only when `LL_HOOK_DEBUG=1`. In production it's a no-op, so there's no performance penalty for adding it. The inventory found 79 bare `catch {}` blocks across the plugin (`.planning/inventory/plugin-patterns.md:299-331`). Track 1I converts all of them. Every new `catch` block must call `logError`.

After track 1I, ESLint rule `no-empty-catch` runs at `"error"`. It does not run yet.

### ESM-only for new code

New files go in `.mjs`. The existing `.js` hooks (`hooks/*.js`) stay as-is because Claude Code's hook loader requires `.js` extensions at the entry point. Internal submodules and all scripts use `.mjs`.

```
hooks/session-start.js        -- entry: must stay .js
hooks/session-start/           -- submodules: .mjs
scripts/vault-search.mjs       -- scripts: always .mjs
scripts/lib/safe-load.mjs      -- lib: always .mjs
```

### tests for every hook and every `scripts/lib/` module

Coverage target: ≥70% line coverage on `hooks/` and `scripts/lib/`. At the 2026-05-11 baseline only 10 of 68 plugin files had tests (see `.planning/inventory/coverage-and-magic.md`); the suite has since grown past 120 test files against ~134 hook/script source files. Track 0D added characterisation tests for the four then-untested hooks; track 0C added tests for the 7 shared primitives.

One test file per hook, one per `scripts/lib/` module. Name: `tests/<name>.test.mjs`. Use Node's built-in `node:test` runner; no test framework dependency.

```bash
node --test tests/<name>.test.mjs
```

---

## why these rules exist

**Scattered env reads.** When `LEARNING_LOOP_INJECTION_THRESHOLD` is read directly in `hooks/session-label.js:293` and `scripts/review-shadow.mjs:74` with different defaults, the two consumers silently disagree. The centralized `env.mjs` model makes defaults visible in one place and type-converts at load time. A wrong env value causes an immediate startup error rather than a logic bug three hooks deep.

**Safe-load.** Six of the 22 `JSON.parse(readFileSync(...))` sites use bare `catch {}`. A corrupt config file silently returns `undefined`, and the downstream code hits a property access error at an unrelated line twenty calls later. `safeLoad` returns `null` and logs the failure. Nulls are easy to check; mystery crashes are not.

**Timeout discipline.** Session-start fires on every session open and has no global timeout. Sub-tasks with their own timeouts (deps check: 5000 ms, snapshot: 10000 ms) are independent, but there is no ceiling on total hook time. A stalled daemon startup at `hooks/session-start.js:266` (2000 ms poll, unbounded retries) can block Claude Code's ready signal indefinitely. `HOOK_BUDGET_MS` + `Promise.race` makes the maximum wall time explicit and auditable.

**File-lock correctness.** The `{ flag: 'wx' }` pattern in session-start.js has a race between the `existsSync` check and the `writeFileSync` call. Two concurrent processes can both pass the check and both write. The `O_EXCL` flag in `openSync` is an atomic kernel operation: only one process wins, the other gets `EEXIST`. This is not a theoretical concern -- edges.mjs confirmed the pattern was broken in practice (`.planning/inventory/plugin-patterns.md:223-253`; since fixed by delegating to `file-lock.mjs`).

**79 bare catches.** Silent catch blocks are the main reason hook failures produce no signal. A failed snapshot write doesn't surface until the next session when context is stale and the user notices degraded responses. `logError` makes the failure visible under `LL_HOOK_DEBUG` without polluting production output.

---

## CI enforcement

| Rule | CI check | Lands in |
|---|---|---|
| `process.env.X` only in `env.mjs` | ESLint `no-process-env-outside-env-module` | Phase 1 (track 1I) |
| No `JSON.parse(readFileSync(...))` outside `safe-load.mjs` | ESLint `no-direct-jsonparse` | Phase 1 (track 1I) |
| No raw `.lock` file creation | ESLint `no-raw-lockfile` + grep CI | Phase 1 (track 1I) |
| No empty `catch {}` | ESLint `no-empty-catch` | Phase 1 (track 1I) |
| Coverage ≥70% on `hooks/` + `scripts/lib/` | `c8` coverage gate | Phase 1 (track 1I) |
| No file >500 LOC in `hooks/` or `scripts/` | grep CI line count | Phase 1 (track 1I) |

*The ESLint config is created in track 0C with all rules set to `"off"`. After track 1I merges, rules flip to `"error"`. Until then, these are code review standards.*

---

## example: writing a new hook

Scenario: a new `post-write-tag-sync.js` hook that runs after every vault write and syncs frontmatter tags to the graph.

**Step 1.** Create the entry at `hooks/post-write-tag-sync.js`. Keep it under 100 LOC:

```js
import { env } from '../scripts/lib/env.mjs';
import { logError } from '../scripts/lib/log.mjs';
import { syncTags } from './post-write-tag-sync/sync.mjs';

const HOOK_BUDGET_MS = 300;

async function main() {
  const input = JSON.parse(await readStdin());
  const result = await Promise.race([
    syncTags(input, env),
    timeout(HOOK_BUDGET_MS),
  ]);
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch((err) => {
  logError('post-write-tag-sync', err);
  process.exit(0); // hooks must not block the write
});
```

**Step 2.** Create `hooks/post-write-tag-sync/sync.mjs` with the logic:

```js
import { withLock } from '../../scripts/lib/file-lock.mjs';
import { safeLoad } from '../../scripts/lib/safe-load.mjs';
import { logError } from '../../scripts/lib/log.mjs';

export async function syncTags(input, env) {
  const graphPath = path.join(env.CLAUDE_PLUGIN_DATA, 'graph.json');
  const graph = await safeLoad(graphPath) ?? {};

  await withLock(graphPath + '.lock', async () => {
    // modify graph
  });

  return { ok: true };
}
```

**Step 3.** Add a test at `tests/hook-post-write-tag-sync.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('syncTags no-ops on empty input', async () => {
  const result = await syncTags({}, { CLAUDE_PLUGIN_DATA: '/tmp/fixture' });
  assert.deepStrictEqual(result, { ok: true });
});
```

**Step 4.** Run it:

```bash
node --test tests/hook-post-write-tag-sync.test.mjs
```

**Step 5.** Register in `package.json` hooks manifest and `settings.json`.

---

---

## hook config constants

All numeric ceilings come from `scripts/lib/hook-config.mjs`. Until that module exists (track 0C), declare constants locally at the top of each hook file. Do not inline literals mid-function.

The full constant inventory from `.planning/inventory/coverage-and-magic.md:177-195`:

| Constant | Value | Purpose |
|---|---|---|
| `HookConfig.LABEL_TIMEOUT_MS` | 3000 | session-label timeout |
| `HookConfig.DEDUPE_WINDOW_MS` | 180000 | session deduplication window |
| `HookConfig.INJECTION_RACE_CAP_MS` | 1500 | JIT injection race cap |
| `HookConfig.QUERY_TIMEOUT_MS` | 3000 | pre-write-check query timeout |
| `HookConfig.DEPS_CHECK_TIMEOUT_MS` | 5000 | session-start deps check |
| `HookConfig.SNAPSHOT_TIMEOUT_MS` | 10000 | vault snapshot timeout |
| `HookConfig.REINDEX_TIMEOUT_MS` | 5000 | daemon reindex timeout |
| `HookConfig.DAEMON_STARTUP_DEADLINE_MS` | 2000 | daemon ready poll deadline |
| `HookConfig.SESSION_SWEEP_TTL_MS` | 604800000 | 7-day stale-session-artifact sweep cutoff |
| `HookConfig.EDGES_TMP_ORPHAN_TTL_MS` | 3600000 | edges.db tmp-orphan sweep cutoff |
| `HookConfig.SESSION_SIZE_THRESHOLD_BYTES` | 51200 | stop-nudge session size check |
| `HookConfig.SIMILARITY_THRESHOLD` | 0.85 | pre-write duplicate gate |
| `HookConfig.REFLECT_COOLDOWN_SECS` | 300 | stop-nudge reflect cooldown |

---

## common hook patterns

### reading stdin

All hook entry points read a JSON object from stdin. Use the async reader pattern:

```js
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
```

Then parse with error handling:

```js
let input;
try {
  input = JSON.parse(await readStdin());
} catch (err) {
  logError('my-hook:stdin', err);
  process.exit(0); // hooks must not block
}
```

### writing stdout

Hook output is a single-line JSON object followed by `\n`. Nothing else should go to stdout.

```js
process.stdout.write(JSON.stringify({ ok: true, data: result }) + '\n');
```

`console.log`, `console.error`, and any other stdout writes corrupt the JSON and cause Claude Code to misparse the hook response.

### exit conventions

| Condition | Exit |
|---|---|
| Success | `process.exit(0)` |
| Soft failure (hook degraded gracefully) | `process.exit(0)` with `{ ok: false, error: msg }` payload |
| Hard failure (hook must not continue) | `process.exit(1)` (rare: only for pre-write-check blocking a bad write) |

Hooks should almost always exit 0. Exiting 1 blocks the triggering Claude Code action and should only be used intentionally (e.g., `pre-write-check.js` vetoing a near-duplicate note).

---

## scripts conventions

Scripts in `scripts/*.mjs` are CLI utilities invoked by hooks, by other scripts, or by the user directly. They are not hooks -- they do not read stdin automatically or write a JSON response.

Entry points use `process.argv` for argument parsing. Keep the entry under 150 LOC; decompose into submodules.

### binary execution

Calls to ll-search go through `scripts/lib/binary.mjs`:

```js
import { runBinary } from '../lib/binary.mjs';
const result = await runBinary(['search', '--vault', vaultPath], inputJson, {
  timeout: HookConfig.QUERY_TIMEOUT_MS,
});
```

Never call `execFileSync` on the ll-search binary directly from a hook. The binary wrapper handles: binary path resolution, timeout, JSON parse of output, and structured error logging.

### long-running scripts

Scripts that watch or daemon (watch.mjs, librarian.mjs) must handle SIGTERM:

```js
let shuttingDown = false;
process.on('SIGTERM', () => {
  shuttingDown = true;
});

// in the main loop:
if (shuttingDown) break;
```

Flush pending state before exiting. Track 1H formalizes this for librarian.mjs.

---

## testing patterns

### fixture vaults

Test fixtures go in `tests/fixtures/vault-small/`. A minimal vault fixture needs:

- A few markdown notes with frontmatter
- A `config.json` pointing to the fixture directory
- A pre-built SQLite DB if the test exercises search (generate with `node scripts/vault-search.mjs --init`)

Do not hardcode absolute paths in fixtures. Use `path.join(import.meta.dirname, '../fixtures/vault-small')`.

### hook tests

Hook tests use the stdin/stdout pattern:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('session-label emits a label on valid input', () => {
  const input = JSON.stringify({ tool_use: [], messages: [] });
  const result = spawnSync('node', ['hooks/session-label.js'], {
    input,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.ok(output.label);
});
```

Run with:

```bash
cd /Users/robin/brain/learning-loop
node --test tests/hook-session-label.test.mjs
```

### lib tests

`scripts/lib/` modules are pure functions or async functions with injectable dependencies. Test them directly without spawning a subprocess:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeLoad } from '../scripts/lib/safe-load.mjs';

test('safeLoad returns null for missing file', async () => {
  const result = await safeLoad('/nonexistent/path.json');
  assert.strictEqual(result, null);
});
```

---

## paths and data directories

All path resolution goes through `scripts/lib/paths.mjs` (or after 0C, `scripts/lib/env.mjs`). Do not construct `CLAUDE_PLUGIN_DATA` paths inline.

Key directories:

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_PLUGIN_DATA` | set by Claude Code | Plugin data root |
| `VAULT_PATH` | from config or env | User's Obsidian vault |
| `pluginData/bin/` | `$CLAUDE_PLUGIN_DATA/bin/` | ll-search binary location |
| `pluginData/retrieval/` | `$CLAUDE_PLUGIN_DATA/retrieval/` | Shadow injection logs |
| `pluginData/provenance/` | `$CLAUDE_PLUGIN_DATA/provenance/` | Provenance JSONL |

---

## see also

- `docs/baseline/rust.md` -- ll-core and ll-search conventions
- `docs/baseline/cross-cutting.md` -- versioning, perf budgets, observability
- `ARCHITECTURE.md` -- repo map and data flow
- `.planning/inventory/plugin-patterns.md` -- full env, JSON.parse, lock, and catch inventory
- `.planning/inventory/coverage-and-magic.md` -- magic number inventory and coverage map
- `.planning/refactors/baseline-2026-05-11.md` -- track-by-track plan with acceptance criteria
