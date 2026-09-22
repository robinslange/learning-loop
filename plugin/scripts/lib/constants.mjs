import { join, resolve } from 'path';
import { getVaultPath, getPluginRoot, getPluginData } from './config.mjs';

export const SCHEMA_VERSION = 2;

export const RRF_K = 5;
export const DISCRIMINATE_THRESHOLD = 0.85;
export const MAX_TEXT_LENGTH = 1500;

export const VAULT_PATH = getVaultPath();
export const PLUGIN_ROOT = getPluginRoot();
export const PLUGIN_DATA = getPluginData();
export const DB_DIR = VAULT_PATH ? join(VAULT_PATH, '.vault-search') : null;
export const DB_PATH = DB_DIR ? join(DB_DIR, 'vault-index.db') : null;
export const BIN_DIR = PLUGIN_DATA ? join(PLUGIN_DATA, 'bin') : null;
