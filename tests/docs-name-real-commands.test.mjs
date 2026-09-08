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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, publishedFiles } from './helpers/published-docs.mjs';

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
 * `#[command(subcommand)]` names the enum the variant delegates to. Every
 * other field is a POSITIONAL, and its place in the list is its place on the
 * command line — `Option<T>` may be left off the end, `Vec<T>` takes the rest.
 */
function parseEnumBody(code, brace) {
  const variants = {};
  const positionalsOf = {};
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
        positionalsOf[variant] = [];
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
        } else {
          positionalsOf[variant].push({ name: m[1], type: m[2] });
        }
        attrs = '';
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return { variants, positionalsOf, nestedOf };
}

/** Every `#[derive(Subcommand)] enum X` in main.rs. */
function parseSubcommandEnums(src) {
  const code = blankLiterals(src);
  const enums = {};
  const positions = {};
  const nested = {};
  for (const m of code.matchAll(/#\[derive\([^)]*\bSubcommand\b[^)]*\)\]\s*enum\s+(\w+)\s*\{/g)) {
    const brace = m.index + m[0].length - 1;
    const { variants, positionalsOf, nestedOf } = parseEnumBody(code, brace);
    enums[m[1]] = variants;
    positions[m[1]] = positionalsOf;
    for (const [variant, child] of Object.entries(nestedOf)) nested[`${m[1]}.${variant}`] = child;
  }
  return { enums, positions, nested };
}

const { enums, positions, nested } = parseSubcommandEnums(readFileSync(MAIN_RS, 'utf8'));

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

/** `{ 'join': { min: 3, max: 3 }, 'intentions': { min: 1, max: 2 }, ... }` */
function flattenArity(enumName, prefix = '') {
  const out = {};
  for (const [variant, fields] of Object.entries(positions[enumName] ?? {})) {
    const name = prefix ? `${prefix} ${kebab(variant)}` : kebab(variant);
    const child = nested[`${enumName}.${variant}`];
    if (child) {
      out[name] = { min: 0, max: 0 };
      Object.assign(out, flattenArity(child, name));
    } else {
      const variadic = fields.some((f) => f.type === 'Vec');
      const required = fields.filter((f) => f.type !== 'Vec' && f.type !== 'Option').length;
      out[name] = { min: required, max: variadic ? Infinity : fields.length };
    }
  }
  return out;
}

const ARITY = flattenArity('Commands');

/** Flags clap supplies itself, on every subcommand. */
const CLAP_BUILTINS = new Set(['--help', '--version']);

// ---------------------------------------------------------------------------
// The docs.
// ---------------------------------------------------------------------------

/**
 * Every markdown document this repository publishes.
 *
 * Exclusion-based, sharing one list with the dead-flow sweep — see
 * `helpers/published-docs.mjs`. The include list this replaced named
 * `plugin/skills/**`, `ARCHITECTURE.md` and `README.md`, and was green while
 * `guide/federation.md` documented a command surface three protocol versions
 * old. A test's file list is itself a claim, and nothing was checking it.
 */
const DOCS = () => publishedFiles('*.md');

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
  return { name, flags, positionals: leadingPositionals(rest) };
}

/**
 * The positional arguments a span writes: the leading run of words before the
 * first flag, optional bracket, or shell operator.
 *
 * Leading, because that is how every invocation in these documents is written
 * and how clap prints its own usage — `[OPTIONS] <A> <B>` reads the same way
 * round. Taking every non-flag word instead would count a flag's VALUE
 * (`--config-dir <config_dir>`) as another positional, which is the reading
 * that makes the check disagree with the CLI on correct documents.
 *
 * The run also stops at a pipe or a redirection: `ll-search index "$VAULT"
 * "$VAULT/…/vault-index.db" 2>&1 | tail -1` supplies two arguments, and the
 * three shell tokens after them are not a third, fourth and fifth.
 */
