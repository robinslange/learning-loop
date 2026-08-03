// bench/provider-bench.mjs : provider/model benchmark for the offload pivot.
//
// Runs three tasks across a set of providers via the shared chatJSON() surface:
//   1. EXTRACT   — claim extraction over fixture sources (quality + latency)
//   2. ABSTAIN   — adversarial-verify probe: does the model correctly refute
//      claims whose quote does NOT support them, while affirming those that do?
//      This is the verify-critical metric (a never-abstainer scores ~50%,
//      affirming everything). Decides whether a model can VERIFY, not just extract.
//   3. SYNTHESIS — extraction-faithfulness on a form-shaped source: does the
//      model return the required fields, WITHOUT inventing values the source
//      never stated? Scores field-completeness AND fabrication rate — the two
//      failure modes that matter for FM's form-schema extraction workload.
//
// Dev-only (outside plugin/, never ships). Run:
//   node bench/provider-bench.mjs            # all configured providers, all tasks
//   node bench/provider-bench.mjs --task abstain
//   node bench/provider-bench.mjs --task extract
//   node bench/provider-bench.mjs --task synthesis
//
// Providers are configured below. The Fireworks key resolves from the macOS
// Keychain (service "fireworks-api-key"), same as the librarian runtime.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chatJSON } from '../plugin/scripts/lib/model-client.mjs';
import { extractClaims } from '../plugin/scripts/librarian/research/extract.mjs';
import { DEFAULT_OLLAMA_URL } from '../plugin/scripts/lib/defaults.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES = join(HERE, 'research-fixtures');
const ABSTAIN_FIXTURES = join(HERE, 'verify-abstention-fixtures.json');
const SYNTHESIS_FIXTURES = join(HERE, 'synthesis-faithfulness-fixtures.json');

function keychain(ref) {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-a', process.env.USER, '-s', ref, '-w'],
      {
        encoding: 'utf-8',
        timeout: 5000,
      },
    ).trim();
  } catch {
    return null;
  }
}

// Providers to compare. Add/remove as needed. apiKey resolved lazily so a
// missing key only skips that provider rather than aborting the run.
//
// Bedrock-hosted models run through FM's LiteLLM gateway, which exposes an
// OpenAI-compatible surface — so they use kind:'openai' with the gateway
// base URL, NOT a bespoke Bedrock client. Point LITELLM_BASE_URL at the
// gateway (default assumes a local proxy) and store its key under the
// Keychain ref 'litellm-gateway-key'. This measures the exact production
// path: LiteLLM → Bedrock ap-southeast-2. Only the compliant (Bedrock-native
// or Western-hosted) set belongs here — never a vendor's own PRC API.
const LITELLM_BASE = process.env.LITELLM_BASE_URL || 'http://localhost:4000';
const OPENROUTER_BASE = 'https://openrouter.ai/api';

