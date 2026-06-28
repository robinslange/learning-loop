# Vault I/O

## Placeholders

Agent and skill files use two path placeholders for the plugin and vault roots:

- `${CLAUDE_PLUGIN_ROOT}` — the plugin install root (where `scripts/`, `agents/`, `skills/` live)
- `{{VAULT}}` — the vault root

(`PLUGIN_DATA` / `${CLAUDE_PLUGIN_DATA}` is a separate token for the plugin's data directory — injected as its own context line, not covered by this rule.)

**Substitution rule:**

- **Value mapping.** The Learning Loop Paths session context carries a `PLUGIN=` and a `VAULT=` line, where `PLUGIN=` → `${CLAUDE_PLUGIN_ROOT}` and `VAULT=` → `{{VAULT}}`.
- **Resolve early.** Resolve both placeholders to literal absolute paths BEFORE passing any prompt to a subagent.
- **Recovery when the context block is absent.** Recover the plugin root in any Bash block: `echo "$CLAUDE_PLUGIN_ROOT"` (a real env var there) or `node "$CLAUDE_PLUGIN_ROOT/scripts/resolve-paths.mjs"`.
- **Inside Bash, it runs as written.** `${CLAUDE_PLUGIN_ROOT}` inside a Bash command resolves at execution — leave it as written.
- **Never guess.** If a placeholder reaches you unresolved in prompt or input TEXT you must use as a path, report it as a dispatch error instead of inventing a value.

Writing a bare `PLUGIN` prefix before a path is banned (a lint test enforces this); always write `${CLAUDE_PLUGIN_ROOT}/`.

## Reading Notes

Use the `Read` tool on `{{VAULT}}/`. Do NOT use Obsidian MCP tools — they are unreliable and frequently fail with JSON parse errors.

Use `Glob` for filename patterns. Use `Grep` for content search.

## Writing Notes

Use the `Write` tool directly to `{{VAULT}}/`. Never use `obsidian_put_file`, `obsidian_patch_file`, or similar MCP tools.

## Path Conventions

| Folder | Purpose |
|--------|---------|
| `0-inbox/` | New captures, rough ideas, counterpoints |
| `1-fleeting/` | Developing notes, partially sourced |
| `2-literature/` | External source captures — source ideas only |
| `3-permanent/` | Complete, sourced, linked, voiced |
| `4-projects/` | Project index notes |
| `5-maps/` | Synthesis maps and MOCs |
| `Excalidraw/` | Excalidraw diagram files (.excalidraw.md) |
| `_system/` | persona.md, capture-rules.md (read-only, never write here without asking) |
| `_archive/1-fleeting/` | Archived fleeting notes (fleeting-sweep moves old notes here) |

## Filename Convention

Kebab-case slug derived from the insight title. Example: `theanine-reaches-brain-slowly-through-two-capacity-limited-gates.md`
