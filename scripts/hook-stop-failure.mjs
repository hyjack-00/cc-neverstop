#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { withWorkspaceLock } from "./lib/lock.mjs";
import { captureProcessRef, isSameProcess, spawnDetached } from "./lib/process.mjs";
import { loadState, newLease, resolveLeaseLogFile, saveState, touchLease, writeLeaseSnapshot } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const RETRYABLE_ERRORS = new Set(["rate_limit", "server_error", "unknown"]);
const TOTAL_RETRY_WINDOW_MS = 5 * 60 * 60 * 1000;

function readInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function pluginRoot() {
  return path.resolve(process.env.CLAUDE_PLUGIN_ROOT || path.join(import.meta.dirname, ".."));
}

async function main() {
  const input = readInput();

  if (process.env.NEVERSTOP_SUPERVISOR_CHILD === "1") {
    const leaseId = process.env.NEVERSTOP_ACTIVE_LEASE_ID;
    if (!leaseId || !input.error) {
      return;
    }
    const cwd = resolveWorkspaceRoot(input.cwd || process.cwd());
    await withWorkspaceLock(cwd, async () => {
      const state = loadState(cwd);
      if (state.active_lease?.lease_id !== leaseId) {
        return;
      }
      const lease = touchLease(state.active_lease, {
        last_error_type: input.error,
        last_error_details: input.error_details ?? null
      });
      state.active_lease = lease;
      writeLeaseSnapshot(cwd, lease);
      saveState(cwd, state);
    });
    return;
  }

  if (!RETRYABLE_ERRORS.has(input.error)) {
    return;
  }

  const cwd = resolveWorkspaceRoot(input.cwd || process.cwd());
  const root = pluginRoot();

  await withWorkspaceLock(cwd, async () => {
    const state = loadState(cwd);
    if (state.active_lease?.supervisor && isSameProcess(state.active_lease.supervisor)) {
      return;
    }

    const lease = touchLease(
      newLease({
        sessionId: input.session_id,
        errorType: input.error,
        deadlineAt: new Date(Date.now() + TOTAL_RETRY_WINDOW_MS).toISOString()
      }),
      {
        next_attempt_at: new Date().toISOString()
      }
    );

    const supervisorLogFile = resolveLeaseLogFile(cwd, lease.lease_id);
    const stdoutFd = fs.openSync(supervisorLogFile, "a");
    const stderrFd = fs.openSync(supervisorLogFile, "a");
    const env = {
      ...process.env,
      NEVERSTOP_PLUGIN_ROOT: root
    };

    const pid = spawnDetached(
      process.execPath,
      [path.join(root, "scripts", "neverstop-supervisor.mjs"), "--cwd", cwd, "--lease-id", lease.lease_id],
      {
        cwd,
        env,
        stdio: ["ignore", stdoutFd, stderrFd]
      }
    );

    lease.supervisor = captureProcessRef(pid);
    lease.phase = "starting";
    writeLeaseSnapshot(cwd, lease);
    saveState(cwd, {
      ...state,
      active_lease: lease
    });
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
