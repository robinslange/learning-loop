import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'session-label.js');
const TMP = join(tmpdir(), 'session-label-test');

function makeTranscript(userMessages) {
  return userMessages
    .map(msg => JSON.stringify({ type: 'user', message: { content: msg } }))
    .join('\n');
}

function run(sessionId, prompt, transcriptPath, cwd = '/tmp') {
  const input = JSON.stringify({
    session_id: sessionId,
    prompt,
    transcript_path: transcriptPath,
    cwd,
  });
  execFileSync('node', [HOOK], {
    input,
    encoding: 'utf-8',
    timeout: 5000,
  });
  const labelFile = join(tmpdir(), `claude-session-label-${sessionId}.txt`);
  if (existsSync(labelFile)) return readFileSync(labelFile, 'utf8');
  return null;
}

describe('session-label', () => {
  before(() => {
    mkdirSync(TMP, { recursive: true });
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('produces a label for a clear topic', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    writeFileSync(transcript, makeTranscript([
      'I need to fix the Thalen iOS build',
      'the simulator crashes on launch',
    ]));
    const label = run(sid, 'can you check the Thalen build config?', transcript);
    assert.ok(label, 'label file should exist');
    assert.ok(label.includes('Thalen'), `label should mention Thalen, got: ${label}`);
  });

  it('handles empty transcript', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    writeFileSync(transcript, '');
    const label = run(sid, 'hello', transcript);
    assert.ok(label !== null, 'label file should exist');
  });

  it('falls back to cwd basename when no patterns match', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    writeFileSync(transcript, makeTranscript([
      'what is the weather like today',
    ]));
    const label = run(sid, 'just chatting about nothing specific', transcript, '/Users/robin/myproject');
    assert.ok(label !== null, 'label file should exist');
    assert.equal(label, 'myproject');
  });

  it('detects action patterns like debug', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    writeFileSync(transcript, makeTranscript([
      'I need to debug the failing tests in Kinso',
    ]));
    const label = run(sid, 'fix the error in the dashboard', transcript);
    assert.ok(label, 'label file should exist');
    assert.ok(label.includes('Kinso'), `label should mention Kinso, got: ${label}`);
    assert.ok(label.includes('debugging'), `label should mention debugging, got: ${label}`);
  });

  it('detects review action', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    writeFileSync(transcript, makeTranscript([
      'review this PR for Solenoid',
    ]));
    const label = run(sid, 'review the changes', transcript);
    assert.ok(label.includes('Solenoid'), `expected Solenoid, got: ${label}`);
    assert.ok(label.includes('review'), `expected review, got: ${label}`);
  });

  it('does not crash on malformed transcript lines', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    writeFileSync(transcript, [
      'not json at all',
      '{"type": "user", "message": {"content": "work on the vault plugin"}}',
      '{invalid json}',
      '{"type": "assistant", "message": "ignored"}',
    ].join('\n'));
    const label = run(sid, 'continue with the plugin', transcript);
    assert.ok(label, 'label file should exist');
    assert.ok(label.includes('plugin'), `expected plugin, got: ${label}`);
  });

  it('does not crash when transcript file is missing', () => {
    const sid = randomUUID();
    const label = run(sid, 'work on Nibbler trading bot', '/nonexistent/path.jsonl');
    assert.ok(label, 'label file should exist');
    assert.ok(label.includes('Nibbler'), `expected Nibbler, got: ${label}`);
  });

  it('truncates labels longer than 35 characters', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    writeFileSync(transcript, makeTranscript([
      'refactor the GraphQL subscriptions in the Kinso frontend',
      'also review the authentication flow',
    ]));
    const label = run(sid, 'refactor the GraphQL subscription auth layer', transcript);
    assert.ok(label.length <= 35, `label should be <= 35 chars, got ${label.length}: "${label}"`);
  });

  it('exits cleanly with empty stdin', () => {
    const result = execFileSync('node', [HOOK], {
      input: '',
      encoding: 'utf-8',
      timeout: 5000,
    });
    assert.equal(result.trim(), '');
  });

  it('exits cleanly with no session_id', () => {
    const input = JSON.stringify({ prompt: 'hello' });
    const result = execFileSync('node', [HOOK], {
      input,
      encoding: 'utf-8',
      timeout: 5000,
    });
    assert.equal(result.trim(), '');
  });

  it('handles array content blocks in transcript', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    const entry = {
      type: 'user',
      message: {
        content: [
          { type: 'text', text: 'deploy the Solenoid worker to Cloudflare' },
        ],
      },
    };
    writeFileSync(transcript, JSON.stringify(entry));
    const label = run(sid, 'ship it', transcript);
    assert.ok(label.includes('Solenoid'), `expected Solenoid, got: ${label}`);
    assert.ok(label.includes('deploying'), `expected deploying, got: ${label}`);
  });

  it('current prompt scores higher than a single old message', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    // One old message about Kinso (will get weight 3 as recent), prompt about Thalen (weight 10)
    writeFileSync(transcript, makeTranscript(['working on Kinso']));
    const label = run(sid, 'switch to Thalen', transcript);
    // Kinso: weight 3, Thalen: weight 10 -- Thalen should be primary topic
    assert.ok(label.startsWith('Thalen'), `current prompt topic should rank first, got: ${label}`);
  });
});

describe('session-label stdout contract', () => {
  function runCapturingStdout(env, prompt = 'test question about hooks and injection') {
    const input = JSON.stringify({
      session_id: randomUUID(),
      prompt,
      transcript_path: '',
      cwd: '/tmp',
    });
    return execFileSync('node', [HOOK], {
      input,
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, ...env },
    });
  }

  it('produces empty stdout in shadow mode', () => {
    const out = runCapturingStdout({ LEARNING_LOOP_INJECTION_MODE: 'shadow' });
    assert.equal(out, '');
  });

  it('produces empty stdout when mode is off', () => {
    const out = runCapturingStdout({ LEARNING_LOOP_INJECTION_MODE: 'off' });
    assert.equal(out, '');
  });

  it('produces empty stdout on gate-fail path', () => {
    const emptyVault = mkdtempSync(join(tmpdir(), 'll-empty-vault-'));
    try {
      const out = runCapturingStdout({
        LEARNING_LOOP_INJECTION_MODE: 'live',
        VAULT_PATH: emptyVault,
      }, 'obscure nonsense that will not match anything in any vault anywhere xyzzy');
      assert.equal(out, '');
    } finally {
      rmSync(emptyVault, { recursive: true, force: true });
    }
  });

  it('produces empty stdout when pipeline throws', () => {
    const out = runCapturingStdout({ LEARNING_LOOP_INJECTION_FORCE_ERROR: '1' });
    assert.equal(out, '');
  });
});
