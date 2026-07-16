import { join } from 'node:path';
import { fork, snapshot, restore } from './snapshot.mjs';
import { scoreProbe, aggregate } from './score.mjs';

async function runProbes({ dir, probes, retrieveFn, readIndex, k }) {
  const indexText = readIndex(dir);
  const rows = [];
  for (const p of probes) {
    const retrieved = await retrieveFn({ question: p.question, indexText });
    rows.push(scoreProbe(p, retrieved, k));
  }
  return aggregate(rows);
}

function verdictFrom(consolidated, control) {
  const delta = consolidated.by_tier.forward.hit_rate - control.by_tier.forward.hit_rate;
  if (delta > 0.02) return 'dream_helps';
  if (delta < -0.02) return 'dream_hurts';
  return 'tie';
}

export async function runControl({
  memoryDir,
  workDir,
  probes,
  retrieveFn,
  invokeDream,
  readIndex,
  k = 3,
}) {
  const forkA = fork(memoryDir, join(workDir, 'fork_a'));
  const forkB = fork(memoryDir, join(workDir, 'fork_b'));
  await invokeDream(forkA);
  const consolidated = await runProbes({ dir: forkA, probes, retrieveFn, readIndex, k });
  const control = await runProbes({ dir: forkB, probes, retrieveFn, readIndex, k });
  return { mode: 'control', consolidated, control, verdict: verdictFrom(consolidated, control) };
}

export async function runSingle({
  memoryDir,
  probes,
  retrieveFn,
  invokeDream,
  readIndex,
  snapshotFn = snapshot,
  workDir,
  k = 3,
}) {
  const snap = snapshotFn(memoryDir, join(workDir, 'pre-dream'));
  const before = await runProbes({ dir: memoryDir, probes, retrieveFn, readIndex, k });
  await invokeDream(memoryDir);
  const after = await runProbes({ dir: memoryDir, probes, retrieveFn, readIndex, k });
  return { mode: 'single', before, after, snapshot: snap };
}

export async function runRepeated({
  memoryDir,
  workDir,
  probes,
  retrieveFn,
  invokeDream,
  readIndex,
  passes = 10,
  k = 3,
  expectedExists,
}) {
  const clone = fork(memoryDir, join(workDir, 'repeated-clone'));
  const curve = [];
  for (let i = 1; i <= passes; i++) {
    await invokeDream(clone);
    const agg = await runProbes({ dir: clone, probes, retrieveFn, readIndex, k });
    let surviving = 0;
    for (const p of probes) {
      for (const f of p.expected_files) {
        if (expectedExists(clone, f)) surviving++;
      }
    }
    curve.push({ pass: i, hit_rate: agg.hit_rate, expected_files_surviving: surviving });
  }
  return { mode: 'repeated', curve };
}
