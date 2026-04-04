# RESOLVE — Handle Contradictions

Processes memory pairs that assert opposite rules or facts about the same subject.

## Execution

For each contradictory pair:

1. Read both files fully. Identify the specific claim that conflicts.

2. Classify the contradiction type:
   - **Temporal**: one was true before, the other is true now (e.g., "project uses SQLite" vs "project uses Postgres" after a migration). Resolution: update the newer memory to include the transition ("migrated from SQLite to Postgres on YYYY-MM-DD"), archive the older.
   - **Preference reversal**: user changed their mind (e.g., "prefer tabs" then later "prefer spaces"). Resolution: keep only the newer preference. Archive the older.
   - **Genuine conflict**: both might still be true in different contexts (e.g., "use gt submit" for Kinso vs "use git push" for personal projects). Resolution: do NOT merge. Add a `context:` line to each memory clarifying when it applies. Log the disambiguation.
   - **Unresolvable**: can't determine which is correct without user input. Resolution: flag in report, do not modify either file.

3. For temporal and preference-reversal resolutions, note the archived memory's confidence tier in the log.

4. Log every resolution with the contradiction type and action taken.

## Log format

```markdown
### RESOLVE
- `feedback_x.md` vs `feedback_y.md` [temporal] -> updated feedback_y.md, archived feedback_x.md
  - Conflict: "use SQLite" vs "use Postgres"
  - Resolution: migration happened 2026-03-15, kept newer
```

Emit provenance after each operation: `PLUGIN/scripts/provenance-emit.js '{"agent":"dream","action":"resolve","target":"FILENAME"}'`
