// scripts/dream-eval/cli.mjs : CLI entry for /learning-loop:dream-eval.
// parseArgs is the unit-tested surface; the main guard below wires the
// in-session Task dispatch (pick/invokeDream) and is exercised by a live run.
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getPluginData } from '../lib/config.mjs';
import { resolveMemoryDir } from '../lib/memory-paths.mjs';
import { DATA_PATHS } from '../lib/paths.mjs';
import { runControl, runSingle, runRepeated } from './run.mjs';
import { writeReport, renderMarkdown } from './report.mjs';
import { retrieveTwoHop } from './retrieve.mjs';

const MODES = new Set(['single', 'control', 'repeated']);

// Parse an `_index_*.md` split-index file in `dir` into the memory filenames it
// lists: lines shaped `- [file.md](file.md) — description`. Returns [] if the
// index is missing (the second hop then finds nothing and the probe is a miss,
// which is the honest outcome).
export function readIndexEntries(dir, indexFile) {
  const path = `${dir}/${indexFile}`;
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*-\s*\[[^\]]+\]\(([^)]+\.md)\)/);
    if (m) out.push(m[1]);
  }
  return out;
}

export function parseArgs(argv) {
  const out = { mode: 'single', passes: 10, mine: false };
  for (const a of argv) {
    if (a.startsWith('--mode=')) out.mode = a.slice('--mode='.length);
    else if (a.startsWith('--passes=')) out.passes = Number(a.slice('--passes='.length));
    else if (a === '--mine') out.mine = true;
  }
  if (!MODES.has(out.mode)) throw new Error(`unknown mode: ${out.mode}`);
  return out;
}

function readProbes(pd) {
  const path = DATA_PATHS.dreamEvalProbes(pd);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { mode, passes } = parseArgs(process.argv.slice(2));
  const pd = getPluginData();
  const memoryDir = resolveMemoryDir(process.env.CLAUDE_PROJECT_DIR);
  const probes = readProbes(pd);
  if (probes.length === 0) {
    process.stderr.write('no probe corpus found. run with --mine first.\n');
    process.exit(1);
  }

  // pick/invokeDream are stand-ins here: the SKILL.md drives the real Task
  // dispatch and /dream invocation in-session, then calls the run.mjs
  // functions directly rather than through this main guard.
  const pick = async () => {
    throw new Error('pick must be wired to an in-session Task dispatch');
  };
  const invokeDream = async () => {
    throw new Error('invokeDream must be wired to an in-session /dream invocation');
  };
  const retrieveFn = ({ question, indexText, dir }) =>
    retrieveTwoHop({
      question,
      indexText,
      pick,
      readIndexFile: (indexFile) => readIndexEntries(dir, indexFile),
    });
  const readIndex = (dir) => readFileSync(`${dir}/MEMORY.md`, 'utf8');
  const workDir = DATA_PATHS.dreamEval(pd);

  const args = { memoryDir, workDir, probes, retrieveFn, invokeDream, readIndex, passes };
  const result =
    mode === 'single'
      ? await runSingle(args)
      : mode === 'control'
        ? await runControl(args)
        : await runRepeated(args);

  const stamp = Math.floor(Date.now() / 1000);
  writeReport(pd, result, stamp);
  console.log(renderMarkdown(result));
}
