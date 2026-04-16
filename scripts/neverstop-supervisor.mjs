#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { withWorkspaceLock } from "./lib/lock.mjs";
import { captureProcessRef, isSameProcess } from "./lib/process.mjs";
import { computeRetryDelayMs } from "./lib/policy.mjs";
import { archiveActiveLease, loadState, resolveLeaseLogFile, saveState, touchLease, writeLeaseSnapshot } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const RETRYABLE_ERRORS = new Set(["rate_limit", "server_error", "unknown"]);

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key?.startsWith("--")) {
      args[key.slice(2)] = value;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pluginRoot() {
  return path.resolve(process.env.NEVERSTOP_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || path.join(import.meta.dirname, ".."));
}

async function withLease(cwd, leaseId, mutate) {
  return withWorkspaceLock(cwd, async () => {
    const state = loadState(cwd);
    const lease = state.active_lease;
    if (!lease || lease.lease_id !== leaseId) {
      return null;
    }
    const updated = mutate(lease, state);
    if (updated === null) {
      saveState(cwd, state);
      return null;
    }
    state.active_lease = updated;
    writeLeaseSnapshot(cwd, updated);
    saveState(cwd, state);
    return updated;
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = resolveWorkspaceRoot(args.cwd || process.cwd());
  const leaseId = args["lease-id"];
  const root = pluginRoot();

  if (!leaseId) {
    throw new Error("Missing --lease-id");
  }

  const bootLease = await withLease(cwd, leaseId, (lease) =>
    touchLease(lease, {
      phase: "starting",
      supervisor: captureProcessRef(process.pid)
    })
  );
  if (!bootLease) {
    return;
  }

  const logFile = resolveLeaseLogFile(cwd, leaseId);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] supervisor started pid=${process.pid}\n`, "utf8");

  while (true) {
    const state = loadState(cwd);
    const lease = state.active_lease;
    if (!lease || lease.lease_id !== leaseId) {
      return;
    }

    if (lease.phase === "takeover_requested" || lease.phase === "stopping") {
      await withLease(cwd, leaseId, (currentLease) =>
        touchLease(currentLease, {
          phase: "stopping",
          exclusive: false
        })
      );
      await withWorkspaceLock(cwd, async () => {
        archiveActiveLease(cwd, "stopped");
      });
      return;
    }

    const deadline = Date.parse(lease.retry_deadline_at);
    if (Number.isFinite(deadline) && Date.now() > deadline) {
      await withLease(cwd, leaseId, (currentLease) =>
        touchLease(currentLease, {
          phase: "failed",
          exclusive: false,
          next_attempt_at: null,
          child: null
        })
      );
      await withWorkspaceLock(cwd, async () => {
        archiveActiveLease(cwd, "failed");
      });
      return;
    }

    const nextAttemptAt = Date.parse(lease.next_attempt_at || lease.updated_at);
    if (Number.isFinite(nextAttemptAt) && Date.now() < nextAttemptAt) {
      await withLease(cwd, leaseId, (currentLease) =>
        touchLease(currentLease, {
          phase: "retry_waiting",
          exclusive: true
        })
      );

      while (Date.now() < nextAttemptAt) {
        const waitingState = loadState(cwd);
        if (!waitingState.active_lease || waitingState.active_lease.lease_id !== leaseId) {
          return;
        }
        if (waitingState.active_lease.phase === "takeover_requested") {
          break;
        }
        await sleep(1000);
      }
      continue;
    }

    const startedLease = await withLease(cwd, leaseId, (currentLease) =>
      touchLease(currentLease, {
        phase: "running",
        attempt: (currentLease.attempt ?? 0) + 1,
        exclusive: true,
        child: null
      })
    );
    if (!startedLease) {
      return;
    }

    const claudeArgs = [
      "--plugin-dir",
      root,
      "--resume",
      startedLease.session_id,
      "-p",
      "continue task"
    ];
    const child = spawn("claude", claudeArgs, {
      cwd,
      env: {
        ...process.env,
        NEVERSTOP_SUPERVISOR_CHILD: "1",
        NEVERSTOP_ACTIVE_LEASE_ID: leaseId
      },
      detached: false,
      stdio: "ignore",
      windowsHide: true
    });

    await withLease(cwd, leaseId, (currentLease) =>
      touchLease(currentLease, {
        phase: "running",
        child: {
          ...captureProcessRef(child.pid)
        }
      })
    );

    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });

    const finishedState = loadState(cwd);
    const finishedLease = finishedState.active_lease;
    if (!finishedLease || finishedLease.lease_id !== leaseId) {
      return;
    }

    if (finishedLease.phase === "takeover_requested") {
      continue;
    }

    if (exitCode === 0) {
      await withLease(cwd, leaseId, (currentLease) =>
        touchLease(currentLease, {
          phase: "completed",
          exclusive: false,
          child: null,
          next_attempt_at: null
        })
      );
      await withWorkspaceLock(cwd, async () => {
        archiveActiveLease(cwd, "completed");
      });
      return;
    }

    if (!RETRYABLE_ERRORS.has(finishedLease.last_error_type)) {
      await withLease(cwd, leaseId, (currentLease) =>
        touchLease(currentLease, {
          phase: "failed",
          exclusive: false,
          child: null,
          next_attempt_at: null
        })
      );
      await withWorkspaceLock(cwd, async () => {
        archiveActiveLease(cwd, "failed");
      });
      return;
    }

    const retryAt = new Date(Date.now() + computeRetryDelayMs(finishedLease.attempt)).toISOString();
    await withLease(cwd, leaseId, (currentLease) =>
      touchLease(currentLease, {
        phase: "retry_waiting",
        exclusive: true,
        child: null,
        next_attempt_at: retryAt
      })
    );

    if (!isSameProcess({ pid: process.pid, start_marker: getProcessStartMarker(process.pid) })) {
      return;
    }
  }
}

main().catch(async (error) => {
  const args = parseArgs(process.argv);
  const cwd = resolveWorkspaceRoot(args.cwd || process.cwd());
  const leaseId = args["lease-id"];
  if (leaseId) {
    try {
      await withLease(cwd, leaseId, (currentLease) =>
        touchLease(currentLease, {
          phase: "failed",
          exclusive: false,
          child: null,
          next_attempt_at: null
        })
      );
      await withWorkspaceLock(cwd, async () => {
        archiveActiveLease(cwd, "failed");
      });
    } catch {
      // Best effort only.
    }
  }
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
