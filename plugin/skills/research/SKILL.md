---
name: research
description: 'Deep research with the local librarian doing the token-heavy middle. Scope on Claude, Search+Fetch+Extract on the local Ollama model, adversarial Verify + Synthesize back on Claude. Usage: /learning-loop:research "<question>". Falls back to Claude-native WebSearch when the librarian is unavailable or sub-tier.'
---

# Research: librarian-offloaded deep research

## Overview

Same shape as the built-in `/deep-research` — Scope → Search → Fetch → Extract →
3-vote adversarial Verify → Synthesize — but the **middle three phases run on the
local librarian** (via `bin/source-gateway.mjs research`: Brave search + fetch +
local Gemma claim extraction). Roughly 15 source documents are distilled to one-line
cited claims _before anything reaches Claude_. Scope, Verify, and Synthesize stay
on Claude — Verify is the step most likely to expose a small model's reasoning
gap, and it runs over cheap one-line claims, not prose.

If the librarian can't run (Ollama down, no Brave key, sub-tier model, or it
returns zero claims) the workflow **falls back to the Claude-native WebSearch
path** so the command never hard-breaks.

## When to use

- `/learning-loop:research "<question>"` — a deep, multi-source, fact-checked
  report when you have a research-capable local model (12b+; chosen at `/init`).
- If the question is underspecified (e.g. "what car to buy" with no
  budget/use-case/region), ask 2-3 clarifying questions first, then weave the
  answers into the question you pass.

## Prerequisites (the workflow checks these, but know them)

- Ollama running locally with a research-capable model resident (`gemma3:12b`
  default; the e2b tier is triage-only and will trip the capability gate).
- Brave API key in the macOS Keychain (`service="brave-search-api-key"`,
  `account=$USER`) — same key the Brave MCP uses.
- The model and `keep_alive` come from `librarian.*` config (set at `/init`).
  **Cold start:** the first 12b call adds ~10-40s; `keep_alive` (default 30m)
  keeps it warm after. To avoid a cold first call, warm it first:
  `curl -s localhost:11434/api/generate -d '{"model":"gemma3:12b","prompt":"hi","stream":false,"keep_alive":"30m"}' >/dev/null`

## How to run

