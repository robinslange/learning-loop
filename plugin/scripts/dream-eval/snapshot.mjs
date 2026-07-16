import { cpSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function fork(srcDir, destDir) {
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(srcDir, destDir, { recursive: true });
  return destDir;
}

export function snapshot(dir, destPath) {
  mkdirSync(dirname(destPath), { recursive: true });
  cpSync(dir, destPath, { recursive: true });
  return destPath;
}

export function restore(snapPath, dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  cpSync(snapPath, dir, { recursive: true });
  return dir;
}
