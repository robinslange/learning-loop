const MARKERS = ['[unresolved]', '[unverified]', '[not in abstract]', '[not in source]'];

function stripFencedBlocks(body) {
  return body.replace(/```[\s\S]*?```/g, '');
}

function findMarkers(body) {
  const stripped = stripFencedBlocks(body);
  return MARKERS.filter((m) => stripped.includes(m));
}

function countPasses(gateCriteria) {
  return Object.values(gateCriteria).filter(Boolean).length;
}

export function canPromote(note) {
  const passes = countPasses(note.gateCriteria);
  const markers = findMarkers(note.body);

  if (markers.length > 0) {
    return {
      allowed: false,
      destination: '1-fleeting/',
      reason: `verification markers present: ${markers.join(', ')}`,
    };
  }

  if (passes === 6) {
    return { allowed: true, destination: '3-permanent/' };
  }
  if (passes >= 3) {
    return { allowed: false, destination: '1-fleeting/', reason: `${passes}/6 criteria` };
  }
  return { allowed: false, destination: '0-inbox/', reason: `${passes}/6 criteria` };
}

export async function promoteWithVerification(note, { verifier }) {
  const gateResult = canPromote(note);
  if (!gateResult.allowed) return gateResult;
  if (gateResult.destination !== '3-permanent/') return gateResult;

  const isSynthesis = note.frontmatter?.source === 'synthesis';
  if (isSynthesis) return gateResult;

  const verifyResult = await verifier(note);
  if (verifyResult.highSeverityIssues > 0) {
    return {
      allowed: false,
      destination: '1-fleeting/',
      reason: `verification failed: ${verifyResult.warnings.join('; ')}`,
      verifyResult,
    };
  }
  return { ...gateResult, verifyResult };
}