**First, resolve the plugin root** — `${CLAUDE_PLUGIN_ROOT}` is set in your main
session but is NOT exported into Workflow subagent shells, so the workflow must be
handed a concrete absolute path. In a Bash block, run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" PLUGIN
```

That prints the absolute plugin root. Then invoke the `Workflow` tool passing
`args` as an object: `{ "question": "<the question>", "pluginRoot": "<that path>" }`.

The script offloads Search+Fetch+Extract to one shell-out (using `pluginRoot`,
never the env var), normalizes the claims bundle into the shape the verify phase
expects, and keeps the proven Claude-side Verify + Synthesize unchanged. Author it
verbatim — the offload and the fallback are the point; do not "simplify" them away.

````javascript
export const meta = {
  name: 'librarian-research',
  description:
    'Deep research; local librarian does Search+Fetch+Extract, Claude does Scope/Verify/Synthesize.',
  phases: [
    { title: 'Scope', detail: 'Decompose question into search angles' },
    {
      title: 'Gather',
      detail:
        'Shell out to local librarian: Brave search + fetch + local claim extraction (fallback: Claude WebSearch)',
    },
    {
      title: 'Verify',
      detail:
        'Route each claim by provenance: sourceId pass/kill → mechanical (deterministic); else/defer/GLM-down → GLM 3-vote off-Claude; GLM unavailable → Claude 3-vote fallback. Survivor-biased audit on the GLM slice.',
    },
    { title: 'Synthesize', detail: 'Merge semantic dupes, rank by confidence, cite sources' },
  ],
};

// librarian-research: Scope (Claude) → Gather (local librarian shell-out, or
// Claude WebSearch fallback) → 3-vote Verify (Claude) → Synthesize (Claude).
// args = { question, pluginRoot }. pluginRoot is resolved in the main session
// (resolve-paths.mjs PLUGIN) and passed in, because ${CLAUDE_PLUGIN_ROOT} is NOT
// exported into Workflow subagent shells. A bare string arg is accepted as the
// question for convenience, but then the librarian can't be located and the run
// uses the Claude-native fallback.

const VOTES_PER_CLAIM = 3;
const REFUTATIONS_REQUIRED = 2;
const MAX_FETCH = 15;
const MAX_VERIFY_CLAIMS = 25;

// ─── Schemas (identical to built-in /deep-research) ───
const SCOPE_SCHEMA = {
  type: 'object',
  required: ['question', 'angles', 'summary'],
  properties: {
    question: { type: 'string' },
    summary: { type: 'string' },
    angles: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['label', 'query'],
        properties: {
          label: { type: 'string' },
          query: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
  },
};
const SEARCH_SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        required: ['url', 'title', 'relevance'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
          relevance: { enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};
const EXTRACT_SCHEMA = {
  type: 'object',
  required: ['claims', 'sourceQuality'],
  properties: {
    sourceQuality: { enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'] },
    publishDate: { type: 'string' },
    claims: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        required: ['claim', 'quote', 'importance'],
        properties: {
          claim: { type: 'string' },
          quote: { type: 'string' },
          importance: { enum: ['central', 'supporting', 'tangential'] },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'evidence', 'confidence'],
  properties: {
    refuted: { type: 'boolean' },
    evidence: { type: 'string' },
    confidence: { enum: ['high', 'medium', 'low'] },
    counterSource: { type: 'string' },
  },
};
const REPORT_SCHEMA = {
  type: 'object',
  required: ['summary', 'findings', 'caveats'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'confidence', 'sources', 'evidence'],
        properties: {
          claim: { type: 'string' },
          confidence: { enum: ['high', 'medium', 'low'] },
          sources: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'string' },
          vote: { type: 'string' },
        },
      },
    },
    caveats: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
};

// ─── Phase 0: Scope (Claude) ───
phase('Scope');
// args may arrive as an object { question, pluginRoot }, or as a JSON string of
// that object, or as a bare question string. Normalize all three.
let ARGS = args;
if (typeof ARGS === 'string') {
  const t = ARGS.trim();
  if (t.startsWith('{')) {
    try {
      ARGS = JSON.parse(t);
    } catch {
      ARGS = { question: t };
    }
  } else ARGS = { question: t };
}
const QUESTION = ((ARGS && ARGS.question) || '').trim();
const PLUGIN_ROOT = (ARGS && ARGS.pluginRoot) || '';
if (!QUESTION) {
  return { error: 'No research question provided. Pass args as { question, pluginRoot }.' };
}
const scope = await agent(
  'Decompose this research question into complementary search angles.\n\n' +
    '## Question\n' +
    QUESTION +
    '\n\n' +
    '## Task\n' +
    "Generate 5 distinct web search queries that together cover the question from different angles. Pick angles that suit the question's domain. Examples:\n" +
    '- broad/primary  · academic/technical  · recent news  · contrarian/skeptical  · practitioner/implementation\n' +
    '- For medical: anatomy · common causes · serious differentials · authoritative refs · red flags\n' +
    '- For tech: state-of-art · benchmarks · limitations · industry adoption · cost/tradeoffs\n\n' +
    'Make queries specific enough to surface high-signal results. Avoid redundancy.\n' +
    'Return: the question (verbatim or lightly normalized), a 1-2 sentence decomposition strategy, and the angles.\n\nStructured output only.',
  { label: 'scope', schema: SCOPE_SCHEMA },
);
if (!scope) {
  return { error: 'Scope agent returned no result — cannot decompose the research question.' };
}
log('Q: ' + QUESTION.slice(0, 80) + (QUESTION.length > 80 ? '…' : ''));
log(
  'Decomposed into ' +
    scope.angles.length +
    ' angles: ' +
    scope.angles.map((a) => a.label).join(', '),
);

// ─── Phase 1: Gather — local librarian shell-out, Claude WebSearch fallback ───
phase('Gather');

// Normalize any source list into the shape Verify/Synthesize consume:
//   { url, title, angle, sourceQuality, publishDate, claims: [{claim, quote, importance, sourceUrl, sourceQuality}] }
function normalizeSource(s) {
  return {
    url: s.url,
    title: s.title || s.url,
    angle: s.angle || 'librarian',
    sourceQuality: s.sourceQuality || 'unreliable',
    publishDate: s.publishDate,
    claims: (s.claims || []).map((c) => ({
      ...c,
      sourceUrl: s.url,
      sourceQuality: s.sourceQuality || 'unreliable',
    })),
  };
}

let allSources = [];
let gatherMode = 'librarian';
let librarianNote = '';

// Try the local librarian first. It owns Search+Fetch+Extract and emits a claims
// bundle: { question, angles, sources:[{url,title,sourceQuality,fetchOk}], claims:[{claim,quote,url,importance}], skipped }.
const anglesJson = JSON.stringify(scope.angles.map((a) => ({ label: a.label, query: a.query })));

// Probe the local librarian only if we were handed a concrete plugin root.
// ${CLAUDE_PLUGIN_ROOT} is NOT exported into subagent shells, so a missing
// PLUGIN_ROOT means we cannot locate research.mjs — go straight to fallback
// rather than shelling out to a broken path.
let probe = null;
if (PLUGIN_ROOT) {
  const shellCmd =
    'node ' +
    shellQuote(PLUGIN_ROOT + '/bin/source-gateway.mjs') +
    ' research ' +
    '--q ' +
    shellQuote(QUESTION) +
    ' ' +
    '--angles ' +
    shellQuote(anglesJson) +
    ' ' +
    '--max-fetch ' +
    MAX_FETCH +
    ' --json';

  probe = await agent(
    'Run this exact shell command with the Bash tool and return its result.\n\n' +
      '```\n' +
      shellCmd +
      '\n```\n\n' +
      'It invokes the local librarian research engine. Capture BOTH stdout and the exit code.\n' +
      '- On exit 0: stdout is a JSON claims bundle. Return it under `bundle` (parsed) with `exitCode: 0`.\n' +
      '- On any non-zero exit (3 = model below research tier; 1 = ollama/Brave unavailable; 2 = usage): ' +
      'return `exitCode` (the number) and `stderr` (the message). Do NOT invent a bundle.\n\n' +
      'Do not retry, do not edit the command, do not fall back yourself — just report what happened. Structured output only.',
    {
      label: 'librarian-gather',
      phase: 'Gather',
      schema: {
        type: 'object',
        required: ['exitCode'],
        properties: {
          exitCode: { type: 'number' },
          stderr: { type: 'string' },
          bundle: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              sources: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    url: { type: 'string' },
                    title: { type: 'string' },
                    sourceQuality: { type: 'string' },
                    fetchOk: { type: 'boolean' },
                  },
                },
              },
              claims: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    claim: { type: 'string' },
                    quote: { type: 'string' },
                    url: { type: 'string' },
                    importance: { type: 'string' },
                  },
                },
              },
              skipped: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { url: { type: 'string' }, reason: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  );
} else {
  log('No pluginRoot in args — cannot locate the librarian; using Claude WebSearch fallback.');
}

