import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const HOOK = join(import.meta.dirname, '..', 'plugin', 'hooks', 'session-label.js');
// mkdtemp, not a fixed name: parallel test runs sharing one dir flake when
// one run's after() rmSync deletes another run's live transcripts.
const TMP = mkdtempSync(join(tmpdir(), 'session-label-test-'));

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

function runWithVault(sessionId, prompt, transcriptPath, vaultPath) {
  const input = JSON.stringify({ session_id: sessionId, prompt, transcript_path: transcriptPath, cwd: '/tmp' });
  execFileSync('node', [HOOK], {
    input, encoding: 'utf-8', timeout: 5000,
    env: { ...process.env, VAULT_PATH: vaultPath },
  });
  const labelFile = join(tmpdir(), `claude-session-label-${sessionId}.txt`);
  return existsSync(labelFile) ? readFileSync(labelFile, 'utf8') : null;
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
      'I need to fix the GraphQL subscriptions',
      'the websocket keeps dropping',
    ]));
    const label = run(sid, 'can you check the GraphQL subscription config?', transcript);
    assert.ok(label, 'label file should exist');
    assert.ok(/GraphQL|GQL/.test(label), `label should mention GraphQL, got: ${label}`);
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
      'I need to debug the failing tests in the MCP server',
    ]));
    const label = run(sid, 'fix the error in the mcp handler', transcript);
    assert.ok(label, 'label file should exist');
    assert.ok(label.includes('MCP'), `label should mention MCP, got: ${label}`);
    assert.ok(label.includes('debugging'), `label should mention debugging, got: ${label}`);
  });

  it('detects review action', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    writeFileSync(transcript, makeTranscript([
      'review this PR for the auth flow',
    ]));
    const label = run(sid, 'review the changes', transcript);
    assert.ok(label.includes('auth'), `expected auth, got: ${label}`);
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
    const label = run(sid, 'work on the trading grid bot', '/nonexistent/path.jsonl');
    assert.ok(label, 'label file should exist');
    assert.ok(label.includes('trading'), `expected trading, got: ${label}`);
  });

  it('truncates labels longer than 35 characters', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    writeFileSync(transcript, makeTranscript([
      'refactor the GraphQL subscriptions in the frontend component',
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
          { type: 'text', text: 'deploy the worker to Cloudflare' },
        ],
      },
    };
    writeFileSync(transcript, JSON.stringify(entry));
    const label = run(sid, 'ship it', transcript);
    assert.ok(label.includes('infra'), `expected infra, got: ${label}`);
    assert.ok(label.includes('deploying'), `expected deploying, got: ${label}`);
  });

  it('current prompt scores higher than a single old message', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    writeFileSync(transcript, makeTranscript(['working on the vault notes']));
    const label = run(sid, 'switch to the MCP server', transcript);
    assert.ok(label.startsWith('MCP'), `current prompt topic should rank first, got: ${label}`);
  });

  it('derives an instance topic from a 4-projects/ slug', () => {
    const vault = mkdtempSync(join(tmpdir(), 'll-label-vault-'));
    mkdirSync(join(vault, '4-projects'), { recursive: true });
    writeFileSync(join(vault, '4-projects', 'widget-co.md'), '# widget-co');
    const sid = randomUUID();
    const label = runWithVault(sid, 'fix the widget-co build', '/nonexistent.jsonl', vault);
    assert.ok(label && /widget[\s-]co/i.test(label), `expected widget-co topic, got: ${label}`);
    rmSync(vault, { recursive: true, force: true });
  });

  // Regression: the hook must read only the transcript TAIL
  // (TRANSCRIPT_TAIL_BYTES), not the whole file — transcripts reach tens of
  // MB and this runs on every prompt inside a 3s outer timeout. A giant early
  // line that falls outside the tail window must not influence the label.
  it('ignores transcript content beyond the tail window', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    const giantOldLine = JSON.stringify({
      type: 'user',
      message: { content: `we discussed graphql ${'pad '.repeat(80_000)}` }, // ~320KB > 256KB tail
    });
    const recent = makeTranscript([
      'keep working on the mobile ios build',
      'the mobile screen still flickers',
    ]);
    writeFileSync(transcript, `${giantOldLine}\n${recent}`);
    const label = run(sid, 'continue the mobile work please', transcript);
    assert.ok(label, 'label file should exist');
    assert.ok(label.includes('mobile'), `expected mobile, got: ${label}`);
    assert.ok(
      !/GraphQL|GQL/.test(label),
      `content outside the tail window must not score topics, got: ${label}`,
    );
  });

  it('source carries no hardcoded instance-name topic patterns', () => {
    const src = readFileSync(HOOK, 'utf8');
    assert.match(src, /4-projects|listProjectSlugs|readVaultProjectIndexSync/,
      'instance-topic derivation from 4-projects/ missing');
    assert.match(src, /allTopicPatterns\s*=\s*\[\s*\.\.\.instanceTopicPatterns\(\)/,
      'instance patterns must be spread first into allTopicPatterns');
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

describe('session-label dedupe levels across prompts', () => {
  // Regression: a note surfaced only as a one-line "Related notes" POINTER on
  // prompt 1 must still get its BODY injected when it is the best match on
  // prompt 2. Pre-fix, pointer paths were persisted into the dedupe state
  // indistinguishably from body-injected paths and filtered out wholesale for
  // the whole DEDUPE_WINDOW_MS.
  it('pointer-only note from prompt 1 is body-injected on prompt 2', () => {
    const base = mkdtempSync(join(tmpdir(), 'll-live-dedupe-'));
    try {
      const vault = join(base, 'vault');
      const pluginData = join(base, 'plugin-data');
      const home = join(base, 'home');
      const stubBin = join(pluginData, 'bin');
      mkdirSync(join(vault, 'notes'), { recursive: true });
      mkdirSync(home, { recursive: true });
      mkdirSync(stubBin, { recursive: true });

      writeFileSync(
        join(vault, 'notes', 'alpha.md'),
        'Alpha note body about hook injection ordering and budgets.\n',
      );
      writeFileSync(
        join(vault, 'notes', 'beta.md'),
        'Beta note body about dedupe windows and pointer suppression.\n',
      );

      // Stub returns the same two above-threshold hits on both prompts.
      const hits = JSON.stringify([
        { path: 'notes/alpha.md', title: 'alpha', score: 0.99 },
        { path: 'notes/beta.md', title: 'beta', score: 0.9 },
      ]);
      writeFileSync(join(stubBin, 'll-search'), `#!/bin/sh\nprintf '%s' '${hits}'\n`, {
        mode: 0o755,
      });

      const sid = randomUUID();
      const env = {
        ...process.env,
        HOME: home,
        TMPDIR: base,
        CLAUDE_PLUGIN_DATA: pluginData,
        VAULT_PATH: vault,
        LEARNING_LOOP_INJECTION_MODE: 'live',
        LEARNING_LOOP_INJECTION_THRESHOLD: '0.1',
        LEARNING_LOOP_INJECTION_RACE_CAP_MS: '20000',
      };
      const runPrompt = (prompt) =>
        execFileSync('node', [HOOK], {
          input: JSON.stringify({ session_id: sid, prompt, transcript_path: '', cwd: '/tmp' }),
          encoding: 'utf-8',
          timeout: 30000,
          env,
        });

      const out1 = runPrompt('tell me about hook injection ordering and budgets');
      assert.ok(out1.includes('Alpha note body'), 'prompt 1 must body-inject the top hit');
      assert.ok(out1.includes('notes/beta.md'), 'prompt 1 must list beta as a pointer');
      assert.ok(!out1.includes('Beta note body'), 'prompt 1 must not inject the pointer body');

      const out2 = runPrompt('now drill into dedupe windows and pointer suppression');
      assert.ok(
        out2.includes('Beta note body'),
        `pointer-seen note must be body-injected on the follow-up prompt; got: ${out2}`,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('session-label live injection scrubbing', () => {
  it('live mode scrubs secrets from injected context (parity with shadow)', () => {
    const base = mkdtempSync(join(tmpdir(), 'll-live-scrub-'));
    try {
      const vault = join(base, 'vault');
      const pluginData = join(base, 'plugin-data');
      const home = join(base, 'home');
      const stubBin = join(pluginData, 'bin');
      mkdirSync(join(vault, 'notes'), { recursive: true });
      mkdirSync(home, { recursive: true });
      mkdirSync(stubBin, { recursive: true });

      writeFileSync(
        join(vault, 'notes', 'aws-key-rotation.md'),
        'The deploy key AKIAIOSFODNN7EXAMPLE must be rotated quarterly. Keep the rotation runbook current.\n',
      );

      // Stub ll-search in <pluginData>/bin — findBinary()'s first slot, so it
      // beats a locally built native/target/release binary and any PATH entry.
      // It emits one above-threshold hit without a body, so the hook enriches
      // it by reading the vault note (which holds the secret).
      const hit = JSON.stringify([
        { path: 'notes/aws-key-rotation.md', title: 'aws-key-rotation', score: 0.99 },
      ]);
      writeFileSync(join(stubBin, 'll-search'), `#!/bin/sh\nprintf '%s' '${hit}'\n`, {
        mode: 0o755,
      });

      const input = JSON.stringify({
        session_id: randomUUID(),
        prompt: 'how should we rotate the AWS deploy key for the worker',
        transcript_path: '',
        cwd: '/tmp',
      });
      const out = execFileSync('node', [HOOK], {
        input,
        encoding: 'utf-8',
        timeout: 30000,
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: base,
          CLAUDE_PLUGIN_DATA: pluginData,
          VAULT_PATH: vault,
          LEARNING_LOOP_INJECTION_MODE: 'live',
          LEARNING_LOOP_INJECTION_THRESHOLD: '0.1',
          // Generous race cap: under full-suite load the 1500ms default can
          // abort the stub backend before it answers, failing the gate.
          LEARNING_LOOP_INJECTION_RACE_CAP_MS: '20000',
        },
      });

      assert.ok(out.length > 0, 'gate did not pass — stub arrangement broken, fix before judging the scrub');
      assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key leaked into live injection');
      assert.ok(out.includes('[REDACTED]'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
