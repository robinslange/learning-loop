// scripts/lib/markdown-parse.mjs : minimal frontmatter / tag / wikilink parser.
//
// Audit (.planning/inventory/plugin-patterns.md §9) found 18 ad-hoc parsers
// duplicating these three operations. This module is intentionally zero-dep:
// hooks must fire before npm install runs during a plugin upgrade, so any
// parser used by hooks cannot depend on npm packages.
//
// Supported frontmatter shape: leading `---\n…\n---`. YAML inside is parsed as
// a flat key:value map; arrays use the `[a, b, c]` inline form -- the only shape
// produced by any hook in the vault (per grep). Multi-line YAML lists are not
// produced by any current consumer; if needed in future, adopt js-yaml then.
//
// Line endings: both LF and CRLF are handled throughout.

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const BLOCK_ARRAY_ITEM_RE = /^\s+-\s+(.*)/;

/**
 * Split leading YAML frontmatter from body.
 *
 * @param {string | null | undefined} text
 * @returns {{ fm: Record<string, string | string[]>, body: string }}
 *   `fm` is always a plain object (empty when absent or unparseable).
 *   `body` is the post-frontmatter content with no leading newline.
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string' || text.length === 0) return { fm: {}, body: text || '' };
  const m = text.match(FM_RE);
  if (!m) return { fm: {}, body: text };
  const rawFm = m[1];
  const body = text.slice(m[0].length);
  const fm = {};
  const lines = rawFm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!key) continue;
    if (val.startsWith('[') && val.endsWith(']')) {
      // Inline YAML array.
      const inner = val.slice(1, -1).trim();
      fm[key] =
        inner.length === 0
          ? []
          : inner
              .split(',')
              .map((s) => s.trim().replace(/^["']|["']$/g, ''))
              .filter(Boolean);
    } else if (val === '') {
      // Possibly a block array — collect subsequent `  - item` lines.
      const items = [];
      while (i + 1 < lines.length && BLOCK_ARRAY_ITEM_RE.test(lines[i + 1])) {
        i++;
        const m = lines[i].match(BLOCK_ARRAY_ITEM_RE);
        if (m) items.push(m[1].trim().replace(/^["']|["']$/g, ''));
      }
      if (items.length > 0) {
        fm[key] = items;
      } else {
        fm[key] = '';
      }
    } else {
      // Scalar -- strip wrapping quotes if present.
      fm[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body };
}

/**
 * Return body text with the leading frontmatter block removed.
 *
 * @param {string | null | undefined} text
 * @returns {string}
 */
export function stripFrontmatter(text) {
  return parseFrontmatter(text).body;
}

/**
 * Lossless frontmatter split for splice-editing callers. Unlike
 * parseFrontmatter, the raw frontmatter text is returned verbatim so the file
 * reconstructs byte-for-byte (assuming consistent line endings):
 *   '---' + nl + fm + nl + '---' + trailing + body
 *
 * @param {string | null | undefined} text
 * @returns {{ fm: string, nl: string, trailing: string, body: string } | null}
 *   null when there is no leading frontmatter fence. `nl` is the fence newline
 *   sequence ('\n' or '\r\n'); `trailing` is the newline after the closing
 *   fence ('' at EOF).
 */
export function splitRawFrontmatter(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const m = text.match(FM_RE);
  if (!m) return null;
  const nl = m[0].startsWith('---\r\n') ? '\r\n' : '\n';
  const closeIdx = m[0].lastIndexOf('---');
  return {
    fm: m[1],
    nl,
    trailing: m[0].slice(closeIdx + 3),
    body: text.slice(m[0].length),
  };
}

/**
 * Extract the tags list from a parsed frontmatter object.
 * Supports three producer styles found in the vault:
 *   - inline array: `tags: [a, b]`
 *   - comma-separated string: `tags: a, b, c`
 *   - whitespace-separated string: `tags: a b c`
 *
 * @param {Record<string, unknown> | null | undefined} fm
 * @returns {string[]}
 */
export function parseTags(fm) {
  if (!fm) return [];
  const raw = fm.tags;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw !== 'string' || raw.length === 0) return [];
  if (raw.includes(','))
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  return raw.split(/\s+/).filter(Boolean);
}

/**
 * Return all unique `[[target]]` references in `text`, in order of first
 * occurrence. Pipe-aliased links (`[[target|alias]]`) return only the target.
 *
 * @param {string | null | undefined} text
 * @returns {string[]}
 */
export function extractWikilinks(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const seen = new Set();
  const out = [];
  WIKILINK_RE.lastIndex = 0;
  let m;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const inner = m[1];
    if (!inner) continue;
    const pipeIdx = inner.indexOf('|');
    const target = (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim();
    if (target.length === 0) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}
