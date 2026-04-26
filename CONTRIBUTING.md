# Contributing

Thanks for working on learning-loop. This file covers what to run before pushing and what CI will check.

## Local checks

```bash
# Node tests (hooks, scripts, library code)
npm test

# Native crate tests
cd native && cargo test --workspace

# Prettier auto-format (run before committing)
npx prettier --write 'hooks/**/*.{js,mjs}' 'scripts/**/*.{js,mjs}'
```

If a test fails on your branch but passes on `main`, rebuild the native binary (`cd native && cargo build --release`) and re-run; stale binaries account for most local-only failures.

## CI

`.github/workflows/test.yml` runs on every push to `main` and on every pull request. Three jobs:

1. **node** -- `npm test`. Runs `node --test` over `tests/*.test.mjs`.
2. **cargo** -- `cargo test --workspace` inside `native/`, with `~/.cargo` and `native/target` cached by `Cargo.lock` hash.
3. **lint** -- two checks:
   - **Resolved-paths grep.** No file under `agents/` or `skills/` may contain `$HOME/brain/learning-loop`, `~/brain/learning-loop`, `$HOME/brain/brain`, or `~/brain/brain`. These paths are Robin's local layout. Use `${CLAUDE_PLUGIN_ROOT}`, `$PLUGIN`, or `{{VAULT}}` tokens instead.
   - **Prettier check.** `npx prettier --check 'hooks/**/*.{js,mjs}' 'scripts/**/*.{js,mjs}'` must pass with no diff. Vendored code under `scripts/lib/vendor/` and `vendor/` is excluded.

## Commit style

Conventional-style prefixes (`fix:`, `docs:`, `feat:`, `chore:`, `tests:`) on a single subject line, focused on what changed and why. No co-author or generated-by attribution lines. Match the existing log (`git log --oneline | head -30`) for cadence.

## Plans and skills

Long-running work goes in `docs/superpowers/plans/YYYY-MM-DD-name.md` using the existing plan format. Skills (`skills/*/SKILL.md`) and agents (`agents/*.md`) follow the conventions documented in their own README files. Read two or three existing skills before adding a new one.
