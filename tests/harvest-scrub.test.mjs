import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubNotes } from '../plugin/scripts/harvest-scrub.mjs';
import { fileURLToPath } from 'node:url';

test('deny-list hit blocks on word boundary (case-insensitive)', () => {
  const notes = [
    { path: 'ok.md', text: 'a generic lesson about retries' },
    { path: 'leak.md', text: 'the NRD registry pattern we used at fostermoore today' },
  ];
  const { blocked, clean } = scrubNotes(notes, {
    denylist: ['fostermoore', 'nrd'],
    tripwirePatterns: [],
  });
  assert.deepEqual(
    blocked.map((b) => b.path),
    ['leak.md'],
  );
  assert.equal(
    blocked[0].hits
      .map((h) => h.toLowerCase())
      .sort()
      .join(','),
    'fostermoore,nrd',
  );
  assert.deepEqual(
    clean.map((c) => c.path),
    ['ok.md'],
  );
});

test('word-boundary: short term does not match inside a larger word', () => {
  const notes = [
    { path: 'innocent.md', text: 'the maintainer fixed a domain bug in the container' },
    { path: 'real.md', text: 'this is about AI specifically' },
  ];
  const { blocked, clean } = scrubNotes(notes, {
    denylist: ['ai'],
    tripwirePatterns: [],
  });
  assert.deepEqual(
    blocked.map((b) => b.path),
    ['real.md'],
  );
  assert.deepEqual(
    clean.map((c) => c.path),
    ['innocent.md'],
  );
});

test('deny term with regex metacharacters is matched literally', () => {
  const notes = [{ path: 'x.md', text: 'contact me at bob@foster.co.nz please' }];
  const { blocked } = scrubNotes(notes, {
    denylist: ['foster.co.nz'],
    tripwirePatterns: [],
  });
  assert.deepEqual(
    blocked.map((b) => b.path),
    ['x.md'],
  );
});

test('tripwire flags but does not block', () => {
  const notes = [{ path: 'maybe.md', text: 'see https://internal.example/doc' }];
  const { blocked, tripwire, clean } = scrubNotes(notes, {
    denylist: [],
    tripwirePatterns: ['https?://\\S+'],
  });
  assert.equal(blocked.length, 0);
  assert.deepEqual(
    tripwire.map((t) => t.path),
    ['maybe.md'],
  );
  assert.deepEqual(
    clean.map((c) => c.path),
    ['maybe.md'],
  );
});

test('a note both denied and tripwired is blocked (block wins)', () => {
  const notes = [{ path: 'bad.md', text: 'NRD at https://x' }];
  const { blocked, clean } = scrubNotes(notes, {
    denylist: ['nrd'],
    tripwirePatterns: ['https?://\\S+'],
  });
  assert.deepEqual(
    blocked.map((b) => b.path),
    ['bad.md'],
  );
  assert.equal(clean.length, 0);
});

test('derived instance facts block even with an empty hand-listed denylist', () => {
  const notes = [{ path: 'leak.md', text: 'ref ed25519:OWNKEY and peer thomas' }];
  const { blocked, clean } = scrubNotes(notes, {
    denylist: ['thomas', 'ed25519:OWNKEY'],
    tripwirePatterns: [],
  });
  assert.deepEqual(
    blocked.map((b) => b.path),
    ['leak.md'],
  );
  assert.equal(clean.length, 0);
});

test('deny term in the FILENAME blocks even when body is clean (finding 1)', () => {
  const notes = [
    { path: 'project_foster_moore_vue_role.md', text: 'a totally generic body about retries' },
    { path: 'clean_note.md', text: 'nothing sensitive here' },
  ];
  const { blocked, clean } = scrubNotes(notes, {
    denylist: ['foster_moore'],
    tripwirePatterns: [],
  });
  assert.deepEqual(
    blocked.map((b) => b.path),
    ['project_foster_moore_vue_role.md'],
  );
  assert.deepEqual(
    clean.map((c) => c.path),
    ['clean_note.md'],
  );
});

