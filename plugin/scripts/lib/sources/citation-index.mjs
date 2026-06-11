import { writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getPluginData } from '../config.mjs';
import { safeLoad } from '../safe-load.mjs';
import { withLock } from '../file-lock.mjs';
import { logError } from '../log.mjs';

const PLUGIN_DATA = getPluginData();
const PLUGIN_DIR = resolve(fileURLToPath(import.meta.url), '../../../..');
const DATA_DIR = PLUGIN_DATA ? join(PLUGIN_DATA, 'data') : join(PLUGIN_DIR, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const INDEX_PATH = join(DATA_DIR, 'citation-index.json');

export function loadCitationIndex() {
  const { value } = safeLoad(INDEX_PATH, { fallback: {} });
  return value ?? {};
}

export function saveCitationIndex(index) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = INDEX_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(index, null, 2));
  renameSync(tmp, INDEX_PATH);
}

// Within-process serialization queue prevents concurrent writes from the same process
let _writeQueue = Promise.resolve();

export function updateCitationIndex(pmid, metadata, noteFilename) {
  _writeQueue = _writeQueue.then(() => _doUpdate(pmid, metadata, noteFilename));
  return _writeQueue;
}

function _doUpdate(pmid, metadata, noteFilename) {
  try {
    withLock(INDEX_PATH, { retries: 5, retryDelayMs: 30 }, () => {
      const index = loadCitationIndex();
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
      saveCitationIndex(index);
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
