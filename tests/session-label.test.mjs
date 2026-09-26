import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { skipOnWindows } from './helpers/platform.mjs';
import { runHook } from './helpers/hook-runner.mjs';
import { composeLabel, topicPatterns } from '../plugin/hooks/session-label.js';

const HOOK = join(import.meta.dirname, '..', 'plugin', 'hooks', 'session-label.js');
// mkdtemp, not a fixed name: parallel test runs sharing one dir flake when
// one run's after() rmSync deletes another run's live transcripts. It is also
// the hook's TMPDIR, so label files land here instead of the shared OS tmp.
const TMP = mkdtempSync(join(tmpdir(), 'session-label-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Every spawn goes through hook-runner: a minimal env with a fresh HOME and
// CLAUDE_PLUGIN_DATA per call, so nothing the developer's shell exports
// (VAULT_PATH, LEARNING_LOOP_*) reaches the hook unless a case passes it here.
// The impact gate would drop most fixture prompts before retrieval. These
// tests exercise dedupe, scrubbing and telemetry, not the gate, so the floor
// is pinned off unless a case overrides it.
function hook(stdin, { env, seed, timeoutMs } = {}) {
  const r = runHook(HOOK, {
    stdin,
    seed,
    timeoutMs,
    env: { TMPDIR: TMP, LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: '0', ...env },
  });
  r.cleanup();
  assert.equal(r.exitCode, 0, `hook exited ${r.exitCode}: ${r.stderr}`);
  return r;
}

function labelOf(sessionId) {
  const labelFile = join(TMP, `claude-session-label-${sessionId}.txt`);
  return existsSync(labelFile) ? readFileSync(labelFile, 'utf8') : null;
}

function makeTranscript(userMessages) {
  return userMessages
    .map((msg) => JSON.stringify({ type: 'user', message: { content: msg } }))
    .join('\n');
}

function run(sessionId, prompt, transcriptPath, cwd = '/tmp', env = {}) {
  hook({ session_id: sessionId, prompt, transcript_path: transcriptPath, cwd }, { env });
  return labelOf(sessionId);
}

// Messages oldest first, current prompt last, as the hook passes them.
function label(messages, { labelTopics = [], projectSlugs = [], cwd = '/tmp' } = {}) {
  return composeLabel(messages, topicPatterns(labelTopics, projectSlugs), cwd);
}

describe('composeLabel', () => {
  it('produces a label for a clear topic', () => {
    const l = label([
      'I need to fix the GraphQL subscriptions',
      'the websocket keeps dropping',
      'can you check the GraphQL subscription config?',
    ]);
    assert.ok(/GraphQL|GQL/.test(l), `label should mention GraphQL, got: ${l}`);
  });

  it('falls back to cwd basename when no patterns match', () => {
    const l = label(['what is the weather like today', 'just chatting about nothing specific'], {
      cwd: '/Users/robin/myproject',
    });
    assert.equal(l, 'myproject');
  });

  it('detects action patterns like debug', () => {
    const l = label([
      'I need to debug the failing tests in the MCP server',
      'fix the error in the mcp handler',
    ]);
    assert.ok(l.includes('MCP'), `label should mention MCP, got: ${l}`);
    assert.ok(l.includes('debugging'), `label should mention debugging, got: ${l}`);
  });

  it('detects review action', () => {
    const l = label(['review this PR for the auth flow', 'review the changes']);
    assert.ok(l.includes('auth'), `expected auth, got: ${l}`);
    assert.ok(l.includes('review'), `expected review, got: ${l}`);
  });

  it('truncates labels longer than 35 characters', () => {
    const l = label([
      'refactor the GraphQL subscriptions in the frontend component',
      'also review the authentication flow',
      'refactor the GraphQL subscription auth layer',
    ]);
    assert.ok(l.length <= 35, `label should be <= 35 chars, got ${l.length}: "${l}"`);
    assert.ok(l.endsWith('…'), `a cut label ends in an ellipsis, got: "${l}"`);
  });

  it('current prompt scores higher than a single old message', () => {
    const l = label(['working on the vault notes', 'switch to the MCP server']);
    assert.ok(l.startsWith('MCP'), `current prompt topic should rank first, got: ${l}`);
  });

  it('derives an instance topic from a 4-projects/ slug', () => {
    const l = label(['fix the widget-co build'], { projectSlugs: ['widget-co'] });
    assert.ok(/widget[\s-]co/i.test(l), `expected widget-co topic, got: ${l}`);
  });

  it('ranks an instance project above a built-in topic matching the same words', () => {
    const l = label(['fix the graphql-api schema'], { projectSlugs: ['graphql-api'] });
    assert.ok(l.startsWith('Graphql Api GraphQL'), `instance topic should rank first, got: ${l}`);
  });

  it('loads owner topic patterns from config label_topics', () => {
    const l = label(['fix the kayak roll technique please'], {
      labelTopics: [{ match: '\\bkayak\\b', label: 'kayaking' }],
    });
    assert.ok(l.includes('kayaking'), `config label_topics should drive label, got: ${l}`);
  });

  it('skips an invalid label_topics regex and keeps its valid siblings', () => {
    const l = label(['fix the kayak roll technique please'], {
      labelTopics: [
        { match: '([', label: 'broken' },
        { match: '\\bkayak\\b', label: 'kayaking' },
        'not-an-object',
      ],
    });
    assert.ok(l.includes('kayaking'), `valid patterns must survive a bad sibling, got: ${l}`);
  });
});

describe('session-label', () => {
  // Owner-specific life/project patterns belong in the instance config
  // (label_topics), never in the public source.
  it('source carries no personal topic patterns', () => {
    assert.doesNotMatch(
      readFileSync(HOOK, 'utf8'),
      /eczema|\\btsw\\b|dermat|nootropic|supplement|autis|audhd|neurodiv|circadian|melatonin|grid.bot|trading|coaching|resto.druid|mythic|\\bwow\\b|kin-\\d|oh.my.claude/i,
    );
  });

  it('reads label_topics from config.json', () => {
    const sid = randomUUID();
    hook(
      {
        session_id: sid,
        prompt: 'fix the kayak roll technique please',
        transcript_path: '',
        cwd: '/tmp',
      },
      {
        env: { LEARNING_LOOP_INJECTION_MODE: 'off' },
        seed: (pluginData) =>
          writeFileSync(
            join(pluginData, 'config.json'),
            JSON.stringify({ label_topics: [{ match: '\\bkayak\\b', label: 'kayaking' }] }),
          ),
      },
    );
    assert.ok(labelOf(sid)?.includes('kayaking'), `got: ${labelOf(sid)}`);
  });

  it('reads project slugs from the vault 4-projects/ folder', () => {
    const vault = mkdtempSync(join(tmpdir(), 'll-label-vault-'));
    try {
      mkdirSync(join(vault, '4-projects'), { recursive: true });
      writeFileSync(join(vault, '4-projects', 'widget-co.md'), '# widget-co');
      const sid = randomUUID();
      const l = run(sid, 'fix the widget-co build', '/nonexistent.jsonl', '/tmp', {
        VAULT_PATH: vault,
      });
      assert.ok(l && /widget[\s-]co/i.test(l), `expected widget-co topic, got: ${l}`);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it('handles empty transcript', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    writeFileSync(transcript, '');
    const label = run(sid, 'hello', transcript);
    assert.ok(label !== null, 'label file should exist');
  });

  it('does not crash on malformed transcript lines', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    writeFileSync(
      transcript,
      [
        'not json at all',
        '{"type": "user", "message": {"content": "work on the vault plugin"}}',
        '{invalid json}',
        '{"type": "assistant", "message": "ignored"}',
      ].join('\n'),
    );
    const label = run(sid, 'continue with the plugin', transcript);
    assert.ok(label, 'label file should exist');
    assert.ok(label.includes('plugin'), `expected plugin, got: ${label}`);
  });

  // Regression: when the transcript's final line exceeds the 256KB tail
  // window, readFileTail returns '' (no newline inside the window). The parse
  // loop must skip empty lines instead of JSON.parse('') failing and logging
  // a parseTranscriptLine error on EVERY prompt.
  it('does not log a parse error when the final transcript line exceeds the tail window', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    const giant = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300_000) } });
    writeFileSync(transcript, makeTranscript(['fix the hooks please']) + '\n' + giant);
    const result = hook({
      session_id: sid,
      prompt: 'continue with the hook work',
      transcript_path: transcript,
      cwd: '/tmp',
    });
    assert.ok(
      !result.stderr.includes('parseTranscriptLine'),
      `empty tail must not be parsed as a transcript line; stderr:\n${result.stderr}`,
    );
    assert.ok(labelOf(sid) !== null, 'label file should still be written from the prompt alone');
  });

  it('does not crash when transcript file is missing', () => {
    const sid = randomUUID();
    const label = run(sid, 'work on the react frontend components', '/nonexistent/path.jsonl');
    assert.ok(label, 'label file should exist');
    assert.ok(label.includes('frontend'), `expected frontend, got: ${label}`);
  });

  it('exits cleanly with empty stdin', () => {
    const { stdout } = hook('');
    assert.equal(stdout.trim(), '');
  });

  it('exits cleanly with no session_id', () => {
    const { stdout } = hook({ prompt: 'hello' });
    assert.equal(stdout.trim(), '');
  });

  it('handles array content blocks in transcript', () => {
    const sid = randomUUID();
    const transcript = join(TMP, `${sid}.jsonl`);
    const entry = {
      type: 'user',
      message: {
        content: [{ type: 'text', text: 'deploy the worker to Cloudflare' }],
      },
    };
    writeFileSync(transcript, JSON.stringify(entry));
    const label = run(sid, 'ship it', transcript);
    assert.ok(label.includes('infra'), `expected infra, got: ${label}`);
    assert.ok(label.includes('deploying'), `expected deploying, got: ${label}`);
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
});

