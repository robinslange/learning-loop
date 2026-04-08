// edge-classifier.mjs — Shared classifier for wiki-link → edge type inference.
// Used by hooks/post-write-edge-infer.js (single-note write) and
// scripts/backfill-edges.mjs (bulk vault scan).

import { readdirSync, statSync } from 'fs';
import { join, basename, sep } from 'path';

// Iteration order is the resolution-priority order: when two folders contain
// notes with the same basename, the first folder in this list wins. Permanent
// notes are the most canonical and should resolve in preference to inbox stubs.
const VAULT_DIRS = ['3-permanent', '2-literature', '5-maps', '4-projects', '1-fleeting', '0-inbox'];

// buildVaultIndex returns a map from bare wiki-link target name → vault-relative
// path. Folder-priority resolution: see VAULT_DIRS comment above.
export function buildVaultIndex(vaultRoot) {
  const map = new Map();
  for (const dir of VAULT_DIRS) {
    const dirPath = join(vaultRoot, dir);
    try {
      const entries = readdirSync(dirPath, { recursive: true });
      for (const e of entries) {
        const full = join(dirPath, String(e));
        try {
          if (!statSync(full).isFile()) continue;
        } catch { continue; }
        const name = basename(String(e), '.md');
        if (!String(e).endsWith('.md')) continue;
        if (!map.has(name)) {
          const relFromVault = full.slice(vaultRoot.length + 1).split(sep).join('/');
          map.set(name, relFromVault);
        }
      }
    } catch {}
  }
  return map;
}

// makeResolver returns a closure suitable for classifyNoteEdges' resolveLink
// argument. Wraps a vault index map.
export function makeResolver(vaultIndex) {
  return (targetName) => vaultIndex.get(targetName) || null;
}

export const PATTERNS = [
  {
    type: 'derived_from',
    high: [
      /\bderived\s+from\b/i,
      /\bbased\s+(?:directly\s+)?on\b/i,
      /\bbuilds?\s+on\b/i,
      /\bextends?\b/i,
      /\bsets?\s+the\s+baseline\b/i,
    ],
    medium: [
      /\bcomes?\s+from\b/i,
      /\boriginated\b/i,
      /\binspired\s+by\b/i,
    ],
  },
  {
    type: 'evidence_for',
    high: [
      /\bproves?\b/i,
      /\bdemonstrates?\b/i,
      /\bevidence\s+(?:for|that)\b/i,
      /\bconfirms?\b/i,
      /\bvalidates?\b/i,
    ],
    medium: [
      /\bshows?\s+(?:that|how|why)\b/i,
      /\bis\s+how\s+to\b/i,
      /\bbenchmarked\s+(?:in|by|on)\b/i,
    ],
  },
  {
    type: 'supports',
    high: [
      /\breinforces?\b/i,
      /\bstrengthens?\b/i,
      /\bbolsters?\b/i,
      /\bcorroborates?\b/i,
    ],
    medium: [
      /\baligns?\s+with\b/i,
      /\bconsistent\s+with\b/i,
      /\bis\s+the\s+\w+\s+(design|method|approach|mechanism|pattern|model|framework)\b/i,
    ],
  },
  {
    type: 'challenges_undermining',
    high: [
      /\bcontradicts?\b/i,
      /\brefutes?\b/i,
      /\bdisproves?\b/i,
      /\bundermines?\b/i,
    ],
    medium: [
      /\bchallenges?\b/i,
      /\bquestions?\s+(?:whether|if)\b/i,
      /\btension\s+(?:with|between)\b/i,
    ],
  },
  {
    type: 'challenges_undercutting',
    high: [
      /\bundercuts?\b/i,
      /\bweakens?\s+the\s+(?:basis|foundation|premise)\b/i,
    ],
    medium: [
      /\bweakens?\b/i,
      /\blimits?\s+the\s+(?:scope|applicability)\b/i,
    ],
  },
  {
    type: 'challenges_rebuttal',
    high: [
      /\brebuts?\b/i,
      /\bdebunks?\b/i,
      /\bcounterexample\s+to\b/i,
    ],
    medium: [
      /\bcounters?\b/i,
      /\bcounterpoint\b/i,
    ],
  },
];

export function extractLinksWithContext(content) {
  const fmEnd = content.match(/^---\n[\s\S]*?\n---\n?/);
  const body = fmEnd ? content.slice(fmEnd[0].length) : content;
  const results = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const target = m[1].split('#')[0].trim();
    if (!target) continue;
    const start = Math.max(0, m.index - 150);
    const end = Math.min(body.length, m.index + m[0].length + 150);
    const context = body.slice(start, end);
    results.push({ target, context, position: m.index });
  }
  return results;
}

export function classifyLink(context, targetName) {
  const targetRe = new RegExp(
    `\\[\\[${targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|[^\\]]+)?\\]\\]`,
  );
  const targetMatch = targetRe.exec(context);
  if (!targetMatch) return null;

  let before = context.slice(0, targetMatch.index);
  let after = context.slice(targetMatch.index + targetMatch[0].length);

  const beforeBoundary = Math.max(
    before.lastIndexOf(']]'),
    before.lastIndexOf('. '),
    before.lastIndexOf('! '),
    before.lastIndexOf('? '),
    before.lastIndexOf('\n'),
  );
  if (beforeBoundary !== -1) before = before.slice(beforeBoundary + 1);

  const afterBoundaries = ['[[', '. ', '! ', '? ', '\n']
    .map(s => after.indexOf(s))
    .filter(i => i !== -1);
  if (afterBoundaries.length) after = after.slice(0, Math.min(...afterBoundaries));

  const beforeTail = before.slice(-100);
  const afterHead = after.slice(0, 100);
  const window = beforeTail + ' ' + afterHead;

  for (const pattern of PATTERNS) {
    for (const re of pattern.high) {
      if (re.test(window)) {
        const flip = detectFlip(beforeTail, afterHead, pattern.high);
        return { type: pattern.type, confidence: 'high', flip };
      }
    }
  }

  for (const pattern of PATTERNS) {
    for (const re of pattern.medium) {
      if (re.test(window)) {
        const flip = detectFlip(beforeTail, afterHead, pattern.medium);
        return { type: pattern.type, confidence: 'medium', flip };
      }
    }
  }

  return null;
}

function detectFlip(beforeTail, afterHead, patterns) {
  const verbInBefore = patterns.some(re => re.test(beforeTail));
  const verbInAfter = patterns.some(re => re.test(afterHead));
  if (verbInBefore && !verbInAfter) return false;
  if (verbInAfter && !verbInBefore) return true;
  return false;
}

// classifyNoteEdges takes the note content, the source note's bare name, and an
// optional resolveLink(targetName) function that maps a wiki-link target like
// "foo-note" to its full vault-relative path "3-permanent/foo-note.md". When the
// resolver is provided and returns a path, that path is stored as toPath so the
// graph traversal queries can join from_path = to_path. Unresolvable links
// (broken wikilinks, peer notes, etc.) are skipped — they cannot participate in
// graph traversal anyway.
export function classifyNoteEdges(content, sourceName, resolveLink = null) {
  const links = extractLinksWithContext(content);
  const edges = [];
  for (const link of links) {
    if (link.target === sourceName) continue;
    const classification = classifyLink(link.context, link.target);
    if (!classification) continue;
    let toPath = link.target;
    if (resolveLink) {
      const resolved = resolveLink(link.target);
      if (!resolved) continue;
      toPath = resolved;
    }
    edges.push({
      toPath,
      edgeType: classification.type,
      confidence: classification.confidence,
      flip: classification.flip,
    });
  }
  return edges;
}
