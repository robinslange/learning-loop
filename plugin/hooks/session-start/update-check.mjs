// hooks/session-start/update-check.mjs : background update check (throttled).
// Spawns a detached child to fetch the latest release from GitHub.
// Results are cached in plugin-data/update-check.json with a 1-hour TTL.

import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { safeLoad } from '../../scripts/lib/safe-load.mjs';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { recordDetachedChild } from '../lib/common.mjs';

export async function run(ctx) {
  if (!ctx.updateCacheFile) return;

  let shouldCheck = true;
  try {
    const { value: cached } = safeLoad(ctx.updateCacheFile, { fallback: null });
    if (cached?.checked && Date.now() / 1000 - cached.checked < HookConfig.VERSION_CHECK_TTL_SECS) {
      shouldCheck = false;
    }
  } catch (err) {
    logError('session-start.update-check.readCache', err);
  }

  if (!shouldCheck) return;

  try {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const fs = require('fs');
      const https = require('https');
      const cacheFile = ${JSON.stringify(ctx.updateCacheFile)};
      const installed = ${JSON.stringify(ctx.pluginVersion)};

      const req = https.get('https://api.github.com/repos/robinslange/learning-loop/releases/latest', {
        headers: { 'User-Agent': 'learning-loop-update-check', 'Accept': 'application/vnd.github.v3+json' },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try {
            const tag = JSON.parse(data).tag_name || '';
            const latest = tag.replace(/^v/, '');
            if (!latest) return;
            const cmp = (a, b) => {
              const pa = a.split('.').map(Number);
              const pb = b.split('.').map(Number);
              return (pa[0] - pb[0]) || (pa[1] - pb[1]) || (pa[2] - pb[2]);
            };
            fs.writeFileSync(cacheFile, JSON.stringify({
              update_available: cmp(latest, installed) > 0,
              installed,
              latest,
              checked: Math.floor(Date.now() / 1000),
            }));
          } catch {}
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => {
        // Stamp the cache so offline machines do not re-spawn a checker every
        // session; the TTL reader only validates 'checked'.
        try {
          fs.writeFileSync(cacheFile, JSON.stringify({
            checked: Math.floor(Date.now() / 1000),
            error: true,
          }));
        } catch {}
      });
      req.end();
    `,
      ],
      { stdio: 'ignore', detached: true },
    );
    child.unref();
    recordDetachedChild(child.pid);
  } catch (err) {
    logError('session-start.update-check.spawn', err);
  }
}
