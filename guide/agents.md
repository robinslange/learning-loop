# Agents

Skills spawn specialized agents as subprocesses. They run in parallel where possible and share 19 skills that enforce consistent quality standards across all operations.

## Why agents, not prompts

A prompt asks Claude to verify sources. An agent forces it. The difference: agents carry their own skill definitions for promotion gating, source verification, and cross-validation. Claude cannot skip a step it does not control. The hooks fire regardless of what the model decides.

## Agent roster

| Agent | Purpose | Model |
|---|---|---|
| discovery-researcher | Deep web research with source verification | Sonnet |
| discovery-vault-scout | Search vault + episodic memory for existing knowledge | Haiku |
| gap-analyser | Socratic analysis of claim quality and coverage | Sonnet |
| inbox-organiser | Batch triage with clustering, promotion, fleeting sweep | Sonnet |
| literature-capturer | Capture external sources as literature notes | Sonnet |
| note-deepener | Strengthen a single note with scaled research | Sonnet |
| note-scorer | Batch quality assessment | Haiku |
| note-verifier | Source verification and claim checking | Sonnet |
| note-writer | Write atomic notes in persona voice | Sonnet |
| correction-analyser | Trace sole-justification dependents of a retracted belief for `/rewrite` impact maps | Sonnet |
| refinement-proposer | Propose upstream refinements when a new note touches an existing claim | Sonnet |
| ingest-context | Extract insights from pasted text | Haiku |
| ingest-linear | Pull and extract from Linear tickets | Haiku |
| ingest-repo | Scan repo surface for architecture insights | Haiku |

Fourteen working agents. The `diagram-rules` shared reference (consumed by `discovery-researcher` and `note-writer` for Excalidraw generation) lives under `agents/_skills/` alongside the other shared skills.

## Vault librarian (local, optional)

A separate tier runs outside of Claude entirely. The vault librarian (`scripts/librarian.mjs`) uses Gemma 4 E2B via ollama for continuous background classification. It dispatches up to four tasks per visited note, mixing one tool-use loop with three single-call structured-output classifiers.

| Task | Mode | Trigger | Output |
|---|---|---|---|
| Link investigation | Tool-use loop, 10 tools backed by `ll-search` and SQL | Orphan notes (no inbound or outbound links) | `link_suggestion` queue entry per candidate |
| Voice gate | Single structured-output call | Inbox or fleeting notes whose title looks topic-style rather than insight-style | `voice_flag` |
| Tag suggestion | Single structured-output call | Notes with 0 or 1 tags | `tag_suggestion` with up to 2 tags |
| Duplicate detection | Single structured-output call | Every visited note | `duplicate_flag` with a 3-way enum (`duplicate`/`same_topic`/`unrelated`) |

The structured-output classifiers all follow the same shape: pre-fetch context, one schema-bound call, no tool-use. Specifics:

- **Tag suggester.** Vocabulary is built from the vault's existing tag set, frequency-curated, top 60, with structural categories (folder labels, status tags) excluded. The classifier picks 0, 1, or 2 tags from that bounded vocabulary; it cannot invent new tags. Manual precision on a 40-note sample: 0.78 strict, 0.84 charitable.
- **Duplicate detector.** Compares the visited note against three nearest neighbours from `ll-search similar`, with 500 characters of body context per side. Returns one of `duplicate` (merge), `same_topic` (link), or `unrelated` (drop). False-positive rate ~3% with body context; the body context is what makes the call accurate at this model size.
- **Voice gate.** Inspects the title only. Returns a flag if the title states a topic ("Spaced Repetition") rather than an insight ("Spaced repetition works because forgetting is active"). F1 0.78 against a hand-labelled set.

All four tasks write observations to `PLUGIN_DATA/librarian/queue.jsonl` with a distinct `task` field. A separate `state.json` tracks visited notes and resets after a full pass. Claude reviews the queue on demand via `/health --librarian`.

| Agent | Engine | Tasks | Speed |
|---|---|---|---|
| librarian | Gemma 4 E2B (ollama, local) | Link validation, voice gate, tag suggestion, duplicate detection, staleness flagging | ~15s/note |
| Claude (on-demand) | Opus or Sonnet (via `/health --librarian`) | Code verification, web research, claim validation | Human-initiated |

E2B is good at classification with evidence (90% link accuracy, voice gate F1 0.78, tag suggester precision 0.78 to 0.84, duplicate detector ~3% false-positive with body context) and weak at open-ended investigation. The architecture splits accordingly.