test('deny term matches hyphen/underscore compounds (finding 2)', () => {
  const notes = [
    { path: 'a.md', text: 'we shipped the acme-registry integration' },
    { path: 'b.md', text: 'notes on acme_registry internals' },
    { path: 'c.md', text: 'an unrelated acmecorp mention should NOT match' },
  ];
  const { blocked, clean } = scrubNotes(notes, {
    denylist: ['acme'],
    tripwirePatterns: [],
  });
  assert.deepEqual(blocked.map((b) => b.path).sort(), ['a.md', 'b.md']);
  assert.deepEqual(
    clean.map((c) => c.path),
    ['c.md'],
  );
});

test('word-boundary still does not match inside an alphanumeric word after the fix', () => {
  // regression guard for the original finding: 'ai' must not match 'maintainer'
  const notes = [{ path: 'x.md', text: 'the maintainer fixed a domain bug' }];
  const { blocked, clean } = scrubNotes(notes, { denylist: ['ai'], tripwirePatterns: [] });
  assert.equal(blocked.length, 0);
  assert.deepEqual(
    clean.map((c) => c.path),
    ['x.md'],
  );
});

test('CLI reads note paths from stdin when no path args given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-scrub-cli-'));
  try {
    const ok = join(dir, 'ok.md');
    const leak = join(dir, 'leak.md');
    const deny = join(dir, 'deny.txt');
    writeFileSync(ok, 'a generic retry lesson');
    writeFileSync(leak, 'we used NRD at work');
    writeFileSync(deny, 'nrd\n');
    const scrubScript = fileURLToPath(
      new URL('../plugin/scripts/harvest-scrub.mjs', import.meta.url),
    );
    const out = execFileSync(
      process.execPath,
      [scrubScript, deny, ''], // empty pluginData => no derived facts
      { input: `${ok}\n${leak}\n`, encoding: 'utf8' },
    );
    const result = JSON.parse(out);
    assert.deepEqual(
      result.blocked.map((b) => b.path),
      [leak],
    );
    assert.deepEqual(
      result.clean.map((c) => c.path),
      [ok],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI blocks an instance domain even when email_domains is a bare string (not array)', () => {
  // B1: a string-typed email_domains must not shred into single chars that fail
  // to block the company domain. The note must be BLOCKED, never land in clean.
  const dir = mkdtempSync(join(tmpdir(), 'll-scrub-str-'));
  try {
    const note = join(dir, 'leak.md');
    const deny = join(dir, 'deny.txt');
    writeFileSync(note, 'we standardised on acmecorp.com for everything');
    writeFileSync(deny, '');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ email_domains: 'acmecorp.com' }));
    const scrubScript = fileURLToPath(
      new URL('../plugin/scripts/harvest-scrub.mjs', import.meta.url),
    );
    const out = execFileSync(process.execPath, [scrubScript, deny, dir], {
      input: `${note}\n`,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
    });
    const result = JSON.parse(out);
    assert.deepEqual(
      result.blocked.map((b) => b.path),
      [note],
    );
    assert.deepEqual(
      result.clean.map((c) => c.path),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails closed (non-zero exit, no clean output) when email_domains is a non-coercible object', () => {
  // M1: an object email_domains used to throw an uncaught TypeError before any
  // JSON was written — the operator saw nothing. It must now fail closed: a clear
  // error on stderr and a non-zero exit, never a partial/empty report read as success.
  const dir = mkdtempSync(join(tmpdir(), 'll-scrub-obj-'));
  try {
    const note = join(dir, 'leak.md');
    const deny = join(dir, 'deny.txt');
    writeFileSync(note, 'we used acmecorp.com');
    writeFileSync(deny, '');
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ email_domains: { a: 'acmecorp.com' } }),
    );
    const scrubScript = fileURLToPath(
      new URL('../plugin/scripts/harvest-scrub.mjs', import.meta.url),
    );
    let threw = false;
    let stderr = '';
    try {
      execFileSync(process.execPath, [scrubScript, deny, dir], {
        input: `${note}\n`,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
      });
    } catch (e) {
      threw = true;
      stderr = String(e.stderr || '');
    }
    assert.ok(threw, 'scrub CLI must exit non-zero on a non-coercible email_domains config');
    assert.match(stderr, /email_domains/, 'error must name the offending config key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 1 when config.json exists but is unparseable (fail closed)', () => {
  // getConfigStrict resolves the config via CLAUDE_PLUGIN_DATA (getPluginData),
  // NOT via the argv pluginData — without the env the CLI would read the real
  // repo config and exit 0.
  const dir = mkdtempSync(join(tmpdir(), 'll-scrub-badcfg-'));
  try {
    const note = join(dir, 'clean-note.md');
    const deny = join(dir, 'deny.txt');
    writeFileSync(note, 'nothing sensitive here');
    writeFileSync(deny, '');
    writeFileSync(join(dir, 'config.json'), '{ this is not json');
    const scrubScript = fileURLToPath(
      new URL('../plugin/scripts/harvest-scrub.mjs', import.meta.url),
    );
    const res = spawnSync(process.execPath, [scrubScript, deny, dir, note], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /config/i);
    assert.ok(!res.stdout.includes('"clean"'), 'no report at all on a corrupt config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 1 when federation config exists but is unparseable', () => {
  // Main config.json is VALID here, pinning the exercised failure to the
  // federation one (FEDERATION_PATHS.config = <pluginData>/federation/config.json).
  const dir = mkdtempSync(join(tmpdir(), 'll-scrub-badfed-'));
  try {
    const note = join(dir, 'clean-note.md');
    const deny = join(dir, 'deny.txt');
    writeFileSync(note, 'nothing sensitive here');
    writeFileSync(deny, '');
    writeFileSync(join(dir, 'config.json'), '{}');
    mkdirSync(join(dir, 'federation'), { recursive: true });
    writeFileSync(join(dir, 'federation', 'config.json'), '{nope');
    const scrubScript = fileURLToPath(
      new URL('../plugin/scripts/harvest-scrub.mjs', import.meta.url),
    );
    const res = spawnSync(process.execPath, [scrubScript, deny, dir, note], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /federation/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 1 when config.json contains literal null (not an object)', () => {
  // Valid JSON `null` parses cleanly but vanishes email_domains with no error —
  // corrupt for gate purposes, not a default.
  const dir = mkdtempSync(join(tmpdir(), 'll-scrub-nullcfg-'));
  try {
    const note = join(dir, 'clean-note.md');
    const deny = join(dir, 'deny.txt');
    writeFileSync(note, 'nothing sensitive here');
    writeFileSync(deny, '');
    writeFileSync(join(dir, 'config.json'), 'null');
    const scrubScript = fileURLToPath(
      new URL('../plugin/scripts/harvest-scrub.mjs', import.meta.url),
    );
    const res = spawnSync(process.execPath, [scrubScript, deny, dir, note], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not an object/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 1 when config.json contains an array (not an object)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-scrub-arrcfg-'));
  try {
    const note = join(dir, 'clean-note.md');
    const deny = join(dir, 'deny.txt');
    writeFileSync(note, 'nothing sensitive here');
    writeFileSync(deny, '');
    writeFileSync(join(dir, 'config.json'), '[1,2]');
    const scrubScript = fileURLToPath(
      new URL('../plugin/scripts/harvest-scrub.mjs', import.meta.url),
    );
    const res = spawnSync(process.execPath, [scrubScript, deny, dir, note], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not an object/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('numeric deny term is coerced and still blocks', () => {
  const { blocked } = scrubNotes([{ path: 'a.md', text: 'project code 4711 is secret' }], {
    denylist: [4711],
    tripwirePatterns: [],
  });
  assert.equal(blocked.length, 1);
});

test('object deny term throws (fail closed, never silently dropped)', () => {
  assert.throws(() =>
    scrubNotes([{ path: 'a.md', text: 'x' }], {
      denylist: [{ term: 'acme' }],
      tripwirePatterns: [],
    }),
  );
});
