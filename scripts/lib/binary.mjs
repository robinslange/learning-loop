import { execFileSync } from 'child_process';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

function getPluginData() {
  return process.env.CLAUDE_PLUGIN_DATA
    || join(homedir(), '.claude', 'plugins', 'data', 'learning-loop');
}

function findBinary() {
  const pluginData = getPluginData();
  const installed = join(pluginData, 'bin', 'll-search');
  if (existsSync(installed)) return installed;

  const devBuild = resolve(join(import.meta.dirname, '..', '..', 'native', 'target', 'release', 'll-search'));
  if (existsSync(devBuild)) return devBuild;

  return null;
}

let _binaryPath = null;

export function binaryPath() {
  if (_binaryPath !== null) return _binaryPath;
  _binaryPath = findBinary();
  return _binaryPath;
}

export function hasBinary() {
  return binaryPath() !== null;
}

export function binaryVersion() {
  if (!hasBinary()) return null;
  try {
    return runRaw(['version']).trim();
  } catch {
    return null;
  }
}

export function run(args, { maxBuffer = 50 * 1024 * 1024 } = {}) {
  const bin = binaryPath();
  if (!bin) {
    throw new Error('ll-search binary not found. Run /learning-loop:init to install.');
  }

  const stdout = execFileSync(bin, args, {
    encoding: 'utf-8',
    maxBuffer,
    env: { ...process.env, ORT_DYLIB_PATH: join(getPluginData(), 'bin') },
  });
  return JSON.parse(stdout);
}

export function runRaw(args, { maxBuffer = 50 * 1024 * 1024 } = {}) {
  const bin = binaryPath();
  if (!bin) {
    throw new Error('ll-search binary not found. Run /learning-loop:init to install.');
  }

  return execFileSync(bin, args, {
    encoding: 'utf-8',
    maxBuffer,
    env: { ...process.env, ORT_DYLIB_PATH: join(getPluginData(), 'bin') },
  });
}
