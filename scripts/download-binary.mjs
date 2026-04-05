#!/usr/bin/env node

import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, createWriteStream, unlinkSync } from 'fs';
import { join } from 'path';
import { platform, arch } from 'os';
import { execFileSync } from 'child_process';
import { getPluginData } from './lib/config.mjs';

function detectArtifact() {
  const p = platform();
  const a = arch();

  if (p === 'darwin' && a === 'arm64') return 'll-search-darwin-arm64.tar.gz';
  if (p === 'linux' && a === 'x64') return 'll-search-linux-x64.tar.gz';
  if (p === 'win32' && a === 'x64') return 'll-search-windows-x64.zip';

  return null;
}

function getRepo() {
  return process.env.LL_REPO || 'robinslange/learning-loop';
}

function getVersion() {
  if (process.argv[2]) return process.argv[2];

  const pkgPath = join(import.meta.dirname, '..', 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return `v${pkg.version}`;
  } catch {
    return 'latest';
  }
}

async function download(url, dest) {
  const https = await import('https');
  const http = await import('http');

  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'learning-loop' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} from ${u}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const file = createWriteStream(dest);

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = Math.round(downloaded / total * 100);
            process.stderr.write(`\r  Downloading... ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB)`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          if (total > 0) process.stderr.write('\n');
          resolve();
        });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function main() {
  const artifact = detectArtifact();
  if (!artifact) {
    console.error(`Unsupported platform: ${platform()} ${arch()}`);
    console.error('Supported: darwin arm64, linux x64, win32 x64');
    process.exit(1);
  }

  const version = getVersion();
  const repo = getRepo();
  const binDir = join(getPluginData(), 'bin');
  const binaryName = platform() === 'win32' ? 'll-search.exe' : 'll-search';
  const binaryPath = join(binDir, binaryName);

  // Check if already installed at this version
  const versionFile = join(binDir, '.version');
  if (existsSync(versionFile) && existsSync(binaryPath)) {
    const installed = readFileSync(versionFile, 'utf-8').trim();
    if (installed === version) {
      console.error(`ll-search ${version} already installed at ${binDir}`);
      process.exit(0);
    }
  }

  console.error(`Downloading ll-search ${version} for ${platform()} ${arch()}...`);

  mkdirSync(binDir, { recursive: true });
  const tmpPath = join(binDir, artifact);

  const tag = version;
  const ghUrl = `https://github.com/${repo}/releases/download/${tag}/${artifact}`;

  try {
    await download(ghUrl, tmpPath);
  } catch (dlErr) {
    console.error(`Download failed: ${dlErr.message}`);
    console.error('Check your network connection and try again.');
    process.exit(1);
  }

  // Extract
  console.error('  Extracting...');
  if (artifact.endsWith('.tar.gz')) {
    execFileSync('tar', ['-xzf', tmpPath, '-C', binDir]);
  } else if (artifact.endsWith('.zip')) {
    execFileSync('tar', ['-xf', tmpPath, '-C', binDir]);
  }

  // Clean up archive
  unlinkSync(tmpPath);

  // Set executable permission on Unix
  if (platform() !== 'win32' && existsSync(binaryPath)) {
    chmodSync(binaryPath, 0o755);
  }

  // Write version file
  writeFileSync(versionFile, version + '\n');

  // Verify
  try {
    const out = execFileSync(binaryPath, ['version'], { encoding: 'utf-8' }).trim();
    console.error(`  Installed: ll-search ${out} at ${binDir}`);
  } catch (err) {
    console.error(`  Warning: binary installed but version check failed: ${err.message}`);
  }
}

main();
