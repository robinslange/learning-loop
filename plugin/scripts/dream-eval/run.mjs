import { join } from 'node:path';
import { fork } from './snapshot.mjs';
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
