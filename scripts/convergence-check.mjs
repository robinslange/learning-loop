#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { run } from './lib/binary.mjs';
import { splitSentences, extractEntities } from './lib/sentence-split.mjs';
import { extractAuthorYearCitations } from './lib/cite-extract.mjs';

const MAX_QUERIES = 12;
const COSINE_CYCLE_THRESHOLD = 0.83;
const NOVELTY_SATURATION = 0.10;
const EMA_ALPHA = 0.3;
const MVT_BUFFER = 0.5;
const SENTENCE_NOVELTY_THRESHOLD = 0.70;

const STATE_DIR = join(tmpdir(), 'll-convergence');

function statePath(sessionId) {
  return join(STATE_DIR, `${sessionId}.json`);
}

function loadState(sessionId) {
  const p = statePath(sessionId);
  if (!existsSync(p)) throw new Error(`Session "${sessionId}" not found`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function saveState(sessionId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(sessionId), JSON.stringify(state));
}

function embed(text) {
  return run(['embed', text.slice(0, 1500)]);
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function initSession(sessionId) {
  const state = {
    queries: [],
    resultEmbeddings: [],
    sentenceEmbeddings: [],
    entities: [],
    citations: [],
    noveltyRates: [],
    runningAvgRate: null,
    queryCount: 0,
  };
  saveState(sessionId, state);
  console.log(JSON.stringify({ ok: true, sessionId }, null, 2));
}

function checkResult(sessionId, query, resultFile) {
  const state = loadState(sessionId);
  const resultText = readFileSync(resultFile, 'utf-8');
  const queryLower = query.toLowerCase();

  // 1. Query cycle detection
  let queryCycle = 'none';
  for (const prior of state.queries) {
    if (queryLower === prior) { queryCycle = 'exact'; break; }
    if (queryLower.includes(prior) || prior.includes(queryLower)) { queryCycle = 'substring'; }
  }

  // 2. Result-level cosine
  const resultEmb = embed(resultText);
  let maxCosineToPrior = 0;
  for (const prior of state.resultEmbeddings) {
    const c = cosine(resultEmb, prior);
    if (c > maxCosineToPrior) maxCosineToPrior = c;
  }
  const semanticCycle = maxCosineToPrior > COSINE_CYCLE_THRESHOLD;

  // 3. Sentence-level novelty
  const sentences = splitSentences(resultText);
  const sentenceEmbs = [];
  let novelSentences = 0;
  let totalSentences = 0;

  for (const s of sentences) {
    if (s.length < 20) continue;
    totalSentences++;
    const emb = embed(s);
    sentenceEmbs.push(emb);

    let maxCos = 0;
    for (const prior of state.sentenceEmbeddings) {
      const c = cosine(emb, prior);
      if (c > maxCos) maxCos = c;
    }
    if (maxCos < SENTENCE_NOVELTY_THRESHOLD) novelSentences++;
  }

  const noveltyRate = totalSentences > 0 ? novelSentences / totalSentences : 1.0;

  // 4. Entity novelty
  const entitySet = extractEntities(resultText);
  const currentEntities = [...entitySet];
  const priorEntitySet = new Set(state.entities);
  const novelEntities = currentEntities.filter(e => !priorEntitySet.has(e)).length;
  const entityNoveltyRate = currentEntities.length > 0 ? novelEntities / currentEntities.length : 0;

  // 5. Citation overlap
  const currentCitations = extractAuthorYearCitations(resultText);
  const novelCitations = currentCitations.filter(c =>
    !state.citations.some(p => p.author === c.author && p.year === c.year)
  ).length;

  // 6. EMA threshold
  const queryNumber = state.queryCount + 1;
  let runningAvgRate = state.runningAvgRate;
  let belowMVTThreshold = false;

  if (queryNumber >= 3 && runningAvgRate !== null) {
    belowMVTThreshold = noveltyRate < runningAvgRate * MVT_BUFFER;
  }

  // Verdict
  let reason = 'continue';
  let stop = false;

  if (queryCycle === 'exact' && semanticCycle) {
    reason = 'hard_stop:query_and_semantic_cycle';
    stop = true;
  } else if (semanticCycle && noveltyRate < 0.05) {
    reason = 'hard_stop:semantic_cycle_no_novelty';
    stop = true;
  } else if (queryNumber >= MAX_QUERIES) {
    reason = 'hard_stop:budget_exhausted';
    stop = true;
  } else if (belowMVTThreshold && noveltyRate < NOVELTY_SATURATION) {
    reason = 'soft_stop:diminishing_returns';
    stop = true;
  } else if (noveltyRate < 0.05 && queryNumber >= 3) {
    reason = 'soft_stop:saturation';
    stop = true;
  }

  const result = {
    stop,
    reason,
    queryNumber,
    signals: {
      queryCycle,
      maxCosineToPrior: Math.round(maxCosineToPrior * 1000) / 1000,
      semanticCycle,
      noveltyRate: Math.round(noveltyRate * 1000) / 1000,
      novelSentences,
      totalSentences,
      novelEntities,
      totalEntities: currentEntities.length,
      entityNoveltyRate: Math.round(entityNoveltyRate * 1000) / 1000,
      novelCitations,
      totalCitations: currentCitations.length,
      runningAvgRate: runningAvgRate !== null ? Math.round(runningAvgRate * 1000) / 1000 : null,
      belowMVTThreshold,
    },
  };

  // Update state AFTER computing verdict
  state.queries.push(queryLower);
  state.resultEmbeddings.push(resultEmb);
  state.sentenceEmbeddings.push(...sentenceEmbs);
  for (const e of currentEntities) {
    if (!priorEntitySet.has(e)) state.entities.push(e);
  }
  for (const c of currentCitations) {
    if (!state.citations.some(p => p.author === c.author && p.year === c.year)) {
      state.citations.push(c);
    }
  }
  state.noveltyRates.push(noveltyRate);
  if (queryNumber >= 2) {
    state.runningAvgRate = runningAvgRate === null
      ? noveltyRate
      : EMA_ALPHA * noveltyRate + (1 - EMA_ALPHA) * runningAvgRate;
  }
  state.queryCount = queryNumber;
  saveState(sessionId, state);

  console.log(JSON.stringify(result, null, 2));
}

function showStatus(sessionId) {
  const state = loadState(sessionId);
  console.log(JSON.stringify(state, null, 2));
}

function resetSession(sessionId) {
  const p = statePath(sessionId);
  if (existsSync(p)) unlinkSync(p);
  console.log(JSON.stringify({ ok: true, reset: sessionId }, null, 2));
}

const [cmd, sessionId, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'init':
    initSession(sessionId);
    break;
  case 'check':
    checkResult(sessionId, rest[0], rest[1]);
    break;
  case 'status':
    showStatus(sessionId);
    break;
  case 'reset':
    resetSession(sessionId);
    break;
  default:
    console.error('Usage: convergence-check.mjs <init|check|status|reset> <session-id> [args...]');
    process.exit(1);
}
