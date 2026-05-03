import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  constants as fsConstants,
} from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getPluginData } from '../config.mjs';

const PLUGIN_DATA = getPluginData();
const PLUGIN_DIR = resolve(fileURLToPath(import.meta.url), '../../../../..');
const DATA_DIR = PLUGIN_DATA ? join(PLUGIN_DATA, 'data') : join(PLUGIN_DIR, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const INDEX_PATH = join(DATA_DIR, 'citation-index.json');

let lockFd = null;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const lockSleepBuf = new Int32Array(new SharedArrayBuffer(4));
function acquireLock(retries = 5, delayMs = 30) {
  const lockPath = INDEX_PATH + '.lock';
  if (lockFd !== null) return false;
  for (let i = 0; i < retries; i++) {
    try {
      lockFd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
      writeFileSync(lockFd, String(process.pid));
      return true;
    } catch {
      try {
        const pid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
        if (pid && !isProcessAlive(pid)) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {}
      if (i < retries - 1) Atomics.wait(lockSleepBuf, 0, 0, delayMs);
    }
  }
  return false;
}

function releaseLock() {
  const lockPath = INDEX_PATH + '.lock';
  if (lockFd !== null) {
    try {
      closeSync(lockFd);
    } catch {}
    lockFd = null;
  }
  try {
    unlinkSync(lockPath);
  } catch {}
}

export function loadCitationIndex() {
  if (!existsSync(INDEX_PATH)) return {};
  try {
    return JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
  } catch {
    return {};
  }
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
  const acquired = acquireLock();
  try {
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
  } finally {
    if (acquired) releaseLock();
  }
}
