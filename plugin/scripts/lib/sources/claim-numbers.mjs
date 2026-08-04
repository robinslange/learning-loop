export const NUMBER_PATTERNS = [
  /\b(?:OR|HR|RR|IRR|AOR|aOR)\s*(?:=\s*)?(\d+\.?\d*)/gi,
  /\b(?:d|g|Cohen’?s?\s*d)\s*=?\s*(\d+\.?\d*)/gi,
  /\b(\d+\.?\d*)\s*%/g,
  /\bn\s*=\s*(\d+)/gi,
  /\b(\d+)\s+(?:patients?|participants?|subjects?|studies)/gi,
  /\bp\s*[<>=]\s*(0?\.\d+)/gi,
  /\b(\d+\.?\d*)\s*(?:mg|mcg|µg|ml|mL|mg\/L|ng\/mL)/gi,
  /\b(\d+\.?\d*)-fold/gi,
  /\b(\d+\.?\d*)\s*(?:ms|seconds?|minutes?|hours?|days?|weeks?|months?)\b/gi,
];

export function extractNumbers(text) {
  const numbers = new Set();
  for (const re of NUMBER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      numbers.add(m[1] || m[0]);
    }
  }
  return [...numbers];
}

/** Every numeric token in a body of text, with thousands separators intact. */
const NUMERIC_TOKEN_RE = /\d[\d,]*(?:\.\d+)?/g;

const toNumber = (s) => Number(String(s).replace(/,/g, ''));

/**
 * Is the claimed number stated in the abstract?
 *
 * Compares whole numeric TOKENS numerically rather than searching for the
 * claim as a substring. Substring search made `in_abstract: true` meaningless —
 * "5" matched an abstract saying "45.2", "12" matched "120 patients" — and a
 * character-class boundary guard fixes that at the cost of two new errors it
 * cannot see: it calls 5 absent from "5.0 mg" (equal values, different
 * spelling) and lets "200" match "1,200" (the separator is not a digit).
 * Parsing both sides settles all four cases the same way.
 *
 * @param {string|number} number
 * @param {string} abstract
 * @returns {{found: boolean, excerpt: string|null}}
 */
export function findNumberInAbstract(number, abstract) {
  if (!abstract) return { found: false, excerpt: null };
  const target = toNumber(number);
  if (!Number.isFinite(target)) return { found: false, excerpt: null };

  NUMERIC_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = NUMERIC_TOKEN_RE.exec(abstract)) !== null) {
    if (toNumber(m[0]) !== target) continue;
    const start = Math.max(0, m.index - 60);
    const end = Math.min(abstract.length, m.index + m[0].length + 60);
    return { found: true, excerpt: abstract.slice(start, end).trim() };
  }
  return { found: false, excerpt: null };
}
