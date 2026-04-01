import { join, resolve } from 'path';
import { getVaultPath, getPluginRoot, getPluginData } from './config.mjs';

export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const DTYPE = 'q8';
export const EMBED_DIM = 384;
export const SCHEMA_VERSION = 2;
export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

export const RRF_K = 5;
export const DISCRIMINATE_THRESHOLD = 0.85;
export const FTS_WEIGHTS = { title: 10.0, tags: 5.0, body: 1.0 };
export const BATCH_SIZE = 32;
export const MAX_TEXT_LENGTH = 1500;

export const VAULT_PATH = getVaultPath();
export const PLUGIN_ROOT = getPluginRoot();
export const PLUGIN_DATA = getPluginData();
export const DB_DIR = join(VAULT_PATH, '.vault-search');
export const DB_PATH = join(DB_DIR, 'vault-index.db');
export const BIN_DIR = join(PLUGIN_DATA, 'bin');

/** @deprecated Use BIN_DIR instead. */
export const CACHE_DIR = resolve(join(PLUGIN_ROOT, 'scripts', '.model-cache'));
