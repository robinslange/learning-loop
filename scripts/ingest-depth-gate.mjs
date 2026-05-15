export function buildGatePrompt(profile) {
  return `You decide whether to fan out 4 deep-mapper agents (~15x token cost) or use the surface profile as-is for a personal second-brain ingest.

Profile:
${JSON.stringify(profile, null, 2)}

Choose tier="parallel" when AT LEAST TWO of:
- file_count >= 200
- languages with >100 files: 2 or more
- frameworks_detected count >= 3
- has_monorepo_signal or has_workspaces
- second_level_dirs reveals 4+ distinct subsystems

Otherwise tier="single".

Bias: when in doubt, "single". A wasted fan-out costs 15x tokens.

Return JSON only:
{ "tier": "single" | "parallel", "reason": "<one-line>" }`;
}

export function parseGateResponse(text) {
  const match = text.match(/\{[^{}]*"tier"[^{}]*\}/s);
  if (!match) return { tier: 'single', reason: 'gate response unparseable, defaulting to single' };
  try {
    const obj = JSON.parse(match[0]);
    if (obj.tier !== 'parallel' && obj.tier !== 'single') {
      return { tier: 'single', reason: 'invalid tier value, defaulting to single' };
    }
    return { tier: obj.tier, reason: obj.reason || '' };
  } catch {
    return { tier: 'single', reason: 'gate response unparseable, defaulting to single' };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'build-prompt') {
    const profileJson = process.argv[3];
    if (!profileJson) {
      console.error('Usage: ingest-depth-gate.mjs build-prompt <profile-json>');
      process.exit(2);
    }
    console.log(buildGatePrompt(JSON.parse(profileJson)));
  } else if (cmd === 'parse-response') {
    const text = process.argv[3] || '';
    console.log(JSON.stringify(parseGateResponse(text)));
  } else {
    console.error(
      'Usage: ingest-depth-gate.mjs build-prompt <profile-json> | parse-response <text>',
    );
    process.exit(2);
  }
}
