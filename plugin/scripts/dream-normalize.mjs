// scripts/dream-normalize.mjs : the DATE NORMALIZE operator, as a function.
//
// /dream Phase 2 used to flag candidates with a bare keyword match and hand
// them to the model to inspect one by one. That cost a scan and a read pass
// every run and returned almost nothing: 44 matches and zero applied
// conversions across five runs, 38 files and ~0 genuine on the run before. The
// matches are dominated by shapes that must NOT be rewritten -- tense-words
// ("as the data model stands today"), the quoted trigger words inside memories
// that document this very rule, and `"x" -> "y"` records in _dream_log.md.
//
// Judgement at that hit rate is a liability rather than an asset: one run that
// applied its matches left "no tag concept in the data model 2026-08-05" in
// the vault, which had been "...in the data model today". So the decision is
// mechanical here, and narrow by construction.
//
// The rule: convert only a reference that resolves to exactly ONE calendar day
// the reader would otherwise have to reconstruct. Everything else is left
// alone. A missed conversion costs a relative date that stays relative; a
// wrong one silently edits what a note claims.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORD_NUMBERS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const WEEKDAYS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

// Deliberately absent: today, now, currently, recently, "last week", "this
// year". The first four are tense-words far more often than dates, and a bare
// week or year names a span, so choosing a day inside it is the judgement this
// module exists to avoid.
const PATTERN = new RegExp(
  [
    String.raw`\b(yesterday|tomorrow)\b`,
    String.raw`\b(\d{1,3}|${Object.keys(WORD_NUMBERS).join('|')})\s+(day|week)s?\s+ago\b`,
    String.raw`\b(last|next)\s+(${Object.keys(WEEKDAYS).join('|')})\b`,
  ].join('|'),
  'gi',
);

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

function isoOf(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(anchorISO, n) {
  const d = new Date(`${anchorISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf(d);
}

// "last Thursday" is the most recent Thursday STRICTLY before the anchor, and
// "next Thursday" the first strictly after -- never the anchor day itself,
// which is what a reader means by either phrase.
function weekdayDate(anchorISO, targetDow, forward) {
  const anchorDow = new Date(`${anchorISO}T00:00:00Z`).getUTCDay();
  let diff = forward ? (targetDow - anchorDow + 7) % 7 : (anchorDow - targetDow + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(anchorISO, forward ? diff : -diff);
}

// Quoted and backticked runs are off limits. Memories that document the date
// rules quote the trigger words as examples, so rewriting inside a quote
// corrupts the description of the behaviour rather than a stale date.
function protectedSpans(line) {
  const spans = [];
  const re = /"[^"]*"|'[^']*'|`[^`]*`/g;
  let m;
  while ((m = re.exec(line)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

function normalizeLine(line, anchorISO, changes, lineNo) {
  const spans = protectedSpans(line);
  return line.replace(PATTERN, (match, simple, count, unit, dir, weekday, offset) => {
    if (spans.some(([start, end]) => offset >= start && offset < end)) return match;

    let iso = null;
    if (simple) {
      iso = addDays(anchorISO, simple.toLowerCase() === 'yesterday' ? -1 : 1);
    } else if (count) {
      const n = WORD_NUMBERS[count.toLowerCase()] ?? Number(count);
      if (!Number.isFinite(n)) return match;
      iso = addDays(anchorISO, -(unit.toLowerCase() === 'week' ? n * 7 : n));
    } else if (dir) {
      iso = weekdayDate(anchorISO, WEEKDAYS[weekday.toLowerCase()], dir.toLowerCase() === 'next');
    }
    if (!iso) return match;

    changes.push({ from: match, to: iso, line: lineNo + 1 });
    return iso;
  });
}

/**
 * Resolve every relative date in `text` that names exactly one day.
 * @param {string} text
 * @param {string} anchorISO  YYYY-MM-DD the relative references are read against
 * @returns {{ text: string, changes: {from: string, to: string, line: number}[] }}
 */
export function normalizeText(text, anchorISO) {
  const changes = [];
  const lines = text.split('\n');
  let inFence = false;
  let inFrontmatter = lines[0]?.trim() === '---';

  const out = lines.map((line, i) => {
    if (inFrontmatter) {
      if (i > 0 && line.trim() === '---') inFrontmatter = false;
      return line;
    }
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;

    // A line already carrying an absolute date is either done or is stating
    // both forms on purpose ("today, 2026-05-29"); either way, leave it.
    if (ISO_DATE.test(line)) return line;
    // `"x" -> "y"` is a _dream_log record of a conversion already made. These
    // re-match every run and are the single largest source of empty hits.
    if (line.includes('->')) return line;

    return normalizeLine(line, anchorISO, changes, i);
  });

  return { text: out.join('\n'), changes };
}

/**
 * Normalize one file against its own mtime, which is the closest thing to the
 * date its relative references were written on.
 * @returns {{ changes: {from: string, to: string, line: number}[] }}
 */
export function normalizeFile(path, { apply = false } = {}) {
  const anchorISO = isoOf(statSync(path).mtime);
  const original = readFileSync(path, 'utf8');
  const { text, changes } = normalizeText(original, anchorISO);
  if (apply && changes.length > 0) writeFileSync(path, text);
  return { changes, anchorISO };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes('--apply');
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('Usage: dream-normalize.mjs <file.md> [more.md ...] [--apply]');
    process.exit(2);
  }
  let total = 0;
  for (const file of files) {
    let result;
    try {
      result = normalizeFile(file, { apply });
    } catch (err) {
      console.error(`skip ${basename(file)}: ${err.message}`);
      continue;
    }
    for (const c of result.changes) {
      console.log(`${basename(file)}:${c.line}: "${c.from}" -> "${c.to}"`);
    }
    total += result.changes.length;
  }
  console.error(apply ? `applied ${total}` : `${total} convertible (dry run; --apply to write)`);
}
