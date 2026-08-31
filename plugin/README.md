# learning-loop — operator reference

This file ships with the plugin, so it is readable at
`${CLAUDE_PLUGIN_ROOT}/README.md` on an installed machine. It covers the
controls an operator needs without a network round-trip: turning parts off,
and removing the plugin. The full project documentation — architecture, the
hook roster, federation, troubleshooting — lives in the repository at
<https://github.com/robinslange/learning-loop>.

## Disabling parts without uninstalling

### One hook, or a few (`hooks.disabled`)

Add the hook's name to `hooks.disabled` in
`~/.claude/plugins/data/learning-loop-learning-loop-marketplace/config.json`:

```json
{
  "hooks": {
    "disabled": ["session-label", "post-search-tracking"]
  }
}
```

The names are the hook script basenames in `${CLAUDE_PLUGIN_ROOT}/hooks/`:

| Name                  | Event           | What turning it off costs                            |
| --------------------- | --------------- | ---------------------------------------------------- |
| `session-start`        | SessionStart    | No retrieval protocol, memory indexes, or intentions |
| `session-label`        | UserPromptSubmit| No just-in-time vault injection or session labelling  |
| `pre-write-check`      | PreToolUse      | No duplicate/frontmatter gate before a vault write    |
| `web-guard`            | PreToolUse      | Web research is no longer routed through the gateway  |
| `post-tool`            | PostToolUse     | No autolink, edge inference, or provenance tracking   |
| `post-read-retrieval`  | PostToolUse     | Vault reads stop being recorded as retrieval          |
| `post-search-tracking` | PostToolUse     | No episodic-query log, no superseded-pattern warning  |
| `stop-nudge`           | Stop            | No end-of-session consolidation nudge                 |
| `subagent-stop`        | SubagentStop    | Subagent results stop appearing in provenance         |

A disabled hook exits before reading its input and writes nothing to stdout,
which every registered event reads as "no opinion" — a disabled `PreToolUse`
hook allows the tool rather than blocking it. Edit `config.json` directly:
it lives in plugin *data*, so it survives plugin updates. Do not hand-edit
`hooks.json` inside the plugin cache — that file is overwritten on update.

An unrecognised name is ignored, and a `disabled` value that is not an array
disables nothing. Both fail open on purpose: a typo in this file must not
silently take the gate down.

### Every hook, from every plugin (`disableAllHooks`)

To silence hooks without touching learning-loop's config, set
`"disableAllHooks": true` in `~/.claude/settings.json`. This is the blunt
instrument — it disables every plugin's hooks, not just this one — and it is
the mechanism Claude Code itself exposes. Prefer `hooks.disabled` above when
you want learning-loop specifically.

Claude Code's `permissions.deny` array accepts tool-name rules (`Bash(...)`,
`Read(...)`, `WebFetch`, etc.); there is no per-hook deny matcher at this
Claude Code version. See the
[permissions documentation](https://docs.anthropic.com/en/docs/claude-code/settings)
for the current syntax.

### The local model (`librarian`)

The librarian offloads consolidation work to a local Ollama model. It is off
unless `librarian.enabled` is exactly `true` in the same `config.json`; any
other value, including a missing key, leaves it off.

### Network egress (`LL_OFFLINE`)

Set `LL_OFFLINE=1` to suppress every network call the plugin initiates on its
own: the SessionStart update poll, the binary auto-update download, and
web-research source fetches. Localhost is never gated, so a local Ollama model
keeps working. `/learning-loop:doctor` reports an **Offline mode: ON** line so
you can confirm the suppression engaged.

## Uninstall

Run `/learning-loop:uninstall` for a guided version, or do it by hand:

```bash
/plugin                                    # remove via the marketplace UI
claude mcp remove episodic-memory          # only if no other plugin uses it — check: claude mcp list
rm -rf ~/.claude/plugins/data/learning-loop-learning-loop-marketplace/  # purge captured indexes
```

The third step is irreversible: it deletes the edges database, provenance and
retrieval logs, and session markers. Your vault and your auto-memory files are
not touched.
