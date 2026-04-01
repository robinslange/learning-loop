---
name: init
description: 'First-time setup or upgrade for the learning-loop plugin. Configures vault path, persona voice, federation, and verifies the installation. Safe to re-run -- detects existing state and skips completed steps.'
---

# Init -- Learning Loop Setup

Four-phase detect-confirm-apply flow. One question at a time. Safe to re-run -- detects existing state and skips completed steps.

All operations use Node.js (fs, path, child_process for binaries). No bash `find`, no shell commands for detection.

Use `{{PLUGIN}}` for PLUGIN_ROOT and `{{PLUGIN_DATA}}` for the data directory (from `scripts/lib/config.mjs`).

---

## Phase 1: Detect and Summarize

Run all checks silently before asking anything. Use Node.js APIs:

1. **Platform:** `process.platform`, `process.arch`
2. **Config:** Read `{{PLUGIN_DATA}}/config.json` (fallback `{{PLUGIN}}/config.json`)
3. **Vault:** Read `vault_path` from config, verify directory exists via `fs.existsSync`, count `.md` files with `fs.readdirSync` (recursive)
4. **Folders:** Check for `0-inbox`, `1-fleeting`, `2-literature`, `3-permanent`, `4-projects`, `5-maps`, `_system`
5. **System files:** Check `_system/persona.md` and `_system/capture-rules.md` exist
6. **Binary:** Check `{{PLUGIN_DATA}}/bin/ll-search` exists; if so, run `ll-search version`
7. **Dependencies:** Run `node {{PLUGIN}}/scripts/check-deps.mjs`
8. **Search index:** If binary present, run `ll-search status`
9. **Federation config:** Check `{{PLUGIN_DATA}}/federation/config.json` exists. If it does, read it and note: identity (displayName, pubkey), hub endpoint, local peer count, visibility rules.
10. **Seed location:** Check if `.seed` exists in `{{PLUGIN}}/federation/` (legacy, needs migration) vs `{{PLUGIN_DATA}}/federation/` (correct). Flag if legacy seed found.
11. **Federation connectivity:** If federation config exists and has a hub endpoint, run the ll-search binary: `ll-search sync <db_path> <vault_path>`. This exports the local index, connects to the hub, uploads, and downloads peer indexes. Report what actually happened, not what you think should happen.

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

**`_system/persona.md`** -- Write the default voice (Hemingway + Musashi + Lao Tzu). Persona customization is handled by `/learning-loop:persona`, not here.

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
  - Download ll-search binary (~50MB)
  - Install packages (sql.js, no native deps)
  - Index your vault (~30s for 2,000 notes)

Proceed?
```

Only list items that are actually needed. After confirmation, run sequentially:

### 3a: Binary Download

Run the download script:

```bash
node {{PLUGIN}}/scripts/download-binary.mjs
```

This detects the platform and downloads the correct artifact. If federation is configured (seed + config exist), it downloads from the hub using Ed25519 auth. Otherwise, falls back to `gh` CLI (handles private repo auth). Extracts to `{{PLUGIN_DATA}}/bin/`, sets executable permission, and writes `.version`.

### 3b: Verify Vendor Dependencies

Confirm `{{PLUGIN}}/vendor/sql-wasm.wasm` exists. All JS dependencies are vendored in `{{PLUGIN}}/vendor/` and require no npm install.

### 3c: Initial Vault Index

Run `ll-search index` to build the search index. Report progress.

### 3d: Plugin Dependencies

Run `node {{PLUGIN}}/scripts/check-deps.mjs`. For each missing dependency, present it and ask to install:

```
Missing dependency: episodic-memory
Required for: Cross-session conversation search
Install: claude plugin install superpowers@claude-plugins-official
```

---

## Phase 4: Federation (Optional)

Ask: "Connect to other learning-loop users?"

**If no:** Skip to summary.

**If yes:** Walk through each sub-step with one confirmation each:

### 4a: Identity

The seed file MUST live in `{{PLUGIN_DATA}}/federation/.seed` (persists across plugin updates), NOT in `{{PLUGIN}}/federation/.seed` (gets wiped on reinstall).

**Migration check:** If `{{PLUGIN}}/federation/.seed` exists but `{{PLUGIN_DATA}}/federation/.seed` does not, migrate it:
1. Copy the seed to `{{PLUGIN_DATA}}/federation/.seed` (mode 0o600)
2. Delete the old one from the marketplace directory
3. Verify the pubkey matches `config.identity.pubkey` -- if not, warn and offer to update the hub

Generate Ed25519 keypair via `ll-search` (the Rust binary handles key generation and migration). Display public key. If `.seed` already exists, show existing key and ask keep/regenerate.

### 4b: Network Connection

Check for Tailscale. If not installed, guide installation (brew for macOS, curl for Linux). Ask for Headscale auth key (provided by the hub admin). Connect to the coordination server. Verify with `tailscale status`.

If no auth key available, skip -- they can re-run init later.

### 4b.1: Hub Registration

The hub requires manual peer registration by the hub admin. There is no self-registration endpoint.

After generating the identity in 4a, display the pubkey and instruct the user:

```
Your public key: ed25519:SvMMcogkaIkiuhxU7BeBkW77KvXBizV8mSYhVGzUrGo=

Send this key to the hub admin. They will register you on the hub.
You can re-run /learning-loop:init to test connectivity once registered.
```

Do not attempt to register the peer on the hub. Do not claim registration succeeded unless a sync test (step 11 in Phase 1) actually succeeds.

### 4c: Visibility Rules

Present defaults:
- `3-permanent/` -> public (full content shared)
- `1-fleeting/` -> listed (title + tags + summary)
- Everything else -> private

Ask: "Does that work for you?" Allow pattern customization if not.

### 4d: Provenance Consent

Ask: "Share anonymized pipeline stats? (Tier 1: action counts only)"

### 4e: Write Config

Write `{{PLUGIN_DATA}}/federation/config.json` with identity, visibility, peers, and `share_provenance` field.

### 4f: First Export and Test

Run `ll-search export-index`. Report counts. If network is connected, attempt a sync test. If sync fails with an auth error, this likely means the hub admin hasn't registered the peer yet -- say so clearly and suggest re-running init after registration.

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
