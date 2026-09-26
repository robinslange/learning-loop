import { join } from 'path';
import { getVaultPath, getPluginData } from './config.mjs';

export const DISCRIMINATE_THRESHOLD = 0.85;

export const VAULT_PATH = getVaultPath();
export const PLUGIN_DATA = getPluginData();
export const DB_DIR = VAULT_PATH ? join(VAULT_PATH, '.vault-search') : null;
export const DB_PATH = DB_DIR ? join(DB_DIR, 'vault-index.db') : null;
