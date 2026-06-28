import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'plugin');

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
// spawn/launch/dispatch/invoke/delegate are forbidden near agent names in
// agent-visible files — do not add "run" here. The e-final verbs (invoke,
// delegate) carry their inflections explicitly so "invoked"/"delegating" match
// without the (s|ing|es|ed) group double-matching the bare-stem verbs. The
// optional (?:re-?) prefix catches reinvoke/re-dispatch/relaunch — there is no
// word boundary inside "reinvoke", so the bare \\b alternation misses them.
const SPAWN_VERB =
  '(?:\\b(?:re-?)?(?:spawn|launch|dispatch)(?:s|ing|es|ed)?|\\b(?:re-?)?(?:invok|delegat)(?:e|es|ed|ing))\\b';
const SPAWN_RE = new RegExp(`${SPAWN_VERB}[^.\\n]*\\b(${AGENT_NAMES})\\b`, 'i');
const SPAWN_REV_RE = new RegExp(`\\b(${AGENT_NAMES})\\b[^.\\n]*${SPAWN_VERB}`, 'i');

test('no agent file instructs spawning another agent (M13)', () => {
  const offenders = [];
  for (const rel of mdFiles('agents')) {
    readFileSync(join(ROOT, rel), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (SPAWN_RE.test(line) || SPAWN_REV_RE.test(line))
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        if (line.includes('subagent_type')) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(
    offenders,
    [],
    'subagents cannot spawn subagents; fan-out belongs in the calling skill',
  );
});

test('every .md under agents/ has frontmatter (no phantom full-privilege agents) (M16)', () => {
  // Any frontmatter-less .md under agents/ auto-registers as a dispatchable
  // subagent with the default "All tools" grant. Shared instruction docs the
  // agents Read() must live OUTSIDE agents/ (agents-shared/), or they become
  // phantom full-privilege agents in the namespace. Regression guard for the
  // Foster Moore enterprise blocker.
  const offenders = mdFiles('agents').filter((rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    return !/^---\n[\s\S]*?\n---/.test(src);
  });
  assert.deepEqual(
    offenders,
    [],
    'frontmatter-less .md under agents/ registers as an All-tools phantom agent; move shared docs to agents-shared/',
  );
});

test('every directory under skills/ has a SKILL.md (no phantom skills) (M17)', () => {
  // A subdirectory of skills/ with no SKILL.md is a phantom skill: the harness
  // tries to register it and errors on load. Shared instruction docs the skills
  // Read() must live OUTSIDE skills/ (skills-shared/). Sibling of the agents/
  // phantom-agent rule (M16).
  const offenders = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      try {
        readFileSync(join(ROOT, 'skills', name, 'SKILL.md'));
        return false;
      } catch {
        return true;
      }
    });
  assert.deepEqual(
    offenders,
    [],
    'a skills/ subdir without SKILL.md errors on plugin load; move shared docs to skills-shared/',
  );
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
  assert.deepEqual(
    offenders,
    [],
    'use ${CLAUDE_PLUGIN_ROOT}/ (see agents-shared/vault-io.md Placeholders)',
  );
});

const ALLOWLISTED = [
  'note-scorer',
  'note-verifier',
  'correction-analyser',
  'gap-analyser',
  'discovery-vault-scout',
  'note-writer',
  'note-deepener',
  'literature-capturer',
  'discovery-researcher',
  'inbox-organiser',
  'refinement-proposer',
  'ingest-mapper-arch',
  'ingest-mapper-conventions',
  'ingest-mapper-domain',
  'ingest-mapper-stack',
  'ingest-mapper-state',
  'ingest-synthesizer',
  'ingest-context',
  'ingest-linear',
  'ingest-repo',
];

test('allowlisted agents declare tools: frontmatter (M14)', () => {
  for (const name of ALLOWLISTED) {
    const src = readFileSync(join(ROOT, 'agents', `${name}.md`), 'utf8');
    const fm = src.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${name}.md has no frontmatter block`);
    assert.match(fm[1], /^tools: \S/m, `${name}.md lost its tools: allowlist`);
  }
});
