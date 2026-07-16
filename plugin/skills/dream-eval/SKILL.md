---
name: dream-eval
description: 'measure whether a /dream pass helps, hurts, or ties against no consolidation. usage: /learning-loop:dream-eval --mode={single|control|repeated} [--passes=N] [--mine]. single scores pre/post on the live corpus; control forks two clones and dreams one; repeated dreams a clone N times and plots the drift + content-survival curve.'
---

# Dream Eval: Measure a Consolidation Pass

## Overview

wraps /dream without changing it, and answers three questions with a number: did this pass help, is /dream better than no consolidation at all, and does it degrade the corpus over repeated passes. report-only. control mode is the one that matters most: on a low-redundancy corpus the published prior says consolidation only ties raw retrieval, so proving it locally is the point.

## Argument Parsing

| Input | Mode | Passes | Mine first |
| --- | --- | --- | --- |
| `/learning-loop:dream-eval` | single | n/a | no |
| `/learning-loop:dream-eval --mode=control` | control | n/a | no |
| `/learning-loop:dream-eval --mode=repeated --passes=5` | repeated | 5 | no |
| `/learning-loop:dream-eval --mine` | (mode) | | yes |

## Steps

1. acquire the dream lock first, before any mining or mode run, using Bash: `node "${CLAUDE_PLUGIN_ROOT}/scripts/marker.mjs" lock-acquire dream`. exit 0 means proceed. exit 1 means another /dream or dream-eval run is active (or a crashed one less than an hour old), so stop and tell the user. exit 2 means a usage or install error, report the stderr message and abort.
2. if `probes.jsonl` is absent and `--mine` was not passed, stop and say: "no probe corpus found. run with --mine first." (release the lock before stopping, see step 6).
3. if `--mine`, run the probe miner (forward + reverse) and persist to probes.jsonl.
4. run the chosen mode. the retrieval function is an in-session Task dispatch: given the question and the MEMORY.md index, pick up to 3 files to read. single mode snapshots the live dir first; control and repeated operate on clones only.
5. write the json + markdown report under dream-eval/reports/ and show the markdown summary inline.
6. release the dream lock when done, after the report is written, always, using Bash: `node "${CLAUDE_PLUGIN_ROOT}/scripts/marker.mjs" lock-release dream`.

## Safety

- shares the dream lock (acquired in step 1, released in step 6) so the harness and /dream never run at once.
- single mode mutates the live memory dir (snapshot taken first); control and repeated never touch it.
- archive over delete.
