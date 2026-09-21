// scripts/lib/provenance-skill.mjs: derives `skill` on a provenance record
// when the caller omitted it, so the two emitters (hooks/lib/common.mjs and
// scripts/provenance.mjs) cannot drift on how they do it.
//
// Kept out of provenance-vocabulary.mjs, which stays a pure constants module
// with no filesystem access.

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readMarker, MARKER_PATHS } from './marker-cache.mjs';
import { logError } from './log.mjs';
import { pluginRoot as defaultPluginRoot } from './plugin-meta.mjs';

// Matches the current-skill marker's own write cadence: a session's last
// skill remains the best attribution for up to 8 hours, long enough to span
// a Stop hook's throttled re-emits without outliving the session it names.
const SKILL_MARKER_TTL_MS = 8 * 60 * 60 * 1000;

// Hook-owned records, never skill-caused: deriving a skill onto these would
// misattribute the hook's own action to whatever skill last ran.
// agent-result is deliberately NOT here -- it is the 3,591-event gap the
// plan named: agent results are dispatched from a skill and should carry it.
export const NO_DERIVE_ACTIONS = new Set(['session-summary', 'session-start']);

let _knownSkillNames = null;

// Directory names under plugin/skills/ that contain a SKILL.md. Memoised per
// process: the skill directory is fixed for the life of a hook/worker run.
// An empty read is never cached -- a transient miss (skills dir not yet
// mounted, a race at process start) would otherwise poison every later call
// in the same process.
export function knownSkillNames(pluginRoot = defaultPluginRoot()) {
  if (_knownSkillNames) return _knownSkillNames;
  const skillsDir = join(pluginRoot, 'skills');
  const names = new Set();
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md'))) {
        names.add(entry.name);
      }
    }
  } catch (err) {
    logError('provenance-skill.knownSkillNames', err);
  }
  if (names.size > 0) _knownSkillNames = names;
  return names;
}

// A skill identifier is `name` or `plugin:name`, each segment
// [a-z0-9][a-z0-9._-]{0,63} (case-insensitive), at most two segments, total
// length <= 128. Anything else -- spaces, slashes, a leading dot, more than
// one colon -- is free text, not an identifier.
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}(:[a-z0-9][a-z0-9._-]{0,63})?$/i;

// Canonicalises a skill identifier by shape, not by directory lookup against
// a fixed corpus: the Skill tool also invokes other plugins' skills
// (`superpowers:brainstorming`, `ygrep:ygrep`), and coercing every one of
// those to 'unknown' was wave 4's bug. A value that matches SKILL_ID_RE is
// lower-cased and, when it names one of learning-loop's own skills (bare or
// `learning-loop:`-prefixed), returned as the bare name -- the convention
// tests and the marker already pin, so `reflect` and `learning-loop:reflect`
// collapse to one label. Any other well-shaped identifier (another plugin's
// `plugin:name`, or a bare name that isn't one of ours) passes through
// as-is: those are legitimate values, not this module's business to rewrite.
// Malformed shapes return null.
export function normaliseSkill(value, pluginRoot = defaultPluginRoot()) {
  if (typeof value !== 'string' || value.length > 128 || !SKILL_ID_RE.test(value)) return null;
  const lower = value.toLowerCase();
  const bare = lower.startsWith('learning-loop:') ? lower.slice('learning-loop:'.length) : lower;
  if (knownSkillNames(pluginRoot).has(bare)) return bare;
  return lower;
}

// Rejects a skill value that will not normalise: logs the length only (never
// the value itself) and returns 'unknown'.
function validatedSkill(value, pluginRoot = defaultPluginRoot()) {
  const normalised = normaliseSkill(value, pluginRoot);
  if (normalised) return normalised;
  logError('provenance.unknownSkill', new Error('rejected skill value'), {
    length: String(value).length,
  });
  return 'unknown';
}

// Sets record.skill from the session's current-skill marker when the caller
// omitted (or emptied) it, and validates whatever skill ends up on the
// record -- caller-supplied or derived -- by identifier shape. Mutates and
// returns record for chaining.
export function deriveSkill(record, pluginData, pluginRoot = defaultPluginRoot()) {
  if (NO_DERIVE_ACTIONS.has(record.action)) return record;
  if (record.skill) {
    record.skill = validatedSkill(record.skill, pluginRoot);
    return record;
  }
  if (!pluginData || !record.session_id) return record;
  const marker = readMarker(MARKER_PATHS.currentSkill(pluginData, record.session_id), {
    ttlMs: SKILL_MARKER_TTL_MS,
  });
  if (marker?.skill) record.skill = validatedSkill(marker.skill, pluginRoot);
  return record;
}
