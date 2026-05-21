const MARKERS = ['[unresolved]', '[unverified]', '[not in abstract]', '[not in source]'];

// Caller-only destinations: the gate respects them but never auto-routes here.
// Literature lives in 2-literature/ via the literature-capturer skill.
// Maps live in 5-maps/ via either explicit caller intent OR the link-density rule below.
const CALLER_ONLY_DESTINATIONS = new Set(['2-literature/', '5-maps/']);

// Synthesis hub notes are routed to 5-maps/ instead of 3-permanent/ when:
//   1. They are tagged or sourced as synthesis (source=synthesis|discovery, OR 'synthesis' tag), AND
//   2. They have at least MAP_LINK_THRESHOLD wikilinks (hub-shape signal).
// Below the threshold, synthesis-tagged notes stay in 3-permanent/ because they are
// atomic claims that happen to involve synthesis rather than hub indices.
const MAP_LINK_THRESHOLD = 10;

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

function countWikilinks(body) {
  const stripped = stripFencedBlocks(body);
  const matches = stripped.match(/\[\[[^\]]+\]\]/g);
  return matches ? matches.length : 0;
}

function isSynthesisNote(frontmatter) {
  if (!frontmatter) return false;
  const source = frontmatter.source;
  if (source === 'synthesis' || source === 'discovery') return true;
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  return tags.includes('synthesis');
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
    if (isSynthesisNote(note.frontmatter) && countWikilinks(note.body) >= MAP_LINK_THRESHOLD) {
      return { allowed: true, destination: '5-maps/' };
    }
    return { allowed: true, destination: '3-permanent/' };
  }
  if (passes >= 3) {
    return { allowed: false, destination: '1-fleeting/', reason: `${passes}/6 criteria` };
  }
  return { allowed: false, destination: '0-inbox/', reason: `${passes}/6 criteria` };
}

export async function promoteWithVerification(note, { verifier }) {
  if (note.callerDestination && CALLER_ONLY_DESTINATIONS.has(note.callerDestination)) {
    return { allowed: true, destination: note.callerDestination };
  }

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
