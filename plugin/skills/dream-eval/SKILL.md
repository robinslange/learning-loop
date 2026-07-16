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

1. if `probes.jsonl` is absent and `--mine` was not passed, stop and say: "no probe corpus found. run with --mine first."
2. if `--mine`, run the probe miner (forward + reverse) and persist to probes.jsonl.
3. run the chosen mode. the retrieval function is an in-session Task dispatch: given the question and the MEMORY.md index, pick up to 3 files to read. single mode snapshots the live dir first; control and repeated operate on clones only.
4. write the json + markdown report under dream-eval/reports/ and show the markdown summary inline.

## Safety

- shares the dream lock so the harness and /dream never run at once.
- single mode mutates the live memory dir (snapshot taken first); control and repeated never touch it.
- archive over delete.
