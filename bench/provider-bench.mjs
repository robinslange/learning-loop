// bench/provider-bench.mjs : provider/model benchmark for the offload pivot.
//
// Runs two tasks across a set of providers via the shared chatJSON() surface:
//   1. EXTRACT  — claim extraction over fixture sources (quality + latency)
//   2. ABSTAIN  — adversarial-verify probe: does the model correctly refute
//      claims whose quote does NOT support them, while affirming those that do?
//      This is the verify-critical metric (a never-abstainer scores ~50%,
//      affirming everything). Decides whether a model can VERIFY, not just extract.
//
// Dev-only (outside plugin/, never ships). Run:
//   node bench/provider-bench.mjs            # all configured providers, both tasks
//   node bench/provider-bench.mjs --task abstain
//   node bench/provider-bench.mjs --task extract
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
const PROVIDERS = [
  {
    name: 'ollama:gemma3:12b',
    provider: { kind: 'ollama', baseUrl: DEFAULT_OLLAMA_URL },
    model: 'gemma3:12b',
  },
  {
    name: 'fireworks:glm-5.2',
    provider: {
      kind: 'openai',
      baseUrl: 'https://api.fireworks.ai/inference',
      apiKeyRef: 'fireworks-api-key',
    },
    model: process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/glm-5p2',
  },
];

function flagValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const QUESTION =
  flagValue('--question') || 'What does the evidence say about creatine dosing and loading?';

const VALID_TASKS = ['all', 'extract', 'abstain'];
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
  let total = 0;
  let falseAffirm = 0; // refuted=false when it should be true — the dangerous failure
  for (const c of cases) {
    total++;
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
      const ok = v.refuted === c.expected_refuted;
      if (ok) correct++;
      if (!ok && c.expected_refuted === true && v.refuted === false) falseAffirm++;
      console.log(
        `  ${ok ? '✓' : '✗'} ${c.id}: got refuted=${v.refuted} (${v.confidence}), expected ${c.expected_refuted}`,
      );
    } catch (e) {
      console.log(`  ? ${c.id}: FAILED ${e.message}`);
    }
  }
  console.log(
    `  SCORE: ${correct}/${total} correct. False-affirms (affirmed an unsupported claim — the dangerous miss): ${falseAffirm}.`,
  );
  console.log(
    `  Verdict: ${falseAffirm === 0 && correct >= total - 1 ? 'VERIFIER-CAPABLE' : falseAffirm >= 2 ? 'NOT a verifier (never-abstain failure mode)' : 'marginal — inspect'}`,
  );
}

const providers = PROVIDERS.map(resolveKey).filter(Boolean);
const skipped = PROVIDERS.length - providers.length;
if (skipped) console.log(`(${skipped} provider(s) skipped — no key in Keychain)`);

for (const p of providers) {
  if (TASK === 'all' || TASK === 'extract') await runExtract(p);
  if (TASK === 'all' || TASK === 'abstain') await runAbstain(p);
}
