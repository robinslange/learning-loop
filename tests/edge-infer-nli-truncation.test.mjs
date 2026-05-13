// tests/edge-infer-nli-truncation.test.mjs
//
// Round-trips the truncated:bool field from the Rust NLI binary through to the
// JSON the JS hook parses. nli.rs serializes truncated with
// #[serde(skip_serializing_if = "std::ops::Not::not")] so the field is OMITTED
// when false and present-and-true when the tokenizer hit max_length=512.
//
// We exercise the real release binary at native/target/release/ll-search. On
// CI without a dev build, t.skip() with a clear reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Resolve the dev-build binary directly rather than via binaryPath(): an
// older bundled binary in the plugin-data dir would shadow the just-built
// release binary that has the truncated field and schema_version envelope.
const BIN = resolve(new URL('../native/target/release/ll-search', import.meta.url).pathname);

function runNliBatch(premise, hypotheses) {
  const dir = mkdtempSync(join(tmpdir(), 'll-nli-trunc-'));
  const hypsFile = join(dir, 'hyps.txt');
  writeFileSync(hypsFile, hypotheses.join('\n'));
  try {
    const stdout = execFileSync(BIN, ['nli-batch', premise, hypsFile], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ORT_DYLIB_PATH: dirname(BIN), ORT_LIB_LOCATION: dirname(BIN) },
    });
    return JSON.parse(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('truncated field is omitted on short (sub-512-token) premise', (t) => {
  if (!existsSync(BIN)) {
    t.skip(`ll-search dev build not present at ${BIN}; skipping`);
    return;
  }

  const out = runNliBatch('Sleep is important for cognition.', [
    'Sleep helps memory consolidation.',
  ]);
  assert.equal(out.schema_version, 1);
  assert.equal(out.results.length, 1);

  // serde(skip_serializing_if = Not::not) → false MUST be absent. We assert on
  // own-property to make the omission semantic, not just falsy.
  assert.equal(
    Object.prototype.hasOwnProperty.call(out.results[0], 'truncated'),
    false,
    `expected truncated key to be omitted on short premise; got: ${JSON.stringify(out.results[0])}`,
  );
});

test('truncated:true surfaces in JSON when premise exceeds 512 tokens', (t) => {
  if (!existsSync(BIN)) {
    t.skip(`ll-search dev build not present at ${BIN}; skipping`);
    return;
  }

  // ~2700 chars of "lorem ipsum" decisively exceeds the 512 wordpiece-token cap.
  const longPremise = 'lorem ipsum dolor sit amet '.repeat(100);
  const out = runNliBatch(longPremise, ['Cognitive load increases with task complexity.']);

  assert.equal(out.schema_version, 1);
  assert.ok(out.results.length >= 1, 'expected at least one result');
  const anyTruncated = out.results.some((r) => r.truncated === true);
  assert.ok(
    anyTruncated,
    `expected at least one result with truncated:true; got: ${JSON.stringify(out.results)}`,
  );
});