describe('session-label stdout contract', () => {
  function runCapturingStdout(env, prompt = 'test question about hooks and injection') {
    return hook({ session_id: randomUUID(), prompt, transcript_path: '', cwd: '/tmp' }, { env })
      .stdout;
  }

  // A vault with one note and a stub ll-search returning an above-threshold
  // hit on it, so the live control below injects. Without it every mode would
  // stop at gate-fail-no-vault and print nothing, and the mode tests would
  // pass whatever the mode did.
  function runWithHit(env) {
    const base = mkdtempSync(join(tmpdir(), 'll-stdout-contract-'));
    try {
      const vault = join(base, 'vault');
      const pluginData = join(base, 'plugin-data');
      mkdirSync(join(vault, 'notes'), { recursive: true });
      mkdirSync(join(pluginData, 'bin'), { recursive: true });
      writeFileSync(
        join(vault, 'notes', 'hook-injection.md'),
        'Hooks inject the top note body before the prompt.\n',
      );
      const hit = JSON.stringify([
        { path: 'notes/hook-injection.md', title: 'hook-injection', score: 0.99 },
      ]);
      writeFileSync(join(pluginData, 'bin', 'll-search'), `#!/bin/sh\nprintf '%s' '${hit}'\n`, {
        mode: 0o755,
      });
      return runCapturingStdout({
        TMPDIR: base,
        CLAUDE_PLUGIN_DATA: pluginData,
        VAULT_PATH: vault,
        LEARNING_LOOP_INJECTION_THRESHOLD: '0.1',
        LEARNING_LOOP_INJECTION_RACE_CAP_MS: '20000',
        ...env,
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  const stub = {
    skip: skipOnWindows(
      'shebang stub: #!/bin/sh ll-search stub is not an executable ll-search.exe on win32',
    ),
  };

  it('injects in live mode with a hit (control for the cases below)', stub, () => {
    assert.ok(runWithHit({ LEARNING_LOOP_INJECTION_MODE: 'live' }).length > 0);
  });

  it('produces empty stdout in shadow mode', stub, () => {
    assert.equal(runWithHit({ LEARNING_LOOP_INJECTION_MODE: 'shadow' }), '');
  });

  it('produces empty stdout when mode is off', stub, () => {
    assert.equal(runWithHit({ LEARNING_LOOP_INJECTION_MODE: 'off' }), '');
  });

  it('produces empty stdout on gate-fail path', () => {
    const emptyVault = mkdtempSync(join(tmpdir(), 'll-empty-vault-'));
    try {
      const out = runCapturingStdout(
        {
          LEARNING_LOOP_INJECTION_MODE: 'live',
          VAULT_PATH: emptyVault,
        },
        'obscure nonsense that will not match anything in any vault anywhere xyzzy',
      );
      assert.equal(out, '');
    } finally {
      rmSync(emptyVault, { recursive: true, force: true });
    }
  });

  it('produces empty stdout when pipeline throws', stub, () => {
    assert.equal(
      runWithHit({
        LEARNING_LOOP_INJECTION_MODE: 'live',
        LEARNING_LOOP_INJECTION_FORCE_ERROR: '1',
      }),
      '',
    );
  });
});

describe(
  'session-label dedupe levels across prompts',
  {
    skip: skipOnWindows(
      'shebang stub: #!/bin/sh ll-search stub is not an executable ll-search.exe on win32',
    ),
  },
  () => {
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
        const stubBin = join(pluginData, 'bin');
        mkdirSync(join(vault, 'notes'), { recursive: true });
        mkdirSync(stubBin, { recursive: true });

        writeFileSync(
          join(vault, 'notes', 'alpha.md'),
          'Alpha note body about hook injection ordering and budgets.\n',
        );
        writeFileSync(
          join(vault, 'notes', 'beta.md'),
          'Beta note body about dedupe windows and pointer suppression.\n',
        );
        writeFileSync(
          join(vault, 'notes', 'gamma.md'),
          'Gamma note body about promoting a pointer across turns.\n',
        );

        // Stub returns the same three above-threshold hits on both prompts.
        // Three, not two: the injection fills two body slots, so a two-hit
        // fixture produces no pointer at all and this test needs one to promote.
        const hits = JSON.stringify([
          { path: 'notes/alpha.md', title: 'alpha', score: 0.99 },
          { path: 'notes/beta.md', title: 'beta', score: 0.9 },
          { path: 'notes/gamma.md', title: 'gamma', score: 0.8 },
        ]);
        writeFileSync(join(stubBin, 'll-search'), `#!/bin/sh\nprintf '%s' '${hits}'\n`, {
          mode: 0o755,
        });

        const sid = randomUUID();
        const env = {
          TMPDIR: base,
          LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: '0',
          CLAUDE_PLUGIN_DATA: pluginData,
          VAULT_PATH: vault,
          LEARNING_LOOP_INJECTION_MODE: 'live',
          LEARNING_LOOP_INJECTION_THRESHOLD: '0.1',
          LEARNING_LOOP_INJECTION_RACE_CAP_MS: '20000',
        };
        const runPrompt = (prompt) =>
          hook(
            { session_id: sid, prompt, transcript_path: '', cwd: '/tmp' },
            {
              timeoutMs: 30000,
              env,
            },
          ).stdout;

        const out1 = runPrompt('tell me about hook injection ordering and budgets');
        assert.ok(out1.includes('Alpha note body'), 'prompt 1 must body-inject the top hit');
        assert.ok(out1.includes('notes/gamma.md'), 'prompt 1 must list gamma as a pointer');
        assert.ok(!out1.includes('Gamma note body'), 'prompt 1 must not inject the pointer body');

        const out2 = runPrompt('now drill into dedupe windows and pointer suppression');
        assert.ok(
          out2.includes('Gamma note body'),
          `pointer-seen note must be body-injected on the follow-up prompt; got: ${out2}`,
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    // The 4h window is only worth anything if a body-injected note actually
    // stays suppressed on the next prompt. Telemetry replay found 45.2% of
    // injections re-showed a note already injected earlier in the same session
    // under the prior 3-minute window.
    it('body-injected note stays suppressed on the next prompt', () => {
      const base = mkdtempSync(join(tmpdir(), 'll-live-dedupe-repeat-'));
      try {
        const vault = join(base, 'vault');
        const pluginData = join(base, 'plugin-data');
        const stubBin = join(pluginData, 'bin');
        mkdirSync(join(vault, 'notes'), { recursive: true });
        mkdirSync(stubBin, { recursive: true });

        writeFileSync(
          join(vault, 'notes', 'solo.md'),
          'Solo note body about hook injection ordering and budgets.\n',
        );

        const hits = JSON.stringify([{ path: 'notes/solo.md', title: 'solo', score: 0.99 }]);
        writeFileSync(join(stubBin, 'll-search'), `#!/bin/sh\nprintf '%s' '${hits}'\n`, {
          mode: 0o755,
        });

        const sid = randomUUID();
        const env = {
          TMPDIR: base,
          LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: '0',
          CLAUDE_PLUGIN_DATA: pluginData,
          VAULT_PATH: vault,
          LEARNING_LOOP_INJECTION_MODE: 'live',
          LEARNING_LOOP_INJECTION_THRESHOLD: '0.1',
          LEARNING_LOOP_INJECTION_RACE_CAP_MS: '20000',
        };
        const runPrompt = (prompt) =>
          hook(
            { session_id: sid, prompt, transcript_path: '', cwd: '/tmp' },
            {
              timeoutMs: 30000,
              env,
            },
          ).stdout;

        const out1 = runPrompt('tell me about hook injection ordering and budgets');
        assert.ok(out1.includes('Solo note body'), 'prompt 1 must body-inject the hit');

        const out2 = runPrompt('more on hook injection ordering and budgets please');
        assert.ok(
          !out2.includes('Solo note body'),
          `body-injected note must stay suppressed within the window; got: ${out2}`,
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    // Dedupe state is a path->level lookup, so repeated turns must not append a
    // row per turn. Without collapsing, a 4h window over a busy session grows
    // the file to ~2.6k rows that loadDedupeState never reads.
    it('dedupe state keeps one row per path across repeated prompts', () => {
      const base = mkdtempSync(join(tmpdir(), 'll-live-dedupe-collapse-'));
      try {
        const vault = join(base, 'vault');
        const pluginData = join(base, 'plugin-data');
        const stubBin = join(pluginData, 'bin');
        mkdirSync(join(vault, 'notes'), { recursive: true });
        mkdirSync(stubBin, { recursive: true });

        writeFileSync(join(vault, 'notes', 'alpha.md'), 'Alpha body about budgets.\n');
        writeFileSync(join(vault, 'notes', 'beta.md'), 'Beta body about budgets.\n');

        const hits = JSON.stringify([
          { path: 'notes/alpha.md', title: 'alpha', score: 0.99 },
          { path: 'notes/beta.md', title: 'beta', score: 0.9 },
        ]);
        writeFileSync(join(stubBin, 'll-search'), `#!/bin/sh\nprintf '%s' '${hits}'\n`, {
          mode: 0o755,
        });

        const sid = randomUUID();
        const env = {
          TMPDIR: base,
          LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: '0',
          CLAUDE_PLUGIN_DATA: pluginData,
          VAULT_PATH: vault,
          LEARNING_LOOP_INJECTION_MODE: 'live',
          LEARNING_LOOP_INJECTION_THRESHOLD: '0.1',
          LEARNING_LOOP_INJECTION_RACE_CAP_MS: '20000',
        };
        for (let i = 0; i < 4; i++) {
          hook(
            {
              session_id: sid,
              prompt: `budgets question number ${i} about hook injection ordering`,
              transcript_path: '',
              cwd: '/tmp',
            },
            {
              timeoutMs: 30000,
              env,
            },
          );
        }

        const statePath = join(pluginData, 'retrieval', 'session-dedupe', `${sid}.json`);
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));
        const paths = state.map((e) => e.path);
        assert.equal(
          paths.length,
          new Set(paths).size,
          `dedupe state must hold one row per path; got ${JSON.stringify(state)}`,
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  },
);

describe(
  'session-label live injection scrubbing',
  {
    skip: skipOnWindows(
      'shebang stub: #!/bin/sh ll-search stub is not an executable ll-search.exe on win32',
    ),
  },
  () => {
    it('live mode scrubs secrets from injected context (parity with shadow)', () => {
      const base = mkdtempSync(join(tmpdir(), 'll-live-scrub-'));
      try {
        const vault = join(base, 'vault');
        const pluginData = join(base, 'plugin-data');
        const stubBin = join(pluginData, 'bin');
        mkdirSync(join(vault, 'notes'), { recursive: true });
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

        const input = {
          session_id: randomUUID(),
          prompt: 'how should we rotate the AWS deploy key for the worker',
          transcript_path: '',
          cwd: '/tmp',
        };
        const out = hook(input, {
          timeoutMs: 30000,
          env: {
            TMPDIR: base,
            LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: '0',
            CLAUDE_PLUGIN_DATA: pluginData,
            VAULT_PATH: vault,
            LEARNING_LOOP_INJECTION_MODE: 'live',
            LEARNING_LOOP_INJECTION_THRESHOLD: '0.1',
            // Generous race cap: under full-suite load the 1500ms default can
            // abort the stub backend before it answers, failing the gate.
            LEARNING_LOOP_INJECTION_RACE_CAP_MS: '20000',
          },
        }).stdout;

        assert.ok(
          out.length > 0,
          'gate did not pass — stub arrangement broken, fix before judging the scrub',
        );
        assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key leaked into live injection');
        assert.ok(out.includes('[REDACTED]'));
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  },
);

describe(
  'session-label live injection telemetry',
  {
    skip: skipOnWindows(
      'shebang stub: #!/bin/sh ll-search stub is not an executable ll-search.exe on win32',
    ),
  },
  () => {
    // Going live must not blind the calibration loop: a successful live
    // injection writes the same gate-pass-payload record shadow mode wrote,
    // marked mode:'live', so review-shadow.mjs keeps seeing gate passes.
    it('live mode logs a gate-pass-payload record with the injected payload', () => {
      const base = mkdtempSync(join(tmpdir(), 'll-live-telemetry-'));
      try {
        const vault = join(base, 'vault');
        const pluginData = join(base, 'plugin-data');
        const stubBin = join(pluginData, 'bin');
        mkdirSync(join(vault, 'notes'), { recursive: true });
        mkdirSync(stubBin, { recursive: true });

        writeFileSync(
          join(vault, 'notes', 'gamma.md'),
          'Gamma note body about race caps and injection telemetry.\n',
        );
        const hit = JSON.stringify([{ path: 'notes/gamma.md', title: 'gamma', score: 0.99 }]);
        writeFileSync(join(stubBin, 'll-search'), `#!/bin/sh\nprintf '%s' '${hit}'\n`, {
          mode: 0o755,
        });

        const out = hook(
          {
            session_id: randomUUID(),
            prompt: 'what do we know about race caps and injection telemetry',
            transcript_path: '',
            cwd: '/tmp',
          },
          {
            timeoutMs: 30000,
            env: {
              TMPDIR: base,
              LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: '0',
              CLAUDE_PLUGIN_DATA: pluginData,
              VAULT_PATH: vault,
              LEARNING_LOOP_INJECTION_MODE: 'live',
              LEARNING_LOOP_INJECTION_THRESHOLD: '0.1',
              LEARNING_LOOP_INJECTION_RACE_CAP_MS: '20000',
            },
          },
        ).stdout;
        assert.ok(out.length > 0, 'gate did not pass — stub arrangement broken');

        const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        const logPath = join(pluginData, 'retrieval', `shadow-injection-${month}.jsonl`);
        assert.ok(existsSync(logPath), 'live injection must write a telemetry record');
        const records = readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        const pass = records.find((r) => r.gate?.passed === true);
        assert.ok(pass, 'a gate-pass record must be logged in live mode');
        assert.equal(pass.mode, 'live');
        assert.ok(pass.payload?.tokens_estimated > 0, 'payload size must be recorded');
        assert.ok(
          Array.isArray(pass.payload?.injected_paths) && pass.payload.injected_paths.length > 0,
          'the full injected note list must be recorded for the per-rank injected-vs-used join',
        );
        assert.ok(
          pass.payload.injected_paths.every((e) => typeof e.path === 'string' && e.level),
          'each injected_paths entry carries a path and its slot level',
        );
        assert.ok(
          (pass.would_inject || '').includes('Gamma note body'),
          'the injected context must be captured for quality review',
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    // retrieval-usage.mjs joins the dedupe-state entry and the
    // gate-pass-payload record for the same live injection on (session_id,
    // path, ts). Two independent `new Date()` calls a few statements apart
    // give them different ts, so one live injection reads as two surfaced
    // events. Both writes must share one ts.
    it('the dedupe-state entry and the gate-pass-payload record share one ts for the same injection', () => {
      const base = mkdtempSync(join(tmpdir(), 'll-live-ts-'));
      try {
        const vault = join(base, 'vault');
        const pluginData = join(base, 'plugin-data');
        const stubBin = join(pluginData, 'bin');
        mkdirSync(join(vault, 'notes'), { recursive: true });
        mkdirSync(stubBin, { recursive: true });

        writeFileSync(
          join(vault, 'notes', 'delta.md'),
          'Delta note body about shared timestamps and dedupe joins.\n',
        );
        const hit = JSON.stringify([{ path: 'notes/delta.md', title: 'delta', score: 0.99 }]);
        writeFileSync(join(stubBin, 'll-search'), `#!/bin/sh\nprintf '%s' '${hit}'\n`, {
          mode: 0o755,
        });

        const sid = randomUUID();
        hook(
          {
            session_id: sid,
            prompt: 'what do we know about shared timestamps and dedupe joins',
            transcript_path: '',
            cwd: '/tmp',
          },
          {
            timeoutMs: 30000,
            env: {
              TMPDIR: base,
              LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: '0',
              CLAUDE_PLUGIN_DATA: pluginData,
              VAULT_PATH: vault,
              LEARNING_LOOP_INJECTION_MODE: 'live',
              LEARNING_LOOP_INJECTION_THRESHOLD: '0.1',
              LEARNING_LOOP_INJECTION_RACE_CAP_MS: '20000',
            },
          },
        );

        const statePath = join(pluginData, 'retrieval', 'session-dedupe', `${sid}.json`);
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));
        const dedupeEntry = state.find((e) => e.path === 'notes/delta.md');
        assert.ok(dedupeEntry, 'dedupe state must record the injected note');

        const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        const logPath = join(pluginData, 'retrieval', `shadow-injection-${month}.jsonl`);
        const records = readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        const pass = records.find((r) => r.gate?.passed === true);
        assert.ok(pass, 'a gate-pass record must be logged in live mode');

        assert.equal(
          dedupeEntry.ts,
          pass.ts,
          'the dedupe-state entry and the shadow record must carry the same ts, or the usage-report join double-counts the injection',
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  },
);

describe(
  'session-label synthetic session tagging',
  {
    skip: skipOnWindows(
      'shebang stub: #!/bin/sh ll-search stub is not an executable ll-search.exe on win32',
    ),
  },
  () => {
    function runWithSynthetic(synthetic) {
      const base = mkdtempSync(join(tmpdir(), 'll-synthetic-'));
      try {
        const vault = join(base, 'vault');
        const pluginData = join(base, 'plugin-data');
        const stubBin = join(pluginData, 'bin');
        mkdirSync(join(vault, 'notes'), { recursive: true });
        mkdirSync(stubBin, { recursive: true });

        writeFileSync(
          join(vault, 'notes', 'delta.md'),
          'Delta note body about synthetic calibration tagging.\n',
        );
        const hit = JSON.stringify([{ path: 'notes/delta.md', title: 'delta', score: 0.99 }]);
        writeFileSync(join(stubBin, 'll-search'), `#!/bin/sh\nprintf '%s' '${hit}'\n`, {
          mode: 0o755,
        });

        const out = hook(
          {
            session_id: randomUUID(),
            prompt: 'what do we know about synthetic calibration tagging',
            transcript_path: '',
            cwd: '/tmp',
          },
          {
            timeoutMs: 30000,
            env: {
              TMPDIR: base,
              LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: '0',
              CLAUDE_PLUGIN_DATA: pluginData,
              VAULT_PATH: vault,
              LEARNING_LOOP_INJECTION_MODE: 'shadow',
              LEARNING_LOOP_INJECTION_THRESHOLD: '0.1',
              LEARNING_LOOP_INJECTION_RACE_CAP_MS: '20000',
              ...(synthetic ? { LEARNING_LOOP_SYNTHETIC: '1' } : {}),
            },
          },
        ).stdout;
        assert.ok(out.length === 0, 'shadow mode must stay silent on stdout');

        const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        const logPath = join(pluginData, 'retrieval', `shadow-injection-${month}.jsonl`);
        assert.ok(existsSync(logPath), 'shadow run must write a telemetry record');
        const records = readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        const pass = records.find((r) => r.gate?.passed === true);
        assert.ok(pass, 'a gate-pass record must be logged');
        return pass;
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }

    it('LEARNING_LOOP_SYNTHETIC=1 tags the logged record synthetic: true', () => {
      const pass = runWithSynthetic(true);
      assert.equal(pass.synthetic, true);
    });

    it('without the env var, records carry no synthetic field', () => {
      const pass = runWithSynthetic(false);
      assert.equal('synthetic' in pass, false);
    });
  },
);

// Every hook spawn must be blind to the developer's shell. Inheriting
// CLAUDE_PLUGIN_DATA (or leaving it unset, which resolves the real install's
// .ll-data-path marker) logs fixture prompts into production telemetry: 70% of
// one calibration window was test runs before this was caught. Inheriting
// VAULT_PATH or LEARNING_LOOP_SYNTHETIC retrieves against the real vault and
// mislabels records. Asserted on where records land and what they carry.
describe('session-label test isolation', () => {
  function withParentEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  function shadowRecords(pluginData) {
    const retrieval = join(pluginData, 'retrieval');
    if (!existsSync(retrieval)) return [];
    return readdirSync(retrieval)
      .filter((f) => f.startsWith('shadow-injection-'))
      .flatMap((f) =>
        readFileSync(join(retrieval, f), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      );
  }

  function runIsolated(parentEnv, seed) {
    return withParentEnv(parentEnv, () =>
      runHook(HOOK, {
        stdin: {
          session_id: randomUUID(),
          prompt: 'a prompt long enough to clear the fast path gate for isolation',
          transcript_path: '',
          cwd: '/tmp',
        },
        env: { TMPDIR: TMP, LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: '0' },
        seed,
      }),
    );
  }

  it('an ambient CLAUDE_PLUGIN_DATA cannot redirect telemetry out of the sandbox', () => {
    const ambient = mkdtempSync(join(tmpdir(), 'll-ambient-data-'));
    const r = runIsolated({ CLAUDE_PLUGIN_DATA: ambient });
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      // Assert on where the telemetry actually landed, not only on the absence
      // of a path: "the ambient dir stayed empty" would also pass if the hook
      // simply never logged, which is the failure this exists to catch.
      assert.ok(shadowRecords(r.pluginDataDir).length > 0, 'the sandbox must hold the record');
      assert.deepEqual(readdirSync(ambient), [], 'nothing may land in the ambient dir');
    } finally {
      r.cleanup();
      rmSync(ambient, { recursive: true, force: true });
    }
  });

  it('an ambient VAULT_PATH and LEARNING_LOOP_SYNTHETIC do not reach the hook', () => {
    const parentVault = mkdtempSync(join(tmpdir(), 'll-parent-vault-'));
    mkdirSync(join(parentVault, 'notes'));
    writeFileSync(join(parentVault, 'notes', 'x.md'), 'Parent vault note about isolation.\n');
    // A stub that records every invocation: retrieval against any vault, the
    // parent's included, has to go through it.
    const r = runIsolated({ VAULT_PATH: parentVault, LEARNING_LOOP_SYNTHETIC: '1' }, (pluginData) =>
      writeFileSync(
        join(pluginData, 'bin', 'll-search'),
        `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(pluginData, 'll-args.log'))}\nprintf '[]'\n`,
        { mode: 0o755 },
      ),
    );
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      const records = shadowRecords(r.pluginDataDir);
      assert.ok(records.length > 0, 'the hook must have logged a record');
      assert.ok(
        records.every((rec) => !('synthetic' in rec)),
        `records must carry no synthetic field; got ${JSON.stringify(records)}`,
      );
      assert.deepEqual(
        records.map((rec) => rec.type),
        ['gate-fail-no-vault'],
        'the hook must see no vault at all',
      );
      assert.ok(
        !existsSync(join(r.pluginDataDir, 'll-args.log')),
        'no retrieval may run against the parent vault',
      );
    } finally {
      r.cleanup();
      rmSync(parentVault, { recursive: true, force: true });
    }
  });
});

// The impact gate. Relevance ("is this note about what was asked") and impact
// ("can any note change what happens next") are different quantities, and the
// RRF gate only sees the first. A prompt carrying almost no subject matter of
// its own is a continuation or a reaction, and no note helps on those turns —
// so the check runs BEFORE retrieval and a hopeless turn costs no search spawn.
//
// hook() pins the floor to 0 for the rest of the file; pinning it here would
// disable the behaviour under test, so this case unsets it.
describe(
  'session-label impact gate',
  { skip: skipOnWindows('the stub ll-search is a #!/bin/sh script, not an .exe') },
  () => {
    it('skips retrieval entirely on a low-specificity prompt', () => {
      const base = mkdtempSync(join(tmpdir(), 'll-impact-'));
      try {
        const pluginData = join(base, 'plugin-data');
        const stubBin = join(pluginData, 'bin');
        const vault = join(base, 'vault');
        mkdirSync(join(vault, 'notes'), { recursive: true });
        mkdirSync(stubBin, { recursive: true });
        writeFileSync(join(vault, 'notes', 'x.md'), 'Body text about deployment.\n');
        // A stub that clears any threshold if it is ever consulted. If the
        // impact gate works, it never is.
        writeFileSync(
          join(stubBin, 'll-search'),
          '#!/bin/sh\nprintf \'%s\' \'[{"path":"notes/x.md","title":"x","score":0.99}]\'\n',
          { mode: 0o755 },
        );
        const out = hook(
          {
            session_id: randomUUID(),
            prompt: 'ah right ok so what do you think about that then',
            transcript_path: '',
            cwd: '/tmp',
          },
          {
            timeoutMs: 30000,
            env: {
              TMPDIR: base,
              CLAUDE_PLUGIN_DATA: pluginData,
              VAULT_PATH: vault,
              LEARNING_LOOP_SYNTHETIC: '1',
              LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: undefined,
              LEARNING_LOOP_INJECTION_MODE: 'live',
              LEARNING_LOOP_INJECTION_THRESHOLD: '0.1',
            },
          },
        ).stdout;
        assert.equal(out, '', 'a low-impact turn must inject nothing');

        // Scan the bucket files rather than computing the month: the writer
        // names them in LOCAL time and toISOString() is UTC, which disagree for
        // the first hours of every month.
        const retrieval = join(pluginData, 'retrieval');
        const kinds = existsSync(retrieval)
          ? readdirSync(retrieval)
              .filter((f) => f.startsWith('shadow-injection-'))
              .flatMap((f) =>
                readFileSync(join(retrieval, f), 'utf8')
                  .trim()
                  .split('\n')
                  .filter(Boolean)
                  .map((l) => JSON.parse(l).type),
              )
          : [];
        assert.ok(
          kinds.includes('gate-fail-low-impact'),
          `expected a low-impact record, got: ${kinds.join(', ')}`,
        );
        assert.ok(
          !kinds.some((k) => k.startsWith('gate-pass')),
          'a suppressed turn must not also record a gate pass',
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  },
);

// The JIT path must not pay for a cross-encoder rerank. The reranker was wired
// log-only to test whether reordering lifts rank-0 precision; measured against
// a year of accumulated rerank_order telemetry it does the opposite (it moves
// the note that actually got used DOWN more often than up), so the call has no
// remaining purpose and costs a second subprocess on every gate pass.
describe(
  'session-label rerank is not in the hot path',
  { skip: skipOnWindows('the stub ll-search is a #!/bin/sh script, not an .exe') },
  () => {
    it('does not spawn a rerank subprocess on a gate pass', () => {
      const base = mkdtempSync(join(tmpdir(), 'll-norerank-'));
      try {
        const pluginData = join(base, 'plugin-data');
        const stubBin = join(pluginData, 'bin');
        const vault = join(base, 'vault');
        const argsLog = join(base, 'll-args.log');
        mkdirSync(join(vault, 'notes'), { recursive: true });
        mkdirSync(stubBin, { recursive: true });
        writeFileSync(join(vault, 'notes', 'gamma.md'), 'Gamma note body about dedupe windows.\n');

        // The stub records every argv it is called with, which is the only way
        // to observe a subprocess the hook spawns internally.
        const hits = '[{"path":"notes/gamma.md","title":"gamma","score":0.99}]';
        writeFileSync(
          join(stubBin, 'll-search'),
          '#!/bin/sh\necho "$*" >> ' + JSON.stringify(argsLog) + "\nprintf '%s' '" + hits + "'\n",
          { mode: 0o755 },
        );

        const out = hook(
          {
            session_id: randomUUID(),
            prompt:
              'walk me through the dedupe window behaviour for injected pointer notes in this session',
            transcript_path: '',
            cwd: '/tmp',
          },
          {
            timeoutMs: 30000,
            env: {
              TMPDIR: base,
              CLAUDE_PLUGIN_DATA: pluginData,
              VAULT_PATH: vault,
              LEARNING_LOOP_SYNTHETIC: '1',
              // The real floor: this prompt clears the impact gate on its own.
              LEARNING_LOOP_INJECTION_MIN_SPECIFICITY: undefined,
              LEARNING_LOOP_INJECTION_MODE: 'live',
              LEARNING_LOOP_INJECTION_THRESHOLD: '0.1',
              LEARNING_LOOP_INJECTION_RACE_CAP_MS: '20000',
            },
          },
        ).stdout;

        // Negative control: without this, the assertion below would also pass
        // if the gate never opened and the binary was never consulted at all.
        assert.ok(
          out.includes('Gamma note body'),
          'the gate must have passed, so rerank had its chance to run',
        );

        assert.ok(existsSync(argsLog), 'the stub must have been invoked at least once');
        const invocations = readFileSync(argsLog, 'utf8');
        assert.ok(
          !/\brerank\b/.test(invocations),
          'the hot path must not invoke the rerank subcommand; got: ' + invocations.trim(),
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  },
);
