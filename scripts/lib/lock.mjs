import fs from "node:fs";
import path from "node:path";

import { captureProcessRef, isSameProcess } from "./process.mjs";
import { resolveLockDir } from "./state.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ownerAgeMs(ownerFile) {
  try {
    const stat = fs.statSync(ownerFile);
    return Date.now() - stat.mtimeMs;
  } catch {
    return 0;
  }
}

function writeOwnerFile(ownerFile) {
  const payload = captureProcessRef(process.pid) ?? { pid: process.pid };
  const tempFile = `${ownerFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(payload)}\n`, "utf8");
  fs.renameSync(tempFile, ownerFile);
}

export async function withWorkspaceLock(cwd, fn, options = {}) {
  const lockDir = resolveLockDir(cwd, options.configDir);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const ownerFile = path.join(lockDir, "owner.json");
  const staleMs = options.staleMs ?? 30000;
  const retryMs = options.retryMs ?? 100;
  const timeoutMs = options.timeoutMs ?? 5000;
  const heartbeatMs = options.heartbeatMs ?? Math.max(1000, Math.floor(staleMs / 3));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      writeOwnerFile(ownerFile);
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
      if (ownerAgeMs(ownerFile) > staleMs && (!owner || !isSameProcess(owner))) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for workspace lock: ${lockDir}`);
      }
      await sleep(retryMs);
    }
  }

  let heartbeat = null;
  try {
    heartbeat = setInterval(() => {
      try {
        writeOwnerFile(ownerFile);
      } catch {
        // Best effort heartbeat only.
      }
    }, heartbeatMs);
    return await fn();
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
