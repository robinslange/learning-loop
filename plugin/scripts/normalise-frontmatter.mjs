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
import {
  ALIASES,
  DATE_RE,
  STATUS_VALUES,
  checkFrontmatter,
  hasUngroundedFactualSignal,
} from './lib/frontmatter-schema.mjs';

const FOLDERS = ['0-inbox', '1-fleeting', '2-literature', '3-permanent'];
const FM_SPLIT_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/;

// One `git log` walk instead of 5600 per-file invocations. --reverse puts the
// oldest commit first, so the first time a path appears is the commit that
// added it. --relative is load-bearing: the vault is usually a subdirectory of
// its repo, and git otherwise reports repo-root-relative paths that never match
// a vault-relative lookup, silently sending every note to the mtime fallback.
function buildAddDateMap(vaultRoot) {
  const map = new Map();
  let out;
  try {
    out = execFileSync(
      'git',
      [
        'log',
        '--reverse',
        '--diff-filter=A',
        '--relative',
        '--date=short',
        '--format=@%ad',
        '--name-only',
      ],
      { cwd: vaultRoot, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
    );
  } catch {
    return map;
  }
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('@')) current = line.slice(1).trim();
    else if (line && current && !map.has(line)) map.set(line, current);
  }
  return map;
}

function listNotes(vaultRoot) {
  const notes = [];
  for (const folder of FOLDERS) {
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

// A sourceless note is only honest as synthesis when it asserts nothing a
// reader could check. Anything with a bare figure or attribution owes a URL,
// and saying so out loud beats laundering it through the synthesis exemption.
// Deliberately does NOT stamp synthesis_validated: the downstream audit still
// gets to run.
function inferSource(body) {
  return hasUngroundedFactualSignal(body) ? '"[no URL found]"' : 'synthesis';
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

function repair(raw, relPath, addDate) {
  const split = raw.match(FM_SPLIT_RE);
  if (!split) return { changes: [], unfixable: ['no frontmatter block'] };

  const { fm, body } = parseFrontmatter(raw);
  const groups = groupLines(split[2].split(/\r?\n/));
  const ordered = reorder(groups);
  const misordered = ordered.some((g, i) => g !== groups[i]);

  const violations = checkFrontmatter(fm);
  if (violations.length === 0 && !misordered) return { changes: [], unfixable: [] };

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

  if (indexOf('date') === -1 || !DATE_RE.test(String(fm.date ?? ''))) {
    if (indexOf('date') !== -1) drop(indexOf('date'));
    if (addDate) {
      append('date', addDate);
      changes.push(`date: ${addDate} (first commit)`);
    } else {
      unfixable.push('no date and no git history');
    }
  }

  if (indexOf('source') === -1) {
    const value = inferSource(body);
    append('source', value);
    changes.push(`source: ${value}`);
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

const args = process.argv.slice(2);
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

  const fallback = isoDate(statSync(abs).mtime);
  const { changes, unfixable, next } = repair(raw, rel, addDates.get(rel) || fallback);

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
