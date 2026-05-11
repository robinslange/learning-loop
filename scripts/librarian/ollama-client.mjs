// scripts/librarian/ollama-client.mjs : ollama HTTP integration for the librarian.
//
// Exposes waitForOllama (probe loop) and chat (single inference call).
// Uses env.OLLAMA_URL (0C primitive); does not read process.env directly.
// Timeouts use AbortSignal.timeout() — no Promise.race.

import { env } from '../lib/env.mjs';
import { logError } from '../lib/log.mjs';

/**
 * Default timing constants for ollama operations.
 * librarian/config.mjs may override url/model; timeouts are fixed.
 */
export const DEFAULTS = Object.freeze({
  url: env.OLLAMA_URL,
  maxAttempts: 10,
  intervalMs: 60_000,
  tagsTimeoutMs: 5_000,
  chatTimeoutMs: 15_000,
  investigateTimeoutMs: 120_000,
});

/**
 * Poll ollama /api/tags until reachable or maxAttempts exhausted.
 * Throws with code 'OLLAMA_UNREACHABLE' on failure.
 *
 * @param {{
 *   url?: string,
 *   maxAttempts?: number,
 *   intervalMs?: number,
 *   logFn?: (msg: string) => void,
 * }} opts
 */
export async function waitForOllama({ url, maxAttempts, intervalMs, logFn } = {}) {
  const base = url || DEFAULTS.url;
  const attempts = maxAttempts ?? DEFAULTS.maxAttempts;
  const interval = intervalMs ?? DEFAULTS.intervalMs;
  const log = logFn || (() => {});

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${base}/api/tags`, {
        signal: AbortSignal.timeout(DEFAULTS.tagsTimeoutMs),
      });
      if (res.ok) return;
    } catch (e) {
      logError('ollama-client:probe', e);
    }
    if (attempt === attempts) {
      const err = new Error(
        `ollama unreachable at ${base} after ${attempts} attempts (${(attempts * interval) / 1000}s). ` +
          `Install ollama or set librarian.ollama_url; disable via librarian.enabled=false in config.json.`,
      );
      err.code = 'OLLAMA_UNREACHABLE';
      throw err;
    }
    log(`Waiting for ollama (${attempt}/${attempts})...\n`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Send a chat completion request to ollama.
 * Returns the raw parsed response body.
 * Throws on network/HTTP error; caller handles parse errors.
 *
 * @param {{
 *   url?: string,
 *   model: string,
 *   messages: object[],
 *   format?: object,
 *   options?: object,
 *   tools?: object[],
 *   logprobs?: boolean,
 *   top_logprobs?: number,
 *   signalTimeoutMs?: number,
 * }} params
 * @returns {Promise<object>}
 */
export async function chat({
  url,
  model,
  messages,
  format,
  options,
  tools,
  logprobs,
  top_logprobs,
  signalTimeoutMs,
}) {
  const base = url || DEFAULTS.url;
  const timeout = signalTimeoutMs ?? DEFAULTS.chatTimeoutMs;

  const body = { model, messages, stream: false };
  if (format !== undefined) body.format = format;
  if (options !== undefined) body.options = options;
  if (tools !== undefined) body.tools = tools;
  if (logprobs !== undefined) body.logprobs = logprobs;
  if (top_logprobs !== undefined) body.top_logprobs = top_logprobs;

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    const err = new Error(`ollama HTTP ${res.status}`);
    err.code = 'OLLAMA_HTTP_ERROR';
    err.status = res.status;
    throw err;
  }

  return res.json();
}