function leadingPositionals(rest) {
  const out = [];
  for (const tok of rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
    if (/^(-|\[|#|\||&|;|\d*>|<<)/.test(tok)) break;
    out.push(tok);
  }
  return out;
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
    'visibility-backfill',
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

test('the doc sweep reaches the documents, and actually finds invocations in them', () => {
  // Two ways this suite could be green for the wrong reason, and the include
  // list it replaced was the first: sweeping no documents, or sweeping them and
  // extracting nothing. Both are checked here rather than assumed.
  const docs = DOCS();
  assert.ok(docs.length > 50, `swept only ${docs.length} documents`);
  for (const expected of ['ARCHITECTURE.md', 'README.md', 'guide/federation.md']) {
    assert.ok(docs.includes(expected), `the sweep must reach ${expected}`);
  }
  const found = docs.flatMap((rel) =>
    codeSpans(readFileSync(join(ROOT, rel), 'utf8'))
      .map(parseSpan)
      .filter(Boolean)
      .map((hit) => hit.name),
  );
  assert.ok(
    found.length > 30,
    `extracted only ${found.length} invocations from ${docs.length} docs`,
  );
  assert.ok(found.includes('identity'), 'guide/federation.md documents `ll-search identity`');
});

test('every command the docs name exists in the CLI', () => {
  const unknown = [];
  for (const rel of DOCS()) {
    for (const span of codeSpans(readFileSync(join(ROOT, rel), 'utf8'))) {
      const hit = parseSpan(span);
      if (hit && !(hit.name in CLI)) unknown.push(`${rel}: ll-search ${hit.name}`);
    }
  }
  assert.deepEqual(
    [...new Set(unknown)].sort(),
    [],
    `documented commands that do not exist:\n${[...new Set(unknown)].sort().join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// The other direction.
// ---------------------------------------------------------------------------

/**
 * A guard that checks one direction of a two-way property will eventually be
 * trusted for both. Everything above asks whether a documented command exists;
 * nothing asked whether an existing command is documented, which is how
 * `ll link revoke` shipped undocumented through a whole plan of
 * doc-consistency work and stayed green.
 *
 * Same derived `CLI` map, same span parser, read the other way round.
 */

/** The document that owes a line to every command. */
const ARCHITECTURE = 'ARCHITECTURE.md';

/**
 * Commands `ARCHITECTURE.md` is allowed not to name, and why each one is out.
 *
 * Same shape as `published-docs.mjs`'s `EXCLUDED`, and checked for rot the
 * same way: an entry naming a command that no longer exists, or one that the
 * document has since started naming, is coverage that reads as real and is
 * not.
 */
const UNDOCUMENTED = [];

/**
 * The commands a document owes a line to: every LEAF of the CLI.
 *
 * A group (`link`, `vault`) is not a runnable command — it is named by its
 * leaves, and requiring a bare `ll-search link` span would be asserting a
 * sentence nobody has a reason to write.
 */
const LEAF_COMMANDS = Object.keys(CLI).filter((name) => !GROUPS.has(name));

/** Every `ll-search <cmd>` invocation `rel` names, by command name. */
function commandsNamedIn(rel) {
  return new Set(
    codeSpans(readFileSync(join(ROOT, rel), 'utf8'))
      .map(parseSpan)
      .filter(Boolean)
      .map((hit) => hit.name),
  );
}

test('every command in the CLI is named in ARCHITECTURE.md', () => {
  const named = commandsNamedIn(ARCHITECTURE);
  // Sweeping the document and extracting nothing from it would pass the
  // assertion below by finding no command anywhere. Same failure the include
  // list was.
  assert.ok(named.size > 20, `extracted only ${named.size} invocations from ${ARCHITECTURE}`);

  const excused = new Set(UNDOCUMENTED.map((e) => e.name));
  const missing = LEAF_COMMANDS.filter((name) => !named.has(name) && !excused.has(name));
  assert.deepEqual(
    missing.sort(),
    [],
    `commands the CLI has and ${ARCHITECTURE} does not name:\n${missing.sort().join('\n')}`,
  );
});

test('every exclusion from the ARCHITECTURE sweep still describes something real', () => {
  const named = commandsNamedIn(ARCHITECTURE);
  for (const { name, why } of UNDOCUMENTED) {
    assert.ok(why, `${name} is excluded with no reason`);
    assert.ok(LEAF_COMMANDS.includes(name), `${name} is excluded and is not a command`);
    assert.ok(!named.has(name), `${name} is excluded and ${ARCHITECTURE} names it anyway`);
  }
});

/**
 * Existence is not the whole claim a document makes about a command.
 *
 * `ll-search join <hub-endpoint> <invite-code> <vault-path>` says three things:
 * that `join` exists, that it takes three arguments, and that they go in that
 * order. Everything above checks the first. The second is checkable against the
 * same derived CLI, and it is the half that strands a reader — a documented
 * invocation missing an argument is a command that exits non-zero, or panics,
 * on the line the reader was told to run.
 *
 * A span that writes NO arguments is skipped, not failed: `ll-search sync`
 * inside a sentence is the command's name, not an invocation of it, and the
 * documents use it that way in a dozen places.
 */
test('every documented invocation supplies the arguments its command takes', () => {
  const wrong = [];
  for (const rel of DOCS()) {
    for (const span of codeSpans(readFileSync(join(ROOT, rel), 'utf8'))) {
      const hit = parseSpan(span);
      if (!hit || hit.positionals.length === 0) continue;
      const arity = ARITY[hit.name];
      if (!arity) continue; // the existence test owns that failure
      const n = hit.positionals.length;
      if (n < arity.min || n > arity.max) {
        wrong.push(
          `${rel}: ll-search ${hit.name} takes ${arity.min}..${arity.max} ` +
            `positionals, written with ${n} (${hit.positionals.join(' ')})`,
        );
      }
    }
  }
  assert.deepEqual([...new Set(wrong)].sort(), [], `wrong arity:\n${wrong.join('\n')}`);
});

test('the arity derivation and its extraction both work', () => {
  // Same reason as the other two derivation guards: an arity map that came
  // back empty, or an extractor that finds no arguments, would make the test
  // above pass by looking at nothing.
  assert.deepEqual(ARITY['join'], { min: 3, max: 3 });
  assert.deepEqual(ARITY['sync'], { min: 2, max: 2 });
  assert.deepEqual(ARITY['status'], { min: 0, max: 0 });
  // `Option` may be omitted, `Vec` takes the rest — both come out of the type,
  // and a check that only counted fields would get these two wrong.
  assert.deepEqual(ARITY['intentions'], { min: 1, max: 2 });
  assert.deepEqual(ARITY['tune-prf'], { min: 1, max: Infinity });

  // A flag's value is not a positional, or every documented `--config-dir DIR`
  // would read as one more argument than the command takes.
  assert.deepEqual(parseSpan('ll-search status --config-dir <config_dir>').positionals, []);
  assert.deepEqual(parseSpan('ll-search join <h> <i> <v> --config-dir <d>').positionals, [
    '<h>',
    '<i>',
    '<v>',
  ]);
  // Shell tokens after the arguments are not arguments.
  assert.deepEqual(parseSpan('ll-search index "$VAULT" "$DB" 2>&1 | tail -1').positionals, [
    '"$VAULT"',
    '"$DB"',
  ]);
  // And the check can actually fail: this is what a doc that dropped the index
  // path from a `sync` line looks like.
  const short = parseSpan('ll-search sync <vault-path>');
  assert.equal(short.positionals.length, 1);
  assert.ok(short.positionals.length < ARITY['sync'].min);
});

test('every flag the docs name exists on the command they name it on', () => {
  const unknown = [];
  for (const rel of DOCS()) {
    for (const span of codeSpans(readFileSync(join(ROOT, rel), 'utf8'))) {
      const hit = parseSpan(span);
      if (!hit) continue;
      const valid = CLI[hit.name];
      if (!valid) continue; // the previous test owns that failure
      for (const flag of hit.flags) {
        if (!valid.has(flag) && !CLAP_BUILTINS.has(flag)) {
          unknown.push(`${rel}: ll-search ${hit.name} ${flag}`);
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
