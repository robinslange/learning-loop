#!/usr/bin/env node
// scripts/codex/generate-agents.mjs : plugin/agents/*.md -> Codex agent TOML.
//
// Claude Code discovers subagents from markdown files bundled in the plugin.
// Codex discovers them from standalone TOML files in ~/.codex/agents/ and has
// no plugin manifest field for agents, so they cannot ship inside the package —
// install.sh generates them instead. The markdown files stay the single source
// of truth; this script is a projection, never an edit target.
//
// Usage: node generate-agents.mjs [--out <dir>] [--list]

import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../lib/markdown-parse.mjs';

const AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../agents');

// Codex agent names are flat — there is no plugin namespace — so the prefix is
// what keeps these from colliding with a built-in or a hand-written agent.
const PREFIX = 'learning-loop-';

// Claude Code model aliases mapped onto the Codex tiers documented for
// subagents. Verify these slugs against the Codex release you are running:
// model names move faster than this file does, and a stale slug is sent to the
// API as written — Codex synthesises fallback metadata but does not substitute
// a working model, so the agent fails on every turn.
const MODELS = {
  opus: 'gpt-5.6',
  sonnet: 'gpt-5.6',
  haiku: 'gpt-5.6-luna',
};

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

// Codex custom agents cannot restrict the tool list, so the `tools:` line only
// tells us whether the agent ever writes. One that does not gets sandboxed.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

// TOML forbids raw control characters in both basic and multi-line basic
// strings, and a single stray one makes Codex drop the whole agent file. Tab is
// legal; newline is legal only in the multi-line form, so the two escapers
// differ on it alone.
function escapeControls(value, keepNewline) {
  return value.replace(/\r\n?|\n|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => {
    if (ch === '\r\n' || ch === '\r' || ch === '\n') return keepNewline ? '\n' : '\\n';
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

function tomlString(value) {
  const escaped = escapeControls(String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"'), false);
  return `"${escaped}"`;
}

function tomlMultiline(value) {
  const escaped = escapeControls(
    String(value).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"'),
    true,
  );
  return `"""\n${escaped.endsWith('\n') ? escaped : escaped + '\n'}"""`;
}

/**
 * Projects one agent markdown file onto a Codex custom-agent TOML file.
 * @param {string} source Full markdown text.
 * @param {string} fallbackName Used when the file omits `name:`.
 * @returns {{name: string, toml: string}}
 */
export function toCodexAgent(source, fallbackName) {
  const { fm, body } = parseFrontmatter(source);
  const raw = String(fm.name || fallbackName);
  // The name becomes a filename under the user's home. A frontmatter `name:`
  // carrying a separator would escape --out, so reject rather than sanitise:
  // a silently renamed agent is worse than a loud stop.
  if (!/^[A-Za-z0-9._-]+$/.test(raw) || raw.startsWith('.')) {
    throw new Error(`unusable agent name ${JSON.stringify(raw)} — expected [A-Za-z0-9._-]+`);
  }
  const name = PREFIX + raw;
  const tools = String(fm.tools || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const lines = [`name = ${tomlString(name)}`, `description = ${tomlString(fm.description || '')}`];

  const model = MODELS[fm.model];
  if (model) lines.push(`model = ${tomlString(model)}`);
  if (EFFORTS.has(fm.effort)) lines.push(`model_reasoning_effort = ${tomlString(fm.effort)}`);
  if (tools.length && !tools.some((t) => WRITE_TOOLS.has(t))) {
    lines.push('sandbox_mode = "read-only"');
  }

  lines.push(`developer_instructions = ${tomlMultiline(body.trim())}`);
  return { name, toml: lines.join('\n') + '\n' };
}

function main(argv) {
  const outFlag = argv.indexOf('--out');
  const outDir = outFlag === -1 ? join(homedir(), '.codex', 'agents') : argv[outFlag + 1];
  const listOnly = argv.includes('--list');

  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
  if (!listOnly) mkdirSync(outDir, { recursive: true });

  const written = [];
  for (const file of files) {
    const { name, toml } = toCodexAgent(
      readFileSync(join(AGENTS_DIR, file), 'utf-8'),
      file.replace(/\.md$/, ''),
    );
    const target = join(outDir, `${name}.toml`);
    if (!listOnly) writeFileSync(target, toml);
    written.push(target);
  }

  process.stdout.write(`${written.length} agents ${listOnly ? 'found' : 'written'} -> ${outDir}\n`);
  return written;
}

// Node resolves symlinks in import.meta.url but not in argv[1], so comparing
// them raw makes this script a silent no-op whenever its path runs through a
// symlink — which is exactly how a plugin cache is often laid out.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main(process.argv.slice(2));
