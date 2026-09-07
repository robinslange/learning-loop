// tests/docs-name-real-commands.test.mjs
//
// "The document mentions the right word" and "the command exists" are
// different claims, and every other docs test in this repo checks the first.
// The gap between them is where a rewritten skill sends a person to a command
// that was renamed three commits earlier — `ll status` meant the search index
// until v5 gave the name to federation, and `--peer-id` outlived the field it
// named by a whole plan.
//
// **This asserts the complement is empty.** Not "the three known bad ones are
// gone" — an enumeration of today's defects can only ever agree with today's
// docs. Every command and every long flag the docs name is checked against the
// CLI, so a name nobody has written yet fails this the day it is written.
//
// The CLI list is DERIVED, from the `Commands` enum in main.rs. A hand-kept
// second list would be the same defect one level up: it would drift from the
// binary exactly as the docs did, and then agree with the docs about a command
// neither of them has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const MAIN_RS = join(ROOT, 'native', 'crates', 'll-search', 'src', 'main.rs');

// ---------------------------------------------------------------------------
// The CLI, out of the clap derive.
// ---------------------------------------------------------------------------

// clap's default rename: `ReflectScan` -> `reflect-scan`, `config_dir` ->
// `--config-dir`. Both cases, because variants are CamelCase and fields are
// snake_case, and getting only the first produces a flag list that looks
// plausible and matches nothing.
const kebab = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();

/**
 * Blank every string literal and comment to spaces, keeping the source's exact
 * length and its newlines.
 *
 * Everything below counts brackets, and a `"` help string in main.rs already
 * contains both `)` and `]`. Counting them without this is not a stricter
 * parse, it is a wrong one: the first multi-line `#[arg(long, help = "...")]`
 * swallows the rest of the enum and the CLI list comes back with two commands
 * in it. So the brackets that survive here are only the real ones.
 */
function blankLiterals(src) {
  let out = '';
  let i = 0;
  const space = (c) => (c === '\n' ? '\n' : ' ');
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      out += ' ';
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += ' ' + space(src[i + 1] ?? ' ');
          i += 2;
          continue;
        }
        if (src[i] === '"') {
          out += ' ';
          i += 1;
          break;
        }
        out += space(src[i]);
        i += 1;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let d = 0;
      while (i < src.length) {
        if (src[i] === '/' && src[i + 1] === '*') d += 1;
        else if (src[i] === '*' && src[i + 1] === '/') {
          d -= 1;
          out += '  ';
          i += 2;
          if (d === 0) break;
          continue;
        }
        out += space(src[i]);
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The `]` that closes the `#[` at `open`. */
function closeBracket(code, open) {
  let d = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '[') d += 1;
    else if (code[i] === ']') {
      d -= 1;
      if (d === 0) return i;
    }
  }
  throw new Error(`unterminated attribute at ${open}`);
}

/**
 * One `enum X { ... }` body, from the index of its opening brace.
 *
 * Variants are the capitalised names at depth 1; a variant's long flags are
 * its fields carrying an `#[arg(... long ...)]`; a field carrying
 * `#[command(subcommand)]` names the enum the variant delegates to.
 */
