// scripts/lib/provenance-skill.mjs: derives `skill` on a provenance record
// when the caller omitted it, so the two emitters (hooks/lib/common.mjs and
// scripts/provenance.mjs) cannot drift on how they do it.
//
// Kept out of provenance-vocabulary.mjs, which stays a pure constants module
// with no filesystem access.

import { readMarker, MARKER_PATHS } from './marker-cache.mjs';

// Matches the current-skill marker's own write cadence: a session's last
// skill remains the best attribution for up to 8 hours, long enough to span
// a Stop hook's throttled re-emits without outliving the session it names.
const SKILL_MARKER_TTL_MS = 8 * 60 * 60 * 1000;

// Hook-owned records, never skill-caused: deriving a skill onto these would
// misattribute the hook's own action to whatever skill last ran.
const NO_DERIVE_ACTIONS = new Set(['session-summary', 'session-start']);

// Sets record.skill from the session's current-skill marker when the caller
// omitted (or emptied) it. Mutates and returns record for chaining.
export function deriveSkill(record, pluginData) {
  if (record.skill || NO_DERIVE_ACTIONS.has(record.action)) return record;
  if (!pluginData || !record.session_id) return record;
  const marker = readMarker(MARKER_PATHS.currentSkill(pluginData, record.session_id), {
    ttlMs: SKILL_MARKER_TTL_MS,
  });
  if (marker?.skill) record.skill = marker.skill;
  return record;
}