const PROVIDERS = [
  {
    name: 'ollama:gemma3:12b',
    provider: { kind: 'ollama', baseUrl: DEFAULT_OLLAMA_URL },
    model: 'gemma3:12b',
  },
  // --- Chinese open-weight set via Fireworks (Western-hosted, OpenAI-compatible) ---
  // Host-agnostic capability proxy: identical weights whether served by Fireworks,
  // OpenRouter, or Bedrock — the host changes jurisdiction and price, not behaviour
  // on these probes. This is the runnable comparison when no Bedrock gateway is up.
  // IDs verified against the account's serverless /models list (2026-07-22).
  {
    name: 'fireworks:glm-5.2',
    provider: { kind: 'openai', baseUrl: 'https://api.fireworks.ai/inference', apiKeyRef: 'fireworks-api-key' },
    model: process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/glm-5p2',
  },
  {
    name: 'fireworks:glm-5.1',
    provider: { kind: 'openai', baseUrl: 'https://api.fireworks.ai/inference', apiKeyRef: 'fireworks-api-key' },
    model: 'accounts/fireworks/models/glm-5p1',
  },
  {
    name: 'fireworks:deepseek-v4-pro', // the abstention-failure risk from the vault notes — test it
    provider: { kind: 'openai', baseUrl: 'https://api.fireworks.ai/inference', apiKeyRef: 'fireworks-api-key' },
    model: 'accounts/fireworks/models/deepseek-v4-pro',
  },
  {
    name: 'fireworks:kimi-k2.6', // Moonshot's Bedrock-adjacent ceiling (K2.5 on Bedrock)
    provider: { kind: 'openai', baseUrl: 'https://api.fireworks.ai/inference', apiKeyRef: 'fireworks-api-key' },
    model: 'accounts/fireworks/models/kimi-k2p6',
  },

  // --- Bedrock-native via LiteLLM gateway (ap-southeast-2, residency-compliant) ---
  // Model IDs are the LiteLLM route names; adjust to the gateway's config.
  // These are the compliant set confirmed on Bedrock Sydney as of 2026-07-20.
  {
    name: 'bedrock:kimi-k2.5',
    provider: { kind: 'openai', baseUrl: LITELLM_BASE, apiKeyRef: 'litellm-gateway-key' },
    model: process.env.BEDROCK_KIMI_MODEL || 'bedrock/moonshot.kimi-k2-5',
  },
  {
    name: 'bedrock:glm-5',
    provider: { kind: 'openai', baseUrl: LITELLM_BASE, apiKeyRef: 'litellm-gateway-key' },
    model: process.env.BEDROCK_GLM_MODEL || 'bedrock/zai.glm-5',
  },
  {
    name: 'bedrock:deepseek-v3.1',
    provider: { kind: 'openai', baseUrl: LITELLM_BASE, apiKeyRef: 'litellm-gateway-key' },
    model: process.env.BEDROCK_DEEPSEEK_MODEL || 'bedrock/deepseek.v3-1',
  },
  {
    name: 'bedrock:qwen3-32b',
    provider: { kind: 'openai', baseUrl: LITELLM_BASE, apiKeyRef: 'litellm-gateway-key' },
    model: process.env.BEDROCK_QWEN_MODEL || 'bedrock/qwen.qwen3-32b',
  },
  {
    name: 'bedrock:sonnet-4.5', // in-region Claude baseline to measure the delta against
    provider: { kind: 'openai', baseUrl: LITELLM_BASE, apiKeyRef: 'litellm-gateway-key' },
    model: process.env.BEDROCK_SONNET_MODEL || 'bedrock/anthropic.claude-sonnet-4-5',
  },

  // --- Capability-proxy bridge: models NOT yet on Bedrock (e.g. Kimi K3) ---
  // OpenRouter is OpenAI-compatible. NOT deployment-compliant for client work —
  // use ONLY to read where the ceiling is headed, never as a production route.
  {
    name: 'openrouter:kimi-k3 (proxy — NOT Bedrock-deployable)',
    provider: { kind: 'openai', baseUrl: OPENROUTER_BASE, apiKeyRef: 'openrouter-api-key' },
    model: 'moonshotai/kimi-k3',
  },
];

function flagValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const QUESTION =
  flagValue('--question') || 'What does the evidence say about creatine dosing and loading?';

const VALID_TASKS = ['all', 'extract', 'abstain', 'synthesis'];
// A present flag must carry a value; only an absent flag falls back to the default.
const TASK = process.argv.includes('--task') ? flagValue('--task') : 'all';
if (!VALID_TASKS.includes(TASK)) {
  console.error(`Unknown --task "${TASK ?? '(missing)'}". Use one of: ${VALID_TASKS.join(', ')}.`);
  process.exit(2);
}
if (process.argv.includes('--question') && !flagValue('--question')) {
  console.error('--question needs a value.');
  process.exit(2);
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'confidence'],
  properties: {
    refuted: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'string' },
  },
};