const bundle = probe && probe.exitCode === 0 ? probe.bundle : null;
const bundleClaims = bundle && Array.isArray(bundle.claims) ? bundle.claims : [];

if (bundle && bundleClaims.length > 0) {
  // Re-shape the flat bundle (claims carry their own url) into per-source groups.
  const byUrl = new Map();
  for (const src of bundle.sources || []) {
    byUrl.set(src.url, {
      url: src.url,
      title: src.title,
      sourceQuality: src.sourceQuality,
      claims: [],
    });
  }
  for (const c of bundleClaims) {
    if (!byUrl.has(c.url))
      byUrl.set(c.url, { url: c.url, title: c.url, sourceQuality: 'unreliable', claims: [] });
    byUrl.get(c.url).claims.push({
      claim: c.claim,
      quote: c.quote,
      importance: c.importance,
      sourceId: c.sourceId ?? null,
    });
  }
  allSources = [...byUrl.values()].map(normalizeSource);
  log('✅ ENGINE: local librarian — search/fetch/extract ran OFF-Claude (token savings active)');
  log(
    'librarian: ' +
      allSources.length +
      ' sources → ' +
      bundleClaims.length +
      ' claims' +
      (bundle.skipped && bundle.skipped.length ? ' (' + bundle.skipped.length + ' skipped)' : ''),
  );
} else {
  // Fallback: Claude-native WebSearch + WebFetch (the same path the built-in
  // /deep-research uses). Distinguish "librarian unavailable" from "librarian ran
  // cleanly but extracted nothing" — exit 0 with zero claims is a degraded-extraction
  // signal (all sources paywalled/timed out, or a misconfigured host), NOT an outage.
  gatherMode = 'claude-fallback';
  librarianNote = !PLUGIN_ROOT
    ? 'no pluginRoot passed — librarian not located'
    : bundle
      ? 'librarian ran but extracted 0 claims from ' +
        (bundle.sources ? bundle.sources.length : 0) +
        ' sources' +
        (bundle.skipped && bundle.skipped.length ? ' (' + bundle.skipped.length + ' skipped)' : '')
      : probe
        ? 'librarian unavailable (exit ' +
          probe.exitCode +
          (probe.stderr ? ': ' + probe.stderr.trim() : '') +
          ')'
        : 'librarian probe returned no result';
  log(
    '⚠️  ENGINE: Claude WebSearch FALLBACK — librarian NOT used (' +
      librarianNote +
      '). No token savings this run.',
  );

  const SEARCH_PROMPT = (angle) =>
    '## Web Searcher: ' +
    angle.label +
    '\n\n' +
    'Research question: "' +
    QUESTION +
    '"\n\n' +
    'Your angle: **' +
    angle.label +
    '** — ' +
    (angle.rationale || '') +
    '\n' +
    'Search query: `' +
    angle.query +
    '`\n\n' +
    '## Task\nUse WebSearch with the query above (or a refined version). Return the top 4-6 most relevant results.\n' +
    'Rank by relevance to the ORIGINAL question, not just the search query. Skip obvious SEO spam/content farms.\n' +
    'Include a short snippet capturing why each result is relevant.\n\nStructured output only.';
  const FETCH_PROMPT = (source, angle) =>
    '## Source Extractor\n\n' +
    'Research question: "' +
    QUESTION +
    '"\n\n' +
    'Fetch and extract key claims from this source:\n' +
    '**URL:** ' +
    source.url +
    '\n**Title:** ' +
    source.title +
    '\n**Found via:** ' +
    angle +
    ' search\n\n' +
    '## Task\n1. Use WebFetch to retrieve the page content.\n' +
    '2. Assess source quality: primary research/institution? secondary reporting? blog/opinion? forum? unreliable?\n' +
    '3. Extract 2-5 FALSIFIABLE claims that bear on the research question. Each claim must:\n' +
    '   - be a concrete, checkable statement (not vague generalities)\n' +
    '   - include a direct quote from the source as support\n' +
    '   - be rated central/supporting/tangential to the research question\n' +
    '4. Note publish date if available.\n\n' +
    'If the fetch fails or the page is irrelevant/paywalled, return claims: [] and sourceQuality: "unreliable".\n\nStructured output only.';

  const normURL = (u) => {
    try {
      const p = new URL(u);
      return (p.hostname.replace(/^www\./, '') + p.pathname.replace(/\/$/, '')).toLowerCase();
    } catch {
      return u.toLowerCase();
    }
  };
  const seen = new Map();
  const relRank = { high: 0, medium: 1, low: 2 };
  let fetchSlots = MAX_FETCH;

  const searchResults = await pipeline(
    scope.angles,
    (angle) =>
      agent(SEARCH_PROMPT(angle), {
        label: 'search:' + angle.label,
        phase: 'Gather',
        schema: SEARCH_SCHEMA,
      }).then((r) => {
        if (!r) return null;
        log(angle.label + ': ' + r.results.length + ' results');
        return { angle: angle.label, results: r.results };
      }),
    (searchResult) => {
      const sorted = [...searchResult.results].sort(
        (a, b) => relRank[a.relevance] - relRank[b.relevance],
      );
      const novel = sorted.filter((r) => {
        const key = normURL(r.url);
        if (seen.has(key)) return false;
        if (fetchSlots <= 0 && relRank[r.relevance] >= 1) return false;
        seen.set(key, true);
        fetchSlots--;
        return true;
      });
      return parallel(
        novel.map((source) => () => {
          let host = 'unknown';
          try {
            host = new URL(source.url).hostname.replace(/^www\./, '');
          } catch {}
          return agent(FETCH_PROMPT(source, searchResult.angle), {
            label: 'fetch:' + host,
            phase: 'Gather',
            schema: EXTRACT_SCHEMA,
          })
            .then((ext) => {
              if (!ext) return null;
              return {
                url: source.url,
                title: source.title,
                angle: searchResult.angle,
                sourceQuality: ext.sourceQuality,
                publishDate: ext.publishDate,
                claims: ext.claims.map((c) => ({
                  ...c,
                  sourceUrl: source.url,
                  sourceQuality: ext.sourceQuality,
                })),
              };
            })
            .catch((e) => {
              log('fetch failed: ' + source.url + ' — ' + (e.message || e));
              return {
                url: source.url,
                title: source.title,
                angle: searchResult.angle,
                sourceQuality: 'unreliable',
                claims: [],
              };
            });
        }),
      );
    },
  );
  allSources = searchResults.flat().filter(Boolean);
}

