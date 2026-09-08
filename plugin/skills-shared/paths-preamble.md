# Paths Preamble

Canonical path resolution for skills. Skills reference this doc instead of restating it.

`PLUGIN_DATA` and `VAULT` are injected by the session-start hook (see "Learning Loop Paths" in your context), alongside a `PLUGIN=` line carrying the plugin root. Use those resolved values for ALL path references in prose.

**In a Bash block, resolve them rather than writing a placeholder:**

```bash
eval "$(ll-paths --sh)"
```

That one line sets `PLUGIN`, `PLUGIN_DATA`, `VAULT`, `SESSION_ID` and the marker paths in one spawn, from any shell, with no environment set up in advance. Write `"$PLUGIN/scripts/..."` after it.

**`${CLAUDE_PLUGIN_ROOT}` must not appear inside a Bash block.** It is not an environment variable — a Bash tool shell has no such name — and the only thing that ever fills it in is the Skill tool, when it loads a `SKILL.md`. A block in any other file arrives through `Read`, unsubstituted, and the placeholder expands to the empty string: `node "${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs"` becomes `node "/scripts/x.mjs"`, which fails while `eval` consumes nothing, leaving every path unset and the work rooted at `/`. `tests/bash-blocks-resolve-paths.test.mjs` fails the build over it.

Never hardcode a fallback path; `resolve-paths.mjs` is the single source of truth (see `tests/agent-architecture-lint.test.mjs` M18).
