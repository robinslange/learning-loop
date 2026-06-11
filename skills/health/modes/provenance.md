# Provenance Mode

Executed by /health --provenance; see SKILL.md.

If `--provenance` flag is present, skip all vault health checks and run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/provenance-report.mjs
```

Display the output directly.

If the report includes a **Recommendations** section, present each recommendation and ask:

> Which of these would you like to act on? Options:
>
> - "N" to act on recommendation N
> - "pattern N" to create a learned pattern from recommendation N
> - "all" to review all recommendations
> - "done" to finish

When user selects "pattern N", draft a positive behavior-based pattern following the format in `PLUGIN_DATA/provenance/learned-patterns.md` (where PLUGIN_DATA = `CLAUDE_PLUGIN_DATA` env or `~/.claude/plugins/data/learning-loop`) and present for approval before writing.

After the local report, check for peer provenance data:

1. Read `PLUGIN_DATA/federation/provenance-peers.json` (where PLUGIN_DATA = `CLAUDE_PLUGIN_DATA` env or `~/.claude/plugins/data/learning-loop`)
2. If exists and has peer entries, display a **Network** section:

```
Network (last 7 days):
  peer-a:   12 sessions, 47 notes, 3 fixes
  peer-b:   5 sessions, 12 notes, 1 fix
```

3. If no peer data exists, show: "No peer provenance data. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/vault-search.mjs sync` to fetch."

Then stop (do not proceed to Step 1).
