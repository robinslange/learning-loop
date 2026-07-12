// Tests for scripts/strip-reflect-sid.mjs — the node replacement for the
// /reflect Step 4.6.g python3 per-note reflect_sid strip.
//
// Two things it must get right, both from the reflect-improvements plan:
//   1. (S2) Fold N python3 spawns (one per note in a while-loop) into ONE node
//      pass reading the new-notes file. Strip the transient `reflect_sid:` stamp
//      from each note's frontmatter; write only if changed; skip missing files.
//   2. (QW7) Frontmatter-SCOPE the strip. The old whole-file `re.sub(count=1)`
//      could remove a col-0 `reflect_sid:` line from a note BODY (plausible in a
//      vault that documents this plugin's internals). Only the frontmatter stamp
//      may be removed; a body line that happens to start with `reflect_sid:`
//      must survive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT = new URL('../plugin/scripts/strip-reflect-sid.mjs', import.meta.url).pathname;

function run(newNotesContent, dir) {
  const listFile = join(dir, 'new-notes.txt');
  writeFileSync(listFile, newNotesContent);
  return execFileSync('node', [SCRIPT, '--stdin'], {
    input: readFileSync(listFile),
    encoding: 'utf-8',
  });
}

test('strips the reflect_sid stamp from frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strip-fm-'));
  try {
    const note = join(dir, 'a.md');
    writeFileSync(note, '---\nname: a\nreflect_sid: sess-123\ntags: [x]\n---\n\nBody text.\n');
    run(note + '\n', dir);
    const out = readFileSync(note, 'utf-8');
    assert.ok(!/^reflect_sid:/m.test(out.split('---')[1]), 'reflect_sid gone from frontmatter');
    assert.match(out, /name: a/);
    assert.match(out, /tags: \[x\]/);
    assert.match(out, /Body text\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does NOT strip a reflect_sid line in the body (QW7 frontmatter-scoping)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strip-body-'));
  try {
    const note = join(dir, 'b.md');
    // frontmatter stamp present AND a body line that starts with reflect_sid:
    const body = 'This note documents the marker.\nreflect_sid: is the field name we strip.\n';
    writeFileSync(note, `---\nname: b\nreflect_sid: sess-9\n---\n\n${body}`);
    run(note + '\n', dir);
    const out = readFileSync(note, 'utf-8');
    const [, fm, ...rest] = out.split('---');
    assert.ok(!/^reflect_sid:/m.test(fm), 'frontmatter stamp stripped');
    assert.match(
      rest.join('---'),
      /reflect_sid: is the field name we strip\./,
      'body line survives',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('leaves a note without the stamp untouched (idempotent, no rewrite)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strip-noop-'));
  try {
    const note = join(dir, 'c.md');
    const original = '---\nname: c\n---\n\nBody.\n';
    writeFileSync(note, original);
    run(note + '\n', dir);
    assert.equal(readFileSync(note, 'utf-8'), original, 'unchanged byte-for-byte');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skips missing files without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strip-missing-'));
  try {
    const missing = join(dir, 'nope.md');
    const real = join(dir, 'real.md');
    writeFileSync(real, '---\nname: real\nreflect_sid: s\n---\nBody.\n');
    // missing first, real second — must process real despite the gap
    run(`${missing}\n${real}\n`, dir);
    assert.ok(!/^reflect_sid:/m.test(readFileSync(real, 'utf-8').split('---')[1]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strips the stamp from a CRLF note and preserves the rest byte-for-byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strip-crlf-'));
  try {
    const note = join(dir, 'e.md');
    writeFileSync(
      note,
      '---\r\nname: e\r\nreflect_sid: sess-42\r\ntags: [x]\r\n---\r\n\r\nBody text.\r\n',
    );
    run(note + '\n', dir);
    const out = readFileSync(note, 'utf-8');
    assert.equal(out, '---\r\nname: e\r\ntags: [x]\r\n---\r\n\r\nBody text.\r\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handles a note with no frontmatter block (body-only) without stripping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strip-nofm-'));
  try {
    const note = join(dir, 'd.md');
    const original = 'reflect_sid: this is just prose, no frontmatter fence at all.\n';
    writeFileSync(note, original);
    run(note + '\n', dir);
    assert.equal(readFileSync(note, 'utf-8'), original, 'no frontmatter -> nothing stripped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