const allClaims = allSources.flatMap((s) => s.claims);
const impRank = { central: 0, supporting: 1, tangential: 2 };
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 };
const rankedClaims = [...allClaims]
  .sort(
    (a, b) =>
      impRank[a.importance] - impRank[b.importance] ||
      qualRank[a.sourceQuality] - qualRank[b.sourceQuality],
  )
  .slice(0, MAX_VERIFY_CLAIMS);

log(
  'Gather (' +
    gatherMode +
    '): ' +
    allSources.length +
    ' sources → ' +
    allClaims.length +
    ' claims → verifying top ' +
    rankedClaims.length,
);

if (rankedClaims.length === 0) {
  return {
    question: QUESTION,
    summary:
      'No claims extracted (' +
      gatherMode +
      (librarianNote ? '; ' + librarianNote : '') +
      '). ' +
      allSources.length +
      ' sources.',
    findings: [],
    refuted: [],
    sources: allSources.map((s) => ({ url: s.url, quality: s.sourceQuality })),
    stats: { gatherMode, angles: scope.angles.length, sources: allSources.length, claims: 0 },
  };
}

// ─── Phase 2: Verify (Claude, 3-vote adversarial) ───
phase('Verify');
const VERIFY_PROMPT = (claim, v) =>
  '## Adversarial Claim Verifier (voter ' +
  (v + 1) +
  '/' +
  VOTES_PER_CLAIM +
  ')\n\n' +
  'Be SKEPTICAL. Try to REFUTE this claim. ≥' +
  REFUTATIONS_REQUIRED +
  '/' +
  VOTES_PER_CLAIM +
  ' refutations kill it.\n\n' +
  '## Research question\n' +
  QUESTION +
  '\n\n' +
  '## Claim under review\n"' +
  claim.claim +
  '"\n\n' +
  '**Source:** ' +
  claim.sourceUrl +
  ' (' +
  claim.sourceQuality +
  ')\n' +
  '**Supporting quote:** "' +
  claim.quote +
  '"\n\n' +
  '## Checklist\n' +
  '1. Is the claim actually supported by the quote, or is it an overreach/misread?\n' +
  '2. WebSearch for contradicting evidence — does any credible source dispute or heavily qualify this?\n' +
  "3. Is the source quality sufficient for the claim's strength? (extraordinary claims need primary sources)\n" +
  '4. Is the claim outdated? (check dates — old claims about fast-moving fields are suspect)\n' +
  '5. Is this a marketing claim / press release / cherry-picked benchmark / forum speculation?\n\n' +
  '**refuted=true** if: unsupported by quote / contradicted / low-quality source for strong claim / outdated / marketing fluff.\n' +
  '**refuted=false** ONLY if: claim is well-supported, current, and source quality matches claim strength.\n' +
  'Default to refuted=true if uncertain.\n\nStructured output only. Evidence MUST be specific.';

