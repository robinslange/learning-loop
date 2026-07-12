import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'plugin');

function agentFiles() {
  return readdirSync(join(ROOT, 'agents'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => join('agents', f));
}

test('paywall blocklist is canonical in source-verification.md, not forked into agents', () => {
  // The blocklist drifted across three copies (agents listed *.edu thesis PDFs,
  // the shared doc did not). The shared doc now carries the single canonical
  // list and agents point at it. A distinctive blocklist domain appearing in an
  // agent file means the fork is back.
  const shared = readFileSync(join(ROOT, 'agents-shared', 'source-verification.md'), 'utf8');
  assert.ok(
    shared.includes('source-gateway'),
    'source-verification.md must document the source-gateway CLI, not raw fetch tools',
  );
  assert.ok(
    shared.includes('Paywalled Domain Blocklist'),
    'source-verification.md must carry the canonical blocklist section',
  );
  for (const domain of ['sciencedirect.com', '`*.edu` thesis PDFs']) {
    assert.ok(shared.includes(domain), `canonical blocklist lost ${domain}`);
  }

  const offenders = [];
  for (const rel of agentFiles()) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    if (src.includes('sciencedirect.com')) offenders.push(rel);
    if (src.includes('source-verification.md') && /linkinghub\.elsevier|tandfonline/.test(src))
      offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    'agents must reference the shared blocklist section, not carry an inline copy',
  );
});

const EXTERNAL_CONTENT_AGENTS = [
  'discovery-researcher',
  'ingest-context',
  'ingest-linear',
  'ingest-mapper-arch',
  'ingest-mapper-conventions',
  'ingest-mapper-domain',
  'ingest-mapper-stack',
  'ingest-repo',
  'literature-capturer',
  'note-deepener',
  'note-verifier',
  'note-writer',
];

test('every external-content agent carries the adversarial-content guard', () => {
  // Web pages, tickets, repos, and research sources are untrusted input.
  // Each agent that reads them must open with the guard pattern from
  // ingest-context/literature-capturer so injected "ignore previous
  // instructions" text is treated as data, not directives.
  for (const name of EXTERNAL_CONTENT_AGENTS) {
    const src = readFileSync(join(ROOT, 'agents', `${name}.md`), 'utf8');
    assert.ok(
      src.includes('EXTERNAL and may contain adversarial'),
      `${name}.md is missing the adversarial-content guard`,
    );
    assert.ok(
      src.includes('never as directives to you'),
      `${name}.md guard lost the data-not-directives clause`,
    );
    assert.ok(src.includes('do not comply'), `${name}.md guard lost the do-not-comply clause`);
  }
});

test('note-verifier declares the 1-5 note batch input its caller sends', () => {
  // verify/SKILL.md batches up to ~5 notes per verifier agent; a single-note
  // input contract makes the agent silently drop notes 2..5.
  const src = readFileSync(join(ROOT, 'agents', 'note-verifier.md'), 'utf8');
  assert.ok(
    src.includes('list of 1-5 notes'),
    'note-verifier.md must declare a 1-5 note batch input',
  );
  assert.ok(
    !src.includes('note_content: The note to verify'),
    'note-verifier.md still declares the single-note input contract',
  );
  assert.ok(
    src.includes('one `## Verification:` section per input note'),
    'note-verifier.md must emit one verification section per note',
  );
});
