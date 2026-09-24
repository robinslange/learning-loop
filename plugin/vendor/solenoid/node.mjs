// src/node.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function fileStore(dir = join(homedir(), ".cache", "solenoid")) {
  const file = join(dir, "outage.json");
  const read = () => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };
  return {
    get: (scope) => read()[scope],
    set(scope, v) {
      const all = read();
      if (all[scope] === v) return;
      all[scope] = v;
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all));
      renameSync(tmp, file);
    }
  };
}
export {
  fileStore
};
