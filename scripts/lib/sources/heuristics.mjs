export function inferStudyType(pubTypes, abstractLower) {
  const types = (Array.isArray(pubTypes) ? pubTypes : []).map((t) => t.toLowerCase());
  if (types.some((t) => t.includes('meta-analysis'))) return 'meta-analysis';
  if (types.some((t) => t.includes('systematic review'))) return 'systematic-review';
  if (types.some((t) => t.includes('review'))) return 'review';
  if (types.some((t) => t.includes('randomized controlled trial'))) return 'RCT';
  if (types.some((t) => t.includes('clinical trial'))) return 'clinical-trial';
  if (types.some((t) => t.includes('case report'))) return 'case-report';

  if (abstractLower.includes('meta-analysis') || abstractLower.includes('meta analysis'))
    return 'meta-analysis';
  if (abstractLower.includes('systematic review')) return 'systematic-review';
  if (abstractLower.includes('randomized') || abstractLower.includes('randomised')) return 'RCT';
  if (abstractLower.includes('double-blind') || abstractLower.includes('placebo-controlled'))
    return 'RCT';
  if (abstractLower.includes('crossover') || abstractLower.includes('cross-over'))
    return 'crossover-RCT';
  if (abstractLower.includes('open-label')) return 'open-label';
  if (abstractLower.includes('cohort study') || abstractLower.includes('prospective study'))
    return 'cohort';
  if (abstractLower.includes('in vitro') || abstractLower.includes('cell culture'))
    return 'in-vitro';
  return 'unknown';
}

export function inferSpecies(abstractLower, titleLower) {
  const combined = abstractLower + ' ' + titleLower;
  if (
    /\b(patients?|participants?|subjects?|volunteers?|adults?|men\b|women\b|children|humans?)\b/.test(
      combined,
    )
  ) {
    if (/\b(mice|mouse|rats?|rodent|murine)\b/.test(combined)) return 'human+animal';
    return 'human';
  }
  if (/\b(mice|mouse|rats?|rodent|murine)\b/.test(combined)) return 'animal';
  if (/\b(in vitro|cell line|cell culture|hela|hek293)\b/.test(combined)) return 'in-vitro';
  if (/\b(drosophila|zebrafish|c\. elegans|primate)\b/.test(combined)) return 'animal';
  return 'unknown';
}

export function inferSampleSize(abstractLower) {
  const nMatch = abstractLower.match(/\bn\s*=\s*(\d+)/i);
  if (nMatch) return parseInt(nMatch[1]);
  const partMatch = abstractLower.match(
    /(\d+)\s+(participants?|subjects?|patients?|volunteers?|adults?)/,
  );
  if (partMatch) return parseInt(partMatch[1]);
  return null;
}

export function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return null;
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) words[pos] = word;
  }
  return words.join(' ');
}
