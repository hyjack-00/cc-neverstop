#!/usr/bin/env node

import process from "node:process";

import { leaseHasLiveProcesses } from "./lib/process.mjs";
import { withWorkspaceLock } from "./lib/lock.mjs";
import { archiveActiveLease, findActiveLeaseContext, loadState, resolveLeaseLogFile } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function line(label, value) {
  return `${label.padEnd(18)} ${value}`;
}

function printArchived(archived) {
  const lines = [
    "Neverstop status: idle",
    "",
    "Most recent lease:",
    line("Lease ID", archived.lease_id),
    line("Session ID", archived.session_id),
    line("Phase", archived.phase),
    line("Attempt", String(archived.attempt)),
    line("Error", String(archived.last_error_type || "")),
    line("Started", archived.started_at),
    line("Updated", archived.updated_at),
    line("Archived", archived.archived_at)
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  const cwd = resolveWorkspaceRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const context = findActiveLeaseContext(cwd, { includeHistory: true });
  const state = context?.state ?? loadState(cwd);
  const configDir = context?.config_dir ?? null;
  const lease = state.active_lease;

  if (!lease) {
    if (state.history[0]) {
      printArchived(state.history[0]);
      return;
    }
    process.stdout.write("Neverstop status: idle\n");
    return;
  }

  if (!leaseHasLiveProcesses(lease)) {
    await withWorkspaceLock(cwd, async () => {
      const nextState = loadState(cwd, configDir);
      if (nextState.active_lease?.lease_id === lease.lease_id && !leaseHasLiveProcesses(nextState.active_lease)) {
        archiveActiveLease(cwd, lease.phase === "failed" ? "failed" : "stopped", configDir);
      }
    }, { configDir });
    const nextState = loadState(cwd, configDir);
    if (nextState.history[0]) {
      printArchived(nextState.history[0]);
      return;
    }
    process.stdout.write("Neverstop status: idle\n");
    return;
  }

  const lines = [
    "Neverstop status: active",
    line("Lease ID", lease.lease_id),
    line("Session ID", lease.session_id),
    line("Phase", lease.phase),
    line("Attempt", String(lease.attempt)),
    line("Error", String(lease.last_error_type || "")),
    line("Config Dir", String(lease.config_dir || "-")),
    line("Started", lease.started_at),
    line("Updated", lease.updated_at),
    line("Deadline", lease.retry_deadline_at),
    line("Next Attempt", lease.next_attempt_at || "-"),
    line("Supervisor PID", String(lease.supervisor?.pid ?? "-")),
    line("Child PID", String(lease.child?.pid ?? "-")),
    line("Log File", resolveLeaseLogFile(cwd, lease.lease_id, lease.config_dir || configDir))
  ];

  if (lease.phase === "retry_waiting") {
    lines.push("");
    lines.push("Background retry is sleeping and still counts as exclusive occupancy.");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
