# librarian-research

Local research engine. Brave search → fetch → local-Gemma claim extraction,
emitting a claims bundle. Keeps `/deep-research`'s token-heavy middle off Claude:
~15 source documents are distilled to one-line claims before anything reaches
Claude's context.

## CLI

```
node research.mjs --question "<q>" \
  [--angles '<json>'] [--model <m>] [--max-fetch <n>] [--json]
```

- `--angles` carries Claude's scope output: `[{"label":"...","query":"..."}]`.
  Without it, the question is used as a single angle.
- `--model` overrides the model. Default: `librarian.model` from config
  (which defaults to `gemma3:12b`). Must be research-capable (12b+) or the CLI
  refuses (exit 3).
- `--max-fetch` caps how many deduped URLs are fetched (default 15).
- `--json` prints the bundle to stdout; otherwise a temp-file path is printed.

## Output: claims bundle

```json
{
  "question": "...",
  "angles": [{ "label": "...", "query": "..." }],
  "sources": [
    {
      "url": "...",
      "title": "...",
      "sourceQuality": "primary|secondary|blog|forum|unreliable",
      "fetchOk": true
    }
  ],
  "claims": [
    { "claim": "...", "quote": "...", "url": "...", "importance": "central|supporting|tangential" }
  ],
  "skipped": [{ "url": "...", "reason": "http_402|timeout|fetch_error|..." }]
}
```

Source prose never enters the bundle — only distilled claims with verbatim
supporting quotes. That distillation is the token saving.

## Requirements

- Ollama running locally with a research-capable model pulled (default `gemma3:12b`).
- Brave API key in the macOS Keychain: `account=$USER`, `service="brave-search-api-key"`.

The model and `keep_alive` come from `librarian.*` config, shared with the
daemon, so one resident model serves both triage and research (no cold-boot
thrash). The model tier is chosen at `/init` from system RAM.

## Capability gate

Research needs real recall. On the e2b tier (16–32GB machines) the CLI refuses
(`researchModelOk` is false below 12b) and exits 3 with a message; triage still
runs and `/deep-research` falls back to its Claude-native path. The benchmark
(`bench.mjs`) showed e2b produces schema-valid output but misses substantive
claims, which is why the gate exists.

## Architecture

Search/fetch/extract run locally. Verify (3-vote adversarial) and synthesis stay
on Claude. See `docs/superpowers/specs/2026-06-16-librarian-research-design.md`.

## Integration with /deep-research

`/deep-research` is a built-in Workflow skill (generated per-run; no committed
source). The integration is a contract, not a code edit:

1. **Scope** (Claude) decomposes the question into angles.
2. **Shell out** (replaces the Search + Fetch + Extract phases):

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/librarian/research.mjs \
     --angles '<scope-json>' --question "<q>" --json
   ```

   The returned bundle's `claims` feed the next phases unchanged.

3. **Verify** (Claude) runs 3-vote adversarial verification over the claims.
4. **Synthesize** (Claude) writes the cited report.

**Fallback:** on a non-zero exit (exit 3 = sub-tier model; exit 1 = ollama/Brave
unavailable) or an empty `claims` array, `/deep-research` reverts to its
Claude-native WebSearch path so the command never hard-breaks. Warm the model
first for snappy runs — a cold 12b load adds ~10–40s to the first call;
`keep_alive` (default 30m) keeps it warm afterward.
