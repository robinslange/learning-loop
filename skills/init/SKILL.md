---
name: init
description: 'First-time setup or upgrade for the learning-loop plugin. Configures vault path, persona voice, federation, CLAUDE.md integration, and verifies the installation. Safe to re-run -- detects existing state and skips completed steps.'
---

# Init -- Learning Loop Setup

Five-phase detect-confirm-apply flow. One question at a time. Safe to re-run -- detects existing state and skips completed steps.

All operations use Node.js (fs, path, child_process for binaries). No bash `find`, no shell commands for detection.

## Paths

`PLUGIN`, `PLUGIN_DATA`, and `VAULT` are injected by the session-start hook (see "Learning Loop Paths" in your context). Use those resolved values for ALL path references below. If not present, resolve them by running: `node <skill-base-dir>/scripts/resolve-paths.mjs`

---

## Phase 1: Detect and Summarize

Run all checks silently before asking anything. Use Node.js APIs:

1. **Platform:** `process.platform`, `process.arch`
2. **Config:** Read `PLUGIN_DATA/config.json` (fallback `PLUGIN/config.json`)
3. **Vault:** Read `vault_path` from config, verify directory exists via `fs.existsSync`, count `.md` files with `fs.readdirSync` (recursive)
4. **Folders:** Check for `0-inbox`, `1-fleeting`, `2-literature`, `3-permanent`, `4-projects`, `5-maps`, `_system`
5. **System files:** Check `_system/persona.md` and `_system/capture-rules.md` exist
6. **Binary:** Check `PLUGIN_DATA/bin/ll-search` exists; if so, run `ll-search version`
7. **Dependencies:** Run `node PLUGIN/scripts/check-deps.mjs`
8. **Search index:** If binary present, run `ll-search status`
9. **Federation config:** Check `PLUGIN_DATA/federation/config.json` exists. If it does, read it and note: identity (displayName, pubkey), hub endpoint, local peer count, visibility rules.
10. **Seed location:** Check if `.seed` exists in `PLUGIN/federation/` (legacy, needs migration) vs `PLUGIN_DATA/federation/` (correct). Flag if legacy seed found.
11. **Federation connectivity:** If federation config exists and has a hub endpoint, run the ll-search binary: `ll-search sync <db_path> <vault_path>`. This exports the local index, connects to the hub, uploads, and downloads peer indexes. Report what actually happened, not what you think should happen.
12. **CLAUDE.md:** Check if `~/.claude/CLAUDE.md` exists. If it does, check whether it contains a `## Learning Loop` section (search for `<!-- learning-loop v` version comment). Read the template version from `PLUGIN/templates/claudemd-section.version` (a single-line file containing the template version, e.g. `1`). Compare against the version in the user's comment tag. Note: present/missing/outdated (version mismatch).

Present a dashboard:

```
Learning Loop Setup

  Platform:      macOS (darwin arm64)
  Vault:         /path/to/vault (2,031 notes)
  Folders:       7/7 present
  System files:  persona + capture rules
  Binary:        ll-search v1.4.0 (installed)
  Dependencies:  all satisfied
  Search index:  2,031 notes indexed
  Federation:    configured (peer registered, hub connected)
  Hub sync:      working (1,200 notes exported, 1 peer downloaded)
  CLAUDE.md:     ~/.claude/CLAUDE.md (learning-loop section present)

Everything looks good. Nothing to set up.
```

**Federation status rules:**
- Only report what the connectivity test actually returned. Never infer or guess peer registration status.
- If sync succeeded: report note counts and peers downloaded.
- If sync failed with auth error: report "auth failed -- your pubkey may not be registered on the hub."
- If sync failed with connection error: report "hub unreachable -- check Tailscale and hub endpoint."
- If no federation config: report "not configured."
- Never tell the user that a remote peer "needs to register" you unless the hub explicitly rejected auth with that reason.

If everything is configured, stop here. If issues exist, proceed to the relevant phases only.

---

## Phase 2: Vault Setup

Only run sub-steps where detection found issues.

### 2a: Vault Path

**If config has valid vault_path:** Show path. Ask: "I found your vault at [path]. Is that right?"

**If not found:** Detect by walking home directory (max depth 4) looking for `.obsidian` directories using Node.js `fs.readdirSync` recursive walk. Present candidates. If none found, ask for the path manually.

Validate the path exists and contains `.md` files. Write to config.json (merge, never overwrite existing fields):
```json
{ "vault_path": "<chosen-path>" }
```

### 2b: Folders

List missing folders from the 7 required. If all present, skip.

If any missing, list them and ask: "Create the missing folders?" Create after confirmation.

Never rename or restructure existing folders.

### 2c: System Files

For each missing system file, write defaults after confirmation:

**`_system/persona.md`** -- Write the default voice (Hemingway + Musashi + Lao Tzu). Persona can be customized by editing `_system/persona.md` directly.

**`_system/capture-rules.md`** -- Write the standard rules:

