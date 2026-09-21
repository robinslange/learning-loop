// tests/provenance-emit-callsites.test.mjs
//
// The emit contract lives in ~38 hand-written JSON literals scattered across
// plugin/skills/**/*.md and plugin/agents/**/*.md, not in one shared harness
// call. This test is the harness's enforcement leg (1e-bis, item 4): it scans
// every provenance-emit.js invocation and asserts the payload parses and
// validates, so a call site missing `skill`, carrying a NEVER_EXPORT field or
// emitting free-text `intent_kind` fails here instead of three months later in
// a dashboard.
//
// Call sites come in two shapes and both must be caught:
//   inline:  `ll-run provenance-emit.js '{...}'`
//   heredoc: `ll-run provenance-emit.js - <<'JSON' ... JSON`
// A grep for the inline form alone silently skips the heredoc form.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { VALID_ACTIONS, INTENT_KINDS } from '../plugin/scripts/lib/provenance-vocabulary.mjs';
import { NEVER_EXPORT } from '../plugin/scripts/otel/schema.mjs';

const ROOT = join(import.meta.dirname, '..', 'plugin');
const SCAN_DIRS = ['skills', 'agents'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (extname(p) === '.md') out.push(p);
  }
  return out;
}

// Markdown call sites hold literal placeholders (N, TOPIC, NOTE_FILENAME,
// true|false, ACTION, R) in place of real values, so a strict JSON.parse
// would fail on every one of them. Placeholders are normalised to valid JSON
// before parsing rather than parsed structurally, because the payloads are
// otherwise well-formed JSON and a normalising pass is far less code than a
// hand-rolled structural matcher.
function normalisePlaceholders(json) {
  return json
    .replace(/:\s*true\|false\b/g, ': true')
    .replace(/"[A-Z][A-Z0-9_]*(\|[A-Z][A-Z0-9_ ]*)+"/g, '"placeholder"') // "PASS|PARTIAL|ISSUES_FOUND"
    .replace(/:\s*N\b/g, ': 0')
    .replace(/:\s*R\b/g, ': 0')
    .replace(/"<[^"]*>"/g, '"placeholder"')
    .replace(/:\s*<[^>]*>/g, ': 0') // bare <cosine>-style numeric placeholder, not string-quoted
    .replace(/\[\s*"type1"\s*\]/g, '["placeholder"]');
}

