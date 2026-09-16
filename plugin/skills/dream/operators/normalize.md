# DATE NORMALIZE -- Fix Relative Dates

Converts relative temporal references to absolute ISO-8601 dates. The decision
is mechanical, so it belongs to `scripts/dream-normalize.mjs` rather than to
judgement: across five runs this operator matched 44 times and applied zero
conversions, and the run that did apply its matches turned "in the data model
today" into "in the data model 2026-08-05".

## Execution

Run the script over the flagged files. It anchors each file to that file's own
modification date, converts only references resolving to exactly one calendar
day, and leaves everything else untouched.

```bash
ll-run dream-normalize.mjs FILE.md [MORE.md ...]
```

That is a dry run: one line per convertible reference, nothing written. Re-run
with `--apply` to write the conversions:

```bash
ll-run dream-normalize.mjs FILE.md [MORE.md ...] --apply
```

## What it converts, and what it refuses

Converted: `yesterday`, `tomorrow`, `N days ago`, `N weeks ago` (digits or
small words such as "two"), and `last` / `next <weekday>`.

Refused on purpose: tense-words (`today`, `currently`, `recently`), quoted and
backticked text, any line already carrying an ISO date, the `->` conversion
records in `_dream_log.md`, fenced code, frontmatter, and a bare week span,
which names seven candidate days rather than one.

Do not hand-edit a date the script declined. It declined because the reference
does not resolve to a single day, and guessing there changes what the note
claims rather than clarifying it.

## Log format

Record the script's output verbatim:

```markdown
### DATE NORMALIZE
- `filename.md`: "last Thursday" -> "2026-03-20"
```

Emit provenance after the run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"dream","skill":"dream","action":"normalize","target":"FILENAME"}'`