```markdown
---
tags: [system]
---
# Capture Rules

## Always Capture

- Decisions made -- what was chosen, what was rejected
- Problems solved -- the problem, the fix, why it worked
- Patterns discovered or reused across projects
- Project state changes -- new dependency, architecture shift, major refactor
- Connections between projects -- shared patterns, shared problems

## Never Capture

- Dead ends that taught nothing
- Routine code changes -- typos, version bumps
- Anything explicitly discarded
- Unvalidated opinions
- Duplicate knowledge -- link or update, don't repeat

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

---

## Phase 3: Binary and Dependencies

Present a single confirmation covering all needed work:

```
Dependencies need installing. This will:
  - Download ll-search binary (~77MB)
  - Install packages (sql.js, no native deps)
  - Index your vault (~30s for 2,000 notes)

Proceed?
```

Only list items that are actually needed. After confirmation, run sequentially:

### 3a: Binary Download

Run the download script:

```bash
node PLUGIN/scripts/download-binary.mjs
```

This detects the platform and downloads the correct binary from GitHub releases. Extracts to `PLUGIN_DATA/bin/`, sets executable permission, and writes `.version`. Skips download if the installed version already matches.

### 3b: Verify Vendor Dependencies

Confirm `PLUGIN/vendor/sql-wasm.wasm` exists. All JS dependencies are vendored in `PLUGIN/vendor/` and require no npm install.

### 3c: Initial Vault Index

Run `ll-search index` to build the search index. Report progress.

### 3d: Plugin Dependencies

Run `node PLUGIN/scripts/check-deps.mjs`. For each missing dependency, present it and ask to install:

```
Missing dependency: episodic-memory
Required for: Cross-session conversation search
Install: claude plugin install episodic-memory@superpowers-marketplace
```

---

## Phase 4: Federation (Optional)

Ask: "Connect to other learning-loop users via interchange.live?"

**If no:** Skip to summary.

**If yes:** Ask: "Do you have an invite token?"

### 4a: No token path

If the user has no token, show:

```
You'll need an invitation to join the federation. Apply at:
  https://interchange.live/apply

Once your application is approved, you'll receive a redeem URL.
Re-run /learning-loop:init after you have it.
```

Skip to summary.

### 4b: Identity

The seed file MUST live in `PLUGIN_DATA/federation/.seed` (persists across plugin updates), NOT in `PLUGIN/federation/.seed` (gets wiped on reinstall).

**Migration check:** If `PLUGIN/federation/.seed` exists but `PLUGIN_DATA/federation/.seed` does not, migrate it:
1. Copy the seed to `PLUGIN_DATA/federation/.seed` (mode 0o600)
2. Delete the old one from the marketplace directory
3. Verify the pubkey matches `config.identity.pubkey` -- if not, warn and offer to update the hub

Generate Ed25519 keypair via `ll-search` (handles key generation and migration). Extract the raw 32-byte public key bytes for redemption (base64-encoded). If `.seed` already exists, reuse the existing key.

### 4c: Redeem

Ask for the token. POST to `https://interchange.live/api/redeem` with:

```json
{ "token": "<token>", "peer_id": "<peer_id>", "pubkey": "<base64-32-bytes>" }
```

The `peer_id` is bound to the token server-side — the user does not choose it. The redeem response returns the `peer_id` along with the headscale auth key and hub endpoint. Store these in memory for the rest of Phase 4. Do NOT write config yet — wait for the sync test to succeed.

Handle server errors:
- `404` -> "invalid token, check the URL you were sent"
- `409` -> "this token was already redeemed"
- `410` -> "this token has expired, contact robin for a new one"
- `502` -> "provisioning service is unreachable, try again later"

On any failure, exit Phase 4 without writing config.

### 4d: Network Connection

Check for Tailscale. If not installed, guide installation (brew for macOS, curl for Linux). Run:

```bash
tailscale up --auth-key <headscale_auth_key> --login-server https://hs.interchange.live
```

Verify with `tailscale status`. If it fails, the auth key may have expired (24-hour window) — surface the error and exit Phase 4 without writing config. The pubkey is already registered so re-running init should work.

### 4e: Visibility Rules

Present defaults:
- `3-permanent/` -> public (full content shared)
- `1-fleeting/` -> listed (title + tags + summary)
- Everything else -> private

Ask: "Does that work for you?" Allow pattern customization if not.

### 4f: Knowledge Graph Opt-in

Ask: "Would you like your public note titles to appear on the interchange.live knowledge graph? (This only shares titles of notes marked public or listed, no content.)"

If yes, set `"graph": true` in the generated config. If no, set `"graph": false`.

### 4g: Provenance Consent

Ask: "Share anonymized pipeline stats? (Tier 1: action counts only)"

### 4h: Write Config

Write `PLUGIN_DATA/federation/config.json` with identity (using the `peer_id` returned from 4c), visibility, `graph`, `share_provenance` fields, and hub endpoint from the redeem response.

### 4i: First Sync Test

Run `ll-search sync`. On success: report counts. On failure: the pubkey is registered but something else is wrong — surface the error and suggest re-running init.

**Key behavioural detail:** if Phase 1 detection found `PLUGIN_DATA/federation/config.json` already exists, Phase 4 is entirely skipped. The token prompt only fires on fresh federation setup, so existing peers re-running init are unaffected.

