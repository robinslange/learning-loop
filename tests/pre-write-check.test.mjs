import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook } from './helpers/hook-runner.mjs';
import { VAULT_DIRS, TITLE_INDEX_EXTRA_DIRS } from '../plugin/hooks/lib/snapshot.mjs';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../plugin/hooks/pre-write-check.js', import.meta.url));
let VAULT;
let NON_VAULT;

// Run the hook through the shared hermetic harness and parse its single
// JSON stdout payload (null when the hook stayed silent).
function run(toolName, filePath, content) {
  const r = runHook(HOOK, {
    stdin: {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: { file_path: filePath, content },
    },
    env: { VAULT_PATH: VAULT },
  });
  try {
    assert.equal(r.signal, null, `hook killed by ${r.signal}; stderr: ${r.stderr}`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(!r.stderr.includes('"level":"error"'), `hook logged an error: ${r.stderr}`);
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : null;
  } finally {
    r.cleanup();
  }
}

function runEdit(filePath, oldString, newString, { replaceAll = false } = {}) {
  const tool_input = { file_path: filePath, old_string: oldString, new_string: newString };
  if (replaceAll) tool_input.replace_all = true;
  const r = runHook(HOOK, {
    stdin: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input,
    },
    env: { VAULT_PATH: VAULT },
  });
  try {
    assert.equal(r.signal, null, `hook killed by ${r.signal}; stderr: ${r.stderr}`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(!r.stderr.includes('"level":"error"'), `hook logged an error: ${r.stderr}`);
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : null;
  } finally {
    r.cleanup();
  }
}

describe('pre-write-check', () => {
  before(() => {
    VAULT = mkdtempSync(join(tmpdir(), 'll-pwc-vault-'));
    NON_VAULT = mkdtempSync(join(tmpdir(), 'll-pwc-other-'));
    // Every dir the snapshot rebuild scans must exist, or the hook logs a
    // readdir error that trips run()'s clean-stderr assertion.
    for (const dir of [...VAULT_DIRS, ...TITLE_INDEX_EXTRA_DIRS, '_system']) {
      mkdirSync(join(VAULT, dir), { recursive: true });
    }
    writeFileSync(
      join(VAULT, '3-permanent', 'existing-note.md'),
      '---\ntitle: existing note\n---\n',
    );
    writeFileSync(join(VAULT, '6-writing', 'the-loud-room.md'), '---\ntitle: the loud room\n---\n');
    writeFileSync(
      join(VAULT, '3-permanent', 'dashed-note.md'),
      '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nThe gate is policy — not aspiration.\n',
    );
  });

  after(() => {
    rmSync(VAULT, { recursive: true, force: true });
    rmSync(NON_VAULT, { recursive: true, force: true });
  });

  it('ignores non-vault writes', () => {
    const result = run(
      'Write',
      join(NON_VAULT, 'file.md'),
      '---\ntags: [a, a]\ndate: 2026-08-03\nsource: synthesis\n---\n',
    );
    assert.equal(result, null);
  });

  it('ignores non-Write tools', () => {
    const result = run(
      'Read',
      join(VAULT, '0-inbox', 'test.md'),
      '---\ntags: [a, a]\ndate: 2026-08-03\nsource: synthesis\n---\n',
    );
    assert.equal(result, null);
  });

  it('ignores non-.md files in vault', () => {
    const result = run(
      'Write',
      join(VAULT, '0-inbox', 'test.txt'),
      '---\ntags: [a, a]\ndate: 2026-08-03\nsource: synthesis\n---\n',
    );
    assert.equal(result, null);
  });

  it('ignores _system/ paths', () => {
    const result = run(
      'Write',
      join(VAULT, '_system', 'config.md'),
      '---\ntags: [a, a]\ndate: 2026-08-03\nsource: synthesis\n---\n',
    );
    assert.equal(result, null);
  });

  it('denies duplicate tags (inline format)', () => {
    const content =
      '---\ntags: [sleep, circadian, sleep]\ndate: 2026-08-03\nsource: synthesis\n---\nBody text.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /sleep/);
  });

  it('denies duplicate tags (block format)', () => {
    const content = '---\ntags:\n  - sleep\n  - circadian\n  - sleep\n---\nBody text.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /sleep/);
  });

  it('allows clean notes with no issues', () => {
    const content =
      '---\ntags: [sleep, circadian]\ndate: 2026-08-03\nsource: synthesis\n---\nBody with [[existing-note]].';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.equal(result, null);
  });

  // Was 'allows notes with no frontmatter'. A bare note in an atomic folder is
  // how the vault accumulated 1429 notes with no source; the contract denies it.
  // Folders outside SCHEMA_CLASSES still take frontmatter-free notes.
  it('denies an atomic note with no frontmatter', () => {
    const content = 'Just a plain note with no frontmatter.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('allows a frontmatter-free note outside the atomic folders', () => {
    const content = 'Just a plain note with no frontmatter.';
    const result = run('Write', join(VAULT, '4-projects', 'index.md'), content);
    assert.equal(result, null);
  });

  it('warns on broken wikilinks (additionalContext, NOT deny)', () => {
    const content =
      '---\ntags: [sleep]\ndate: 2026-08-03\nsource: synthesis\n---\nSee [[nonexistent-note]] and [[also-missing]].';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, undefined);
    assert.ok(result.hookSpecificOutput.additionalContext);
    assert.match(result.hookSpecificOutput.additionalContext, /nonexistent-note/);
    assert.match(result.hookSpecificOutput.additionalContext, /also-missing/);
  });

  it('resolves bare-basename wikilinks to notes living in 6-writing/', () => {
    const content =
      '---\ntags: [sleep]\ndate: 2026-08-03\nsource: synthesis\n---\nSee [[the-loud-room]].';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.equal(result, null);
  });

  it('resolves subdir-prefixed wikilinks like [[6-writing/the-loud-room]]', () => {
    const content =
      '---\ntags: [sleep]\ndate: 2026-08-03\nsource: synthesis\n---\nSee [[6-writing/the-loud-room]].';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.equal(result, null);
  });

  it('resolves subdir-prefixed wikilinks like [[3-permanent/existing-note]]', () => {
    const content =
      '---\ntags: [sleep]\ndate: 2026-08-03\nsource: synthesis\n---\nSee [[3-permanent/existing-note]].';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.equal(result, null);
  });

  it('denies an em-dash in body prose, naming the line', () => {
    const content =
      '---\ntags: [sleep]\ndate: 2026-08-03\nsource: synthesis\n---\nThe rule is policy — or it is aspiration.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /em.?dash|en.?dash|dash/i);
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /aspiration/);
  });

  it('denies an en-dash in body prose', () => {
    const content =
      '---\ntags: [sleep]\ndate: 2026-08-03\nsource: synthesis\n---\nThe range is 3–5 notes per day.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  });

  // permissionDecision must not be 'deny' whether the hook emitted output or
  // not — optional chaining over null gives undefined, which satisfies
  // notEqual.
  it('allows an em-dash on a Source: line', () => {
    const content =
      '---\ntags: [sleep]\ndate: 2026-08-03\nsource: synthesis\n---\nClean body.\n\nSource: example.com — pulled after second reading.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.notEqual(result?.hookSpecificOutput?.permissionDecision, 'deny');
  });

  it('allows an em-dash on a Related: line', () => {
    const content =
      '---\ntags: [sleep]\ndate: 2026-08-03\nsource: synthesis\n---\nClean body.\n\nRelated: [[existing-note]] — the same shape at the data layer.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.notEqual(result?.hookSpecificOutput?.permissionDecision, 'deny');
  });

  it('allows an em-dash inside frontmatter only', () => {
    const content =
      '---\ntags: [sleep]\ndate: 2026-08-03\nsource: 2026-05-29 vault sweep — span bug caught in preview\n---\nClean body with no dashes.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.equal(result, null);
  });

  it('denies on duplicate tags before checking em-dashes (tags win)', () => {
    const content =
      '---\ntags: [sleep, sleep]\ndate: 2026-08-03\nsource: synthesis\n---\nBody with an em-dash — here.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /sleep/);
  });

  // Vault convention: frontmatter source: is an origin tag and a body
  // Sources: line is a citation — together they are neither a leak nor a
  // violation, so the hook must produce no output at all.
  it('stays silent on frontmatter source: plus a body Sources: line', () => {
    const content =
      '---\ntags: [test]\ndate: 2026-08-03\nsource: https://example.com/paper\ndate: 2026-05-21\n---\n\n# Test Note\n\nThe claim happens.\n\nSources: pulled from example.com after second reading.\n';
    const result = run('Write', join(VAULT, '0-inbox', 'test-conventions.md'), content);
    assert.equal(result, null);
  });

  it('stays silent on a body Sources: line with no frontmatter source field', () => {
    const content =
      '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\n\n# Test Note\n\nSources: a blog post.\n';
    const result = run('Write', join(VAULT, '0-inbox', 'test-conventions-2.md'), content);
    assert.equal(result, null);
  });

  it('allows a Write to an existing file whose pre-existing em-dash is carried unchanged', () => {
    const content =
      '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nThe gate is policy — not aspiration. A new clean sentence.\n';
    const result = run('Write', join(VAULT, '3-permanent', 'dashed-note.md'), content);
    assert.notEqual(result?.hookSpecificOutput?.permissionDecision, 'deny');
  });

  it('denies a Write to an existing dashed file when the new content ADDS another dash', () => {
    const content =
      '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nThe gate is policy — not aspiration.\nA second dash — added now.\n';
    const result = run('Write', join(VAULT, '3-permanent', 'dashed-note.md'), content);
    assert.ok(result, 'expected a deny payload');
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /em.?dash|en.?dash|dash/i);
  });

  it('denies a Write to a NEW file carrying an em-dash (any-dash deny unchanged)', () => {
    const content =
      '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nBrand new note — with a dash.\n';
    const result = run('Write', join(VAULT, '0-inbox', 'brand-new-dashed.md'), content);
    assert.ok(result, 'expected a deny payload');
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('denies an Edit whose new_string ADDS an em-dash (old_string clean)', () => {
    const result = runEdit(
      join(VAULT, '0-inbox', 'test.md'),
      'The rule is policy or it is aspiration.',
      'The rule is policy — or it is aspiration.',
    );
    assert.ok(result, 'expected a deny payload');
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /em.?dash|en.?dash|dash/i);
  });

  it('allows an Edit whose old_string and new_string both carry the same em-dash (pre-existing, not added)', () => {
    const result = runEdit(
      join(VAULT, '0-inbox', 'test.md'),
      'The rule is policy — or it is aspiration.',
      'The rule is policy — or it is an ambition.',
    );
    assert.notEqual(result?.hookSpecificOutput?.permissionDecision, 'deny');
  });

  it('warns on broken wikilinks in an Edit new_string (additionalContext, NOT deny)', () => {
    const result = runEdit(
      join(VAULT, '0-inbox', 'test.md'),
      'Clean body.',
      'See [[nonexistent-note]] and [[also-missing]].',
    );
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, undefined);
    assert.ok(result.hookSpecificOutput.additionalContext);
    assert.match(result.hookSpecificOutput.additionalContext, /nonexistent-note/);
    assert.match(result.hookSpecificOutput.additionalContext, /also-missing/);
  });

  // Edit-path dash semantics must match the Write path: recompute the
  // post-edit note from disk, strip frontmatter, and deny only when the
  // exposed BODY dash count increases. Fragment-only heuristics false-deny
  // when the fragment loses its frontmatter or Source:-line context.
  it('allows an Edit adding a dash inside frontmatter only', () => {
    const p = join(VAULT, '3-permanent', 'fm-edit-note.md');
    writeFileSync(
      p,
      '---\ntags: [test]\ndate: 2026-08-03\nsource: 2026-05-29 vault sweep\n---\nClean body with no dashes.\n',
    );
    const result = runEdit(
      p,
      'source: 2026-05-29 vault sweep',
      'source: 2026-05-29 vault sweep — span bug caught in preview',
    );
    assert.notEqual(result?.hookSpecificOutput?.permissionDecision, 'deny');
  });

  it('allows an Edit adding a dash to an existing Source: line via a fragment without the line prefix', () => {
    const p = join(VAULT, '3-permanent', 'source-line-edit-note.md');
    writeFileSync(
      p,
      '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nClean body.\n\nSource: example.com\n',
    );
    const result = runEdit(p, 'example.com', 'example.com — pulled after second reading');
    assert.notEqual(result?.hookSpecificOutput?.permissionDecision, 'deny');
  });

  it('still denies an Edit adding a dash to body prose of an on-disk note', () => {
    const p = join(VAULT, '3-permanent', 'body-prose-edit-note.md');
    writeFileSync(
      p,
      '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nThe rule is policy.\n',
    );
    const result = runEdit(p, 'The rule is policy.', 'The rule is policy — or it is aspiration.');
    assert.ok(result, 'expected a deny payload');
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /em.?dash|en.?dash|dash/i);
  });

  it('allows a replace_all Edit over dashed content when the dash count is unchanged', () => {
    const p = join(VAULT, '3-permanent', 'replace-all-edit-note.md');
    writeFileSync(
      p,
      '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nThe gate is policy — not aspiration.\nAgain: the gate is policy — not aspiration.\n',
    );
    const result = runEdit(p, 'policy — not aspiration', 'policy — never aspiration', {
      replaceAll: true,
    });
    assert.notEqual(result?.hookSpecificOutput?.permissionDecision, 'deny');
  });

  it('Edit payloads skip the duplicate-tags deny even when new_string carries duplicated tags', () => {
    const result = runEdit(
      join(VAULT, '0-inbox', 'test.md'),
      '---\ntags: [sleep]\ndate: 2026-08-03\nsource: synthesis\n---\nBody text.',
      '---\ntags: [sleep, circadian, sleep]\ndate: 2026-08-03\nsource: synthesis\n---\nBody text.',
    );
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Filename-style advisory tests
// ---------------------------------------------------------------------------

describe('pre-write-check filename-style advisory', () => {
  let STYLE_VAULT;

  // Populate one vault with kebab-style filenames (>70% without spaces).
  before(() => {
    STYLE_VAULT = mkdtempSync(join(tmpdir(), 'll-pwc-style-vault-'));
    for (const dir of [...VAULT_DIRS, ...TITLE_INDEX_EXTRA_DIRS, '_system']) {
      mkdirSync(join(STYLE_VAULT, dir), { recursive: true });
    }
    // 10 kebab names in 0-inbox so auto-detect resolves to 'kebab'.
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(STYLE_VAULT, '0-inbox', `existing-kebab-note-${i}.md`), '');
    }
  });

  after(() => {
    rmSync(STYLE_VAULT, { recursive: true, force: true });
  });

  // Run the hook with an optional config.json written into the sandbox.
  function runStyleHook(vaultPath, filePath, content, configObj) {
    const r = runHook(HOOK, {
      stdin: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: filePath, content },
      },
      env: { VAULT_PATH: vaultPath },
      seed: configObj
        ? (pluginDataDir) => {
            writeFileSync(join(pluginDataDir, 'config.json'), JSON.stringify(configObj));
          }
        : undefined,
    });
    try {
      assert.equal(r.signal, null, `hook killed by ${r.signal}; stderr: ${r.stderr}`);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(!r.stderr.includes('"level":"error"'), `hook logged an error: ${r.stderr}`);
      const out = r.stdout.trim();
      return out ? JSON.parse(out) : null;
    } finally {
      r.cleanup();
    }
  }

  it('kebab vault + spaced new filename → advisory present (warn, not deny)', () => {
    const result = runStyleHook(
      STYLE_VAULT,
      join(STYLE_VAULT, '0-inbox', 'My Spaced Note.md'),
      '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nBody.',
    );
    assert.ok(result, 'expected an advisory payload');
    assert.equal(result.hookSpecificOutput.permissionDecision, undefined, 'must warn, never deny');
    assert.ok(result.hookSpecificOutput.additionalContext, 'expected additionalContext');
    assert.match(result.hookSpecificOutput.additionalContext, /convention|kebab/i);
  });

  it('kebab vault + kebab new filename → no advisory', () => {
    const result = runStyleHook(
      STYLE_VAULT,
      join(STYLE_VAULT, '0-inbox', 'my-clean-note.md'),
      '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nBody.',
    );
    // Either null or no additionalContext about convention (may have other
    // advisories like broken wikilinks, but not a style one).
    if (result) {
      assert.ok(
        !result.hookSpecificOutput?.additionalContext?.includes('convention'),
        'unexpected style advisory on kebab-named note',
      );
    }
  });

  it('spaces vault + spaced filename → no advisory', () => {
    const spacesVault = mkdtempSync(join(tmpdir(), 'll-pwc-spaces-vault-'));
    try {
      for (const dir of [...VAULT_DIRS, ...TITLE_INDEX_EXTRA_DIRS, '_system']) {
        mkdirSync(join(spacesVault, dir), { recursive: true });
      }
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(spacesVault, '0-inbox', `Note With Spaces ${i}.md`), '');
      }
      const result = runStyleHook(
        spacesVault,
        join(spacesVault, '0-inbox', 'My New Note.md'),
        '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nBody.',
      );
      if (result) {
        assert.ok(
          !result.hookSpecificOutput?.additionalContext?.includes('convention'),
          'unexpected style advisory on spaces-named note in spaces vault',
        );
      }
    } finally {
      rmSync(spacesVault, { recursive: true, force: true });
    }
  });

  it('config override filename_style=kebab beats auto on a spaces vault', () => {
    const spacesVault = mkdtempSync(join(tmpdir(), 'll-pwc-cfg-vault-'));
    try {
      for (const dir of [...VAULT_DIRS, ...TITLE_INDEX_EXTRA_DIRS, '_system']) {
        mkdirSync(join(spacesVault, dir), { recursive: true });
      }
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(spacesVault, '0-inbox', `Note With Spaces ${i}.md`), '');
      }
      // Config says kebab even though vault population is spaces-dominant.
      const result = runStyleHook(
        spacesVault,
        join(spacesVault, '0-inbox', 'My Spaced Note.md'),
        '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nBody.',
        { filename_style: 'kebab' },
      );
      assert.ok(result, 'expected an advisory payload');
      assert.equal(
        result.hookSpecificOutput.permissionDecision,
        undefined,
        'must warn, never deny',
      );
      assert.match(result.hookSpecificOutput.additionalContext, /convention|kebab/i);
    } finally {
      rmSync(spacesVault, { recursive: true, force: true });
    }
  });

  it('existing-file Write (not new) → no style advisory', () => {
    const existingPath = join(STYLE_VAULT, '0-inbox', 'existing-kebab-note-0.md');
    const result = runStyleHook(
      STYLE_VAULT,
      existingPath,
      '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nUpdated body.',
    );
    if (result) {
      assert.ok(
        !result.hookSpecificOutput?.additionalContext?.includes('convention'),
        'unexpected style advisory on existing-file Write',
      );
    }
  });

  it('_system Write → no style advisory (isVaultNote filter)', () => {
    const result = runStyleHook(
      STYLE_VAULT,
      join(STYLE_VAULT, '_system', 'My Config.md'),
      '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nBody.',
    );
    assert.equal(result, null, '_system writes must be ignored entirely');
  });

  it('Edit → no style advisory', () => {
    const r = runHook(HOOK, {
      stdin: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: join(STYLE_VAULT, '0-inbox', 'My Spaced Note.md'),
          old_string: 'old',
          new_string: 'new',
        },
      },
      env: { VAULT_PATH: STYLE_VAULT },
    });
    try {
      assert.equal(r.signal, null);
      assert.equal(r.exitCode, 0, r.stderr);
      const out = r.stdout.trim();
      const result = out ? JSON.parse(out) : null;
      if (result) {
        assert.ok(
          !result.hookSpecificOutput?.additionalContext?.includes('convention'),
          'unexpected style advisory on Edit',
        );
      }
    } finally {
      r.cleanup();
    }
  });
});

