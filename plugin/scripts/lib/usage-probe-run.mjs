// scripts/lib/usage-probe-run.mjs : the Stop-hook side of the usage probe.
//
// Joins what retrieval surfaced to this session against what the transcript
// shows the session did with it, and writes a note-usage event per note with
// evidence. See usage-probe.mjs for why it writes only `used` events and
// stays silent on everything else.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_PATHS } from './paths.mjs';
import { appendJsonlLine } from './jsonl.mjs';
import { logError } from './log.mjs';
import { sessionSurfaced, loadNoteUsageEvents } from './retrieval-usage.mjs';
import { probeTranscriptUsage } from './usage-probe.mjs';

// The whole transcript, not a tail. The first version read the last 1MB on
// the theory that engagement lives in recent turns, and against a real 4.5MB
// session it found nothing: the note writes had happened an hour earlier and
// sat outside the window. A probe that silently reports no-evidence for a
// session that plainly engaged is not a cheaper probe, it is a broken one,
// and its failures are invisible by construction.
//
// Cost is bounded by a size ceiling rather than a window: the Stop hook
// already reads this same file whole to count its lines, so the marginal
// cost here is one more pass, not a new class of work.
const MAX_TRANSCRIPT_BYTES = 64 * 1_048_576;

/**
 * Probe one session and record what it engaged with.
 *
 * @param {object} opts
 * @param {string} opts.pluginData
 * @param {string} opts.sessionId      The hook-supplied id. Passed explicitly
 *   rather than resolved here: the events must key on the same id the
 *   surfacing rows carry, or the join they exist for finds nothing.
 * @param {string} opts.transcriptPath
 * @returns {number} events written.
 */
export function runUsageProbe({ pluginData, sessionId, transcriptPath } = {}) {
  if (!pluginData || !sessionId || !transcriptPath) return 0;

  try {
    if (!existsSync(transcriptPath)) return 0;

    const surfaced = sessionSurfaced(pluginData, sessionId);
    if (surfaced.length === 0) return 0;

    // /reflect's Step 4.7 judges the same session with a reader that can see
    // `informed`, which no mechanical probe can. When it has already spoken,
    // the probe stands down rather than double-counting the same use. This
    // also makes the probe idempotent: its own events are note-usage events,
    // so a second run sees them and stops.
    const alreadyJudged = loadNoteUsageEvents(pluginData).some((e) => e.session_id === sessionId);
    if (alreadyJudged) return 0;

    // Refuse absurd inputs rather than pretending to scan them: a transcript
    // past this size means something else is wrong, and a probe is not worth
    // an OOM in the Stop hook.
    if (statSync(transcriptPath).size > MAX_TRANSCRIPT_BYTES) return 0;

    const found = probeTranscriptUsage(readFileSync(transcriptPath, 'utf8'), surfaced, {
      directOnly: true,
    });
    if (found.length === 0) return 0;

    const file = join(DATA_PATHS.provenance(pluginData), `events-${monthStamp()}.jsonl`);
    const surfacedVia = new Map(surfaced.map((s) => [s.path, s.via]));
    let written = 0;
    for (const { path, signals } of found) {
      appendJsonlLine(file, {
        ts: new Date().toISOString(),
        session_id: sessionId,
        // 'probe' rather than 'skill': a mechanical verdict and a read one are
        // different evidence, and a report that cannot tell them apart cannot
        // say how much of its ground truth was judged by a model.
        source: 'probe',
        agent: 'usage-probe',
        action: 'note-usage',
        target: path,
        status: 'used',
        signals,
        surfaced_via: surfacedVia.get(path) ?? [],
      });
      written += 1;
    }
    return written;
  } catch (err) {
    logError('usage-probe-run', err);
    return 0;
  }
}

function monthStamp() {
  return new Date().toISOString().slice(0, 7);
}
