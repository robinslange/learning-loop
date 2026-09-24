import { writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { getPluginData } from '../config.mjs';
import { safeLoad } from '../safe-load.mjs';
import { withLock } from '../file-lock.mjs';
import { logError } from '../log.mjs';

// Resolved per call: a path fixed at import binds whatever plugin data the
// first importer saw, and a derived cache has no business in the install dir.
function indexPath() {
  const pd = getPluginData();
  return pd ? join(pd, 'data', 'citation-index.json') : null;
}

function readIndex(path) {
  const { value } = safeLoad(path, { fallback: {} });
  return value ?? {};
}

export function loadCitationIndex() {
  const path = indexPath();
  return path ? readIndex(path) : {};
}

function saveCitationIndex(path, index) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(index, null, 2));
  renameSync(tmp, path);
}

// Within-process serialization queue prevents concurrent writes from the same process
let _writeQueue = Promise.resolve();

export function updateCitationIndex(pmid, metadata, noteFilename) {
  _writeQueue = _writeQueue.then(() => _doUpdate(pmid, metadata, noteFilename));
  return _writeQueue;
}

function _doUpdate(pmid, metadata, noteFilename) {
  const path = indexPath();
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  try {
    withLock(path, { retries: 5, retryDelayMs: 30 }, () => {
      const index = readIndex(path);
      const key = `pmid:${pmid}`;
      if (!index[key]) {
        index[key] = {
          authors: metadata.authors || [],
          title: metadata.title || '',
          year: metadata.year || null,
          cited_in: [],
        };
      }
      if (!index[key].cited_in.includes(noteFilename)) {
        index[key].cited_in.push(noteFilename);
      }
      saveCitationIndex(path, index);
    });
  } catch (err) {
    // ELOCK_TIMEOUT here means every retry was contended. The previous
    // implementation silently no-op'd this case (citation update lost).
    // Surface it so lost updates are debuggable.
    if (err.code === 'ELOCK_TIMEOUT') {
      logError('citation-index.updateCitationIndex.lockTimeout', err, { pmid, noteFilename });
    } else {
      throw err;
    }
  }
}
