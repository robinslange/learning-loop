# Agents

Skills spawn specialized agents as subprocesses. They run in parallel where possible and share 18 skills that enforce consistent quality standards across all operations.

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
| diagram-rules | Shared Excalidraw generation spec | (reference) |

Fourteen working agents plus the `diagram-rules` shared reference file.

## Model selection

Lightweight agents (vault search, scoring, ingestion) run on Haiku to keep costs down. Anything that requires judgment about source quality, claim validity, or writing in the persona voice runs on Sonnet.

## Shared skills

Agents share 18 skills in `agents/_skills/` that standardize quality decisions:

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
