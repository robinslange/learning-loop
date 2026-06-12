#!/usr/bin/env node
/**
 * Synthetic vault generator for bench harness.
 *
 * Usage:
 *   node generate-vault.mjs --count 10000 --out .cache/vault-10k --seed 20260511
 *
 * Outputs one .md file per note plus manifest.json.
 * Idempotent: skips generation if manifest exists with matching count+seed.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// CLI parse
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : def;
}

const COUNT = parseInt(getArg("count", "1000"), 10);
const OUT = getArg("out", ".cache/vault");
const SEED = parseInt(getArg("seed", "20260511"), 10);

// Bump when note-content generation changes so stale .cache fixtures (and
// quality baselines built on them) regenerate instead of silently reusing
// old content. v2: topic-clustered vocabulary + topic-biased wikilinks.
const GENERATOR_VERSION = 2;

// ---------------------------------------------------------------------------
// mulberry32 PRNG — no deps, deterministic, fast
// ---------------------------------------------------------------------------

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Vocabulary (deterministic corpus — no files needed)
// ---------------------------------------------------------------------------

const TAGS = [
  "cognition", "sleep", "productivity", "llm", "zettelkasten",
  "neuroscience", "memory", "attention", "learning", "metacognition",
  "statistics", "bayesian", "causal", "information-theory", "entropy",
  "systems", "feedback", "emergence", "complexity", "resilience",
  "health", "nutrition", "exercise", "circadian", "stress",
  "software", "architecture", "distributed", "reliability", "testing",
];

const WORDS = [
  "activation", "adaptive", "aggregate", "algorithm", "alignment",
  "allocation", "analysis", "anchor", "annotation", "architecture",
  "assertion", "attention", "attribute", "augmentation", "autoencoder",
  "backpropagation", "bandwidth", "baseline", "batch", "bayesian",
  "bias", "boundary", "branching", "buffer", "calibration",
  "capacity", "causal", "chain", "channel", "classifier",
  "cluster", "coherence", "compression", "computation", "concept",
  "confidence", "consolidation", "constraint", "context", "convergence",
  "correlation", "coupling", "criterion", "cross-entropy", "cycle",
  "decay", "decoding", "decomposition", "delta", "density",
  "dependency", "depth", "derivative", "detection", "dimension",
  "direction", "distribution", "divergence", "domain", "dropout",
  "dynamics", "efficiency", "embedding", "encoding", "entropy",
  "epoch", "equilibrium", "error", "evaluation", "evidence",
  "evolution", "expansion", "expectation", "exploration", "extraction",
  "factorization", "feedback", "filter", "finetuning", "flow",
  "focus", "formation", "forward-pass", "foundation", "frequency",
  "function", "gain", "gradient", "graph", "heuristic",
  "hierarchy", "hypothesis", "identity", "inference", "initialization",
  "integration", "interaction", "interpolation", "invariance", "iteration",
  "kernel", "knowledge", "label", "latent", "layer",
  "learning", "likelihood", "linear", "loss", "manifold",
  "mapping", "margin", "matrix", "mechanism", "memory",
  "metric", "mixture", "model", "momentum", "monitoring",
  "network", "noise", "normalization", "objective", "optimization",
  "output", "overfitting", "parameter", "pattern", "penalty",
  "perception", "pipeline", "posterior", "prediction", "prior",
  "probability", "projection", "propagation", "prototype", "pruning",
  "query", "ranking", "recall", "reconstruction", "recurrence",
  "regularization", "reinforcement", "representation", "residual", "retrieval",
  "sampling", "scalar", "search", "selection", "sensitivity",
  "sequence", "signal", "similarity", "softmax", "sparsity",
  "spectrum", "state", "strategy", "structure", "supervision",
  "tensor", "threshold", "training", "transfer", "transformation",
  "uncertainty", "update", "variance", "vector", "weight",
];

// ---------------------------------------------------------------------------
// Sentence templates (filled with random words)
// ---------------------------------------------------------------------------

const SENTENCE_TEMPLATES = [
  (w) => `The ${w[0]} mechanism enables ${w[1]} through ${w[2]} alignment.`,
  (w) => `Research on ${w[0]} suggests that ${w[1]} correlates with ${w[2]}.`,
  (w) => `${cap(w[0])} and ${w[1]} interact via ${w[2]} in the ${w[3]} domain.`,
  (w) => `When ${w[0]} exceeds the ${w[1]} threshold, ${w[2]} is required.`,
  (w) => `The ${w[0]}-${w[1]} relationship determines ${w[2]} performance.`,
  (w) => `Applying ${w[0]} to ${w[1]} produces stable ${w[2]} outcomes.`,
  (w) => `${cap(w[0])} regularization reduces ${w[1]} without degrading ${w[2]}.`,
  (w) => `The key insight is that ${w[0]} acts as a ${w[1]} proxy for ${w[2]}.`,
];

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Topic clustering — notes belong to a topic with its own vocabulary slice,
// and wikilinks prefer same-topic notes. Without this, link targets share no
// vocabulary with their source and link-grounded retrieval eval is pure noise.
// ---------------------------------------------------------------------------

const TOPIC_COUNT = 12;
const TOPIC_VOCAB_SIZE = 30;
const TOPIC_WORD_BIAS = 0.7; // probability a word is drawn from the topic vocabulary
const SAME_TOPIC_LINK_BIAS = 0.8; // probability a wikilink targets a same-topic note

function topicVocab(topic) {
  // Overlapping windows over WORDS — adjacent topics share some vocabulary,
  // like real vaults do.
  const start = Math.floor((topic * WORDS.length) / TOPIC_COUNT);
  const vocab = [];
  for (let i = 0; i < TOPIC_VOCAB_SIZE; i++) {
    vocab.push(WORDS[(start + i) % WORDS.length]);
  }
  return vocab;
}

const TOPIC_VOCABS = Array.from({ length: TOPIC_COUNT }, (_, t) => topicVocab(t));

function pickWords(rng, n, topic) {
  const vocab = TOPIC_VOCABS[topic];
  const out = [];
  for (let i = 0; i < n; i++) {
    const pool = rng() < TOPIC_WORD_BIAS ? vocab : WORDS;
    out.push(pool[Math.floor(rng() * pool.length)]);
  }
  return out;
}

function sentence(rng, topic) {
  const tmpl = SENTENCE_TEMPLATES[Math.floor(rng() * SENTENCE_TEMPLATES.length)];
  return tmpl(pickWords(rng, 4, topic));
}

function paragraph(rng, topic, sentences = 4) {
  return Array.from({ length: sentences }, () => sentence(rng, topic)).join(" ");
}

// ---------------------------------------------------------------------------
// Note generation
// ---------------------------------------------------------------------------

function generateNote(id, rng, allNotes) {
  const topic = Math.floor(rng() * TOPIC_COUNT);
  const wordSlug = pickWords(rng, 3, topic).join("-");
  const filename = `${String(id).padStart(5, "0")}-${wordSlug}.md`;

  // frontmatter: tags keyed off the topic plus 0-2 random extras
  const tagCount = 1 + Math.floor(rng() * 3);
  const noteTags = [TAGS[topic % TAGS.length]];
  const tagSet = new Set(noteTags);
  while (noteTags.length < tagCount) {
    const t = TAGS[Math.floor(rng() * TAGS.length)];
    if (!tagSet.has(t)) { tagSet.add(t); noteTags.push(t); }
  }

  // mtime: spread over 2 years (seconds)
  const baseEpoch = 1640000000;
  const span = 2 * 365 * 24 * 3600;
  const mtime = Math.floor(baseEpoch + rng() * span);

  // wikilinks (5-15, from earlier notes only — prevents forward refs).
  // Same-topic targets are preferred so link structure correlates with
  // content, making link-grounded eval meaningful.
  const linkCount = 5 + Math.floor(rng() * 11);
  const links = [];
  const usable = allNotes.slice(0, Math.max(0, id - 1));
  const sameTopic = usable.filter((n) => n.topic === topic);
  if (usable.length > 0) {
    for (let i = 0; i < Math.min(linkCount, usable.length); i++) {
      const pool = sameTopic.length > 0 && rng() < SAME_TOPIC_LINK_BIAS ? sameTopic : usable;
      // Wikilinks target the filename stem (Obsidian-style), so the indexer's
      // link resolution (`<stem>.md` lookup) actually resolves them.
      const target = pool[Math.floor(rng() * pool.length)].stem;
      if (!links.includes(target)) links.push(target);
    }
  }

  // body: 200-800 words → 3-10 paragraphs
  const paraCount = 3 + Math.floor(rng() * 8);
  const bodyParas = Array.from({ length: paraCount }, () =>
    paragraph(rng, topic, 2 + Math.floor(rng() * 4))
  );

  const wikilinksInBody = links
    .slice(0, 3)
    .map((t) => `[[${t}]]`)
    .join(", ");

  const body = [
    ...bodyParas,
    links.length > 0
      ? `Related: ${wikilinksInBody}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const title = cap(wordSlug.replace(/-/g, " "));

  const noteMeta = { title, stem: filename.replace(/\.md$/, ""), topic };

  const content = [
    "---",
    `title: "${title}"`,
    `tags: [${noteTags.map((t) => `"${t}"`).join(", ")}]`,
    `mtime: ${mtime}`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
  ].join("\n");

  return { filename, noteMeta, content };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const manifestPath = join(OUT, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (existing.count === COUNT && existing.seed === SEED && existing.generatorVersion === GENERATOR_VERSION) {
        process.stdout.write(
          JSON.stringify({ status: "skipped", reason: "manifest matches", count: COUNT }) + "\n"
        );
        return;
      }
    } catch {
      // regenerate
    }
  }

  mkdirSync(OUT, { recursive: true });

  const rng = mulberry32(SEED);
  const allNotes = [];
  const paths = [];

  process.stderr.write(`Generating ${COUNT} notes in ${OUT} (seed=${SEED})...\n`);

  for (let i = 0; i < COUNT; i++) {
    const { filename, noteMeta, content } = generateNote(i + 1, rng, allNotes);
    allNotes.push(noteMeta);
    const filePath = join(OUT, filename);
    writeFileSync(filePath, content);
    paths.push(filename);

    if ((i + 1) % 1000 === 0) {
      process.stderr.write(`  ${i + 1}/${COUNT}\n`);
    }
  }

  // manifest
  const hash = createHash("sha256");
  for (const p of paths) hash.update(p);
  const sha256OfAllPaths = hash.digest("hex");

  const manifest = {
    count: COUNT,
    seed: SEED,
    generatorVersion: GENERATOR_VERSION,
    sha256OfAllPaths,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  process.stdout.write(
    JSON.stringify({ status: "generated", count: COUNT, out: OUT, sha256OfAllPaths }) + "\n"
  );
}

main();
