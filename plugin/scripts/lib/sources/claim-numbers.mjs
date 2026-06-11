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
  const re = new RegExp('.{0,60}' + escaped + '.{0,60}', 'i');
  const match = abstract.match(re);
  return match ? { found: true, excerpt: match[0].trim() } : { found: false, excerpt: null };
}
