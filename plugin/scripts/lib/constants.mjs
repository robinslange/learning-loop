import { getVaultPath, getPluginData } from './config.mjs';
import { VAULT_PATHS } from './paths.mjs';

export const DISCRIMINATE_THRESHOLD = 0.85;

export const VAULT_PATH = getVaultPath();
export const PLUGIN_DATA = getPluginData();
export const DB_DIR = VAULT_PATH ? VAULT_PATHS.dir(VAULT_PATH) : null;
export const DB_PATH = VAULT_PATH ? VAULT_PATHS.index(VAULT_PATH) : null;
