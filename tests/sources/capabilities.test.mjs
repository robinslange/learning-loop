import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, capabilityMethods } from '../../plugin/scripts/lib/sources/capabilities.mjs';

describe('capability contract', () => {
  it('lists exactly query, fetch, verify', () => {
    assert.deepEqual([...CAPABILITIES].sort(), ['fetch', 'query', 'verify']);
  });
  it('maps each capability to its required methods', () => {
    assert.deepEqual(capabilityMethods.query, ['query']);
    assert.deepEqual(capabilityMethods.fetch, ['fetch']);
    assert.deepEqual(capabilityMethods.verify, ['matches', 'verify']);
  });
  it('is frozen', () => {
    assert.throws(() => { CAPABILITIES.push('x'); });
  });
});