function pluginScript(name) {
  return PLUGIN_ROOT ? PLUGIN_ROOT + '/scripts/librarian/' + name : null;
}

const ROUTE_SCHEMA = {
  type: 'object',
  required: ['exitCode'],
  properties: {
    exitCode: { type: 'number' },
    stderr: { type: 'string' },
    result: { type: 'object' },
  },
};

// ── Verify decision logic — kept byte-faithful to plugin/scripts/librarian/verify-route.mjs
// (the Workflow sandbox can't import it; a contract test asserts the copy matches). Two
// invariants: never trust a transcribed survives scalar — recompute it from the verdicts;
// and treat fewer-than-quorum valid votes as INCONCLUSIVE, never as an adversarial kill.
function computeSurvives(validVotes) {
  const votes = validVotes || [];
  if (votes.length < REFUTATIONS_REQUIRED) return { survives: null, inconclusive: true };
  const refuted = votes.filter((v) => v.refuted).length;
  return { survives: refuted < REFUTATIONS_REQUIRED, inconclusive: false };
}
function normalizeMechanical(out) {
  const r = out && out.exitCode === 0 ? out.result : null;
  if (r && (r.verdict === 'pass' || r.verdict === 'kill') && typeof r.survives === 'boolean') {
    return { shortCircuit: true, survives: r.survives, verdict: r.verdict, evidence: r.evidence };
  }
  return { shortCircuit: false };
}
function normalizeGlm(out) {
  const r = out && out.exitCode === 0 ? out.result : null;
  const verdicts = (r && r.verdicts) || [];
  if (verdicts.length === 0) return { ok: false };
  const { survives, inconclusive } = computeSurvives(verdicts.filter(Boolean));
  return { ok: true, survives, verdicts, inconclusive };
}
function auditOutcome(glmSurvives, claudeValidVotes) {
  const { survives, inconclusive } = computeSurvives(claudeValidVotes);
  if (inconclusive) return { status: 'inconclusive', claudeSurvives: null };
  return { status: glmSurvives === survives ? 'agreed' : 'disagreed', claudeSurvives: survives };
}

