// provenance-vocabulary.mjs: the committed set of legal provenance `action` values.
//
// Derived by reconciling static grep of skill/agent markdown and JS call sites
// against four months of the live provenance corpus. Static analysis alone
// finds 25 actions and misses 11 that only ever appear built from ternaries or
// emitted from markdown the grep can't parse; the live corpus in turn shows 5
// one-off spellings from June/July that never recurred. Union: 36.
//
// VALID_ACTIONS is what emitters may write going forward: the 25 statically
// visible actions plus the 6 that are real but statically invisible
// (vault-write, vault-edit, refinement-passed, refinement, counterpoint-linked,
// refinement-rejected).
//
// LEGACY_ACTIONS is the 5 one-off historical spellings (write, write-note,
// demote, refine, refinement-skipped). They are not valid to emit again, but
// historical event files on disk contain them, so readers must still
// recognise them as known rather than treating them as garbage.

export const VALID_ACTIONS = new Set([
  // Statically visible (25)
  'abstract',
  'auto-link',
  'batch-promote',
  'batch-score',
  'capture',
  'compress',
  'create',
  'deepen',
  'link',
  'merge',
  'normalize',
  'note-usage',
  'prune',
  'refinement-applied',
  'research',
  'resolve',
  'score',
  'session-end',
  'session-start',
  'source-check',
  'triage',
  'verify',
  'agent-result',
  'agent-spawn',
  'skill-invoke',
  // Current but statically invisible (6)
  'vault-write',
  'vault-edit',
  'refinement-passed',
  'refinement',
  'counterpoint-linked',
  'refinement-rejected',
]);

export const LEGACY_ACTIONS = new Set([
  'write',
  'write-note',
  'demote',
  'refine',
  'refinement-skipped',
]);

export function isKnownAction(action) {
  return VALID_ACTIONS.has(action) || LEGACY_ACTIONS.has(action);
}

// INTENT_KINDS replaces the free-text `intent` field that verify, gaps and
// discovery previously emitted as an uppercase placeholder (`SCOPE`, `TOPIC`)
// standing in for a full research sentence. Unbounded prose is neither a
// usable metric label nor exportable (`intent` is in NEVER_EXPORT), so
// `intent_kind` carries one of these bounded labels instead. Kept small and
// closed: add a value only when a skill's emit genuinely needs a new kind,
// not to preserve nuance that belongs in local JSONL, not a Grafana label.
export const INTENT_KINDS = new Set(['research', 'scope', 'topic', 'triage', 'deepen']);

// SESSION_END_FIELDS: the common numeric core every `session-end` payload
// should carry so cross-skill panels work without per-skill special-casing.
// Skill-specific counters (e.g. verify's findings_total, inbox's promoted)
// remain allowed as ADDITIONAL numeric fields alongside these; this set is a
// floor, not a ceiling.
export const SESSION_END_FIELDS = new Set([
  'items_in',
  'items_out',
  'items_flagged',
  'duration_ms',
]);
