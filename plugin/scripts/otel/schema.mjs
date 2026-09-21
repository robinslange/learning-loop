// scripts/otel/schema.mjs : the export allowlist, phase 0 of the OTEL plan.
//
// This is an INCLUSION list, not an exclusion list. Two earlier drafts of
// docs/plans/otel-consolidation.md hand-wrote an exclusion list and both were
// incomplete, which is a silent-failure design: a field absent from an
// exclusion list ships by default. Here the opposite holds: a field absent
// from EXPORT_SCHEMA fails closed, via validateExportRecord below.
//
// Only numeric (counter/gauge/histogram) and bounded-enum (label) fields
// appear here. Free text, paths and anything identifying stay out, and
// NEVER_EXPORT names them explicitly so the exclusion is testable rather than
// implicit in omission.

export const NEVER_EXPORT = new Set([
  'query',
  'prompt',
  'target',
  'evidence',
  'top_paths',
  'question',
  'message',
  'note',
  'topic',
  'intent',
  'finding_detail',
  'transcript_path',
  'tags',
  'description',
  'args',
  'session_label',
  'current_title',
  'reason',
  'suggested_tags',
  'existing_tags',
  'duplicate_of',
  'suggested_link',
  'matched_patterns',
  'expected_files',
  'stack',
  'meta',
  'msg',
]);

// Session identity is a deliberate exception to "never export identifying
// fields": session_id is a content-free UUID, and cross-stream correlation by
// session is the point of the export (decision 3 in the plan).
const IDENTITY = { session_id: 'label' };

const ENUM_LABEL = 'label';

// The envelope every stream carries. `ts` is the event time, which becomes the
// OTLP timeUnixNano rather than an attribute, and `source` distinguishes the
// hook emitter from the CLI one. Both are content-free and present on every
// record, so leaving them out made every real record fail validation.
const ENVELOPE = { ts: 'timestamp', source: ENUM_LABEL };

export const EXPORT_SCHEMA = {
  provenance: {
    ...ENVELOPE,
    ...IDENTITY,
    action: ENUM_LABEL,
    skill: ENUM_LABEL,
    agent: ENUM_LABEL,
    folder: ENUM_LABEL,
    task: ENUM_LABEL,
  },
  'cache-health': {
    ...ENVELOPE,
    ...IDENTITY,
    turn: 'gauge',
    model: ENUM_LABEL,
    version: ENUM_LABEL,
    cache_read: 'counter',
    cache_creation: 'counter',
    uncached_input: 'counter',
    output_tokens: 'counter',
    total_input: 'counter',
    turn_hit_rate: 'histogram',
    window_hit_rate: 'histogram',
    lifetime_hit_rate: 'histogram',
    session_busts: 'counter',
    used_percentage: 'gauge',
    total_cost_usd: 'gauge',
  },
  retrieval: {
    ...ENVELOPE,
    ...IDENTITY,
    // `type` is a bounded outcome label, not free text: `memory-read` on
    // reads, and the four gate outcomes on shadow-injection
    // (gate-pass-payload, gate-fail-below-threshold, gate-fail-fast-path,
    // gate-fail-low-impact). Verified against the live corpus.
    type: ENUM_LABEL,
    command: ENUM_LABEL,
    via: ENUM_LABEL,
    level: ENUM_LABEL,
    kind: ENUM_LABEL,
    surfaced_via: ENUM_LABEL,
    signals: ENUM_LABEL,
    federated: ENUM_LABEL,
    result_count: 'histogram',
    peer_results: 'histogram',
    prompt_length: 'histogram',
    latency_ms: 'histogram',
    confidence: 'histogram',
    cosine_score: 'histogram',
    model_prob: 'histogram',
    similarity: 'histogram',
  },
  'hook-errors': {
    ...ENVELOPE,
    module: ENUM_LABEL,
    code: ENUM_LABEL,
    latency_ms: 'histogram',
    budget_ms: 'gauge',
    elapsed_ms: 'histogram',
  },
  // log.mjs's error sink (PLUGIN_DATA/logs/log-YYYY-MM.jsonl). The export is a
  // counter by scope: 126 distinct scopes measured, dotted and namespaced
  // (watch.stop.unlinkPid, provenance.invalidAction), safe cardinality for a
  // label. No ts/source envelope here: log.mjs's own record shape is
  // {ts, level, plugin, scope, msg, meta}, and msg/meta/stack (inside
  // meta.err) are all free text, already in NEVER_EXPORT. `plugin` identifies
  // which learning-loop install emitted the line, not a person or a path, so
  // it is safe as a label; it is not a metric or a counter dimension the
  // reducer needs, so it stays out of the schema rather than being exported
  // unused.
  logs: {
    ts: 'timestamp',
    level: ENUM_LABEL,
    scope: ENUM_LABEL,
  },
  // No ts and no session_id on this stream: mine-probes.mjs writes
  // {tier, question, expected_files, source_session, confidence, probe_id}.
  // probe_id is a content-free identifier, source_session correlates to a
  // session without being one.
  'dream-eval': {
    probe_id: ENUM_LABEL,
    source_session: ENUM_LABEL,
    tier: ENUM_LABEL,
    confidence: 'histogram',
  },
  // Queue items carry their own envelope: an opaque id and a created_at used
  // for the lag histogram, not a ts/session_id pair.
  librarian: {
    id: ENUM_LABEL,
    created_at: 'timestamp',
    task: ENUM_LABEL,
    status: ENUM_LABEL,
    usage: ENUM_LABEL,
    expired_reason: ENUM_LABEL,
    scope: ENUM_LABEL,
    confidence: 'histogram',
    cosine_score: 'histogram',
    model_prob: 'histogram',
    similarity: 'histogram',
  },
};

// Fails closed: a key not in the named stream's schema throws rather than
// passing through. A newly added field is meant to break the build, not ship
// silently. See docs/plans/otel-consolidation.md, phase 0.
export function validateExportRecord(stream, record) {
  const schema = EXPORT_SCHEMA[stream];
  if (!schema) {
    throw new Error(`otel export: unknown stream "${stream}"`);
  }
  for (const key of Object.keys(record)) {
    if (!(key in schema)) {
      throw new Error(
        `otel export: field "${key}" is not in the export schema for stream "${stream}"`,
      );
    }
  }
}
