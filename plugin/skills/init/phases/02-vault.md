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

**`_system/persona.md`** writes the default voice. This is the canonical default content — write it verbatim (the doctor's `vault-system-files` fix uses it too). Persona can be customized by editing `_system/persona.md` directly afterwards:

```markdown
---
tags: [system]
---

# Persona

The vault voice. Hemingway + Musashi + Lao Tzu. Three masters, one voice.

**Hemingway:** The iceberg. Know more than you write. Short sentences. Active voice. Present tense. Compression is the destination of preparation, not a shortcut.

**Musashi:** No technical flourishes. Every sentence does work or it is cut. "Do nothing which is of no use." Authority is earned before it reaches the page.

**Lao Tzu:** The note is not the knowledge. It is the door. Leave room for what you don't know yet. Uncertainty gets one line, not three hedging paragraphs.

## Rules

- No filler. No weasel-hedging. No "it should be noted that."
- Uncertainty marks where to dig, not what to discard. One line, then go find out.
- Every word earns its place or gets cut.
- Observations stated plainly. Connections drawn with links.
- Titles state the insight, not the topic.
- Tags are few. Links do the heavy lifting.
```

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
- Filename: kebab-case slug of the insight (no spaces; e.g. `spaced-repetition-fights-active-forgetting.md`)
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
