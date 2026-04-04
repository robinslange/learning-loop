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

export function splitSentences(text) {
  const engine = loadNLP();
  const doc = engine.readDoc(text);
  const sentences = [];
  doc.sentences().each((s) => sentences.push(s.out()));
  return sentences;
}

export function extractEntities(text) {
  const engine = loadNLP();
  const doc = engine.readDoc(text);
  const entities = new Set();
  doc.tokens().each((t) => {
    if (t.out(engine.its.pos) === 'PROPN') {
      const word = t.out();
      if (word.replace(/\./g, '').length >= 2) {
        entities.add(word.toLowerCase());
      }
    }
  });
  return entities;
}
