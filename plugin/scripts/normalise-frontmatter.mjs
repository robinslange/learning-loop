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
        // A user's log.showSignature or color.ui would put text between the
        // records this reads.
        '--no-show-signature',
        '--no-color',
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
    return new Map();
  }
  return parseAddDates(out);
}

// Records are NUL-separated: \x01<date> opens a commit, then a status (A, M,
// D, T, or R<score> with two paths) and its path(s). Anything else means the
// output is not what this reads, and guessing past it would date notes wrong.
export function parseAddDates(out) {
  const map = new Map();
  let date = null;
  let added = [];
  let renamed = [];
  const flush = () => {
    const bulk = added.filter((p) => p.endsWith('.md')).length >= BULK_ADD;
    for (const p of added) if (!map.has(p)) map.set(p, bulk ? null : date);
    // A note that moved no longer lives at its old path; a new note made there later is a different note.
    for (const [from, to] of renamed) {
      if (!map.has(from)) continue;
      map.set(to, map.get(from));
      map.delete(from);
    }
    added = [];
    renamed = [];
  };
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i++].replace(/^\n/, '');
    if (token.startsWith('\x01')) {
      flush();
      date = token.slice(1);
    } else if (/^R\d*$/.test(token)) {
      renamed.push([tokens[i++], tokens[i++]]);
    } else if (token === 'A') {
      added.push(tokens[i++]);
    } else if (/^[MDT]$/.test(token)) {
      i++;
    } else if (token !== '') {
      throw new Error(`unexpected git log output: ${JSON.stringify(token.slice(0, 40))}`);
    }
  }
  flush();
  return map;
}

// The folders the contract covers, as SCHEMA_CLASSES names them. A name that
// is not a directory fails the readdir below and is skipped there.
//
// Below the folder itself only real directories are descended into: a
// directory link can loop, or lead out of the vault into files --apply would
// then rewrite. Any other .md entry is read, as before: on Windows a cloud-sync
// placeholder file is a reparse point, which is not isFile().
function listNotes(vaultRoot) {
  const notes = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(join(vaultRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (e.name.endsWith('.md')) notes.push(`${rel}/${e.name}`);
    }
  };
  for (const name of readdirSync(vaultRoot)) {
    if (SCHEMA_CLASSES.has(classifyVaultPath(`${name}/`))) walk(name);
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

  // Judged as the gate parses it, from the lines as they stand after the
  // renames above: a `created:` renamed to `date:` is not in `fm`.
  const current = parseFrontmatter(
    split[1] + groups.flatMap((g) => g.lines).join('\n') + split[3],
  ).fm;
  const dateValue = String(current.date ?? '');
  if (!DATE_RE.test(dateValue)) {
    if (addDate) {
      // Every date line goes, and the change names each, so none is lost unseen.
      // A block list's value is on its item lines, not the key line.
      const named = (g, i) =>
        [valueOf(i), ...g.lines.slice(1).map((l) => l.trim().replace(/^-\s*/, ''))]
          .filter(Boolean)
          .join(' ');
      const replaced = groups.map((g, i) => (g.key === 'date' ? named(g, i) : '')).filter(Boolean);
      for (let i; (i = indexOf('date')) !== -1; ) drop(i);
      append('date', addDate);
      const was = replaced.length ? `, replacing ${replaced.join(', ')}` : '';
      changes.push(`date: ${addDate} (first commit${was})`);
    } else {
      // The line stays: a malformed date is still the only record of one.
      const found = dateValue ? `date ${dateValue} is not YYYY-MM-DD` : 'no date';
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
  let addDates;
  let notes;
  try {
    if (!vaultRoot) throw new Error('no vault path is configured');
    addDates = buildAddDateMap(vaultRoot);
    notes = listNotes(vaultRoot);
  } catch (err) {
    console.error(`normalise-frontmatter: ${err.message}; nothing was scanned`);
    process.exitCode = 1;
    return;
  }

  let scanned = 0;
  let repaired = 0;
  const blocked = [];

  for (const rel of notes) {
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
