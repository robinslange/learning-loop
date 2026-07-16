import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_PATHS } from '../lib/paths.mjs';

function pct(x) {
  return x === undefined ? 'n/a' : (x * 100).toFixed(1) + '%';
}

export function renderMarkdown(r) {
  const lines = [`# Dream eval: mode=${r.mode}`, ''];
  if (r.mode === 'control') {
    lines.push(`Verdict: ${r.verdict}`, '');
    lines.push('| metric | consolidated | control |', '|---|---|---|');
    lines.push(`| hit rate | ${pct(r.consolidated.hit_rate)} | ${pct(r.control.hit_rate)} |`);
    lines.push(
      `| forward hit | ${pct(r.consolidated.by_tier.forward.hit_rate)} | ${pct(r.control.by_tier.forward.hit_rate)} |`,
    );
  } else if (r.mode === 'single') {
    lines.push('| metric | before | after |', '|---|---|---|');
    lines.push(`| hit rate | ${pct(r.before.hit_rate)} | ${pct(r.after.hit_rate)} |`);
  } else if (r.mode === 'repeated') {
    lines.push('| pass | hit rate | files surviving |', '|---|---|---|');
    for (const p of r.curve)
      lines.push(`| ${p.pass} | ${pct(p.hit_rate)} | ${p.expected_files_surviving} |`);
  }
  return lines.join('\n');
}

export function renderJson(r) {
  return r;
}

export function writeReport(pd, result, stamp) {
  const dir = DATA_PATHS.dreamEvalReports(pd);
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${stamp}-${result.mode}.json`);
  const mdPath = join(dir, `${stamp}-${result.mode}.md`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  writeFileSync(mdPath, renderMarkdown(result));
  return [jsonPath, mdPath];
}
