import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BINDING_PATH = join(
  homedir(),
  '.claude/plugins/cache/superpowers-marketplace/episodic-memory/1.0.15/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
);

test(
  'episodic-memory better-sqlite3 binding loads against current Node ABI',
  { skip: !existsSync(BINDING_PATH) && 'episodic-memory plugin not installed at expected version' },
  () => {
    const require = createRequire(import.meta.url);
    assert.doesNotThrow(() => require(BINDING_PATH), 'better-sqlite3 binding should load without ABI error');
  },
);
