// scripts/lib/frontmatter-schema.mjs : the atomic-note frontmatter contract.
//
// capture-rules.md has stated `tags` + `date` + `source` since the beginning and
// ships a correct template. 53% of the vault still lacks `date:`, 25% lacks
// `source:`, and four key names compete for two concepts (`created:`/`date:`,
// `source-project:`/`source:`). A rule an agent can read is not a rule an agent
// obeys; only a deny is.
//
// One definition, two consumers: pre-write-check.js denies on it, and
// normalise-frontmatter.mjs repairs against it. If the gate and the repairer
// each carried their own copy they would drift, which is the bug being fixed.
//
// Zero-dep by the same constraint as markdown-parse.mjs: hooks fire before
// `npm install` runs during a plugin upgrade.

// Folder classes whose notes are atomic and carry the contract. Project index
// notes, maps and bookmarks are a different shape and are deliberately exempt.
export const SCHEMA_CLASSES = new Set(['inbox', 'fleeting', 'literature', 'permanent']);

export const REQUIRED_KEYS = ['tags', 'date', 'source'];

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// status: tracks intention only. The folder IS the maturity, so `status: inbox`
// and friends are a category error, not a spelling mistake.
export const STATUS_VALUES = new Set(['intentioned', 'resolved', 'limbo']);

// Deprecated keys mapped to their canonical replacement. `source-project` also
// implies a `project:` wikilink, which the repairer adds; the gate only needs
// to know the key is wrong.
export const ALIASES = {
  created: 'date',
  updated: 'date',
  'source-project': 'source',
};

// A bare factual signal is a claim a reader could check against the world:
// a figure with a unit or comparator, an author+year attribution, or an appeal
// to research. Their ABSENCE is what makes `source: synthesis` honest, so the
// repairer uses this to decide whether a sourceless note may be called
// synthesis or must be flagged as owing a URL.
const FACTUAL_SIGNAL_RES = [
  // `%` is a non-word character, so a trailing \b after it never matches (the
  // space that follows is non-word too). Word-shaped units keep their boundary;
  // the percent sign must not have one.
  /\b\d[\d,.]*\s?(?:%|(?:mg|kg|ms|hz|kb|mb|gb|x)\b|-fold\b)/i,
  /\b(n\s?=\s?\d|p\s?[<>=]\s?0?\.\d)/i,
  /[<>]\s?\d/,
  /\b[A-Z][a-z]+(?:\s(?:&|and)\s[A-Z][a-z]+)?,?\s\(?(?:19|20)\d{2}\)?/,
  /\b(research shows|studies (?:show|find)|evidence suggests|meta-analysis)\b/i,
];

// Fenced blocks hold sample data and command output, not claims the note makes.
function stripFences(body) {
  return body.replace(/^```[\s\S]*?^```/gm, '');
}

/**
 * True when the body asserts something checkable that no wikilink backs.
 * A figure carried in via `[[some-grounded-note]]` is legitimate synthesis.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function hasUngroundedFactualSignal(body) {
  const text = stripFences(typeof body === 'string' ? body : '');
  return text
    .split(/\n\s*\n/)
    .some((para) => !para.includes('[[') && FACTUAL_SIGNAL_RES.some((re) => re.test(para)));
}

// Frontmatter `source:` is the capture ORIGIN (session, discovery, ingest,
// synthesis, literature). Citation URLs live on a body `Source:` line, and
// ~693 notes use both together. Anything judging whether a note is sourced
// has to read the body line too: calling a note uncited because its citations
// are not in frontmatter is a false negative about a note that is fine.
const BODY_CITATION_RE = /^(Sources?):/m;

/**
 * True when the body carries its citations on a `Source:` / `Sources:` line.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function hasBodyCitation(body) {
  return BODY_CITATION_RE.test(stripFences(typeof body === 'string' ? body : ''));
}

/**
 * Check parsed frontmatter against the contract.
 *
 * @param {Record<string, string | string[]>} fm
 * @returns {Array<{id: string, key: string, code: string, message: string}>}
 *   `id` is a stable `code:key` handle so a caller can diff two violation sets
 *   and act only on what a write newly introduces.
 */
export function checkFrontmatter(fm) {
  const violations = [];
  const add = (code, key, message) => violations.push({ id: `${code}:${key}`, key, code, message });

  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (alias in fm) {
      add('alias', alias, `\`${alias}:\` is not a vault key. Use \`${canonical}:\` instead.`);
    }
  }

  for (const key of REQUIRED_KEYS) {
    const val = fm[key];
    const empty = val === undefined || val === '' || (Array.isArray(val) && val.length === 0);
    if (empty && !(key in fm)) add('missing', key, `\`${key}:\` is required.`);
    else if (empty) add('empty', key, `\`${key}:\` is present but empty.`);
  }

  if (typeof fm.date === 'string' && fm.date !== '' && !DATE_RE.test(fm.date)) {
    add('bad-date', 'date', `\`date: ${fm.date}\` is not YYYY-MM-DD.`);
  }

  if (typeof fm.status === 'string' && fm.status !== '' && !STATUS_VALUES.has(fm.status)) {
    add(
      'bad-status',
      'status',
      `\`status: ${fm.status}\` is not an intention value. Use ${[...STATUS_VALUES].join(', ')}, ` +
        `or drop the field: the folder already carries maturity.`,
    );
  }

  return violations;
}

/**
 * Render violations as a deny reason that names the exact rewrite, so the
 * caller fixes it in one turn instead of guessing at the schema.
 *
 * @param {Array<{message: string}>} violations
 * @returns {string}
 */
export function formatViolations(violations) {
  return (
    `Frontmatter does not meet the atomic-note contract:\n` +
    violations.map((v) => `  ${v.message}`).join('\n') +
    `\n\nEvery note in 0-inbox/, 1-fleeting/, 2-literature/ and 3-permanent/ needs ` +
    `\`tags\`, \`date: YYYY-MM-DD\` and \`source\`.\n\n` +
    `\`source:\` is the capture ORIGIN, not a citation: \`session\`, \`discovery\`, ` +
    `\`ingest\`, \`literature\` (cited work, citations on a body \`Source:\` line), or ` +
    `\`synthesis\` (first-hand, asserts nothing a reader could check). Citation URLs ` +
    `belong on a body \`Source:\` line and coexist with this field. Only when a note ` +
    `makes an external claim and you have no citation anywhere, write ` +
    `\`source: "[no URL found]"\` so the gap stays visible.`
  );
}
