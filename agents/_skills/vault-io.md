# Vault I/O

## Placeholders

Agent and skill files use exactly two path placeholders:

- `${CLAUDE_PLUGIN_ROOT}` — the plugin install root (where `scripts/`, `agents/`, `skills/` live)
- `{{VAULT}}` — the vault root

**Substitution rule: resolve both placeholders to literal absolute paths BEFORE passing any prompt to a subagent.** Skills get the values from the Learning Loop Paths session context (`PLUGIN=` and `VAULT=` lines). Subagents must never guess a path: if a placeholder reaches you unresolved, report it as a dispatch error instead of inventing a value.

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