const VERIFY_PROMPT = `You are an adversarial claim verifier. You are given a CLAIM and the QUOTE offered as its supporting evidence.
Decide whether the quote actually supports the claim.
- refuted=false ONLY if the quote genuinely and specifically supports the claim.
- refuted=true if the quote does not support it: overreach, magnitude mismatch, different subject, weaker than the claim, fabricated specificity, or contradiction.
When the quote is weaker or narrower than the claim, refute. Default to refuted=true if uncertain.`;

function resolveKey(p) {
  if (p.provider.kind === 'openai' && p.provider.apiKeyRef) {
    const key = keychain(p.provider.apiKeyRef);
    return key ? { ...p, provider: { ...p.provider, apiKey: key } } : null;
  }
  return p;
}

async function runExtract(p) {
  console.log(`\n===== EXTRACT — ${p.name} =====`);
  for (const file of readdirSync(SOURCES).filter((f) => f.endsWith('.txt'))) {
    const text = readFileSync(join(SOURCES, file), 'utf-8');
    const t0 = Date.now();
    try {
      // Measure the SAME extraction path production uses, so the bench can't drift
      // from extract.mjs (prompt, format, 12k slice, temperature all live there).
      const parsed = await extractClaims(text, QUESTION, {
        provider: p.provider,
        model: p.model,
        timeoutMs: 180000,
        throwOnError: true, // a benchmark must SEE a provider failure, not log it as 0 claims
      });
      const n = Array.isArray(parsed.claims) ? parsed.claims.length : 0;
      console.log(`  ${file}: ${n} claims, quality=${parsed.sourceQuality}, ${Date.now() - t0}ms`);
      for (const c of parsed.claims || [])
        console.log(`     [${c.importance}] ${c.claim.slice(0, 90)}`);
    } catch (e) {
      console.log(`  ${file}: FAILED ${e.message}`);
    }
  }
}

async function runAbstain(p) {
  console.log(`\n===== ABSTAIN (verify probe) — ${p.name} =====`);
  const { cases } = JSON.parse(readFileSync(ABSTAIN_FIXTURES, 'utf-8'));
  let correct = 0;
  let answered = 0; // cases the model actually returned a verdict for
  let errored = 0; // transport/schema failures — NOT a model signal
  let falseAffirm = 0; // refuted=false when it should be true — the dangerous failure
  for (const c of cases) {
    try {
      const v = await chatJSON({
        provider: p.provider,
        model: p.model,
        system: VERIFY_PROMPT,
        user: `CLAIM: ${c.claim}\n\nQUOTE: ${c.quote}\n\nDoes the quote support the claim?`,
        schema: VERDICT_SCHEMA,
        options: { temperature: 0 },
        timeoutMs: 60000,
      });
      answered++;
      const ok = v.refuted === c.expected_refuted;
      if (ok) correct++;
      if (!ok && c.expected_refuted === true && v.refuted === false) falseAffirm++;
      console.log(
        `  ${ok ? '✓' : '✗'} ${c.id}: got refuted=${v.refuted} (${v.confidence}), expected ${c.expected_refuted}`,
      );
    } catch (e) {
      errored++;
      console.log(`  ? ${c.id}: FAILED ${e.message}`);
    }
  }
  const errNote = errored ? ` (${errored} case(s) errored — excluded)` : '';
  console.log(
    `  SCORE: ${correct}/${answered} answered correct${errNote}. False-affirms (affirmed an unsupported claim — the dangerous miss): ${falseAffirm}.`,
  );
  // A run where too little actually landed is INCONCLUSIVE, never a pass. Silence is not success.
  const verdict =
    answered < cases.length / 2
      ? 'INCONCLUSIVE — too many failures, re-run (do not run providers concurrently against the same host)'
      : falseAffirm === 0 && correct >= answered - 1
        ? 'VERIFIER-CAPABLE'
        : falseAffirm >= 2
          ? 'NOT a verifier (never-abstain failure mode)'
          : 'marginal — inspect';
  console.log(`  Verdict: ${verdict}`);
}

