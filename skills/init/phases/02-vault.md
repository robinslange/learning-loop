# Phase 2: Vault Setup

Only run sub-steps where Phase 1 detection found issues.

## 2a: Vault Path

**If config has valid vault_path:** Show path. Ask: "I found your vault at [path]. Is that right?"

**If not found:** Detect by walking home directory (max depth 4) looking for `.obsidian` directories using Node.js `fs.readdirSync` recursive walk. Present candidates. If none found, ask for the path manually.

Validate the path exists and contains `.md` files. Write to config.json (merge, never overwrite existing fields):

```json
{ "vault_path": "<chosen-path>" }
```

## 2b: Folders

List missing folders from the 7 required. If all present, skip.

If any missing, list them and ask: "Create the missing folders?" Create after confirmation.

Never rename or restructure existing folders.

## 2c: System Files

For each missing system file, write defaults after confirmation:

**`_system/persona.md`** writes the default voice (Hemingway + Musashi + Lao Tzu). Persona can be customized by editing `_system/persona.md` directly.

**`_system/capture-rules.md`** writes the standard rules:

```markdown
---
tags: [system]
---

# Capture Rules

## Always Capture

- Decisions made: what was chosen, what was rejected
- Problems solved: the problem, the fix, why it worked
- Patterns discovered or reused across projects
- Project state changes: new dependency, architecture shift, major refactor
- Connections between projects: shared patterns, shared problems

## Never Capture

- Dead ends that taught nothing
- Routine code changes: typos, version bumps
- Anything explicitly discarded
- Unvalidated opinions
- Duplicate knowledge: link or update, don't repeat

## Format

- One idea per note
- Title states the insight, not the topic
- Body: 3-10 lines. Longer means split it.
- Max 3 tags
- At least one link to an existing note
- **Counterpoint notes**: must include at least 2 body wiki-links beyond the `challenged` frontmatter field

## Flow

- Auto-captures land in `0-inbox/`
- Promotion: inbox -> fleeting -> permanent
- Project index notes update in-place

## Boundaries

- Never delete or rewrite manually-created notes without asking
- Never create notes about the user personally
- Never restructure notes outside `0-inbox/` without asking
```
