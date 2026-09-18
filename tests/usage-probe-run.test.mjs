// tests/usage-probe-run.test.mjs
// The Stop-hook side of the automatic usage probe: join what retrieval
// surfaced to this session against what the transcript shows the session did,
// and emit note-usage events for the notes with evidence. Only those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUsageProbe } from '../plugin/scripts/lib/usage-probe-run.mjs';

const SID = 'sess-probe';

function setup({ queries = [], transcript = '' } = {}) {
  const pd = mkdtempSync(join(tmpdir(), 'll-probe-run-'));
  mkdirSync(join(pd, 'retrieval'), { recursive: true });
  mkdirSync(join(pd, 'provenance'), { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  writeFileSync(
    join(pd, 'retrieval', `queries-${month}.jsonl`),
    queries.map((q) => JSON.stringify(q)).join('\n'),
  );
  const tp = join(pd, 'transcript.jsonl');
  writeFileSync(tp, transcript);
  return { pd, transcriptPath: tp };
}

function events(pd) {
  const dir = join(pd, 'provenance');
  return readdirSync(dir)
    .filter((f) => f.startsWith('events-'))
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l)),
    )
    .filter((e) => e.action === 'note-usage');
}

const surfacedQuery = (paths) => ({
  ts: new Date().toISOString(),
  session_id: SID,
  command: 'query',
  top_paths: paths,
});

const readOf = (p) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `/v/${p}` } }] },
  });

test('emits a used event for a surfaced note the session read', () => {
  const { pd, transcriptPath } = setup({
    queries: [surfacedQuery(['3-permanent/alpha.md', '3-permanent/beta.md'])],
    transcript: readOf('3-permanent/alpha.md'),
  });
  try {
    const written = runUsageProbe({ pluginData: pd, sessionId: SID, transcriptPath });
    assert.equal(written, 1);
    const evs = events(pd);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].target, '3-permanent/alpha.md');
    assert.equal(evs[0].status, 'used');
    assert.deepEqual(evs[0].signals, ['read']);
    assert.equal(evs[0].session_id, SID, 'must carry the hook session id so the join works');
    assert.equal(
      evs[0].source,
      'probe',
      'a mechanical verdict must be distinguishable from /reflect',
    );
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('emits nothing for surfaced notes without evidence', () => {
  // The critical honesty property: classifyUsage folds any non-'used' status
  // to 'ignored', so silence is the only safe way to say "I cannot tell".
  const { pd, transcriptPath } = setup({
    queries: [surfacedQuery(['3-permanent/alpha.md', '3-permanent/untouched.md'])],
    transcript: readOf('3-permanent/alpha.md'),
  });
  try {
    runUsageProbe({ pluginData: pd, sessionId: SID, transcriptPath });
    const paths = events(pd).map((e) => e.target);
    assert.deepEqual(paths, ['3-permanent/alpha.md']);
    assert.ok(!paths.includes('3-permanent/untouched.md'));
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('never emits an ignored event', () => {
  const { pd, transcriptPath } = setup({
    queries: [surfacedQuery(['3-permanent/a.md', '3-permanent/b.md', '3-permanent/c.md'])],
    transcript: readOf('3-permanent/a.md'),
  });
  try {
    runUsageProbe({ pluginData: pd, sessionId: SID, transcriptPath });
    assert.ok(events(pd).every((e) => e.status === 'used'));
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('does not re-emit for a session it already probed', () => {
  const { pd, transcriptPath } = setup({
    queries: [surfacedQuery(['3-permanent/alpha.md'])],
    transcript: readOf('3-permanent/alpha.md'),
  });
  try {
    assert.equal(runUsageProbe({ pluginData: pd, sessionId: SID, transcriptPath }), 1);
    assert.equal(runUsageProbe({ pluginData: pd, sessionId: SID, transcriptPath }), 0);
    assert.equal(events(pd).length, 1);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('stands down when /reflect already judged this session', () => {
  // The model's verdict is richer: it can see `informed`, which the probe
  // cannot. Two verdicts for one session would double-count the same use.
  const { pd, transcriptPath } = setup({
    queries: [surfacedQuery(['3-permanent/alpha.md'])],
    transcript: readOf('3-permanent/alpha.md'),
  });
  try {
    const month = new Date().toISOString().slice(0, 7);
    writeFileSync(
      join(pd, 'provenance', `events-${month}.jsonl`),
      JSON.stringify({
        ts: new Date().toISOString(),
        session_id: SID,
        action: 'note-usage',
        target: '3-permanent/other.md',
        status: 'ignored',
      }),
    );
    assert.equal(runUsageProbe({ pluginData: pd, sessionId: SID, transcriptPath }), 0);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('a session with nothing surfaced writes nothing', () => {
  const { pd, transcriptPath } = setup({ queries: [], transcript: readOf('3-permanent/alpha.md') });
  try {
    assert.equal(runUsageProbe({ pluginData: pd, sessionId: SID, transcriptPath }), 0);
    assert.deepEqual(events(pd), []);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('an unreadable transcript is survived, not thrown', () => {
  const { pd } = setup({ queries: [surfacedQuery(['3-permanent/alpha.md'])] });
  try {
    assert.equal(
      runUsageProbe({ pluginData: pd, sessionId: SID, transcriptPath: join(pd, 'nope.jsonl') }),
      0,
    );
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('another session surfacing a note does not count for this one', () => {
  const { pd, transcriptPath } = setup({
    queries: [{ ...surfacedQuery(['3-permanent/alpha.md']), session_id: 'someone-else' }],
    transcript: readOf('3-permanent/alpha.md'),
  });
  try {
    assert.equal(runUsageProbe({ pluginData: pd, sessionId: SID, transcriptPath }), 0);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('finds engagement that happened early in a long session', () => {
  // Regression: the first version read only the last 1MB, on the theory that
  // engagement lives in recent turns. Against a real 4.5MB session it found
  // nothing, because the note writes had happened an hour earlier. The
  // failure mode is a silent false negative, which is precisely what corrupts
  // the ground truth this probe exists to improve.
  const early = readOf('3-permanent/alpha.md');
  const filler = Array.from({ length: 4000 }, (_, i) =>
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `padding turn ${i} `.repeat(20) }] },
    }),
  ).join('\n');
  const { pd, transcriptPath } = setup({
    queries: [surfacedQuery(['3-permanent/alpha.md'])],
    transcript: `${early}\n${filler}`,
  });
  try {
    assert.ok(
      readFileSync(transcriptPath).length > 1_048_576,
      'fixture must exceed the old window',
    );
    assert.equal(runUsageProbe({ pluginData: pd, sessionId: SID, transcriptPath }), 1);
    assert.equal(events(pd)[0].target, '3-permanent/alpha.md');
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});