const EXTRACT_SCHEMA = {
  type: 'object',
  required: ['fields'],
  properties: {
    fields: {
      type: 'object',
      description:
        'One key per requested field. Use the exact string null (not a guess) when the source does not state the value.',
    },
  },
};

const SYNTHESIS_PROMPT = `You extract structured fields from a source document for a government registry form.
You are given the SOURCE text and the list of FIELDS to extract.
Return {"fields": {...}} with one entry per requested field.
CRITICAL: if the source does not state a field's value, set it to null. Do NOT infer, guess, or fabricate.
A fabricated value is worse than a missing one — this is a compliance-graded extraction.`;

// Field-shaped extraction probe. The two failure modes that matter for FM's
// form workload: a MISS (field present in source but returned null/absent —
// costs completeness) and a FABRICATION (a value the source never stated —
// the disqualifying failure, exactly parallel to never-abstaining in verify).
async function runSynthesis(p) {
  console.log(`\n===== SYNTHESIS (form-extraction faithfulness) — ${p.name} =====`);
  const { cases } = JSON.parse(readFileSync(SYNTHESIS_FIXTURES, 'utf-8'));
  let misses = 0;
  let fabrications = 0;
  let expectedPresent = 0;
  let expectedNull = 0;
  let answered = 0;
  let errored = 0;
  for (const c of cases) {
    const fieldList = Object.keys(c.expected).join(', ');
    try {
      const out = await chatJSON({
        provider: p.provider,
        model: p.model,
        system: SYNTHESIS_PROMPT,
        user: `SOURCE:\n${c.source}\n\nFIELDS: ${fieldList}\n\nExtract each field.`,
        schema: EXTRACT_SCHEMA,
        options: { temperature: 0 },
        timeoutMs: 60000,
      });
      answered++;
      const got = out.fields || {};
      const isNull = (v) => v === null || v === undefined || v === 'null' || v === '';
      let caseMiss = 0;
      let caseFab = 0;
      for (const [k, expected] of Object.entries(c.expected)) {
        if (expected === null) {
          expectedNull++;
          if (!isNull(got[k])) caseFab++; // invented a value the source never stated
        } else {
          expectedPresent++;
          if (isNull(got[k])) caseMiss++; // failed to extract a stated value
        }
      }
      misses += caseMiss;
      fabrications += caseFab;
      const mark = caseFab === 0 ? (caseMiss === 0 ? '✓' : '~') : '✗';
      console.log(`  ${mark} ${c.id}: ${caseMiss} miss, ${caseFab} fabricated`);
    } catch (e) {
      errored++;
      console.log(`  ? ${c.id}: FAILED ${e.message}`);
    }
  }
  const completeness = expectedPresent ? (((expectedPresent - misses) / expectedPresent) * 100).toFixed(0) : '—';
  const errNote = errored ? ` (${errored} case(s) errored — excluded)` : '';
  console.log(
    `  SCORE: completeness ${completeness}% (${expectedPresent - misses}/${expectedPresent} stated fields extracted)${errNote}. ` +
      `Fabrications (invented a value on ${expectedNull} not-stated fields — the disqualifying miss): ${fabrications}.`,
  );
  const verdict =
    answered < cases.length / 2
      ? 'INCONCLUSIVE — too many failures, re-run (do not run providers concurrently against the same host)'
      : fabrications === 0 && misses <= 1
        ? 'EXTRACTION-CAPABLE'
        : fabrications >= 2
          ? 'NOT extraction-safe (fabrication failure mode)'
          : 'marginal — inspect';
  console.log(`  Verdict: ${verdict}`);
}

const providers = PROVIDERS.map(resolveKey).filter(Boolean);
const skipped = PROVIDERS.length - providers.length;
if (skipped) console.log(`(${skipped} provider(s) skipped — no key in Keychain)`);

for (const p of providers) {
  if (TASK === 'all' || TASK === 'extract') await runExtract(p);
  if (TASK === 'all' || TASK === 'abstain') await runAbstain(p);
  if (TASK === 'all' || TASK === 'synthesis') await runSynthesis(p);
}
