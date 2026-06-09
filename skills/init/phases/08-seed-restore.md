# Phase 8: Seed restore + harvest deny-list

Two setup steps for instance portability. Both are safe to skip on a standalone instance.

## A. Restore a seed bundle (optional)

Check the current working directory (and ask the operator for a path) for a `seed-bundle-*/` produced by `/learning-loop:seed` on another instance.

If found and the operator confirms:
1. Copy `memory/*` into this instance's auto-memory dir. Resolve it mechanically:
   ```
   node -e "import('PLUGIN/scripts/lib/memory-paths.mjs').then(m=>console.log(m.resolveMemoryDir(process.env.CLAUDE_PROJECT_DIR)))"
   ```
2. Copy `_system/*` into `VAULT/_system/`.
3. Merge `CLAUDE-portable.md` into this instance's `~/.claude/CLAUDE.md` (append under a clear heading; do not clobber existing content).
4. Rebuild `MEMORY.md` from scratch from the restored memory files using the SAME format `/learning-loop:dream` Phase 4 uses: one `- [filename.md](filename.md): description` line per file, grouped by topic, under 150 chars per line, excluding `MEMORY.md`/`_dream_log.md`/`_archived/`. Do NOT copy any index from the bundle.
5. Report what was restored.

If no bundle is present, say so and continue — this is normal for a first instance.

## B. Seed the harvest deny-list (always)

Harvest (`/learning-loop:harvest`) will never let a note leave this instance if it contains a deny-listed IP term. Seed that list now.

Prompt the operator: "If this instance is for work or a context with IP that must never leave, list the terms harvest should hard-block (company name, product names, internal codenames, email domains). One per line. Leave blank for a personal instance."

The deny-list matches on word boundaries treating `-` and `_` as boundaries, so list **each compound form explicitly** — e.g. list both `acme` AND `acme-registry`, not just `acme`. A bare term will not catch its hyphenated or underscored compounds.

Write the answers to the path resolved by `DATA_FILES.harvestDenylist(PLUGIN_DATA)` (i.e. `PLUGIN_DATA/.harvest-denylist`), one term per line, `#` for comments. Resolve it mechanically:
```
node -e "import('PLUGIN/scripts/lib/paths.mjs').then(m=>console.log(m.DATA_FILES.harvestDenylist(process.argv[1])))" "<PLUGIN_DATA>"
```
If blank, write the file with only a comment header so harvest finds an (empty) list rather than erroring. Note: harvest ALSO merges mechanically-derived instance facts (peer ids, pubkey, configured email domains) at scrub time, so an empty hand-list is not the same as no protection.
