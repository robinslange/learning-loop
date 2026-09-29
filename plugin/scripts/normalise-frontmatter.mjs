#!/usr/bin/env node
// normalise-frontmatter.mjs : bring existing notes onto the atomic-note
// contract in scripts/lib/frontmatter-schema.mjs.
//
// The pre-write gate stops new drift; this clears the backlog that accumulated
// while the contract was advisory. Nothing here consults a model: every repair
// is a rename, a lookup, or a regex verdict, because a model is what produced
// four spellings of two keys in the first place.
//
// Frontmatter is edited as raw lines rather than reserialised from the parsed
// map. Reserialising would rewrite quoting and key order across thousands of
// notes and bury the real diff.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getVaultPath } from './lib/config.mjs';
import { parseFrontmatter } from './lib/markdown-parse.mjs';
import { hasFlag, flagValue } from './lib/cli-args.mjs';
import { isMainModule } from './lib/is-main.mjs';
import { gitEnv } from './lib/session-ledger.mjs';
import { classifyVaultPath } from '../hooks/lib/common.mjs';
import {
  ALIASES,
  DATE_RE,
  SCHEMA_CLASSES,
  STATUS_VALUES,
  checkFrontmatter,
  hasBodyCitation,
  hasUngroundedFactualSignal,
} from './lib/frontmatter-schema.mjs';

// A commit that adds this many notes at once says when they arrived, not when
// they were written: a merged vault, a restored backup, a batch sync. Those
// notes get no date from it and are left for a human.
export const BULK_ADD = 100;

const FM_SPLIT_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/;

// One `git log` walk instead of 5600 per-file invocations, oldest commit
// first, mapping each note's current path to the date it was first added.
// --relative is load-bearing: the vault is usually a subdirectory of its repo,
// and git otherwise reports repo-root-relative paths that never match a
// vault-relative lookup, silently sending every note to the mtime fallback.
//
// Renames carry the date to the new path, because promotion moves notes and a
// moved note was written when it was first added. -z keeps paths raw, so a
// non-ASCII name matches its file instead of git's quoted escape.
//
// A note first added by a bulk commit maps to null, not to that commit's date.
export function buildAddDateMap(vaultRoot) {
  const map = new Map();
  let out;
  try {
    out = execFileSync(
      'git',
      [
        'log',
        '--reverse',
        '-z',
        '-M',
        '--name-status',
        '--relative',
        '--date=short',
        '--format=%x01%ad',
      ],
      {
        cwd: vaultRoot,
        encoding: 'utf-8',
        maxBuffer: 256 * 1024 * 1024,
        env: gitEnv(),
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch {
    return map;
  }
  let date = null;
  let added = [];
  let renamed = [];
  const flush = () => {
    const bulk = added.filter((p) => p.endsWith('.md')).length >= BULK_ADD;
    for (const p of added) if (!map.has(p)) map.set(p, bulk ? null : date);
    for (const [from, to] of renamed) if (map.has(from)) map.set(to, map.get(from));
    added = [];
    renamed = [];
  };
  // Records are NUL-separated: \x01<date> opens a commit, then a status
  // (A, M, D, ... or R<score> with two paths) and its path(s).
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i++].replace(/^\n/, '');
    if (token.startsWith('\x01')) {
      flush();
      date = token.slice(1);
    } else if (token.startsWith('R')) {
      renamed.push([tokens[i++], tokens[i++]]);
    } else if (token === 'A') {
      added.push(tokens[i++]);
    } else if (token) {
      i++;
    }
  }
  flush();
  return map;
}

// The folders the contract covers, as SCHEMA_CLASSES names them. A name that
// is not a directory fails the readdir below and is skipped there.
function listNotes(vaultRoot) {
  const folders = readdirSync(vaultRoot).filter((name) =>
    SCHEMA_CLASSES.has(classifyVaultPath(`${name}/`)),
  );
  const notes = [];
  for (const folder of folders) {
    let entries;
    try {
      entries = readdirSync(join(vaultRoot, folder));
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith('.md')) notes.push(`${folder}/${name}`);
    }
  }
  return notes.sort();
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// Pick the capture origin from what the body actually shows. Body citations
// come first: a note whose sources sit on a `Source:` line is cited work, and
// calling it uncited because the URLs are not in frontmatter is a lie about a
// note that is fine. Then the honest-synthesis test: only a note asserting
// nothing a reader could check earns `synthesis`. Everything else owes a URL,
// and saying so beats laundering it through the synthesis exemption.
// Deliberately does NOT stamp synthesis_validated: the downstream audit still
// gets to run.
function inferSource(body) {
  if (hasBodyCitation(body)) return 'literature';
  return hasUngroundedFactualSignal(body) ? '"[no URL found]"' : 'synthesis';
}

// An earlier pass of this script judged groundedness on wikilinks alone and
// stamped `[no URL found]` on 99 notes that carry their citations in the body.
// Correcting a value this script wrote is its job, so the repair is a rule here
// rather than a one-off migration nobody will find later.
function miscalledUncited(fm, body) {
  return fm.source === '[no URL found]' && hasBodyCitation(body);
}

// Group raw lines by key so a block-form value moves as one unit:
//   tags:
//     - a
//     - b
// Reordering or deleting a bare line would orphan the `- a` items.
function groupLines(lines) {
  const groups = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_-]+):/);
    if (m) groups.push({ key: m[1], lines: [line] });
    else if (groups.length > 0) groups[groups.length - 1].lines.push(line);
    else groups.push({ key: null, lines: [line] });
  }
  return groups;
}

// capture-rules.md shows tags/date/source in that order, and an agent copies
// the shape it sees far more reliably than the rule it reads. Every note ends
// up with the template's shape so there is nothing else to copy.
const CANONICAL_ORDER = ['tags', 'date', 'source'];

