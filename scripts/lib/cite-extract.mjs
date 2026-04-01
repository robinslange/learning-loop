// POS-tagged citation extraction using vendored winkNLP.
// Replaces naive [A-Z][a-z]+ \d{4} regex that false-positives on months and common words.
// winkNLP uses Universal Dependencies POS tags: PROPN, NOUN, NUM, etc.

import { createRequire } from 'module';
import { join } from 'path';

let nlp = null;

function loadNLP() {
  if (nlp) return nlp;
  const require = createRequire(import.meta.url);
  const winkNLP = require(join(import.meta.dirname, 'vendor', 'wink-nlp', 'src', 'wink-nlp.js'));
  const model = require(join(import.meta.dirname, 'vendor', 'wink-eng-lite-web-model'));
  nlp = winkNLP(model);
  return nlp;
}

const YEAR_RE = /^(19[5-9]\d|20[0-3]\d)$/;

// Words tagged PROPN by winkNLP but aren't author names.
// Months are proper nouns grammatically; common false positives from vault audits included.
const NOT_AUTHORS = new Set([
  'january', 'february', 'march', 'april', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  'reports', 'figure', 'table', 'section', 'chapter', 'issue', 'version',
]);

function isAuthorToken(token) {
  if (token.pos !== 'PROPN') return false;
  if (NOT_AUTHORS.has(token.text.toLowerCase())) return false;
  return true;
}

export function extractAuthorYearCitations(text) {
  const engine = loadNLP();
  const results = [];
  const lines = text.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    const doc = engine.readDoc(line);
    const tokens = [];
    doc.tokens().each((t) => {
      tokens.push({ text: t.out(), pos: t.out(engine.its.pos) });
    });

    for (let i = 0; i < tokens.length; i++) {
      if (!isAuthorToken(tokens[i])) continue;

      let authorParts = [tokens[i].text];
      let j = i + 1;

      while (j < tokens.length) {
        const next = tokens[j];
        if (isAuthorToken(next)) {
          authorParts.push(next.text);
          j++;
        } else if (next.text === '&' || next.text === 'and') {
          authorParts.push(next.text);
          j++;
        } else if (next.text.toLowerCase() === 'et' && j + 1 < tokens.length &&
                   (tokens[j + 1].text === 'al.' || tokens[j + 1].text === 'al')) {
          // "et al." -- winkNLP tags both as NOUN, but it's a citation pattern
          authorParts.push('et al.');
          j += 2;
          // Skip the trailing "." that winkNLP splits from "al."
          if (j < tokens.length && tokens[j].text === '.' && tokens[j].pos === 'PUNCT') j++;
        } else {
          break;
        }
      }

      // Look for year after author sequence (skip punctuation between)
      let yearIdx = j;
      while (yearIdx < tokens.length && /^[,()\s]$/.test(tokens[yearIdx].text)) {
        yearIdx++;
      }

      if (yearIdx < tokens.length && tokens[yearIdx].pos === 'NUM' && YEAR_RE.test(tokens[yearIdx].text)) {
        const author = authorParts.join(' ');
        const year = parseInt(tokens[yearIdx].text);
        if (!results.some(r => r.author === author && r.year === year)) {
          results.push({ author, year });
        }
        // Skip past all consumed tokens to avoid re-matching parts of multi-author citations
        i = yearIdx;
      }
    }
  }

  return results;
}
