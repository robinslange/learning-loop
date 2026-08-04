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

export function findNumberInAbstract(number, abstract) {
  if (!abstract) return { found: false, excerpt: null };
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Digit boundaries, or the claim matches as a substring of a longer number and
  // `in_abstract: true` becomes meaningless: claiming "5" passed against an
  // abstract saying "45.2", and "12" passed against "120 patients". The number
  // must not be preceded or followed by another digit or a decimal point.
  const re = new RegExp('.{0,60}(?<![\\d.])' + escaped + '(?![\\d.]*\\d).{0,60}', 'i');
  const match = abstract.match(re);
  return match ? { found: true, excerpt: match[0].trim() } : { found: false, excerpt: null };
}
