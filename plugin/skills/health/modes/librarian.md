# Librarian Review Mode (`--librarian`)

Executed by /health --librarian; see SKILL.md.

If `--librarian` flag is present, skip all vault health checks and enter librarian review mode.

**Step L1: Load Queue**

Read `PLUGIN_DATA/librarian/queue.jsonl`. Parse all lines. Filter to `status === 'pending'`. If no pending items, report "No pending librarian observations." and stop.

**Step L2: Phase 1: Advisory Review**

Group pending items into link suggestions, tag suggestions, voice flags, and duplicate flags. Each subsection is independent: present and resolve one at a time.

**Link suggestions:**
Present in a table grouped by confidence:

```
High confidence (N):
  Orphan                                    → Suggested link                           Reason
  3-permanent/cadences-are-harmonic...      → 3-permanent/chord-progressions-are...    Both discuss harmonic function
  ...

Review (N):
  Orphan                                    → Suggested link                           Reason
  ...
```

Ask user: "Apply approved links? Enter numbers to approve (e.g., '1,3,5'), 'all-high' for all high-confidence, or 'skip'."

For each approved link suggestion:

1. Read the target (orphan) note
2. Append `\n\n[[suggested-note-slug]]` to the note body using Edit tool
3. Update queue item status to `approved`

For rejected items, update status to `rejected`.

**Tag suggestions:**
Present as a table:

```
Tag suggestions (N):
  Target                                    Existing tags    Suggested tags
  3-permanent/ginkgo-biloba-acute-pk...     nootropic        pharmacology, neuroscience
  ...
```

Ask user: "Apply tag suggestions? Enter numbers, 'all', or 'skip'."

For each approved tag suggestion:

1. Read the target's frontmatter
2. Merge `suggested_tags` into the existing `tags:` list (dedupe)
3. Write the updated frontmatter back via Edit
4. Update queue item status to `approved`

For rejected items, update status to `rejected`.

**Voice flags:**
Present as a list:

```
Voice flags (N):
  0-inbox/gmail-multi-daemon-pull-dedup...  "gmail multi daemon pull deduplication": Names a topic without stating a claim
  ...
```

These are advisory: present them for awareness. Ask: "Acknowledge voice flags? (y/n)": on yes, update all to `acknowledged`.

**Duplicate flags:**
Present as a list:

```
Duplicate flags (N):
  1. 0-inbox/foo-claim.md  ↔  3-permanent/foo-claim-original.md  (similarity 0.93)
  ...
```

For each, ask the user to choose one of: `merge` (read both, decide which to keep, the user does the merge), `link` (add a wikilink between them: drop a `[[other]]` reference into the newer note's body), `dismiss`. Update queue item status to `merged`, `linked`, or `dismissed`.

**Step L3: Phase 2: Staleness Suspects**

Present staleness suspects:

```
Staleness suspects (N):
  3-permanent/react-compiler-memoizes...    90 days old, matched: v1.0, October 2025
  ...
```

Ask: "Investigate staleness suspects? Enter numbers (e.g., '1,2'), 'all', or 'skip'."

For each selected suspect, Claude (the active model) investigates using available tools:

- Read the note content
- Check if version references are still current (web search if needed)
- Check if specific claims are still accurate
- Report findings inline

After investigation, ask user what to do with each: "update", "dismiss", or "flag for /deepen".

**Step L4: Cleanup**

After both phases:

1. Expire processed/old items: `node -e "import('${CLAUDE_PLUGIN_ROOT}/scripts/librarian/queue.mjs').then(m => m.expireStaleItems('VAULT_PATH'))"` (replace `VAULT_PATH` with the resolved vault path; `expireStaleItems(vaultPath)` lives at `scripts/librarian/queue.mjs`)
2. Reset librarian state to allow re-investigation: `node -e "import('${CLAUDE_PLUGIN_ROOT}/scripts/librarian/queue.mjs').then(m => m.resetState())"`
3. Report summary: "Processed N items: X links applied, Y tags applied, V voice flags acknowledged, D duplicates resolved, Z suspects investigated."

Then stop (do not proceed to Step 1).
