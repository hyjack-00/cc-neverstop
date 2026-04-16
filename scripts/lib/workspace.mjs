import fs from "node:fs";
import path from "node:path";

export function resolveWorkspaceRoot(cwd) {
  const candidate = path.resolve(cwd || process.cwd());
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return candidate;
  }
}