describe('pre-write-check frontmatter schema', () => {
  let FM_VAULT;

  const VALID = '---\ntags: [test]\ndate: 2026-08-03\nsource: synthesis\n---\nBody.';

  before(() => {
    FM_VAULT = mkdtempSync(join(tmpdir(), 'll-pwc-fm-vault-'));
    for (const dir of [...VAULT_DIRS, ...TITLE_INDEX_EXTRA_DIRS, '_system']) {
      mkdirSync(join(FM_VAULT, dir), { recursive: true });
    }
    // Predates the contract: missing date and source, and using the `created:`
    // alias. Edits to it must stay possible.
    writeFileSync(
      join(FM_VAULT, '3-permanent', 'legacy-note.md'),
      '---\ntags: [legacy]\ncreated: 2026-01-01\n---\nOld body.\n',
    );
  });

  after(() => {
    rmSync(FM_VAULT, { recursive: true, force: true });
  });

  function write(relPath, content) {
    const r = runHook(HOOK, {
      stdin: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(FM_VAULT, relPath), content },
      },
      env: { VAULT_PATH: FM_VAULT },
    });
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      const out = r.stdout.trim();
      return out ? JSON.parse(out) : null;
    } finally {
      r.cleanup();
    }
  }

  function edit(relPath, oldString, newString) {
    const r = runHook(HOOK, {
      stdin: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: join(FM_VAULT, relPath),
          old_string: oldString,
          new_string: newString,
        },
      },
      env: { VAULT_PATH: FM_VAULT },
    });
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      const out = r.stdout.trim();
      return out ? JSON.parse(out) : null;
    } finally {
      r.cleanup();
    }
  }

  const denial = (result) =>
    result?.hookSpecificOutput?.permissionDecision === 'deny'
      ? result.hookSpecificOutput.permissionDecisionReason
      : null;

  it('accepts a conforming new note', () => {
    assert.equal(denial(write('0-inbox/good.md', VALID)), null);
  });

  it('denies a new note missing date and source', () => {
    const reason = denial(write('0-inbox/bare.md', '---\ntags: [test]\n---\nBody.'));
    assert.ok(reason, 'expected a deny');
    assert.match(reason, /`date:` is required/);
    assert.match(reason, /`source:` is required/);
  });

  it('denies the created: alias and names the replacement', () => {
    const content = '---\ntags: [test]\ncreated: 2026-08-03\nsource: synthesis\n---\nBody.';
    const reason = denial(write('0-inbox/aliased.md', content));
    assert.match(reason, /`created:` is not a vault key\. Use `date:`/);
  });

  it('denies source-project: and names the replacement', () => {
    const content = '---\ntags: [t]\ndate: 2026-08-03\nsource-project: learning-loop\n---\nBody.';
    const reason = denial(write('0-inbox/sp.md', content));
    assert.match(reason, /`source-project:` is not a vault key\. Use `source:`/);
  });

  it('denies a malformed date', () => {
    const content = '---\ntags: [t]\ndate: 03-08-2026\nsource: synthesis\n---\nBody.';
    assert.match(denial(write('0-inbox/baddate.md', content)), /not YYYY-MM-DD/);
  });

  it('denies a folder name smuggled into status:', () => {
    const content = VALID.replace('source: synthesis', 'source: synthesis\nstatus: permanent');
    assert.match(denial(write('0-inbox/badstatus.md', content)), /not an intention value/);
  });

  it('exempts folders that are not atomic notes', () => {
    assert.equal(denial(write('4-projects/index.md', '---\ntags: [t]\n---\nBody.')), null);
  });

  it('allows an edit to a legacy note that fixes nothing', () => {
    assert.equal(denial(edit('3-permanent/legacy-note.md', 'Old body.', 'New body.')), null);
  });

  it('allows an edit that repairs a legacy note', () => {
    const reason = denial(
      edit(
        '3-permanent/legacy-note.md',
        'created: 2026-01-01',
        'date: 2026-01-01\nsource: synthesis',
      ),
    );
    assert.equal(reason, null);
  });

  it('denies an edit that introduces a new violation on a legacy note', () => {
    const reason = denial(
      edit('3-permanent/legacy-note.md', 'tags: [legacy]', 'tags: [legacy]\nstatus: permanent'),
    );
    assert.match(reason, /not an intention value/);
  });
});
