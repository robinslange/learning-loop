export function scoreProbe(probe, retrieved, k = 3) {
  const topK = retrieved.slice(0, k);
  let rank = null;
  for (let i = 0; i < topK.length; i++) {
    if (probe.expected_files.includes(topK[i])) {
      rank = i + 1;
      break;
    }
  }
  return {
    probe_id: probe.probe_id,
    tier: probe.tier,
    retrieved: topK,
    expected: probe.expected_files,
    hit: rank !== null,
    rank,
  };
}

function tierStats(rows) {
  if (rows.length === 0) return { hit_rate: 0, mrr: 0, n: 0 };
  const hits = rows.filter((r) => r.hit).length;
  const mrr = rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rows.length;
  return { hit_rate: hits / rows.length, mrr, n: rows.length };
}

export function aggregate(results) {
  const forward = results.filter((r) => r.tier === 'forward');
  const reverse = results.filter((r) => r.tier === 'reverse');
  const all = tierStats(results);
  return {
    hit_rate: all.hit_rate,
    mrr: all.mrr,
    n: all.n,
    by_tier: { forward: tierStats(forward), reverse: tierStats(reverse) },
  };
}
