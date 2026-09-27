// tests/hook-config-librarian-enabled.test.mjs
// Unit tests for librarianEnabled(): must match loadLibrarianConfig()'s
// (scripts/librarian/config.mjs) `enabled: libCfg.enabled === true` rule
// exactly, so the pre-write gate and the daemon agree on whether the
// librarian is on.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { librarianEnabled } from '../plugin/scripts/lib/hook-config.mjs';

describe('librarianEnabled()', () => {
  it('defaults to disabled when librarian key is absent', () => {
    assert.equal(librarianEnabled({}), false);
  });

  it('defaults to disabled when config is null', () => {
    assert.equal(librarianEnabled(null), false);
  });

  it('defaults to disabled when config is undefined', () => {
    assert.equal(librarianEnabled(undefined), false);
  });

  it('defaults to disabled when librarian.enabled is absent', () => {
    assert.equal(librarianEnabled({ librarian: {} }), false);
  });

  it('honours enabled when explicitly true', () => {
    assert.equal(librarianEnabled({ librarian: { enabled: true } }), true);
  });

  it('stays disabled on a truthy non-boolean value', () => {
    assert.equal(librarianEnabled({ librarian: { enabled: 'true' } }), false);
  });

  it('stays disabled when explicitly false', () => {
    assert.equal(librarianEnabled({ librarian: { enabled: false } }), false);
  });
});
