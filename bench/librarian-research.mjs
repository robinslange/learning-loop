// bench/librarian-research.mjs : Phase 0 model benchmark.
//
// Runs the EXTRACT prompt against candidate models on fixture sources and prints
// results side by side. Dev-only (lives outside plugin/ so it never ships);
// selects the extraction model from evidence. Run manually:
//   node bench/librarian-research.mjs "<research question>"
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRACT_PROMPT, EXTRACT_FORMAT } from '../plugin/scripts/librarian/research/extract.mjs';
import { DEFAULT_OLLAMA_URL } from '../plugin/scripts/lib/defaults.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'research-fixtures');
const MODELS = ['gemma4:e2b', 'gemma3:12b', 'gemma3:27b'];
const QUESTION =
  process.argv[2] || 'What does the evidence say about caffeine half-life in adults?';
const OLLAMA = process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL;

async function extract(model, text) {
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: 'Question: ' + QUESTION + '\n\nSource:\n' + text.slice(0, 12000) },
      ],
      format: EXTRACT_FORMAT,
      options: { temperature: 0 },
      stream: false,
    }),
    signal: AbortSignal.timeout(180000),
  });
  return { ms: Date.now() - t0, raw: (await res.json()).message.content };
}

for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.txt'))) {
  const text = readFileSync(join(FIXTURES, file), 'utf-8');
  console.log('\n========== ' + file + ' ==========');
  for (const model of MODELS) {
    try {
      const { ms, raw } = await extract(model, text);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      console.log(
        '\n--- ' + model + ' (' + ms + 'ms, schema-valid: ' + (parsed ? 'yes' : 'NO') + ') ---',
      );
      console.log(parsed ? JSON.stringify(parsed, null, 2) : raw);
    } catch (err) {
      console.log('\n--- ' + model + ' FAILED: ' + err.message + ' ---');
    }
  }
}
