# Contributing

Thanks for working on learning-loop. This file covers what to run before pushing and what CI will check.

## Conventions

Long-form rules live in `docs/baseline/`. Read the one relevant to your change:

- `docs/baseline/rust.md` -- ll-core and ll-search
- `docs/baseline/plugin.md` -- hooks and scripts
- `docs/baseline/cross-cutting.md` -- versioning, perf budgets, observability
- `ARCHITECTURE.md` -- repo map and data-flow diagrams

## Local checks

```bash
# Node tests (hooks, scripts, library code)
npm test

# Native crate tests
cd native && cargo test --workspace

# Prettier auto-format (run before committing)
npx prettier --write 'plugin/hooks/**/*.{js,mjs}' 'plugin/scripts/**/*.{js,mjs}'
```

If a test fails on your branch but passes on `main`, rebuild the native binary (`cd native && cargo build --release`) and re-run; stale binaries account for most local-only failures.

## CI

`.github/workflows/test.yml` runs on every push to `main` and on every pull request. Three jobs:

1. **node** -- `npm test`. Runs `node --test` over `tests/*.test.mjs`.
2. **cargo** -- `cargo test --workspace` inside `native/`, with `~/.cargo` and `native/target` cached by `Cargo.lock` hash.
3. **lint** -- three checks:
   - **Resolved-paths grep.** No file under `plugin/agents/` or `plugin/skills/` may contain `$HOME/brain/learning-loop`, `~/brain/learning-loop`, `$HOME/brain/brain`, or `~/brain/brain`. These paths are Robin's local layout. Use `${CLAUDE_PLUGIN_ROOT}`, `$PLUGIN`, or `{{VAULT}}` tokens instead.
   - **Prettier check.** `npx prettier --check 'plugin/hooks/**/*.{js,mjs}' 'plugin/scripts/**/*.{js,mjs}'` must pass with no diff. Vendored code under `plugin/scripts/lib/vendor/` and `plugin/vendor/` is excluded.
   - **Code-fence tag check.** No markdown file under `plugin/skills/`, `plugin/agents/`, `docs/`, `guide/`, `plugin/hooks/`, `plugin/scripts/` (plus `CHANGELOG.md` and `README.md`) may use non-canonical code-fence tags. Use `bash`, `js`, or `ts` only.

## Commit style

Conventional-style prefixes (`fix:`, `docs:`, `feat:`, `chore:`, `tests:`) on a single subject line, focused on what changed and why. No co-author or generated-by attribution lines. Match the existing log (`git log --oneline | head -30`) for cadence.

## PR checklist

Tick what applies. Items map to a rule in `docs/baseline/`.

*These checks are currently advisory. After track 1I lands and `.github/workflows/baseline.yml` exists, failing checks block merge.*

- [ ] No new `process.env.X` outside `scripts/lib/env.mjs`
- [ ] No `JSON.parse(fs.readFileSync(...))` outside `scripts/lib/safe-load.mjs`
- [ ] No raw `.lock` file creation outside `scripts/lib/file-lock.mjs`
- [ ] New hook has a `timeout` declared in `hooks/hooks.json` and uses `HookConfig.*_TIMEOUT_MS` (from `scripts/lib/hook-config.mjs`) for any inner per-operation deadlines
- [ ] New Rust public item has `///` doc comment
- [ ] No `.clone()` introduced in `search/{query,context,federation,graph,reflect}.rs` hot paths
- [ ] Tests added for new module or hook
- [ ] If hot path touched, bench numbers re-run
- [ ] If `ll-core` public API added, `cargo public-api -p ll-core` shows additive-only diff

## Plans and skills

Long-running work goes in `docs/superpowers/plans/YYYY-MM-DD-name.md` using the existing plan format. Skills (`skills/*/SKILL.md`) and agents (`agents/*.md`) follow the conventions documented in their own README files. Read two or three existing skills before adding a new one.

## Style notes

- No em dashes. Use `--` or restructure the sentence.
- No AI attribution lines.
- New JS files use `.mjs`. Existing `.js` hook entry points stay `.js`.
- Inline filenames in backticks. Fenced code blocks for shell commands.
- Tables for "rule / where / why" patterns.
- Lowercase headings except for proper nouns (ll-core, Claude Code, SQLite).
