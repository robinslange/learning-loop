# Paths Preamble

Canonical path resolution for skills. Skills reference this doc instead of restating it.

`PLUGIN_DATA` and `VAULT` are injected by the session-start hook (see "Learning Loop Paths" in your context), alongside a `PLUGIN=` line carrying the plugin root. Use those resolved values for ALL path references in prose.

**In a Bash block, name the command — do not build a path to it:**

```bash
ll-run provenance-emit.js '{"agent":"...","skill":"..."}'
```

`ll-run <script> [args]` runs `scripts/<script>` from the newest installed
version. It needs no environment, no variable and no prior line. That covers
almost every block, because almost every block only ever wanted to run a
script.

For the blocks that genuinely need a path — an inline `node -e "import(...)"`,
or a vault or plugin-data location — ask for the one field you need:

```bash
VAULT="$(ll-paths VAULT)"
PLUGIN_DATA="$(ll-paths PLUGIN_DATA)"
```

`ll-paths` prints any one of `PLUGIN`, `PLUGIN_DATA`, `VAULT`, `SESSION_ID`,
`REFLECT_SCRATCH`, `REFLECT_PREFIX`, `LAST_DREAM`, `LAST_REFLECT`,
`DREAM_LOCK`. Name the fields the block uses, and no others — a reader should
be able to see what a block touches without running it.

**Never `eval "$(ll-paths --sh)"`.** It reads as one cheap spawn instead of
several, and it cost every skill its worktree sessions: the isolation guard
refuses a command it cannot statically verify, and `eval` of a command
substitution is exactly that. It also hides which paths a block depends on,
and it swallows the resolver's own failure — `eval` of a command that died
consumes nothing and leaves every name unset. `tests/bash-blocks-resolve-paths.test.mjs`
fails the build over it.

**`${CLAUDE_PLUGIN_ROOT}` must not appear inside a Bash block.** It is not an environment variable — a Bash tool shell has no such name — and the only thing that ever fills it in is the Skill tool, when it loads a `SKILL.md`. A block in any other file arrives through `Read`, unsubstituted, and the placeholder expands to the empty string: `node "${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs"` becomes `node "/scripts/x.mjs"`, which fails while `eval` consumes nothing, leaving every path unset and the work rooted at `/`. `tests/bash-blocks-resolve-paths.test.mjs` fails the build over it.

Never hardcode a fallback path; `resolve-paths.mjs` is the single source of truth (see `tests/agent-architecture-lint.test.mjs` M18).
