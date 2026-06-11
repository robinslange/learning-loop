import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

function mdFiles(dir) {
  return readdirSync(join(ROOT, dir), { recursive: true })
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

const AGENT_NAMES =
  'note-writer|note-verifier|note-scorer|note-deepener|gap-analyser|correction-analyser|' +
  'discovery-researcher|discovery-vault-scout|inbox-organiser|literature-capturer|' +
  'refinement-proposer|ingest-[a-z-]+';
// Lexical contract: "run" is the sanctioned wording for skill-executed fragments
// (route-output, ingest-synthesizer's "run automatically by note-writer");
// spawn/launch/dispatch are forbidden near agent names in agent-visible files — do not add "run" here.
const SPAWN_VERB = '\\b(spawn|launch|dispatch)(s|ing|es|ed)?\\b';
const SPAWN_RE = new RegExp(`${SPAWN_VERB}[^.\\n]*\\b(${AGENT_NAMES})\\b`, 'i');
const SPAWN_REV_RE = new RegExp(`\\b(${AGENT_NAMES})\\b[^.\\n]*${SPAWN_VERB}`, 'i');

test('no agent file instructs spawning another agent (M13)', () => {
  const offenders = [];
  for (const rel of mdFiles('agents')) {
    readFileSync(join(ROOT, rel), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (SPAWN_RE.test(line) || SPAWN_REV_RE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        if (!rel.includes('_skills/') && line.includes('subagent_type')) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(offenders, [], 'subagents cannot spawn subagents; fan-out belongs in the calling skill');
});

test('no PLUGIN/ placeholder remains in agents/ or skills/ (M15)', () => {
  const offenders = [];
  for (const rel of [...mdFiles('agents'), ...mdFiles('skills')]) {
    readFileSync(join(ROOT, rel), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (line.includes('PLUGIN/')) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(offenders, [], 'use ${CLAUDE_PLUGIN_ROOT}/ (see agents/_skills/vault-io.md Placeholders)');
});

const ALLOWLISTED = [
  'note-scorer', 'note-verifier', 'correction-analyser', 'gap-analyser',
  'discovery-vault-scout', 'note-writer', 'note-deepener', 'literature-capturer',
  'discovery-researcher', 'inbox-organiser',
  'ingest-mapper-arch', 'ingest-mapper-conventions', 'ingest-mapper-domain',
  'ingest-mapper-stack', 'ingest-mapper-state', 'ingest-synthesizer',
];

test('allowlisted agents declare tools: frontmatter (M14)', () => {
  for (const name of ALLOWLISTED) {
    const src = readFileSync(join(ROOT, 'agents', `${name}.md`), 'utf8');
    const fm = src.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${name}.md has no frontmatter block`);
    assert.match(fm[1], /^tools: \S/m, `${name}.md lost its tools: allowlist`);
  }
});
