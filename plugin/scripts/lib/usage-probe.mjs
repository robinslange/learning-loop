// scripts/lib/usage-probe.mjs : mechanical end-of-session usage evidence.
//
// Usage ground truth otherwise exists only for sessions that ran /reflect,
// which injection-precision.mjs's own comments call a small, self-selected
// slice. Every retrieval-quality claim in this repo is graded against that
// sample. This probe runs from the Stop hook on every session instead, and
// reads the transcript for evidence that the session ACTED on a note it was
// shown.
//
// What it may claim is bounded by the honesty contract in retrieval-usage.mjs,
// and the boundary is sharper than it first looks: `classifyUsage` folds ANY
// status other than the literal 'used' to 'ignored'. So a probe that emitted
// "I could not tell" as its own status would not be recording uncertainty, it
// would be recording definitive non-use, automatically and at scale, for every
// note of every session. That is worse than the gap it set out to close.
//
// Hence: this returns `used` evidence or it returns nothing. A note it cannot
// speak for stays unevaluated, which is the bucket that already exists for
// exactly this.
//
// It also cannot judge `informed`, a claim reaching the session's output
// without the note being touched. That needs a reader to name the claim and
// where it landed, which is a model's job and stays with /reflect Step 4.7.
// The probe sees only `engaged`: read, edited, linked.
//
// `edited` overlaps a signal that already exists: injection-precision.mjs
// unions `vault-edit`/`vault-write` provenance, which every session emits for
// free whether or not it ran /reflect. That union is keyed by
// (session_id, path) and first-writer-wins, so the overlap costs nothing and
// cannot inflate a precision number. It is kept because this module's output
// also feeds reports that do not read vault-edit, and because a note edited
// without a provenance event still leaves a transcript record. The signal
// this probe adds that nothing else has is `read` and `linked`.

const ENGAGED = { read: 'read', edited: 'edited', linked: 'linked' };

// Tools that mean the session opened the note itself.
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

function parseLines(transcript) {
  if (typeof transcript !== 'string' || !transcript) return [];
  const out = [];
  for (const line of transcript.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A live transcript can be truncated mid-write. Skipping a line costs
      // one signal; throwing costs the whole session's evidence.
    }
  }
  return out;
}

/** Content blocks of an assistant turn, whatever shape the record uses. */
function assistantBlocks(rec) {
  if (rec?.type !== 'assistant') return [];
  const content = rec.message?.content ?? rec.content;
  return Array.isArray(content) ? content : [];
}

function stemOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/**
 * Evidence that this session acted on notes it was shown.
 *
 * @param {string} transcript        Raw transcript JSONL, whole. A window
 *   would be cheaper and wrong: see the note in usage-probe-run.mjs.
 * @param {{path: string}[]} surfaced Notes retrieval put in front of the session.
 * @param {object} [opts]
 * @param {boolean} [opts.skipHookReads] Ignore tool calls the hook chain made
 *   on the session's behalf. A duplicate-gate scan is not engagement: it fires
 *   without the model ever considering the note.
 * @returns {{path: string, signals: string[]}[]} One entry per note with
 *   evidence, signals sorted. Notes without evidence are absent, deliberately:
 *   see the note on `classifyUsage` above.
 */
export function probeTranscriptUsage(transcript, surfaced, opts = {}) {
  const notes = Array.isArray(surfaced) ? surfaced.filter((n) => n?.path) : [];
  if (notes.length === 0) return [];

  // Wikilinks carry a bare stem, so a stem shared by two surfaced notes cannot
  // be resolved. Crediting both would invent use and crediting either would be
  // a coin flip, so an ambiguous stem credits nothing.
  const byStem = new Map();
  for (const note of notes) {
    const stem = stemOf(note.path);
    byStem.set(stem, byStem.has(stem) ? null : note.path);
  }

  const signals = new Map();
  const add = (path, signal) => {
    if (!signals.has(path)) signals.set(path, new Set());
    signals.get(path).add(signal);
  };

  // A surfaced path is matched as a suffix: the transcript carries absolute
  // paths and the surfacing ledger carries vault-relative ones.
  const matchPath = (filePath) => {
    if (typeof filePath !== 'string') return null;
    const normalised = filePath.replace(/\\/g, '/');
    return notes.find((n) => normalised === n.path || normalised.endsWith(`/${n.path}`))?.path;
  };

  for (const rec of parseLines(transcript)) {
    for (const block of assistantBlocks(rec)) {
      if (block?.type === 'tool_use') {
        if (opts.skipHookReads && block._meta?.hook) continue;
        const target = matchPath(block.input?.file_path ?? block.input?.notebook_path);
        if (!target) continue;
        if (READ_TOOLS.has(block.name)) add(target, ENGAGED.read);
        else if (EDIT_TOOLS.has(block.name)) add(target, ENGAGED.edited);
        continue;
      }
      // Only text the assistant wrote counts as a link. A wikilink inside an
      // injected note body is the injection talking, not the session.
      if (block?.type === 'text' && typeof block.text === 'string') {
        for (const match of block.text.matchAll(WIKILINK_RE)) {
          const target = byStem.get(match[1].trim());
          if (target) add(target, ENGAGED.linked);
        }
      }
    }
  }

  return [...signals.entries()]
    .map(([path, set]) => ({ path, signals: [...set].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