// One claim → a normalized verdict { claim, survives, evidence, mode }.
// Router: sourceId(pass|kill) → mechanical; defer/malformed/error → GLM; GLM exit≠0 → Claude 3-vote.
// A claim whose verifier could not reach quorum is carried as inconclusive (survives=null),
// reported separately, and never counted as an adversarial refutation.
async function routeClaim(claim) {
  const stdin = JSON.stringify({ question: QUESTION, claim });

  // Branch 1: mechanical — only a positive verdict (pass|kill) short-circuits; defer/error → GLM.
  if (PLUGIN_ROOT && claim.sourceId && claim.sourceId.kind) {
    const out = await agent(
      'Run this shell command with the Bash tool, piping the JSON on stdin via printf. Return exit code and stdout.\n\n' +
        "```\nprintf '%s' " +
        shellQuote(stdin) +
        ' | node ' +
        shellQuote(pluginScript('verify-source.mjs')) +
        '\n```\n\n' +
        'On exit 0: stdout is one JSON verdict object { claim, verdict, survives, ... }; return it under `result` with exitCode 0. ' +
        'On non-zero: return exitCode and stderr, no result. Do not retry or fall back yourself. Structured output only.',
      { label: 'verify-source:' + claim.sourceId.kind, phase: 'Verify', schema: ROUTE_SCHEMA },
    );
    const m = normalizeMechanical(out);
    if (m.shortCircuit) {
      return {
        ...claim,
        survives: m.survives,
        evidence: m.evidence || '',
        vote: m.verdict,
        mode: 'mechanical',
      };
    }
  }

  // Branch 2: GLM 3-vote (all-or-nothing — any non-zero exit → Claude fallback).
  if (PLUGIN_ROOT) {
    const out = await agent(
      'Run this shell command with the Bash tool, piping the JSON on stdin via printf. Return exit code and stdout.\n\n' +
        "```\nprintf '%s' " +
        shellQuote(stdin) +
        ' | node ' +
        shellQuote(pluginScript('verify.mjs')) +
        '\n```\n\n' +
        'On exit 0: stdout is a JSON object { claim, verdicts, survives, mode }; return it under `result` with exitCode 0. ' +
        'On exit 3 (no GLM) or 1 (provider down): return exitCode and stderr, no result. Structured output only.',
      { label: 'verify-glm', phase: 'Verify', schema: ROUTE_SCHEMA },
    );
    const g = normalizeGlm(out);
    if (g.ok) {
      const vs = g.verdicts;
      const refuted = vs.filter((x) => x.refuted).length;
      const best = vs.filter((x) => !x.refuted)[0] || vs[0] || {};
      return {
        ...claim,
        survives: g.survives,
        inconclusive: g.inconclusive,
        verdicts: vs,
        evidence: best.evidence || '',
        vote: vs.length - refuted + '-' + refuted,
        mode: 'glm',
      };
    }
  }

  // Branch 3: Claude 3-vote fallback (the original adversarial loop, reuses VERIFY_PROMPT/VERDICT_SCHEMA).
  const verdicts = (
    await parallel(
      Array.from(
        { length: VOTES_PER_CLAIM },
        (_, v) => () =>
          agent(VERIFY_PROMPT(claim, v), {
            label: 'claude-v' + v + ':' + claim.claim.slice(0, 30),
            phase: 'Verify',
            schema: VERDICT_SCHEMA,
          }),
      ),
    )
  ).filter(Boolean);
  const refuted = verdicts.filter((x) => x.refuted).length;
  // Verifier failure (fewer than quorum valid votes) is inconclusive, not a refutation:
  // a 429 cascade nulling the votes must not ship a well-sourced claim as adversarially killed.
  const { survives, inconclusive } = computeSurvives(verdicts);
  const best = verdicts.filter((x) => !x.refuted)[0] || verdicts[0] || {};
  return {
    ...claim,
    survives,
    inconclusive,
    verdicts,
    evidence: best.evidence || '',
    vote: inconclusive
      ? verdicts.length + '/' + VOTES_PER_CLAIM + ' votes (inconclusive)'
      : verdicts.length - refuted + '-' + refuted,
    mode: 'claude-fallback',
  };
}

const routed = (await parallel(rankedClaims.map((c) => () => routeClaim(c)))).filter(Boolean);
routed.forEach((r) =>
  log(
    '"' +
      r.claim.slice(0, 50) +
      '…": ' +
      (r.inconclusive ? '?' : r.survives ? '✓' : '✗') +
      ' [' +
      r.mode +
      ']',
  ),
);

// Three buckets, not two: survives===true confirmed, survives===false killed,
// survives===null inconclusive (the verifier could not reach quorum — never a refutation).
const confirmed = routed.filter((c) => c.survives === true);
const killed = routed.filter((c) => c.survives === false);
const inconclusive = routed.filter((c) => c.survives == null);

const verifyEngine = routed.some((c) => c.mode === 'glm')
  ? 'GLM-5.2 (verification ran off-Claude) + ' +
    routed.filter((c) => c.mode === 'mechanical').length +
    ' mechanical'
  : routed.some((c) => c.mode === 'mechanical')
    ? routed.filter((c) => c.mode === 'mechanical').length + ' mechanical, rest on Claude'
    : 'Claude (no GLM configured - verify ran on Claude)';

// Audit only GLM-judged claims — mechanical is deterministic, claude-fallback is already Claude.
const glmClaims = routed.filter((c) => c.mode === 'glm');
const auditDisagreed = [];
let auditSampled = 0,
  auditAgreed = 0,
  auditInconclusive = 0;
