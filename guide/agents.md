# Agents

Agents are specialized subprocesses spawned by skills. They run in parallel where possible.

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
| ingest-context | Extract insights from pasted text | Haiku |
| ingest-linear | Pull and extract from Linear tickets | Haiku |
| ingest-repo | Scan repo surface for architecture insights | Haiku |
| diagram-rules | Shared Excalidraw generation spec | (reference) |

Agents share 18 skills in `agents/_skills/` covering promote-gate assessment, cross-validation, source verification, coverage mapping, blindspot detection, and more.
