const FLAG_PREFIX = '__llWarned_';

export function warnOnce(key, message) {
  const flag = FLAG_PREFIX + key;
  if (globalThis[flag]) return;
  globalThis[flag] = true;
  process.stderr.write(message);
}

export function resetForTests(key) {
  delete globalThis[FLAG_PREFIX + key];
}
