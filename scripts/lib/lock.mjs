import fs from "node:fs";
import path from "node:path";

import { captureProcessRef, isSameProcess } from "./process.mjs";
import { resolveLockDir } from "./state.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockAgeMs(lockDir) {
  try {
    const stat = fs.statSync(lockDir);
    return Date.now() - stat.mtimeMs;
  } catch {
    return 0;
  }
}

export async function withWorkspaceLock(cwd, fn, options = {}) {
  const lockDir = resolveLockDir(cwd);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const ownerFile = path.join(lockDir, "owner.json");
  const staleMs = options.staleMs ?? 30000;
  const retryMs = options.retryMs ?? 100;
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      fs.writeFileSync(ownerFile, `${JSON.stringify(captureProcessRef(process.pid) ?? { pid: process.pid })}\n`, "utf8");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
      } catch {
        owner = null;
      }
      if (lockAgeMs(lockDir) > staleMs && (!owner || !isSameProcess(owner))) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for workspace lock: ${lockDir}`);
      }
      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
