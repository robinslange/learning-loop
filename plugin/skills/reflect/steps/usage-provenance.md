# Step 4.7: Retrieval Usage Provenance

Close the surfacing→use loop: for every vault note that retrieval surfaced to
this session, record whether the session actually engaged with it. These
events are what `/health`'s "frequently surfaced, never used" check aggregates
— without them the telemetry can only count surfacing.

Run this step on every `/reflect`, even when Step 4.6 was skipped (a session
that wrote no notes can still have used or ignored its injected context).
All commands run silently.

## 4.7.a: Gather surfaced notes

```bash
LL_SID=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" SESSION_ID)
node "${CLAUDE_PLUGIN_ROOT}/scripts/retrieval-report.mjs" --session-surfaced "$LL_SID"
```

Output is a JSON array of `{path, via, level?}`:

- `via: ["injected"]` — the note (or a pointer to it) was placed in your
  context at session start by the injection hook. `level: "pointer"` means
  only the title/path was shown; `level: "body"` means the note body was
  injected.
- `via: ["retrieved"]` — the note ranked in the top results of a
  `vault-search` query this session (excluding the Step 2.5 reflect-scan, which
  is filtered from the surfacing ledger because it is the pipeline scanning
  itself, not a retrieval surfaced to a session).

If the array is empty, skip to the next step — emit nothing.

Known gap, accept it: the injected record keeps only the session's most recent
injection burst (the dedupe state is pruned on write), so earlier injections
in the same session may be missing. The durable injections ledger captures the
burst at the time of the report run, but any burst that came and went before a
sync ran is gone permanently. Classify what the list gives you; do not
reconstruct paths from memory.

## 4.7.b: Classify each note as used or ignored

A note is **used** only if at least one of these happened in THIS session:

- **read** — you personally opened the note's content (Read tool or `cat`).
  Pipeline-mandated reads do NOT count: the Step 3 duplicate-check read is a
  system operation required by the reflect workflow, not engagement — do not
  count it as a 'read' signal.
- **edited** — the note itself was edited or refined this session (it appears
  in the reflect new-notes marker, was a Step 4.6 refinement target, or you
  ran Write/Edit on it directly with intent to improve it).
- **linked** — a wikilink to the note was written by you in a note this session.
  Autolink-hook-appended links do NOT count: the autolink hook mechanically
  appends `[[wikilinks]]` to every new note after write; those links are
  machine-generated, not authored engagement. To distinguish: check whether the
  link appears in the note body you dictated vs. a trailing autolink block you
  did not write. When in doubt, do not count it.

Everything else is **ignored**. Honesty rules — these keep the downstream
report meaningful:

- Injection alone is never use. A note body sitting in your context at
  session start counts as ignored unless one of the three signals above also
  fired. Same for a `level: "pointer"` entry you never opened.
- Appearing in search results is never use. Parsing reflect-scan similarity
  scores does not make the matched notes used — only reading/editing/linking
  them does.
- Machine-generated signals are never use. Hook-chain-triggered reads (duplicate
  gate, edge-infer scan) and autolink-appended wikilinks fire without model
  engagement and must be excluded.
- When unsure, classify as ignored. A false "used" poisons the
  surfaced-never-used candidate list; a false "ignored" merely delays it.

## 4.7.c: Emit one provenance event per surfaced note

For each note from 4.7.a, emit (vault-relative path, exactly as returned):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"reflect","skill":"reflect","action":"note-usage","target":"<path>","status":"used","signals":["read","linked"],"surfaced_via":["injected"]}'
```

- `status`: `"used"` or `"ignored"`.
- `signals`: the subset of `["read","edited","linked"]` that fired; `[]` when
  ignored.
- `surfaced_via`: the `via` array from 4.7.a.

Batch the emissions in a single Bash call (one `provenance-emit.js` line per
note) to avoid N round-trips.

## 4.7.d: Fold into the Step 5 report

Add one line to the Step 5 summary:

```
Retrieval usage: N used / M ignored of K surfaced
```

Omit the line when nothing was surfaced.
