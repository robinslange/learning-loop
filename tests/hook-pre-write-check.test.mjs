import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHook } from './helpers/hook-runner.mjs';

const HOOK = new URL('../hooks/pre-write-check.js', import.meta.url).pathname;
const VAULT = new URL('./fixtures/vault-small', import.meta.url).pathname;

test('pre-write-check: silent when body has Source: line alongside frontmatter source: (vault convention, not a leak)', () => {
  const noteContent = `---
tags: [test]
source: https://example.com/paper
date: 2026-05-21
---

# Test Note

The claim happens.

Sources: pulled from example.com after second reading.
`;
  const r = runHook(HOOK, {
    stdin: {
      tool_name: 'Write',
      tool_input: {
        file_path: `${VAULT}/0-inbox/test-body-source-leak.md`,
        content: noteContent,
      },
    },
    env: { VAULT_PATH: VAULT },
  });
  try {
    assert.equal(r.exitCode, 0);
    const out = r.stdout.trim();
    if (out) {
      const parsed = JSON.parse(out);
      const ctx = parsed.hookSpecificOutput?.additionalContext || '';
      assert.doesNotMatch(ctx, /source.*body/i, `body Source: alongside frontmatter source: must not warn (frontmatter source is origin-tag, body Source is citation), got: ${ctx}`);
    }
  } finally {
    r.cleanup();
  }
});

test('pre-write-check: silent when only frontmatter has source (no body Source line)', () => {
  const noteContent = `---
tags: [test]
source: https://example.com/paper
---

# Test Note

Body without source-line.
`;
  const r = runHook(HOOK, {
    stdin: {
      tool_name: 'Write',
      tool_input: {
        file_path: `${VAULT}/0-inbox/test-no-leak.md`,
        content: noteContent,
      },
    },
    env: { VAULT_PATH: VAULT },
  });
  try {
    assert.equal(r.exitCode, 0);
    const out = r.stdout.trim();
    if (out) {
      const parsed = JSON.parse(out);
      const ctx = parsed.hookSpecificOutput?.additionalContext || '';
      assert.doesNotMatch(ctx, /source.*body/i);
    }
  } finally {
    r.cleanup();
  }
});

test('pre-write-check: silent when body Source line present but no frontmatter source field', () => {
  const noteContent = `---
tags: [test]
---

# Test Note

Sources: someone's blog post.
`;
  const r = runHook(HOOK, {
    stdin: {
      tool_name: 'Write',
      tool_input: {
        file_path: `${VAULT}/0-inbox/test-body-only.md`,
        content: noteContent,
      },
    },
    env: { VAULT_PATH: VAULT },
  });
  try {
    assert.equal(r.exitCode, 0);
    const out = r.stdout.trim();
    if (out) {
      const parsed = JSON.parse(out);
      const ctx = parsed.hookSpecificOutput?.additionalContext || '';
      assert.doesNotMatch(ctx, /source.*body/i);
    }
  } finally {
    r.cleanup();
  }
});