function reorder(groups) {
  const rank = (g) => {
    const i = CANONICAL_ORDER.indexOf(g.key);
    return i === -1 ? CANONICAL_ORDER.length : i;
  };
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)
    .map((x) => x.g);
}

// `addDate` is null for a note a bulk import added: see BULK_ADD.
export function repair(raw, relPath, addDate) {
  const split = raw.match(FM_SPLIT_RE);
  if (!split) return { changes: [], unfixable: ['no frontmatter block'] };

  const { fm, body } = parseFrontmatter(raw);
  const groups = groupLines(split[2].split(/\r?\n/));
  const ordered = reorder(groups);
  const misordered = ordered.some((g, i) => g !== groups[i]);

  const violations = checkFrontmatter(fm);
  const miscalled = miscalledUncited(fm, body);
  if (violations.length === 0 && !misordered && !miscalled) return { changes: [], unfixable: [] };

  const changes = [];
  const unfixable = [];
  const indexOf = (k) => groups.findIndex((g) => g.key === k);
  const valueOf = (i) => groups[i].lines[0].slice(groups[i].key.length + 1).trim();
  const rewrite = (i, line) => (groups[i].lines[0] = line);
  const drop = (i) => groups.splice(i, 1);
  const append = (key, value) => groups.push({ key, lines: [`${key}: ${value}`] });

  for (const [alias, canonical] of Object.entries(ALIASES)) {
    const i = indexOf(alias);
    if (i === -1) continue;
    const value = valueOf(i);

    if (alias === 'source-project') {
      // Carries two facts under one key: which project, and that the note is
      // first-hand. Split them back apart.
      if (indexOf('project') === -1 && value) {
        rewrite(i, `project: "[[${value}]]"`);
        groups[i].key = 'project';
        changes.push(`source-project -> project: "[[${value}]]"`);
      } else {
        drop(i);
        changes.push('dropped source-project (project already set)');
      }
      continue;
    }

    if (indexOf(canonical) !== -1) {
      drop(i);
      changes.push(`dropped ${alias} (${canonical} already set)`);
    } else {
      rewrite(i, `${canonical}: ${value}`);
      groups[i].key = canonical;
      changes.push(`${alias} -> ${canonical}: ${value}`);
    }
  }

  const statusIdx = indexOf('status');
  if (statusIdx !== -1) {
    const value = valueOf(statusIdx);
    if (value && !STATUS_VALUES.has(value)) {
      drop(statusIdx);
      changes.push(`dropped status: ${value} (folder carries maturity)`);
    }
  }

  // Read from the lines, not `fm`: a `created:` renamed above is not in `fm.date`.
  const dateAt = indexOf('date');
  // Unwrapped as leniently as the parser: a one-item list, and quotes on either end.
  const dateValue = dateAt === -1 ? '' : valueOf(dateAt).replace(/^\[?["']?|["']?\]?$/g, '');
  if (!DATE_RE.test(dateValue)) {
    if (addDate) {
      if (dateAt !== -1) drop(dateAt);
      append('date', addDate);
      changes.push(`date: ${addDate} (first commit)`);
    } else {
      // The line stays: a malformed date is still the only record of one.
      const found = dateAt === -1 ? 'no date' : `date ${dateValue} is not YYYY-MM-DD`;
      unfixable.push(
        `${found}, and it was first committed with ${BULK_ADD - 1}+ other notes at once, so that commit's date is not when it was written`,
      );
    }
  }

  if (indexOf('source') === -1) {
    const value = inferSource(body);
    append('source', value);
    changes.push(`source: ${value}`);
  } else if (miscalled) {
    rewrite(indexOf('source'), 'source: literature');
    changes.push('source: [no URL found] -> literature (citations are in the body)');
  }

  if (indexOf('tags') === -1) unfixable.push('no tags (cannot be inferred)');

  // Placement is the sort's job, not each insertion's: append anywhere above,
  // then let reorder() put the trio in template order exactly once.
  const final = reorder(groups);
  if (misordered && changes.length === 0) changes.push('reordered to tags/date/source');
  if (changes.length === 0) return { changes, unfixable };

  const text = final.flatMap((g) => g.lines).join('\n');
  return { changes, unfixable, next: split[1] + text + split[3] + body };
}

function main(args) {
  const apply = hasFlag(args, '--apply');
  const only = flagValue(args, '--folder', null);
  const vaultRoot = getVaultPath();
  const addDates = buildAddDateMap(vaultRoot);

  let scanned = 0;
  let repaired = 0;
  const blocked = [];

  for (const rel of listNotes(vaultRoot)) {
    if (only && !rel.startsWith(only)) continue;
    const abs = join(vaultRoot, rel);
    let raw;
    try {
      raw = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    scanned++;

    // Untracked by git: the file's own mtime is the best date there is.
    const addDate = addDates.has(rel) ? addDates.get(rel) : isoDate(statSync(abs).mtime);
    const { changes, unfixable, next } = repair(raw, rel, addDate);

    if (unfixable.length > 0) blocked.push(`${rel}: ${unfixable.join(', ')}`);
    if (changes.length === 0) continue;

    repaired++;
    console.log(`${rel}`);
    for (const c of changes) console.log(`    ${c}`);
    if (apply && next) writeFileSync(abs, next);
  }

  console.log(
    `\n${scanned} scanned, ${repaired} ${apply ? 'repaired' : 'would be repaired'}, ${blocked.length} need a human`,
  );
  for (const b of blocked) console.log(`  ${b}`);
  if (!apply && repaired > 0) console.log(`\nRe-run with --apply to write.`);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
