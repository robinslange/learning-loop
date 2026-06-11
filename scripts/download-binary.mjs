#!/usr/bin/env node

import {
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { platform, arch } from 'os';
import { execFileSync, spawnSync } from 'child_process';
import { getPluginData } from './lib/config.mjs';
import { env } from './lib/env.mjs';
import { logError } from './lib/log.mjs';
import { safeLoad } from './lib/safe-load.mjs';
import { DATA_FILES } from './lib/paths.mjs';
import { verifyArtifact, isAllowedRedirect } from './lib/artifact-verify.mjs';

function detectArtifact() {
  const p = platform();
  const a = arch();

  if (p === 'darwin' && a === 'arm64') return 'll-search-darwin-arm64.tar.gz';
  if (p === 'linux' && a === 'x64') return 'll-search-linux-x64.tar.gz';
  if (p === 'win32' && a === 'x64') return 'll-search-windows-x64.zip';

  return null;
}

function getRepo() {
  return env.LL_REPO;
}

function getVersion() {
  if (process.argv[2]) return process.argv[2];

  const pkgPath = join(import.meta.dirname, '..', 'package.json');
  const { value: pkg } = safeLoad(pkgPath);
  if (pkg?.version) return `v${pkg.version}`;
  return 'latest';
}

async function download(url, dest) {
  const https = await import('https');
  const http = await import('http');

  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      mod
        .get(u, { headers: { 'User-Agent': 'learning-loop' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (!isAllowedRedirect(res.headers.location)) {
              return reject(new Error(`Refusing non-https redirect to ${res.headers.location}`));
            }
            return follow(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            const err = new Error(`HTTP ${res.statusCode} from ${u}`);
            err.statusCode = res.statusCode;
            return reject(err);
          }

          const total = parseInt(res.headers['content-length'] || '0', 10);
          let downloaded = 0;
          const file = createWriteStream(dest);

          res.on('data', (chunk) => {
            downloaded += chunk.length;
            if (total > 0) {
              const pct = Math.round((downloaded / total) * 100);
              process.stderr.write(
                `\r  Downloading... ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB)`,
              );
            }
          });
          res.pipe(file);
          res.on('error', (e) => {
            file.close();
            reject(e);
          });
          file.on('finish', () => {
            file.close();
            if (total > 0) process.stderr.write('\n');
            resolve();
          });
          file.on('error', reject);
        })
        .on('error', reject);
    };
    follow(url);
  });
}

function extractZip(zipPath, destDir) {
  // Windows 10 1803+ ships tar.exe with zip support; older Windows + non-Windows
  // need a fallback. Try tar first, then PowerShell Expand-Archive on Windows,
  // then unzip on POSIX.
  const tarRes = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'ignore' });
  if (tarRes.status === 0) return;

  if (platform() === 'win32') {
    const psRes = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
      { stdio: 'ignore' },
    );
    if (psRes.status === 0) return;
  } else {
    const unzipRes = spawnSync('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'ignore' });
    if (unzipRes.status === 0) return;
  }
  throw new Error(`Failed to extract ${zipPath}: install tar, powershell, or unzip`);
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
  const pluginData = getPluginData();
  const binDir = join(pluginData, 'bin');
  const binaryName = platform() === 'win32' ? 'll-search.exe' : 'll-search';
  const binaryPath = join(binDir, binaryName);

  // Check if already installed at this version
  const versionFile = DATA_FILES.binVersion(pluginData);
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
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
    if (dlErr.statusCode === 404) {
      console.error(`  Release ${version} has no ${artifact} yet — release still building, will retry next session.`);
      process.exit(0);
    }
    console.error(`Download failed: ${dlErr.message}`);
    console.error('Check your network connection and try again.');
    process.exit(1);
  }

  // Verify against the release's SHA256SUMS (absent on pre-1.27 releases)
  const sumsPath = `${tmpPath}.sums`;
  const sumsUrl = `https://github.com/${repo}/releases/download/${tag}/SHA256SUMS`;
  let sumsText = null;
  try {
    await download(sumsUrl, sumsPath);
    sumsText = readFileSync(sumsPath, 'utf-8');
    unlinkSync(sumsPath);
  } catch (sumsErr) {
    if (existsSync(sumsPath)) unlinkSync(sumsPath);
    if (sumsErr.statusCode === 404) {
      console.error('  Warning: release has no SHA256SUMS (pre-1.27 release) — skipping verification');
    } else {
      console.error(`Failed to fetch SHA256SUMS: ${sumsErr.message}`);
      console.error('Check your network connection and try again.');
      unlinkSync(tmpPath);
      process.exit(1);
    }
  }

  if (sumsText !== null) {
    try {
      verifyArtifact(tmpPath, sumsText, artifact);
      console.error('  Verified sha256 against SHA256SUMS');
    } catch (verifyErr) {
      console.error(`  ${verifyErr.message}`);
      unlinkSync(tmpPath);
      process.exit(1);
    }
  }

  // Extract (archive is removed whether extraction succeeds or throws)
  console.error('  Extracting...');
  let extractErr = null;
  try {
    if (artifact.endsWith('.tar.gz')) {
      execFileSync('tar', ['-xzf', tmpPath, '-C', binDir]);
    } else if (artifact.endsWith('.zip')) {
      extractZip(tmpPath, binDir);
    }
  } catch (err) {
    extractErr = err;
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
  if (extractErr) {
    console.error(`  Extraction failed: ${extractErr.message}`);
    process.exit(1);
  }

  // Set executable permission on Unix
  if (platform() !== 'win32' && existsSync(binaryPath)) {
    chmodSync(binaryPath, 0o755);
  }

  // Smoke check before recording the install — a broken binary must not be
  // stamped as installed or the next session would never retry
  try {
    const out = execFileSync(binaryPath, ['version'], { encoding: 'utf-8' }).trim();
    console.error(`  Installed: ll-search ${out} at ${binDir}`);
  } catch (err) {
    console.error(`  Warning: binary installed but version check failed: ${err.message}`);
    process.exit(1);
  }

  // Write version file
  writeFileSync(versionFile, version + '\n');
}

main();
