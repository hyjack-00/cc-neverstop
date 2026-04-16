#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { leaseHasLiveProcesses } from "./lib/process.mjs";
import { withWorkspaceLock } from "./lib/lock.mjs";
import { archiveActiveLease, loadState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function readInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function emit(json) {
  process.stdout.write(`${JSON.stringify(json)}\n`);
}

function buildMessage(lease) {
  if (lease.phase === "retry_waiting") {
    return `Neverstop background retry is waiting until ${lease.next_attempt_at}. Use /neverstop:status or /neverstop:takeover before resuming foreground work.`;
  }
  return `Neverstop background lease is active (${lease.phase}) for session ${lease.session_id}. Use /neverstop:status or /neverstop:takeover before normal foreground work.`;
}

async function main() {
  const input = readInput();
  const cwd = resolveWorkspaceRoot(input.cwd || process.cwd());
  const state = loadState(cwd);
  const lease = state.active_lease;
  if (!lease) {
    return;
  }

  if (!leaseHasLiveProcesses(lease)) {
    await withWorkspaceLock(cwd, async () => {
      const nextState = loadState(cwd);
      if (nextState.active_lease?.lease_id === lease.lease_id && !leaseHasLiveProcesses(nextState.active_lease)) {
        archiveActiveLease(cwd, lease.phase === "failed" ? "failed" : "stopped");
      }
    });
    return;
  }

  emit({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildMessage(lease)
    }
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