function parseEnumBody(code, brace) {
  const variants = {};
  const nestedOf = {};
  let depth = 1;
  let attrs = '';
  let variant = null;

  for (let i = brace + 1; i < code.length && depth > 0; ) {
    const c = code[i];
    if (c === '#' && code[i + 1] === '[') {
      const end = closeBracket(code, i + 1);
      attrs += code.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 1) {
      const m = /^([A-Z]\w*)/.exec(code.slice(i));
      if (m) {
        variant = m[1];
        variants[variant] = new Set();
        attrs = '';
        i += m[1].length;
        continue;
      }
    }
    if (depth === 2 && variant && /[a-z_]/.test(c) && !/[\w]/.test(code[i - 1] ?? ' ')) {
      const m = /^([a-z_]\w*)\s*:\s*(\w+)/.exec(code.slice(i));
      if (m) {
        if (/#\[command\(\s*subcommand\s*\)\]/.test(attrs)) {
          nestedOf[variant] = m[2];
        } else if (/#\[arg\(/.test(attrs) && /\blong\b/.test(attrs)) {
          // A renamed flag would make the field name a lie. Nothing in main.rs
          // does this today; if something starts, fail here rather than
          // silently asserting against a flag that does not exist.
          assert.ok(!/\blong\s*=/.test(attrs), `${variant}.${m[1]} renames its long flag`);
          variants[variant].add(`--${kebab(m[1])}`);
        }
        attrs = '';
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return { variants, nestedOf };
}

/** Every `#[derive(Subcommand)] enum X` in main.rs. */
function parseSubcommandEnums(src) {
  const code = blankLiterals(src);
  const enums = {};
  const nested = {};
  for (const m of code.matchAll(/#\[derive\([^)]*\bSubcommand\b[^)]*\)\]\s*enum\s+(\w+)\s*\{/g)) {
    const brace = m.index + m[0].length - 1;
    const { variants, nestedOf } = parseEnumBody(code, brace);
    enums[m[1]] = variants;
    for (const [variant, child] of Object.entries(nestedOf)) nested[`${m[1]}.${variant}`] = child;
  }
  return { enums, nested };
}

const { enums, nested } = parseSubcommandEnums(readFileSync(MAIN_RS, 'utf8'));

/** `{ 'reflect-scan': Set<flag>, 'link approve': Set<flag>, ... }` */
function flattenCli(enumName, prefix = '') {
  const out = {};
  for (const [variant, flags] of Object.entries(enums[enumName] ?? {})) {
    const name = prefix ? `${prefix} ${kebab(variant)}` : kebab(variant);
    const child = nested[`${enumName}.${variant}`];
    if (child) {
      // The group itself is a real name a doc may use in prose ("`ll-search
      // link` pairs a machine"), and every leaf under it is a real command.
      out[name] = new Set();
      Object.assign(out, flattenCli(child, name));
    } else {
      out[name] = flags;
    }
  }
  return out;
}

const CLI = flattenCli('Commands');

/** Flags clap supplies itself, on every subcommand. */
const CLAP_BUILTINS = new Set(['--help', '--version']);

// ---------------------------------------------------------------------------
// The docs.
// ---------------------------------------------------------------------------

const DOCS = [
  join(ROOT, 'ARCHITECTURE.md'),
  join(ROOT, 'README.md'),
  ...walkMarkdown(join(ROOT, 'plugin', 'skills')),
];

function walkMarkdown(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'vendor' ? [] : walkMarkdown(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}

/**
 * The code-ish spans of a markdown file: fenced blocks and inline-code spans.
 *
 * Only these. Prose says things like "`ll-search` is a clap CLI binary", and a
 * word-boundary scan over prose would decide `is` is a subcommand. Restricting
 * to code spans is what makes a hit worth failing on.
 */
function codeSpans(md) {
  const spans = [];
  const fenced = md.replace(/```[a-z]*\n([\s\S]*?)```/g, (_, body) => {
    spans.push(...body.split('\n'));
    return '\n';
  });
  for (const m of fenced.matchAll(/`([^`\n]+)`/g)) spans.push(m[1]);
  return spans;
}

/** The subcommand names that take a subcommand of their own. */
const GROUPS = new Set(Object.keys(nested).map((k) => kebab(k.split('.')[1])));

/**
 * Every `ll-search <sub>` invocation in a code span, with the long flags
 * written after it.
 *
 * **The invocation must START the span or the line.** Fenced blocks in these
 * skills are as often a mock of the dashboard as they are a command —
 * `  ✗ ll-search binary   missing at …` and `  Binary: ll-search vX.Y.Z` are
 * both real lines in real skills, and a scan that took `ll-search` anywhere in
 * a line would call `binary` and `vX` commands. What actually distinguishes a
 * command from a noun phrase is position: a command line begins with the
 * binary, and a sentence about the binary does not.
 *
 * Under a group (`link`, `vault`) the SECOND word is part of the name and is
 * not allowed to fall back to the group. `ll-search link revoke` must fail as
 * `link revoke`; resolving it to the group would let any invented subcommand
 * pass under a real one.
 */
function parseSpan(span) {
  const m = /^\s*(?:\$\s+)?(?:ll|ll-search)((?:\s+[a-z][a-z0-9-]*)+)/.exec(span);
  if (!m) return null;
  const words = m[1].trim().split(/\s+/);
  const name = GROUPS.has(words[0]) && words[1] ? `${words[0]} ${words[1]}` : words[0];
  const rest = span.slice(m[0].length);
  const flags = [...rest.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)].map((f) => f[1]);
  return { name, flags };
}

// ---------------------------------------------------------------------------

test('the CLI list is derived, and the derivation actually works', () => {
  // If the parser silently produced nothing, every assertion below would pass
  // vacuously — which is the failure mode a derived list is supposed to avoid.
  assert.ok(Object.keys(CLI).length > 25, `parsed only ${Object.keys(CLI).length} commands`);
  for (const known of [
    'query',
    'status',
    'index-status',
    'graph-opt-in',
    'link approve',
    'vault add',
  ]) {
    assert.ok(known in CLI, `parser missed ${known}`);
  }
  assert.ok(CLI['sync'].has('--hub-endpoint'), 'parser missed sync --hub-endpoint');
  assert.ok(CLI['link approve'].has('--offline'), 'parser missed link approve --offline');
  assert.ok(!('unfollow' in CLI), 'parser invented a command that is not in the enum');
});

test('the extraction catches a command that is absent, and one hiding under a group', () => {
  // Before believing a green run, check the extractor against names that are
  // NOT in the CLI. A green extractor that matches nothing is
  // indistinguishable from a green extractor that matches everything.
  //
  // The fixtures are deliberately synthetic. An earlier version used
  // `ll-search link revoke` as the absent name and went red the day that
  // command landed — a true report about the CLI, but this test is about the
  // extractor, and coupling it to which commands happen not to exist yet
  // makes every future subcommand a failure here.
  const absent = 'zzz-not-a-command';
  assert.ok(!(absent in CLI), 'the negative fixture must stay absent');
  assert.equal(parseSpan(`ll-search ${absent} --now`).name, absent);

  // `link` IS a real command, so an invented subcommand under it must not be
  // allowed to resolve to the group and pass. This is the case that matters:
  // without it, any invented subcommand inherits its group's existence.
  assert.ok(GROUPS.has('link'), 'link must be a group for this check to mean anything');
  assert.ok(!(`link ${absent}` in CLI));
  assert.equal(parseSpan(`ll-search link ${absent} <key>`).name, `link ${absent}`);

  // Flags are checked against the command they are written on, not the union.
  assert.deepEqual(parseSpan('ll-search sync <db> <vault> [--peer-id ID]').flags, ['--peer-id']);
  assert.ok(!CLI['sync'].has('--peer-id'), 'Plan 5 removed peer_id from Commands::Sync');
  assert.ok(CLI['link approve'].has('--offline'), 'and a real flag on a real command passes');

  // A sentence about the binary is not an invocation of it.
  assert.equal(parseSpan('  ✗ ll-search binary            missing at /x/bin/ll-search'), null);
  assert.equal(parseSpan('  Binary:        ll-search vX.Y.Z (installed)'), null);
});

test('every command the docs name exists in the CLI', () => {
  const unknown = [];
  for (const file of DOCS) {
    for (const span of codeSpans(readFileSync(file, 'utf8'))) {
      const hit = parseSpan(span);
      if (hit && !(hit.name in CLI)) unknown.push(`${relative(ROOT, file)}: ll-search ${hit.name}`);
    }
  }
  assert.deepEqual(
    [...new Set(unknown)].sort(),
    [],
    `documented commands that do not exist:\n${[...new Set(unknown)].sort().join('\n')}`,
  );
});

test('every flag the docs name exists on the command they name it on', () => {
  const unknown = [];
  for (const file of DOCS) {
    for (const span of codeSpans(readFileSync(file, 'utf8'))) {
      const hit = parseSpan(span);
      if (!hit) continue;
      const valid = CLI[hit.name];
      if (!valid) continue; // the previous test owns that failure
      for (const flag of hit.flags) {
        if (!valid.has(flag) && !CLAP_BUILTINS.has(flag)) {
          unknown.push(`${relative(ROOT, file)}: ll-search ${hit.name} ${flag}`);
        }
      }
    }
  }
  assert.deepEqual(
    [...new Set(unknown)].sort(),
    [],
    `documented flags that do not exist:\n${[...new Set(unknown)].sort().join('\n')}`,
  );
});
