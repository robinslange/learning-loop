import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { HttpResponse, startOllamaMock, tags } from './helpers/ollama-mock.mjs';

const runId = randomBytes(4).toString('hex');
const TEMP_ROOT = join(tmpdir(), `ll-wait-ollama-${runId}`);
const TEMP_VAULT = join(TEMP_ROOT, 'vault');
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');

describe('waitForOllama bounded retry', () => {
  const server = startOllamaMock();

  before(() => {
    mkdirSync(TEMP_VAULT, { recursive: true });
    mkdirSync(join(TEMP_DATA, 'librarian'), { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    process.env.LL_VAULT_OVERRIDE = TEMP_VAULT;
  });

  after(() => {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  it('throws after maxAttempts when ollama never responds', async () => {
    let probes = 0;
    server.use(
      tags(() => {
        probes += 1;
        return HttpResponse.error();
      }),
    );

    const { __test__ } = await import(
      `../plugin/scripts/librarian.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    await assert.rejects(
      () => __test__.waitForOllama({ maxAttempts: 3, intervalMs: 1 }),
      /ollama unreachable/i,
    );
    assert.equal(probes, 3);
  });

  it('returns when ollama becomes reachable mid-loop', async () => {
    let probes = 0;
    server.use(
      tags(() => {
        probes += 1;
        return probes < 2 ? HttpResponse.error() : HttpResponse.json({ models: [] });
      }),
    );

    const { __test__ } = await import(
      `../plugin/scripts/librarian.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    await __test__.waitForOllama({ maxAttempts: 5, intervalMs: 1 });
    assert.equal(probes, 2);
  });

  // The old stub answered `{ ok: true }` for every request, so a probe that
  // reached ollama and got a 503 counted as "reachable". Only a real Response
  // carries the status that distinguishes the two.
  it('keeps retrying when ollama answers but is not ready', async () => {
    let probes = 0;
    server.use(
      tags(() => {
        probes += 1;
        return HttpResponse.json({ error: 'loading model' }, { status: 503 });
      }),
    );

    const { __test__ } = await import(
      `../plugin/scripts/librarian.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    await assert.rejects(
      () => __test__.waitForOllama({ maxAttempts: 2, intervalMs: 1 }),
      /ollama unreachable/i,
    );
    assert.equal(probes, 2);
  });
});
