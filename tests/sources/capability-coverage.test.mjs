import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sourcesWith } from '../../plugin/scripts/lib/sources/registry.mjs';
import { capabilityMethods } from '../../plugin/scripts/lib/sources/capabilities.mjs';

describe('capability coverage — a source cannot lie about what it does', () => {
  it('every verify source exposes matches + verify', () => {
    for (const s of sourcesWith('verify')) {
      for (const m of capabilityMethods.verify) {
        assert.equal(typeof s[m], 'function', `${s.id} declares verify but lacks ${m}()`);
      }
    }
  });
  it('every query source exposes search or query', () => {
    for (const s of sourcesWith('query')) {
      assert.ok(
        typeof s.search === 'function' || typeof s.query === 'function',
        `${s.id} declares query but exposes neither search() nor query()`,
      );
    }
  });
  it('at least one verify and one query source are registered', () => {
    assert.ok(sourcesWith('verify').length > 0);
    assert.ok(sourcesWith('query').length > 0);
  });
  it('verify precedence order is preserved (pubmed before crossref before pmc)', () => {
    const ids = sourcesWith('verify').map((s) => s.id);
    assert.ok(ids.indexOf('pubmed') < ids.indexOf('crossref'));
    assert.ok(ids.indexOf('crossref') < ids.indexOf('pmc'));
  });
});