if (glmClaims.length > 0) {
  const survivors = glmClaims.filter((c) => c.survives === true);
  const kills = glmClaims.filter((c) => c.survives === false);
  const sampleSize = Math.ceil(0.2 * glmClaims.length);
  const stride = Math.max(1, Math.floor(survivors.length / Math.max(1, sampleSize)));
  const picked = [];
  for (let i = 0; i < survivors.length && picked.length < sampleSize; i += stride)
    picked.push(survivors[i]);
  for (let i = 0; i < kills.length && picked.length < sampleSize; i++) picked.push(kills[i]);

  const audits = await parallel(
    picked.map(
      (c) => () =>
        parallel(
          Array.from(
            { length: VOTES_PER_CLAIM },
            (_, v) => () =>
              agent(VERIFY_PROMPT(c, v), {
                label: 'audit-v' + v + ':' + c.claim.slice(0, 30),
                phase: 'Verify',
                schema: VERDICT_SCHEMA,
              }),
          ),
        ).then((vs) => {
          const valid = vs.filter(Boolean);
          // <quorum Claude votes is inconclusive (the audit couldn't run), NOT a Claude
          // disagreement — otherwise a transient agent failure inflates "disagreed".
          const { status, claudeSurvives } = auditOutcome(c.survives, valid);
          return { claim: c.claim, glm: c.survives, claude: claudeSurvives, status };
        }),
    ),
  );
  for (const a of audits.filter(Boolean)) {
    if (a.status === 'inconclusive') {
      auditInconclusive++;
      continue;
    }
    auditSampled++;
    if (a.status === 'agreed') auditAgreed++;
    else
      auditDisagreed.push({
        claim: a.claim,
        glm: a.glm ? 'survive' : 'kill',
        claude: a.claude ? 'survive' : 'kill',
      });
  }
  log(
    'Audit: ' +
      auditSampled +
      ' sampled, ' +
      auditAgreed +
      ' agreed, ' +
      auditDisagreed.length +
      ' disagreed' +
      (auditInconclusive ? ', ' + auditInconclusive + ' inconclusive (audit could not run)' : ''),
  );
}

log(
  'Verify done: ' +
    routed.length +
    ' claims → ' +
    confirmed.length +
    ' confirmed, ' +
    killed.length +
    ' killed' +
    (inconclusive.length ? ', ' + inconclusive.length + ' inconclusive' : ''),
);

const verifyStats = () => ({
  mechanical: routed.filter((c) => c.mode === 'mechanical').length,
  glm: routed.filter((c) => c.mode === 'glm').length,
  claudeFallback: routed.filter((c) => c.mode === 'claude-fallback').length,
  inconclusive: inconclusive.length,
  audit: {
    sampled: auditSampled,
    agreed: auditAgreed,
    disagreed: auditDisagreed,
    inconclusive: auditInconclusive,
  },
});

if (confirmed.length === 0) {
  // Separate a genuine all-refuted result from one where the verifier itself could not
  // run: the latter is not evidence against the claims, so don't report it as refutation.
  const summary =
    killed.length > 0
      ? killed.length +
        ' of ' +
        routed.length +
        ' claims refuted by adversarial verification' +
        (inconclusive.length ? '; ' + inconclusive.length + ' inconclusive (verifier unavailable)' : '') +
        '. Research inconclusive.'
      : 'No claims could be verified: all ' +
        routed.length +
        ' verification attempts were inconclusive (verifier unavailable). Research inconclusive — rerun when the verifier is reachable.';
  return {
    question: QUESTION,
    summary,
    findings: [],
    refuted: killed.map((c) => ({ claim: c.claim, vote: c.vote, source: c.sourceUrl })),
    inconclusive: inconclusive.map((c) => ({ claim: c.claim, vote: c.vote, source: c.sourceUrl })),
    sources: allSources.map((s) => ({
      url: s.url,
      quality: s.sourceQuality,
      claimCount: s.claims.length,
    })),
    stats: {
      gatherMode,
      angles: scope.angles.length,
      sources: allSources.length,
      claims: allClaims.length,
      verified: routed.length,
      confirmed: 0,
      killed: killed.length,
      verify: verifyStats(),
    },
    verifyEngine,
  };
}

// ─── Phase 3: Synthesize (Claude) ───
phase('Synthesize');
const confRank = { high: 0, medium: 1, low: 2 };
const block = confirmed
  .map((c, i) => {
    const best = (c.verdicts || [])
      .filter((v) => !v.refuted)
      .sort((a, b) => confRank[a.confidence] - confRank[b.confidence])[0];
    return (
      '### [' +
      i +
      '] ' +
      c.claim +
      '\n' +
      'Vote: ' +
      c.vote +
      ' · Source: ' +
      c.sourceUrl +
      ' (' +
      c.sourceQuality +
      ') · Verifier: ' +
      c.mode +
      '\n' +
      'Quote: "' +
      c.quote +
      '"\nVerifier evidence' +
      (best ? ' (' + best.confidence + ')' : '') +
      ': ' +
      (c.evidence || (best && best.evidence) || '') +
      '\n'
    );
  })
  .join('\n');
const killedBlock =
  killed.length > 0
    ? '\n## Refuted claims (for transparency)\n' +
      killed.map((c) => '- "' + c.claim + '" (' + c.sourceUrl + ', vote ' + c.vote + ')').join('\n')
    : '';

