import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dirname, '..', '..', 'vendor', 'sql-wasm.wasm');

let _SQL = null;

export async function initSQL() {
  if (_SQL) return _SQL;
  const require = createRequire(import.meta.url);
  const initSqlJs = require(join(__dirname, '..', '..', 'vendor', 'sql-wasm.js'));
  const wasmBinary = readFileSync(wasmPath);
  _SQL = await initSqlJs({ wasmBinary });
  return _SQL;
}

export async function openReadonly(dbPath) {
  const SQL = await initSQL();
  const buffer = readFileSync(dbPath);
  return new SQL.Database(buffer);
}
