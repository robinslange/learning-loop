// config.mjs builds DATA_PATH_MARKER from homedir() at import, so every case
// imports it in a child whose HOME is a sandbox. The live install's marker is
// only ever read, to prove the file left it alone.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const runId = randomBytes(4).toString('hex');
// Outside any temp dir so persistMarker treats it as "real", and on disk,
// because a path that does not exist is never stamped. Only the sandbox
// marker ever records it.
const REAL_LIKE_PLUGIN_DATA = import.meta.dirname;
const MISSING_PLUGIN_DATA = `/Users/ll-marker-test/${runId}/plugin-data`;

const REAL_MARKER = join(homedir(), '.claude', 'plugins', 'data', '.ll-data-path');

function snapshot(file) {
  try {
    return { contents: readFileSync(file, 'utf-8'), mtimeMs: statSync(file).mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const realBefore = snapshot(REAL_MARKER);

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'll-marker-')));
  const marker = join(home, '.claude', 'plugins', 'data', '.ll-data-path');
  mkdirSync(join(home, '.claude', 'plugins', 'data'), { recursive: true });
  return {
    home,
    marker,
    readMarker: () => snapshot(marker)?.contents.trim() ?? null,
    resolve: (moduleUrl, fn, pluginData) => {
      const res = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const m = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(m.${fn}() ?? '');`,
        ],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: pluginData },
        },
      );
      assert.equal(res.status, 0, res.stderr);
      return res.stdout;
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

const CONFIG = new URL('../plugin/scripts/lib/config.mjs', import.meta.url).href;

describe('plugin-data marker stomp guard', () => {
  after(() => {
    assert.deepEqual(
      snapshot(REAL_MARKER),
      realBefore,
      `${REAL_MARKER} must not be touched by this file`,
    );
  });

  it('does not stomp the marker with a temp path', () => {
    const s = sandbox();
    try {
      const sentinel = '/Users/test/sentinel-real-plugin-data';
      writeFileSync(s.marker, sentinel, 'utf-8');
      const tempPluginData = join(s.home, 'plugin-data');

      assert.equal(s.resolve(CONFIG, 'getPluginData', tempPluginData), tempPluginData);
      assert.equal(s.readMarker(), sentinel, 'marker still holds the original real path');
    } finally {
      s.cleanup();
    }
  });

  it('does not stomp the marker with a /var/folders path', () => {
    const s = sandbox();
    try {
      const sentinel = '/Users/test/sentinel-real-plugin-data-2';
      writeFileSync(s.marker, sentinel, 'utf-8');
      const varFolders = '/var/folders/abc/T/some-test/plugin-data';

      assert.equal(s.resolve(CONFIG, 'getPluginData', varFolders), varFolders);
      assert.equal(s.readMarker(), sentinel, 'marker unchanged');
    } finally {
      s.cleanup();
    }
  });

  it('stamps the marker for a real (non-temp) env path', () => {
    const s = sandbox();
    try {
      assert.equal(
        s.resolve(CONFIG, 'getPluginData', REAL_LIKE_PLUGIN_DATA),
        REAL_LIKE_PLUGIN_DATA,
      );
      assert.equal(s.readMarker(), REAL_LIKE_PLUGIN_DATA, 'marker now points at the real path');
    } finally {
      s.cleanup();
    }
  });

  it('does not stomp the marker with a path that does not exist', () => {
    const s = sandbox();
    try {
      const sentinel = '/Users/test/sentinel-real-plugin-data-3';
      writeFileSync(s.marker, sentinel, 'utf-8');

      assert.equal(s.resolve(CONFIG, 'getPluginData', MISSING_PLUGIN_DATA), MISSING_PLUGIN_DATA);
      assert.equal(s.readMarker(), sentinel, 'marker unchanged');
    } finally {
      s.cleanup();
    }
  });
});