const report = await agent(
  '## Synthesis: research report\n\n' +
    '**Question:** ' +
    QUESTION +
    '\n\n' +
    confirmed.length +
    ' claims survived ' +
    VOTES_PER_CLAIM +
    '-vote adversarial verification. Merge semantic duplicates and synthesize.\n\n' +
    '## Confirmed claims\n' +
    block +
    '\n' +
    killedBlock +
    '\n\n' +
    '## Instructions\n' +
    '1. Identify claims that say the same thing — merge them, combine their sources.\n' +
    '2. Group related claims into coherent findings. Each finding should directly address the research question.\n' +
    '3. Assign confidence per finding: high (multiple primary sources, unanimous votes), medium (secondary sources or split votes), low (single source or blog-quality).\n' +
    '4. Write a 3-5 sentence executive summary answering the research question.\n' +
    "5. Note caveats: what's uncertain, what sources were weak, what time-sensitivity applies.\n" +
    "6. List 2-4 open questions that emerged but weren't answered.\n\nStructured output only.",
  { label: 'synthesize', schema: REPORT_SCHEMA },
);

if (!report) {
  return {
    question: QUESTION,
    summary:
      'Synthesis step was skipped or failed — returning ' +
      confirmed.length +
      ' verified claims unmerged.',
    findings: [],
    confirmed: confirmed.map((c) => ({
      claim: c.claim,
      source: c.sourceUrl,
      quote: c.quote,
      vote: c.vote,
    })),
    refuted: killed.map((c) => ({ claim: c.claim, vote: c.vote, source: c.sourceUrl })),
    sources: allSources.map((s) => ({
      url: s.url,
      quality: s.sourceQuality,
      claimCount: s.claims.length,
    })),
    stats: {
      gatherMode,
      angles: scope.angles.length,
      sources: allSources.length,
      claims: allClaims.length,
      verified: routed.length,
      confirmed: confirmed.length,
      killed: killed.length,
      afterSynthesis: 0,
    },
  };
}

return {
  question: QUESTION,
  gatherMode,
  engine:
    gatherMode === 'librarian'
      ? 'local librarian (gemma) — search/fetch/extract ran off-Claude'
      : 'Claude WebSearch fallback — librarian NOT used (' +
        (librarianNote || 'unknown reason') +
        ')',
  verifyEngine,
  ...report,
  refuted: killed.map((c) => ({ claim: c.claim, vote: c.vote, source: c.sourceUrl })),
  sources: allSources.map((s) => ({
    url: s.url,
    quality: s.sourceQuality,
    angle: s.angle,
    claimCount: s.claims.length,
  })),
  stats: {
    gatherMode,
    angles: scope.angles.length,
    sourcesFetched: allSources.length,
    claimsExtracted: allClaims.length,
    claimsVerified: routed.length,
    confirmed: confirmed.length,
    killed: killed.length,
    inconclusive: inconclusive.length,
    afterSynthesis: report.findings.length,
    verify: verifyStats(),
  },
};

// shellQuote: single-quote for POSIX sh, escaping embedded single quotes.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
````

## Notes

- **Always report which engine ran.** When you present the result, state the
  `gatherMode`/`engine` field to the user up front — `librarian` (offload worked,
  token savings active) vs `claude-fallback` (librarian NOT used + the reason). A
  silent fallback otherwise looks identical to a successful offload; surfacing it
  is the only way the user can tell. See
  [[feedback_graceful_fallback_masks_offload_failure]].
- **The win is the Gather phase.** In librarian mode, source prose never enters
  Claude's context — only one-line claims with quotes. Scope is one agent call;
  Verify and Synthesize run over claims, not documents.
- **Fallback is automatic.** Sub-tier model (exit 3), Ollama/Brave down (exit 1),
  or an empty claims array → Claude-native WebSearch, same as built-in
  `/deep-research`. The `stats.gatherMode` field records which path ran.
- **Verify is routed by provenance.** A claim with a resolved `sourceId` and a
  positive `verdict` (pass or kill) is settled mechanically, deterministically,
  off-Claude. A `defer` verdict (ambiguous, could be a transient outage) or no
  sourceId falls through to the GLM 3-vote branch, also off-Claude. If GLM is down
  or unconfigured (exit 1 or 3) the whole claim falls back to the original Claude
  3-vote adversarial loop. The GLM branch is all-or-nothing per claim: no partial
  vote survival.
- **The audit is survivor-biased and log-only.** A ~20% sample of the GLM-judged
  claims (weighted toward survivors) is re-run on Claude's 3-vote loop and the two
  verdicts are compared. Disagreements are logged, not acted on: the GLM verdict
  ships. The audit only measures GLM drift; mechanical is deterministic and
  claude-fallback is already Claude.
- **Always report `verifyEngine` like `gatherMode`.** Surface whether verification
  ran on GLM, mechanically, or on Claude, so an off-Claude offload is never
  invisible. Same reason as the engine field above. See the spec for the routing
  table: `docs/superpowers/specs/2026-06-16-librarian-research-design.md`.
- This is the first skill to offload to the librarian; `scripts/librarian/research/`
  is built to be reused once it earns trust. See
  `scripts/librarian/research/README.md` and
  `docs/superpowers/specs/2026-06-16-librarian-research-design.md`.

```

```
