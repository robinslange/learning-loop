import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'plugin');

function skillMd(name) {
  return readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
}

test('uninstall is operator-only (disable-model-invocation: true)', () => {
  // uninstall walks rm -rf of the captured-index data dir. Every other
  // destructive operator-only skill (harvest, seed, rewrite, init) sets the
  // flag; a model-invocable uninstall is a self-destruct button.
  const fm = skillMd('uninstall').match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, 'uninstall/SKILL.md has no frontmatter block');
  assert.match(fm[1], /^disable-model-invocation: true$/m);
});

test('dream operators emit provenance in the canonical node form with the bucket field', () => {
  // provenance-consolidate.mjs buckets on event.skill first (skill || agent ||
  // action). Operators that omit "skill" and the node prefix rely on the file
  // being executable and fall through to the agent field, diverging from
  // dream/SKILL.md's canonical emit form.
  const dir = join(ROOT, 'skills', 'dream', 'operators');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 7, 'expected exactly seven dream operator files');
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.match(
      src,
      /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/provenance-emit\.js"/,
      `${f} must invoke provenance-emit.js with a node prefix`,
    );
    assert.ok(src.includes('"skill":"dream"'), `${f} must carry the "skill" bucket field`);
  }
});

test('paths-preamble pointers resolve (shared doc exists, known skills reference it)', () => {
  assert.ok(
    existsSync(join(ROOT, 'skills-shared', 'paths-preamble.md')),
    'skills-shared/paths-preamble.md missing while skills point at it',
  );
  for (const name of ['init', 'seed', 'doctor', 'harvest', 'federation']) {
    assert.ok(
      skillMd(name).includes('skills-shared/paths-preamble.md'),
      `${name}/SKILL.md lost its paths-preamble pointer (do not re-inline the preamble)`,
    );
  }
});

test('rewrite wires federation retraction notify', () => {
  // retraction-notify.mjs is the only path by which federation peers learn a
  // note they hold was retracted; rewrite executes retractions end-to-end and
  // must invoke it (gated on federation-active, fail-soft).
  const src = skillMd('rewrite');
  assert.ok(src.includes('retraction-notify.mjs'), 'rewrite/SKILL.md must invoke retraction-notify.mjs');
  assert.ok(src.includes('federation-active.mjs'), 'retraction notify must be gated on federation-active.mjs');
});
