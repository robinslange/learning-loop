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

test('durable ingest mappers self-contain the full ack schema (M19)', () => {
  // ingest/SKILL.md Step 6 validates every durable mapper ack for focus,
  // status, and doc_path, but each mapper is dispatched with only its own
  // definition file. A mapper whose Return section doesn't spell out those
  // fields is being validated against a schema it was never given (the
  // "Same ack JSON shape as stack mapper" drift).
  for (const focus of ['stack', 'arch', 'conventions', 'domain']) {
    const src = readFileSync(join(ROOT, 'agents', `ingest-mapper-${focus}.md`), 'utf8');
    for (const field of ['"focus"', '"doc_path"', '"status"']) {
      assert.ok(
        src.includes(field),
        `ingest-mapper-${focus}.md must define ${field} in its ack schema; the coordinator validates it`,
      );
    }
  }
});

test('ingest-synthesizer emits the extract-insights item schema (M20)', () => {
  // The deep-ingest synthesizer feeds the SAME preview + route-output stages
  // as single-pass extract-insights. Its output items must carry the canonical
  // fields those stages consume (type/confidence/source_ids under a
  // confirmed_insights array), not the drifted durable_insights/sources/tags
  // shape that preview-format could not render.
  const src = readFileSync(join(ROOT, 'agents', 'ingest-synthesizer.md'), 'utf8');
  for (const needed of ['"confirmed_insights"', '"confidence"', '"source_ids"', '"type"']) {
    assert.ok(src.includes(needed), `ingest-synthesizer.md output schema must include ${needed}`);
  }
  for (const banned of ['durable_insights', '"sources"', '"tags"']) {
    assert.ok(
      !src.includes(banned),
      `ingest-synthesizer.md still carries drifted schema key ${banned}`,
    );
  }
});

test('harvest bundle handoff has a receiving side in ingest (M21)', () => {
  // harvest tells the operator to absorb the bundle with /ingest; for a year
  // ingest had no bundle mode, so the pointer led to a door that didn't exist.
  const ingest = readFileSync(join(ROOT, 'skills', 'ingest', 'SKILL.md'), 'utf8');
  assert.ok(
    /HARVEST-MANIFEST\.md/.test(ingest),
    'ingest must implement the harvest-bundle restore flow',
  );
  const harvest = readFileSync(join(ROOT, 'skills', 'harvest', 'SKILL.md'), 'utf8');
  assert.ok(
    /ingest bundle/.test(harvest),
    'harvest must point the operator at the ingest bundle mode',
  );
});

test('no skill/agent hardcodes an unsuffixed plugin-data fallback (M18)', () => {
  // The real data dir is marketplace-suffixed (learning-loop-learning-loop-
  // marketplace). Skills that documented "~/.claude/plugins/data/learning-loop"
  // as the fallback read a nonexistent (or stale) dir and their own
  // skip-silently-if-missing rules swallowed the miss. resolve-paths.mjs exists
  // so prose never hardcodes this; the suffixed literal stays allowed only in
  // uninstall/SKILL.md, where the operator must see the exact rm -rf target.
  const offenders = [];
  const dirs = ['agents', 'agents-shared', 'skills', 'skills-shared'];
  for (const rel of dirs.flatMap(mdFiles)) {
    readFileSync(join(ROOT, rel), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/plugins\/data\/learning-loop(?!-learning-loop-marketplace)/.test(line))
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        if (
          /plugins\/data\/learning-loop-learning-loop-marketplace/.test(line) &&
          !rel.endsWith(join('uninstall', 'SKILL.md'))
        )
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(
    offenders,
    [],
    'resolve PLUGIN_DATA via scripts/resolve-paths.mjs, never a hardcoded fallback',
  );
});

test('researcher agents do not list raw WebSearch/WebFetch (routed via source gateway)', () => {
  const routed = ['discovery-researcher', 'literature-capturer', 'note-deepener', 'note-verifier', 'note-writer'];
  for (const name of routed) {
    const src = readFileSync(join(ROOT, 'agents', `${name}.md`), 'utf8');
    const fm = src.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${name}.md has no frontmatter block`);
    const toolsLine = fm[1].split('\n').find((l) => l.startsWith('tools:'));
    assert.ok(toolsLine, `${name}.md has no tools: line`);
    assert.doesNotMatch(toolsLine, /\bWebSearch\b/, `${name}.md still lists WebSearch — route it via source-gateway.mjs`);
    assert.doesNotMatch(toolsLine, /\bWebFetch\b/, `${name}.md still lists WebFetch — route it via source-gateway.mjs`);
  }
});