---

## Phase 5: CLAUDE.md Integration

CLAUDE.md tells Claude *how to behave* with the learning loop throughout a session. Without it, the plugin is installed but Claude does not know when to retrieve, how to capture, or when to suggest consolidation.

### Dependencies

Phase 5 requires outputs from earlier phases:

- **Vault path** (Phase 2a) -- used in the template. If vault path is not yet resolved, run 2a first.
- **System files** (Phase 2c) -- the template references `_system/capture-rules.md` and `_system/persona.md`. If either does not exist, omit the corresponding line from the template rather than referencing a missing file.
- **Folder structure** (Phase 2b) -- the template assumes `0-inbox/` and `4-projects/` exist. If they don't, omit the "Second Brain" section.

### 5a: Detect

Read the template version from `PLUGIN/templates/claudemd-section.version`. Then check three things:

1. Does `~/.claude/CLAUDE.md` exist at all?
2. If yes, does it contain `## Learning Loop`?
3. If yes, does the version comment `<!-- learning-loop v` match the current template version?

Four possible states:

| State | Action |
|-------|--------|
| No CLAUDE.md exists | Offer to create one (Phase 5b) |
| CLAUDE.md exists, no learning-loop section | Offer to append section (Phase 5c) |
| Section exists, version matches | Skip -- already configured |
| Section exists, version outdated | Offer to update section (Phase 5d) |

### 5b: New CLAUDE.md (prompt-driven generation)

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

### 5c: Append learning-loop section

Generate the section using the detected vault path and current template version. The template:

```markdown
## Learning Loop

<!-- learning-loop vX.Y -->

Three stores, three purposes:
- **Auto-memory** (~/.claude/projects/*/memory/) -- preferences, corrections, project context.
- **Obsidian vault** (VAULT_PATH) -- decisions, patterns, domain insights.
- **Episodic memory** (plugin) -- conversation history across sessions.

### Retrieval (every session)

On session start, the learning-loop plugin injects context. Act on it:
1. Read any auto-memories flagged as relevant by the hook.
2. Search episodic memory for relevant past conversations about the current topic/project.
3. Search the Obsidian vault for relevant knowledge notes.
4. Surface relevant findings concisely: `Recall: [insight]` or `Transfer: [insight from other project]`
5. Keep it to one line per insight. No walls of retrieval text.

### Capture (during work)

- **On correction**: Immediately save to auto-memory as feedback type. No delay, no batching.
- **On decisions**: When a non-obvious choice is made, note it -- either auto-memory (project context) or Obsidian (durable knowledge).
- **On patterns**: When a pattern spans projects, capture to Obsidian with cross-project links.
- **Mid-conversation insights**: Use `/learning-loop:quick-note` for insights worth keeping without breaking flow.
- Capture silently. Don't announce unless asked.

### Consolidation (end of session)

After substantial work, suggest `/learning-loop:reflect` to run the consolidation checkpoint. This routes learnings to the correct stores, cross-links projects, and promotes inbox notes.

### Second Brain (Obsidian)

Captures go to 0-inbox/ as atomic notes. Tag with source project. Link to the project index note in 4-projects/.

Follow the rules in _system/capture-rules.md. Read _system/persona.md for voice and tone.
```

**Template substitution:** Replace `VAULT_PATH` with the detected vault path. Replace `vX.Y` with the template version from `PLUGIN/templates/claudemd-section.version`.

**Conditional lines:** Before generating, check which system files and folders exist:
- If `_system/capture-rules.md` does not exist, remove the "Follow the rules in _system/capture-rules.md." line
- If `_system/persona.md` does not exist, remove the "Read _system/persona.md for voice and tone." line
- If both are missing, omit the entire last line of the "Second Brain" section
- If `0-inbox/` or `4-projects/` do not exist, omit the "Second Brain (Obsidian)" section entirely

Show the section and ask: "Where should the learning-loop section go?"

1. `~/.claude/CLAUDE.md` (user-level, applies to all projects) -- recommended
2. `.claude/CLAUDE.md` in the vault project directory (project-level, only when working in the vault)
3. Skip -- I'll add it myself later

Append to the end of the chosen file. Never reorder or modify existing content.

### 5d: Update outdated section

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

---

## Summary

After all phases complete, show final state:

```
Learning loop configured.

  Vault:       /path/to/vault (2,031 notes)
  Folders:     7/7 present
  Binary:      ll-search v1.4.0
  Search:      2,031 notes indexed
  Federation:  configured, 1 peer
  CLAUDE.md:   learning-loop section present

Run /learning-loop:help to see available commands.
```

---

## Rules

- One question at a time. Wait for the answer before moving on.
- Validate paths before writing config.
- Never overwrite existing vault files without asking.
- Never restructure an existing vault.
- Preserve existing config.json fields when updating -- read, merge, write.
- All detection via Node.js APIs. No `find`, no shell globbing.
- If any step fails, explain what went wrong and how to fix it.
- Works for: fresh install, existing vault + new plugin, or upgrade.
