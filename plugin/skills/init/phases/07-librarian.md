# Phase 7: Librarian (Optional)

Background agent that continuously maintains your vault using Gemma 4 E2B via ollama. Finds orphan notes that should be linked, flags topic-style titles, and marks potentially stale claims. Runs locally (free, private, no API calls). Requires ~5GB RAM while active.

## 7a: Detect

Use Phase 1's librarian detection results:

- If `librarian.enabled` is already `true` in config: skip with "Librarian: already enabled."
- If ollama not installed or RAM < 16GB: skip with "Librarian: skipped (requires ollama + 16GB+ RAM)."
- If ollama installed and RAM sufficient: proceed to 7b.

## 7b: Confirm

Present:

> The librarian is a background agent that continuously maintains your vault:
>
> - Finds orphan notes that should be linked to their neighbors
> - Flags topic-style titles in inbox notes
> - Marks potentially stale claims for investigation
>
> It runs Gemma 4 E2B locally via ollama (free, private, ~5GB RAM while active).
> It starts automatically when `ll-watch` runs and stops when the watcher stops.
>
> Enable the librarian?

## 7c: Setup

On confirmation:

1. **Pull model** (if not already pulled):

   ```bash
   ollama pull gemma4:e2b
   ```

   Show progress. This is an ~8GB download.

2. **Update config:** Set `librarian.enabled: true` in config.json (merge, don't overwrite).

3. **Verify:** Run a test classification to confirm the model works:

   ```bash
   curl -s http://localhost:11434/api/generate -d '{"model":"gemma4:e2b","prompt":"Classify: is this a topic or an insight? Title: cadences-are-harmonic-punctuation","stream":false}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('response','')[:200])"
   ```

   If this returns a sensible response, report: "Librarian enabled. It will start when `ll-watch` runs."
   If it fails, report the error and suggest: "Model may still be loading. Try re-running /init in a minute."
