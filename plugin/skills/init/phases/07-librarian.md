# Phase 7: Librarian (Optional)

Background agent that continuously maintains your vault locally via ollama (free, private, no API calls). Finds orphan notes that should be linked, flags topic-style titles, and marks potentially stale claims. On a capable machine it can also run local web research (claim extraction for `/deep-research`).

The model is chosen by **tier** from system RAM, so one resident model serves both triage and research without cold-boot thrash:

- **≥32GB RAM → `gemma3:12b`** (~8.9GB resident): triage **and** local research.
- **16–32GB RAM → `gemma4:e2b`** (~7.2GB resident): triage only; research falls back to `/deep-research`'s Claude-native path.
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
> - (12b tier only) Runs local web research for `/deep-research`, keeping it off your Claude token budget
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

   Show progress. `gemma4:e2b` is ~8GB; `gemma3:12b` is ~8GB.

2. **Update config:** Merge into config.json (don't overwrite):
   - `librarian.enabled: true`
   - `librarian.model: "<chosen model>"`

   This `librarian.model` value is the single source of truth — the daemon and the research CLI both read it.

3. **Verify:** Run a test classification to confirm the model works:

   ```bash
   curl -s http://localhost:11434/api/generate -d '{"model":"<chosen model>","prompt":"Classify: is this a topic or an insight? Title: cadences-are-harmonic-punctuation","stream":false}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('response','')[:200])"
   ```

   If this returns a sensible response, report: "Librarian enabled (<chosen model>). It will start when `ll-watch` runs." On the 12b tier add: "Local research is available for `/deep-research`." On the e2b tier add: "Research uses Claude; the librarian handles vault triage."
   If it fails, report the error and suggest: "Model may still be loading. Try re-running /init in a minute."
