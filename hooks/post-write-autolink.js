#!/usr/bin/env node
import { readFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const SIMILARITY_THRESHOLD = 0.65;
const MAX_AUTO_LINKS = 3;
const VAULT_DIRS = ['0-inbox', '1-fleeting', '2-literature', '3-permanent', '4-projects', '5-maps'];

function home() { return process.env.HOME || process.env.USERPROFILE || homedir(); }

function getPluginData() {
  return process.env.CLAUDE_PLUGIN_DATA
    || join(home(), '.claude', 'plugins', 'data', 'learning-loop');
}

function resolveVaultPath() {
  if (process.env.VAULT_PATH) return resolve(process.env.VAULT_PATH);
  try {
    const pluginData = getPluginData();
    const cfg = JSON.parse(readFileSync(join(pluginData, 'config.json'), 'utf-8'));
    return resolve((cfg.vault_path || '~/brain/brain').replace(/^~/, home()));
  } catch {}
  try {
    const cfg = JSON.parse(readFileSync(join(resolve(import.meta.dirname, '..'), 'config.json'), 'utf-8'));
    return resolve((cfg.vault_path || '~/brain/brain').replace(/^~/, home()));
  } catch {}
  return resolve(join(home(), 'brain', 'brain'));
}

function findBinary() {
  const pluginData = getPluginData();
  const installed = join(pluginData, 'bin', 'll-search');
  if (existsSync(installed)) return { bin: installed, binDir: join(pluginData, 'bin') };
  const devBuild = resolve(join(import.meta.dirname, '..', 'native', 'target', 'release', 'll-search'));
  if (existsSync(devBuild)) return { bin: devBuild, binDir: resolve(join(import.meta.dirname, '..', 'native', 'target', 'release')) };
  return null;
}

function isWatchRunning() {
  try {
    const pid = parseInt(readFileSync(join(getPluginData(), 'watch.pid'), 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function isVaultNote(filePath, vaultRoot) {
  const prefix = vaultRoot + sep;
  if (!filePath.startsWith(prefix)) return false;
  if (!filePath.endsWith('.md')) return false;
  const rel = filePath.slice(prefix.length);
  const firstSegment = rel.split(sep)[0];
  if (firstSegment.startsWith('_') || firstSegment.startsWith('.')) return false;
  return true;
}

function extractWikilinks(content) {
  const fmEnd = content.match(/^---\n[\s\S]*?\n---\n?/);
  const body = fmEnd ? content.slice(fmEnd[0].length) : content;
  const links = new Set();
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const target = m[1].split('#')[0].trim();
    if (target) links.add(target);
  }
  return links;
}

function buildNoteMap(vaultRoot) {
  const map = new Map();
  for (const dir of VAULT_DIRS) {
    const dirPath = join(vaultRoot, dir);
    try {
      const files = readdirSync(dirPath, { recursive: true });
      for (const f of files) {
        const name = basename(String(f));
        if (name.endsWith('.md') && !map.has(name)) {
          map.set(name, join(dirPath, String(f)));
        }
      }
    } catch {}
  }
  return map;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name;
    if (toolName !== 'Write' && toolName !== 'Edit') return;
    if (!data.tool_response?.success) return;

    const filePath = data.tool_input?.file_path;
    if (!filePath) return;

    const vaultRoot = resolveVaultPath();
    if (!isVaultNote(filePath, vaultRoot)) return;

    const sourceName = basename(filePath, '.md');
    const relativePath = filePath.slice(vaultRoot.length + 1);
    const dbPath = join(vaultRoot, '.vault-search', 'vault-index.db');

    // Get content: for Write it's in tool_input, for Edit read from disk
    let content;
    if (toolName === 'Write') {
      content = data.tool_input?.content || '';
    } else {
      try { content = readFileSync(filePath, 'utf-8'); } catch { return; }
    }

    const existingLinks = extractWikilinks(content);
    const binary = findBinary();
    const noteMap = buildNoteMap(vaultRoot);

    // --- Backlink logic (runs for both Write and Edit) ---
    for (const linkName of existingLinks) {
      if (linkName === sourceName) continue;
      const targetPath = noteMap.get(`${linkName}.md`);
      if (!targetPath) continue;
      const targetContent = readFileSync(targetPath, 'utf-8');
      if (targetContent.includes(`[[${sourceName}]]`)) continue;
      const needsNewline = targetContent.length > 0 && !targetContent.endsWith('\n');
      appendFileSync(targetPath, (needsNewline ? '\n' : '') + `[[${sourceName}]]\n`);
    }

    // --- Auto-link logic (Write only) ---
    if (toolName !== 'Write') return;
    if (!binary || !existsSync(dbPath)) return;

    // 1. Incremental index
    if (!isWatchRunning()) {
      try {
        execFileSync(binary.bin, ['index', vaultRoot, dbPath, '--incremental'], {
          timeout: 2000, stdio: 'ignore',
          env: { ...process.env, ORT_DYLIB_PATH: binary.binDir },
        });
      } catch {}
    }

    // 2. Find similar notes
    let similar;
    try {
      const out = execFileSync(binary.bin, ['similar', dbPath, relativePath, '--top', '5'], {
        encoding: 'utf-8', timeout: 1000,
        env: { ...process.env, ORT_DYLIB_PATH: binary.binDir },
      });
      similar = JSON.parse(out);
    } catch { return; }

    // 3. Filter and select
    const candidates = similar
      .filter(r => r.score >= SIMILARITY_THRESHOLD)
      .filter(r => {
        const name = basename(r.path, '.md');
        return name !== sourceName && !existingLinks.has(name);
      })
      .slice(0, MAX_AUTO_LINKS);

    if (candidates.length === 0) return;

    // 4. Append auto-links to the written note
    const autoLinks = candidates.map(r => `[[${basename(r.path, '.md')}]]`).join('\n');
    const currentContent = readFileSync(filePath, 'utf-8');
    const needsNewline = currentContent.length > 0 && !currentContent.endsWith('\n');
    appendFileSync(filePath, (needsNewline ? '\n' : '') + autoLinks + '\n');

    // 5. Add backlinks to each target
    for (const r of candidates) {
      const targetPath = noteMap.get(basename(r.path));
      if (!targetPath) continue;
      try {
        const targetContent = readFileSync(targetPath, 'utf-8');
        if (targetContent.includes(`[[${sourceName}]]`)) continue;
        const needsNl = targetContent.length > 0 && !targetContent.endsWith('\n');
        appendFileSync(targetPath, (needsNl ? '\n' : '') + `[[${sourceName}]]\n`);
      } catch {}
    }
  } catch {
    // Silent failure: never break Claude's flow
  }
});
