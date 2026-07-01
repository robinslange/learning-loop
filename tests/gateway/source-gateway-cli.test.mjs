import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

describe('gateway CLI contract', () => {
  it('prints usage and exits 2 with no verb', () => {
    try {
      execFileSync('node', ['plugin/bin/source-gateway.mjs'], { encoding: 'utf-8' });
      assert.fail('should have exited non-zero');
    } catch (e) {
      assert.equal(e.status, 2);
    }
  });
});
