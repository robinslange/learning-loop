/**
 * tests/helpers/platform.mjs — platform-skip helpers for node:test suites.
 *
 * Usage:
 *   import { skipOnWindows } from './helpers/platform.mjs';
 *   test('name', { skip: skipOnWindows('UDS socket: not supported on win32') }, () => { ... });
 *
 * `skipOnWindows(reason)` returns `reason` (a truthy string) when
 * process.platform === 'win32', and `false` otherwise.  The node:test runner
 * treats a truthy skip value as the reason string in the report, and `false`
 * as "do not skip", so the helper is safe to inline in test options.
 */

/**
 * @param {string} reason  Human-readable explanation of why the test cannot
 *                         run on Windows (e.g. 'UDS socket: not supported on win32').
 * @returns {string|false} The reason string on win32, false elsewhere.
 */
export function skipOnWindows(reason) {
  return process.platform === 'win32' ? reason : false;
}
