import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function loadModule() {
  // Cache-bust the import so each test gets a clean module — important
  // because the module may read env at import time in future iterations.
  const url = new URL('../hooks/session-start/dream-trigger.mjs', import.meta.url);
  url.searchParams.set('t', Date.now().toString());
  return await import(url.href);
}

describe('dream-trigger', () => {
  let pluginData;
  let tmp;
  let origTmpdir;

  beforeEach(() => {
    pluginData = mkdtempSync(join(tmpdir(), 'll-dream-pd-'));
    tmp = mkdtempSync(join(tmpdir(), 'll-dream-tmp-'));
    origTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
  });

  afterEach(() => {
    if (origTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = origTmpdir;
    rmSync(pluginData, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('first session with no marker: no nudge, counter starts at 1', async () => {
    const mod = await loadModule();
    const ctx = { pluginData, context: '' };
    await mod.run(ctx);
    assert.equal(ctx.context, '');
    const counter = join(pluginData, '.dream-session-count');
    assert.equal(readFileSync(counter, 'utf-8').trim(), '1');
  });

  it('threshold met and dream is old: emits nudge, resets counter', async () => {
    const old = Math.floor(Date.now() / 1000) - 25 * 3600;
    writeFileSync(join(tmp, 'learning-loop-last-dream'), String(old));
    writeFileSync(join(pluginData, '.dream-session-count'), '5');
    const mod = await loadModule();
    const ctx = { pluginData, context: '' };
    await mod.run(ctx);
    assert.match(ctx.context, /\/learning-loop:dream/);
    const counter = join(pluginData, '.dream-session-count');
    assert.equal(readFileSync(counter, 'utf-8').trim(), '0');
  });

  it('recent dream within age threshold: counter reset, no nudge', async () => {
    const recent = Math.floor(Date.now() / 1000) - 60;
    writeFileSync(join(tmp, 'learning-loop-last-dream'), String(recent));
    writeFileSync(join(pluginData, '.dream-session-count'), '7');
    const mod = await loadModule();
    const ctx = { pluginData, context: '' };
    await mod.run(ctx);
    assert.equal(ctx.context, '');
    const counter = join(pluginData, '.dream-session-count');
    assert.equal(readFileSync(counter, 'utf-8').trim(), '0');
  });

  it('old dream but below session threshold: counter increments, no nudge', async () => {
    const old = Math.floor(Date.now() / 1000) - 48 * 3600;
    writeFileSync(join(tmp, 'learning-loop-last-dream'), String(old));
    writeFileSync(join(pluginData, '.dream-session-count'), '2');
    const mod = await loadModule();
    const ctx = { pluginData, context: '' };
    await mod.run(ctx);
    assert.equal(ctx.context, '');
    const counter = join(pluginData, '.dream-session-count');
    assert.equal(readFileSync(counter, 'utf-8').trim(), '3');
  });

  it('missing pluginData: no-op, no throw', async () => {
    const mod = await loadModule();
    const ctx = { pluginData: null, context: '' };
    await mod.run(ctx);
    assert.equal(ctx.context, '');
  });
});