## Model selection

Lightweight agents (vault search, scoring, ingestion) run on Haiku to keep costs down. Anything that requires judgment about source quality, claim validity, or writing in the persona voice runs on Sonnet.

## Shared skills

Agents share 19 skills in `agents/_skills/` that standardize quality decisions:

- **promote-gate** -- six-criteria assessment that determines whether a note advances
- **source-verification** -- mechanical citation checking against academic APIs
- **cross-validation** -- checks claims against other vault notes for consistency
- **coverage-mapping** -- measures how thoroughly a topic is covered
- **blindspot-detection** -- surfaces what the vault does not address
- **claim-extraction** -- pulls verifiable claims from prose
- **evidence-comparison** -- compares competing claims across sources
- **counter-argument-linking** -- finds and links opposing positions
- **discrimination** -- distinguishes confusable notes
- **overlap-check** -- catches near-duplicates before they land
- **route-output** -- directs agent output to the correct vault location
- **capture-rules** -- enforces vault writing standards
- **vault-io** -- standardized read/write operations
- **decision-gates** -- structured go/no-go checkpoints
- **extract-insights** -- pulls atomic insights from raw content
- **source-quality** -- rates source reliability
- **preview-format** -- standardized output formatting
- **fleeting-sweep** -- identifies stale fleeting notes for archival
- **diagram-rules** -- when and how to generate Excalidraw diagrams during research

## Source verification and overclaim mitigation

Two layers run on every note the `note-writer` agent emits: a write-time shape check against the prose, and a post-write resolver pass against the cited source.

The shape check lives in `agents/_skills/capture-rules.md` under "Claim Shapes Requiring Verbatim Anchoring". Four shapes account for ~94% of overclaim findings in vault audits:

1. **Numerical figures** -- any "X%", "X billion", "<X", ">X", "X ms", "X-fold". Must match the source phrasing including hedges. Strengthening "roughly 65%" into ">65%" fails the check.
2. **Universal claims** -- "no X does Y", "X is the only Y", "every X". Require a survey-style citation or softening to a first-person evidence claim.
3. **Named attributions** -- "Author said", "Paper shows", "RFC defines". Require a verbatim sentence-fragment from the cited source.
4. **Strengthened hedges** -- promoting "preferential" to "exclusive", "may" to "does". The hedge IS the claim; preserve it.

If a shape fires and the writer cannot resolve it (no verbatim, no survey, no fetched source), the figure or attribution gets the inline marker `[not in source]` so a later `/verify` pass catches it.

After the note is on disk, `scripts/source-resolver.mjs check-claims` runs the resolver pass. For PubMed, DOI, and arXiv sources it diffs the note's quantitative claims against the abstract. For non-academic URLs (docs, blog posts, vendor pages), it fetches the page, strips HTML, and runs the same diff against the page text. A `WEB_FETCH_BLOCKLIST` skips paywalled domains and PDF endpoints (sciencedirect, springer, raw `doi.org`). Output records `source_kind: "abstract" | "page"` and the resolved URL so a reader can see which path ran.

The four inline markers are documented in `capture-rules.md` under "Verification Markers" and understood by every agent that handles notes:

- `[unresolved]` -- citation not found via any academic API.
- `[unverified]` -- source found but author or year mismatch could not auto-correct.
- `[not in abstract]` -- figure absent from the academic abstract; may be in full text.
- `[not in source]` -- figure absent from a fetched non-academic page; check manually or soften.

See `agents/_skills/capture-rules.md` for the full shape rules and `agents/note-writer.md` Pass 1 for the write-time procedure.

## Subagent writes and hook replay

PostToolUse hooks (`post-write-autolink.js`, `post-write-edge-infer.js`) do not fire on Write or Edit calls made inside a subagent. Notes written by `note-writer`, `literature-capturer`, `note-deepener`, and the other write-capable agents bypass the structural backlink and typed-edge passes by default.

Skills that dispatch write-capable subagents replay the hook chain explicitly via `scripts/sweep-hook-replay.mjs`. The script accepts vault paths on stdin or as positional args, runs both PostToolUse hooks against each, and emits a JSON summary. Hooks are idempotent, so replaying on already-hooked notes is safe.

The canonical patterns (an unlinked-body filter for end-of-skill sweeps and a targeted variant for known paths) live in `skills/_shared/hook-replay.md`. Skills like `/reflect`, `/ingest`, `/quick`, and `/literature` reference that snippet rather than reimplementing it.
