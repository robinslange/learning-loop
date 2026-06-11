#!/usr/bin/env node
// hooks/session-start/update-check-worker.mjs — detached update checker.
// Fetches the latest release tag from GitHub and stamps update-check.json.
// Spawned by update-check.mjs; fire-and-forget, never raises.
//
// Every outcome stamps 'checked' — an unstamped cache respawns the checker
// on every session-start. Failure stamps merge over the prior cache so a
// known update_available (and its tag) survives going offline.
//
// argv: <cacheFile> <installedVersion> [apiUrl] [timeoutMs]
// apiUrl/timeoutMs default to production values; the hook passes only the
// first two.

import { writeFileSync, readFileSync } from 'node:fs';
import https from 'node:https';
import http from 'node:http';

const [
  cacheFile,
  installed,
  apiUrl = 'https://api.github.com/repos/robinslange/learning-loop/releases/latest',
  timeoutArg,
] = process.argv.slice(2);

if (!cacheFile || !installed) process.exit(0);

const timeoutMs = Number(timeoutArg) > 0 ? Number(timeoutArg) : 10000;
const mod = apiUrl.startsWith('http:') ? http : https;

function readPrior() {
  try {
    const prior = JSON.parse(readFileSync(cacheFile, 'utf8'));
    return prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {};
  } catch {
    return {};
  }
}

function stampFailure() {
  try {
    writeFileSync(
      cacheFile,
      JSON.stringify({
        ...readPrior(),
        checked: Math.floor(Date.now() / 1000),
        error: true,
      }),
    );
  } catch {}
  process.exit(0);
}

const req = mod.get(
  apiUrl,
  {
    headers: {
      'User-Agent': 'learning-loop-update-check',
      Accept: 'application/vnd.github.v3+json',
    },
    timeout: timeoutMs,
  },
  (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      let latest = '';
      try {
        latest = (JSON.parse(data).tag_name || '').replace(/^v/, '');
      } catch {}
      if (!latest) {
        stampFailure();
        return;
      }
      const cmp = (a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
      };
      try {
        writeFileSync(
          cacheFile,
          JSON.stringify({
            update_available: cmp(latest, installed) > 0,
            installed,
            latest,
            checked: Math.floor(Date.now() / 1000),
          }),
        );
      } catch {}
      // Explicit exit: the global keep-alive agent otherwise holds the
      // socket (and the process) open until the request timeout fires.
      process.exit(0);
    });
  },
);
// destroy(err) makes 'error' fire — a bare destroy() ends the request
// silently and the cache never gets stamped.
req.on('timeout', () => req.destroy(new Error('update-check timeout')));
req.on('error', stampFailure);
req.end();