// Extracts every provenance-emit.js payload from a markdown file's text,
// covering both the inline `'{...}'` shape and the `- <<'JSON' ... JSON`
// heredoc shape.
function extractPayloads(text) {
  const payloads = [];

  for (const m of text.matchAll(/provenance-emit\.js\s+'(\{.*\})'/g)) {
    payloads.push(m[1]);
  }

  for (const m of text.matchAll(/provenance-emit\.js\s+-\s+<<'JSON'\n([\s\S]*?)\nJSON/g)) {
    payloads.push(m[1].trim());
  }

  return payloads;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
const callSites = [];
for (const file of files) {
  const text = readFileSync(file, 'utf-8');
  for (const raw of extractPayloads(text)) {
    // dream/SKILL.md documents the ACTION placeholder pattern itself, not a
    // real call site: `"action":"ACTION"` never parses to a valid action and
    // is explained one line below as a template for the real per-operator
    // calls (which each match this scanner in their own files).
    if (raw.includes('"action":"ACTION"')) continue;
    callSites.push({ file, raw });
  }
}

test('the scanner finds every provenance-emit.js call site, both shapes', () => {
  // Ground truth: 35 inline + 3 heredoc = 38, minus dream/SKILL.md's one
  // ACTION-placeholder template line that documents the pattern rather than
  // emitting.
  assert.strictEqual(
    callSites.length,
    37,
    `expected 37 real call sites, found ${callSites.length}`,
  );

  const heredocSites = callSites.filter((c) => !c.raw.startsWith("'"));
  const fromHeredocFiles = callSites.filter((c) =>
    ['usage-provenance.md', 'note-verifier.md'].some((f) => c.file.endsWith(f)),
  );
  // verify/SKILL.md, reflect's usage-provenance.md and note-verifier.md each
  // contribute a heredoc payload; confirms the heredoc regex actually matched
  // rather than the inline regex silently absorbing zero heredoc sites.
  assert.ok(fromHeredocFiles.length >= 3, 'expected to find the known heredoc call sites');
});

test('every provenance-emit.js payload parses as JSON', () => {
  for (const { file, raw } of callSites) {
    const normalised = normalisePlaceholders(raw);
    assert.doesNotThrow(() => JSON.parse(normalised), `${file}: failed to parse payload:\n${raw}`);
  }
});

test('every payload has an action in VALID_ACTIONS', () => {
  for (const { file, raw } of callSites) {
    const payload = JSON.parse(normalisePlaceholders(raw));
    assert.ok(
      VALID_ACTIONS.has(payload.action),
      `${file}: action "${payload.action}" is not in VALID_ACTIONS`,
    );
  }
});

// NEVER_EXPORT governs the OTLP export boundary (validateExportRecord), not
// local JSONL emission: free-text fields like `target` (a vault path),
// `finding_detail` and `evidence` are legitimate at the emit layer across the
// whole plugin and stay there deliberately, so raw JSONL keeps everything for
// audit while export drops what it must at read time. Removing them from
// call sites is the bulk migration this task explicitly does not own (see
// SCOPE in the task prompt: 5 named agent files and the harness only, not all
// ~38 call sites). `intent` is the one exception: replacing it with
// `intent_kind` on the 3 named skills IS this task's job, checked separately
// below, so it is deliberately absent from this exemption list.
//
// This exemption is now a DELIBERATE BOUNDARY, not deferred work. Migrating
// these fields out of local emits was investigated and declined: `target` is
// read in five places by provenance-report.mjs plus injection-precision.mjs,
// `finding_type`/`ambiguous_alt` feed its taxonomy-health metric, and
// `finding_detail`, though unread by any tool, holds 101 historical records of
// what /verify actually found and exists nowhere else. NEVER_EXPORT governs the
// export boundary; phase 0 already stops all of these at the wire. See
// "The bulk call-site migration: investigated, then declined" in the plan.
const EMIT_LAYER_EXEMPT = new Set([
  'target',
  'evidence',
  'finding_detail',
  'prompt',
  'question',
  'reason',
  'topic',
]);

test('no payload contains a NEVER_EXPORT field, aside from the emit-layer exemption', () => {
  for (const { file, raw } of callSites) {
    const payload = JSON.parse(normalisePlaceholders(raw));
    for (const key of Object.keys(payload)) {
      if (EMIT_LAYER_EXEMPT.has(key)) continue;
      assert.ok(
        !NEVER_EXPORT.has(key),
        `${file}: field "${key}" is in NEVER_EXPORT and must not be emitted`,
      );
    }
  }
});

test('any intent_kind is a bounded value from INTENT_KINDS', () => {
  for (const { file, raw } of callSites) {
    const payload = JSON.parse(normalisePlaceholders(raw));
    if ('intent_kind' in payload) {
      assert.ok(
        INTENT_KINDS.has(payload.intent_kind),
        `${file}: intent_kind "${payload.intent_kind}" is not in INTENT_KINDS`,
      );
    }
  }
});

test('no payload emits free-text intent', () => {
  for (const { file, raw } of callSites) {
    const payload = JSON.parse(normalisePlaceholders(raw));
    assert.ok(
      !('intent' in payload),
      `${file}: emits free-text "intent"; use "intent_kind" instead`,
    );
  }
});

// An adversarial review found two live actions the vocabulary missed:
// supersession-recorded and refinement-skipped, both instructed in prose at
// reflect/steps/refinement.md:150 as `action: "..."` rather than inside a JSON
// payload, so the scanner above (which reads provenance-emit.js invocations)
// could not see them. This closes the class: every action named anywhere in
// skill or agent markdown must be emittable.
test('every action named in skill or agent prose is emittable', () => {
  const named = new Map();
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const text = readFileSync(file, 'utf-8');
      // Covers both quote styles and digits/underscores, not just the two
      // spellings seen today: `action: "x"` in prose, "action":"x" in a
      // payload, and single-quoted variants. A leading `"` is required to be
      // part of the key or absent entirely, so `"actions":{...}` (a different
      // field) cannot match.
      for (const m of text.matchAll(/\baction"?\s*:\s*['"]([a-z][a-z0-9_-]*)['"]/g)) {
        if (!named.has(m[1])) named.set(m[1], file);
      }
    }
  }
  assert.ok(named.size > 10, `expected many actions, found ${named.size}`);
  const missing = [...named.entries()]
    .filter(([a]) => !VALID_ACTIONS.has(a))
    .map(([a, f]) => `${a} (${f.replace(ROOT, 'plugin')})`);
  assert.deepEqual(missing, [], 'instructed in markdown but would be dropped at emit');
});
