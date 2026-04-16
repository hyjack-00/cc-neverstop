#!/usr/bin/env node

import process from "node:process";

import { withWorkspaceLock } from "./lib/lock.mjs";
import { isSameProcess, terminateProcessTree } from "./lib/process.mjs";
import { archiveActiveLease, loadState, saveState, touchLease } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const cwd = resolveWorkspaceRoot(process.cwd());
  let sessionId = null;
  let supervisor = null;
  let child = null;

  await withWorkspaceLock(cwd, async () => {
    const state = loadState(cwd);
    const lease = state.active_lease;
    if (!lease) {
      return;
    }

    sessionId = lease.session_id;
    supervisor = lease.supervisor;
    child = lease.child;
    state.active_lease = touchLease(lease, {
      phase: "takeover_requested"
    });
    saveState(cwd, state);

    if (isSameProcess(supervisor)) {
      terminateProcessTree(supervisor.pid, "SIGTERM");
    }
    if (isSameProcess(child)) {
      terminateProcessTree(child.pid, "SIGTERM");
    }
  });

  const gracefulDeadline = Date.now() + 5000;
  while (Date.now() < gracefulDeadline) {
    if (!isSameProcess(supervisor) && !isSameProcess(child)) {
      break;
    }
    await sleep(200);
  }

  if (isSameProcess(supervisor)) {
    terminateProcessTree(supervisor.pid, "SIGKILL");
  }
  if (isSameProcess(child)) {
    terminateProcessTree(child.pid, "SIGKILL");
  }

  const forceDeadline = Date.now() + 3000;
  while (Date.now() < forceDeadline) {
    if (!isSameProcess(supervisor) && !isSameProcess(child)) {
      break;
    }
    await sleep(200);
  }

  if (isSameProcess(supervisor) || isSameProcess(child)) {
    process.stderr.write("Failed to stop the active Neverstop background processes cleanly. Foreground takeover is unsafe.\n");
    process.exit(1);
  }

  await withWorkspaceLock(cwd, async () => {
    const state = loadState(cwd);
    if (state.active_lease?.session_id === sessionId) {
      archiveActiveLease(cwd, "stopped");
    }
  });

  if (!sessionId) {
    process.stdout.write("Neverstop status: idle\n");
    return;
  }

  process.stdout.write(`Background lease stopped.\nResume with:\nclaude --resume ${sessionId}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
