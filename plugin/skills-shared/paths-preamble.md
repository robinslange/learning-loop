# Paths Preamble

Canonical path resolution for skills. Skills reference this doc instead of restating it.

`PLUGIN_DATA` and `VAULT` are injected by the session-start hook (see "Learning Loop Paths" in your context); the plugin root is `${CLAUDE_PLUGIN_ROOT}` (a real env var in Bash blocks, injected as the `PLUGIN=` context line). Use those resolved values for ALL path references. If not present, resolve them by running:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs
```

Never hardcode a fallback path; `resolve-paths.mjs` is the single source of truth (see `tests/agent-architecture-lint.test.mjs` M18).
