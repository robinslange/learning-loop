const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /gh[po]_[A-Za-z0-9]{36,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._\-\/+=]{20,}/g,
];

export function scrubSecrets(text) {
  let result = text;
  for (const pat of SECRET_PATTERNS) {
    result = result.replace(pat, '[REDACTED]');
  }
  return result;
}

function truncateAtSentenceBoundary(text, maxTokens) {
  const charLimit = maxTokens * 4;
  if (text.length <= charLimit) return text;
  const slice = text.slice(0, charLimit);
  const boundaryRe = /[.!?](?:\s|\n)/g;
  let lastBoundary = -1;
  let m;
  while ((m = boundaryRe.exec(slice)) !== null) {
    lastBoundary = m.index + 1;
  }
  if (lastBoundary > 0) return text.slice(0, lastBoundary);
  const lastSpace = slice.lastIndexOf(' ');
  return lastSpace > 0 ? text.slice(0, lastSpace) : slice;
}

export function buildInjection({ vaultHits, episodicHits, query, alreadyInjectedPaths }) {
  const filtered = vaultHits.filter((h) => !alreadyInjectedPaths.has(h.path));
  if (filtered.length === 0 && episodicHits.length === 0) return null;

  const sections = [];
  const injectedVaultPaths = [];

  if (filtered.length > 0) {
    const top = filtered[0];
    const body = truncateAtSentenceBoundary(top.body, 300);
    const lines = [`## From your vault (top match: ${top.title}, similarity ${top.score})`, '', body];
    injectedVaultPaths.push(top.path);

    const pointers = filtered.slice(1, 5);
    if (pointers.length > 0) {
      lines.push('');
      for (const p of pointers) {
        lines.push(`- ${p.title} — ${p.path}`);
        injectedVaultPaths.push(p.path);
      }
    }
    sections.push(lines.join('\n'));
  }

  if (episodicHits.length > 0) {
    const lines = ['## From past conversations'];
    for (const hit of episodicHits.slice(0, 3)) {
      const snippet = hit.snippet.length > 120 ? hit.snippet.slice(0, 120) : hit.snippet;
      lines.push(`- [${hit.date}, ${hit.project}] ${snippet}`);
    }
    sections.push(lines.join('\n'));
  }

  return {
    additionalContext: sections.join('\n\n'),
    injectedVaultPaths,
  };
}

export function emitHookOutput({ event, additionalContext }) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext },
  }));
}
