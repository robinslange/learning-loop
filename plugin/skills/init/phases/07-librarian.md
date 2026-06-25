# Phase 7: Librarian (Optional)

Background agent that continuously maintains your vault locally via ollama (free, private, no API calls). Finds orphan notes that should be linked, flags topic-style titles, and marks potentially stale claims. On a capable machine it can also run local web research (claim extraction for `/learning-loop:research`). An optional cloud provider (7d) can additionally offload the research **Verify** phase off the Claude budget.

The model is chosen by **tier** from system RAM, so one resident model serves both triage and research without cold-boot thrash:

- **≥32GB RAM → `gemma3:12b`** (~8.9GB resident): triage **and** local research.
- **16–32GB RAM → `gemma4:e2b`** (~7.2GB resident): triage only; `/learning-loop:research` runs but its Verify/Synthesize stay on Claude and, below the research tier, it routes to its own Claude-native WebSearch fallback.
- **<16GB RAM →** librarian skipped.

## 7a: Detect

Use Phase 1's librarian detection results (ollama presence, RAM, configured tier):

- If `librarian.enabled` is already `true` in config: skip with "Librarian: already enabled."
- If ollama not installed or RAM < 16GB: skip with "Librarian: skipped (requires ollama + 16GB+ RAM)."
- Otherwise determine the tier from RAM (≥32GB → `gemma3:12b`; 16–32GB → `gemma4:e2b`) and proceed to 7b.

## 7b: Confirm

Present (substitute the detected tier and RAM):

> The librarian is a background agent that continuously maintains your vault:
>
> - Finds orphan notes that should be linked to their neighbors
> - Flags topic-style titles in inbox notes
> - Marks potentially stale claims for investigation
> - (12b tier only) Runs local web research for `/learning-loop:research`, keeping search/fetch/extract off your Claude token budget
>
> Detected <RAM>GB → recommended model: **<tier model>**. It runs locally via ollama
> (free, private), stays resident across triage + research, and starts automatically
> when `ll-watch` runs.
>
> Enable the librarian with <tier model>? (Or choose `gemma4:e2b` for a lighter
> footprint — triage only, research uses Claude.)

Let the user override the tier. The model they confirm is `<chosen model>` below.

## 7c: Setup

On confirmation:

1. **Pull model** (if not already pulled):

   ```bash
   ollama pull <chosen model>
   ```

   Show progress. Download is ~7GB (`gemma4:e2b`) / ~8GB (`gemma3:12b`); resident footprint ~7.2GB / ~8.9GB.

2. **Update config:** Merge into config.json (don't overwrite):
   - `librarian.enabled: true`
   - `librarian.model: "<chosen model>"`

   This `librarian.model` value is the single source of truth — the daemon and the research CLI both read it.

3. **Verify:** Run a test classification to confirm the model works:

   ```bash
   curl -s http://localhost:11434/api/generate -d '{"model":"<chosen model>","prompt":"Classify: is this a topic or an insight? Title: cadences-are-harmonic-punctuation","stream":false}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('response','')[:200])"
   ```

   If this returns a sensible response, report: "Librarian enabled (<chosen model>). It will start when `ll-watch` runs." On the 12b tier add: "Local research is available for `/learning-loop:research` (Search + Fetch + Extract run locally, off your Claude budget)." On the e2b tier add: "Research uses Claude; the librarian handles vault triage."
   If it fails, report the error and suggest: "Model may still be loading. Try re-running /init in a minute."

## 7d: Verify offload (optional, advanced)

`/learning-loop:research` runs an adversarial 3-vote **Verify** phase. By default Verify runs on Claude. You can offload it to an OpenAI-compatible cloud model (e.g. GLM-5.2 via Fireworks) so the whole token-heavy Verify step leaves the Claude budget too — the local librarian only does Search/Fetch/Extract, this does Verify. Claims with a resolvable id (PubMed/DOI/arXiv) are still checked deterministically with no model at all.

This is **opt-in and separate from the Ollama tier** — it needs an API key, so only offer it if the user wants cloud-assisted verification. With no provider configured, Verify falls back to Claude automatically (no action needed; this is the safe default).

**Only run 7d if** Phase 1 found no `librarian.provider` of `kind: openai` AND the user expresses interest. Otherwise skip silently — the Claude fallback is fully functional.

### 7d-i: Confirm

> Verify currently runs on Claude. Want to offload it to a cloud model (GLM-5.2 via Fireworks) to keep it off your Claude budget? This needs a Fireworks API key stored in your macOS Keychain. With no provider set, Verify just runs on Claude (the default — nothing breaks). Set this up? (y/N)

If no: skip. If yes:

### 7d-ii: Key

Ask the user for their Fireworks API key (or confirm one already exists). Store it in the macOS Keychain under a service name they choose (default `fireworks-api-key`), account = `$USER` — never write the key into config.json:

```bash
security add-generic-password -a "$USER" -s "fireworks-api-key" -w "<key>" -U
```

Confirm it resolves:

```bash
security find-generic-password -a "$USER" -s "fireworks-api-key" -w >/dev/null && echo "key resolves"
```

### 7d-iii: Config

Merge a `provider` block into the existing `librarian` config (don't overwrite siblings). The key lives in the Keychain; only its service-name **reference** goes in config:

```json
"librarian": {
  "provider": {
    "kind": "openai",
    "base_url": "https://api.fireworks.ai/inference",
    "model": "accounts/fireworks/models/glm-4p6",
    "api_key_ref": "fireworks-api-key"
  }
}
```

- `base_url` is the OpenAI-compatible host root (the client appends `/v1/chat/completions`). Fireworks: `https://api.fireworks.ai/inference`.
- `model` is the provider's model id — confirm the exact current GLM id with the user; the value above is an example.
- `api_key_ref` must match the Keychain service name from 7d-ii.

### 7d-iv: Verify

Confirm the provider resolves and answers (this hits the cloud API, so it costs a token or two):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/librarian/verify.mjs <<'JSON'
{"question":"is water wet?","claim":{"claim":"water is wet","quote":"water is wet","sourceUrl":"https://example.com","sourceQuality":"reliable"}}
JSON
```

- Exit 0 with a `{verdicts,survives,...}` JSON line → "Verify offload enabled (GLM). `/learning-loop:research` will run Verify off your Claude budget."
- Exit 3 ("no openai provider configured") → the config didn't take; re-check the `provider.kind` is `openai` and config.json is valid.
- Exit 1 (provider/network error) → report stderr; the key may be wrong or the model id stale. Note that `/research` still works — it falls back to Claude verification on any provider failure.
