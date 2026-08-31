# Phase 5: Instruction-file Integration

The instruction file tells the agent _how to behave_ with the learning loop throughout a session. Without it, the plugin is installed but the agent does not know when to retrieve, how to capture, or when to suggest consolidation.

Each harness reads a different file, and the same section works in both:

| Harness     | User-level file        | Project-level file      |
| ----------- | ---------------------- | ----------------------- |
| Claude Code | `~/.claude/CLAUDE.md`  | `.claude/CLAUDE.md`     |
| Codex       | `~/.codex/AGENTS.md`   | `AGENTS.md` at repo root |

Run this phase for every harness present on the machine — `codex` on PATH is the test for the second one. A user who installed the plugin for both and only configured Claude Code gets a Codex that loads the skills but never retrieves.

## Dependencies

Phase 5 requires outputs from earlier phases:

- **Vault path** (Phase 2a) used in the template. If vault path is not yet resolved, run 2a first.
- **System files** (Phase 2c) the template references `_system/capture-rules.md` and `_system/persona.md`. If either does not exist, omit the corresponding line from the template rather than referencing a missing file.
- **Folder structure** (Phase 2b) the template assumes `0-inbox/` and `4-projects/` exist. If they don't, omit the "Second Brain" section.

## 5a: Detect

Read the template version from `${CLAUDE_PLUGIN_ROOT}/templates/claudemd-section.version`. Then check three things:

1. Does `~/.claude/CLAUDE.md` exist at all?
2. If yes, does it contain `## Learning Loop`?
3. If yes, does the version comment `<!-- learning-loop v` match the current template version?

Four possible states:

| State                                      | Action                             |
| ------------------------------------------ | ---------------------------------- |
| No CLAUDE.md exists                        | Offer to create one (Phase 5b)     |
| CLAUDE.md exists, no learning-loop section | Offer to append section (Phase 5c) |
| Section exists, version matches            | Skip: already configured           |
| Section exists, version outdated           | Offer to update section (Phase 5d) |

Then, if `codex` is on PATH, run the same three checks against `~/.codex/AGENTS.md` and resolve it through Phase 5c-codex. The two files are tracked independently: one being current says nothing about the other.

## 5b: New CLAUDE.md (prompt-driven generation)

If the user has no `~/.claude/CLAUDE.md`, offer to generate a starter. Ask up to 4 questions to tailor it:

1. "What's your primary language/stack?" (options: a few common ones + Other)
2. "Git commit style preference?" (options: conventional commits, descriptive, short)
3. "How verbose should Claude be?" (options: concise/default, detailed explanations, match my style)
4. "Any code style rules Claude should follow?" (free text, optional)

Generate a concise CLAUDE.md (~50-80 lines) with:

- `## Git` section based on answer 2
- `## Code Style` section based on answers 1 and 4
- `## Workflow` section based on answer 3
- `## Learning Loop` section (the template from 5c)

Show the full generated file and ask: "Write this to ~/.claude/CLAUDE.md?"

Keep it minimal. The user will refine over time. The goal is a working starting point, not perfection.

## 5c: Append learning-loop section

Generate the section using the detected vault path and current template version. The template:

```markdown
## Learning Loop

<!-- learning-loop vN -->

Three stores, three purposes:

- **Auto-memory** (~/.claude/projects/*/memory/): preferences, corrections, project context.
- **Obsidian vault** (VAULT_PATH): decisions, patterns, domain insights.
- **Episodic memory** (plugin): conversation history across sessions.

### Retrieval (every session)

On session start, the learning-loop plugin injects context. Act on it:

1. Read any auto-memories flagged as relevant by the hook.
2. Search episodic memory for relevant past conversations about the current topic/project.
3. Search the Obsidian vault for relevant knowledge notes.
4. Surface relevant findings concisely: `Recall: [insight]` or `Transfer: [insight from other project]`
5. Keep it to one line per insight. No walls of retrieval text.

### Capture (during work)

- **On correction**: Immediately save to auto-memory as feedback type. No delay, no batching.
- **On decisions**: When a non-obvious choice is made, note it: either auto-memory (project context) or Obsidian (durable knowledge).
- **On patterns**: When a pattern spans projects, capture to Obsidian with cross-project links.
- **Mid-conversation insights**: Use `/learning-loop:quick-note` for insights worth keeping without breaking flow.
- Capture silently. Don't announce unless asked.

### Consolidation (end of session)

After substantial work, suggest `/learning-loop:reflect` to run the consolidation checkpoint. This routes learnings to the correct stores, cross-links projects, and promotes inbox notes.

### Second Brain (Obsidian)

Captures go to 0-inbox/ as atomic notes. Tag with source project. Link to the project index note in 4-projects/.

Follow the rules in _system/capture-rules.md. Read _system/persona.md for voice and tone.
```

**Template substitution:** Replace `VAULT_PATH` with the detected vault path. Replace `vN` with the integer template version from `${CLAUDE_PLUGIN_ROOT}/templates/claudemd-section.version`.

**Conditional lines:** Before generating, check which system files and folders exist:

- If `_system/capture-rules.md` does not exist, remove the "Follow the rules in _system/capture-rules.md." line
- If `_system/persona.md` does not exist, remove the "Read _system/persona.md for voice and tone." line
- If both are missing, omit the entire last line of the "Second Brain" section
- If `0-inbox/` or `4-projects/` do not exist, omit the "Second Brain (Obsidian)" section entirely

Show the section and ask: "Where should the learning-loop section go?"

1. `~/.claude/CLAUDE.md` (user-level, applies to all projects): recommended
2. `.claude/CLAUDE.md` in the vault project directory (project-level, only when working in the vault)
3. Skip: I'll add it myself later

Append to the end of the chosen file. Never reorder or modify existing content.

## 5c-codex: The same section for Codex

Only if `codex` is on PATH. Codex reads `AGENTS.md`, never `CLAUDE.md`, so the section has to be written there as well — the two files do not substitute for each other.

Use the identical template with two adjustments:

- Replace every `CLAUDE.md` mention in the prose with `AGENTS.md`.
- Replace `${CLAUDE_PLUGIN_ROOT}` with the literal resolved path. Codex sets `CLAUDE_PLUGIN_ROOT` for plugin hooks, but an instruction file is not a hook and gets no interpolation.

Ask: "Where should the learning-loop section go for Codex?"

1. `~/.codex/AGENTS.md` (user-level, applies to every repo): recommended
2. `AGENTS.md` at the vault repo root (project-level)
3. Skip

Codex caps the combined AGENTS.md chain at `project_doc_max_bytes` (32 KiB by default) and stops adding files once it hits the cap. If the target file is already close to that, say so rather than silently pushing it over.

## 5d: Update outdated section

If the version comment is older than the current template version:

1. Read the existing section from CLAUDE.md (everything between `## Learning Loop` and the next `## ` heading or end of file)
2. Generate the new template with current substitutions
3. Show a before/after comparison: list each instruction that was added, removed, or reworded. Use `+` / `-` prefixes so the user can scan it like a diff. Example:
   ```
   Changes in learning-loop template (v1 -> v2):
   - Removed: "Search the Obsidian vault (via MCP)"
   + Added:   "Search the Obsidian vault"
   + Added:   new "Consolidation" section with /reflect guidance
   ```
4. Ask: "Update the learning-loop section in your CLAUDE.md?"
5. If yes, replace the entire section with the new template
6. Preserve all content outside the learning-loop section

Apply the same three steps to `~/.codex/AGENTS.md` when it carries an outdated section.
