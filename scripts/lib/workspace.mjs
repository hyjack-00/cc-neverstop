import fs from "node:fs";
import path from "node:path";

function canonicalize(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
}

function findWorkspaceAnchor(start) {
  let current = start;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}

export function resolveWorkspaceRoot(cwd) {
  const candidate = canonicalize(path.resolve(cwd || process.cwd()));
  return canonicalize(findWorkspaceAnchor(candidate));
}
