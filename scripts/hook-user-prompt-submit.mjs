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

function extractPrompt(input) {
  return input.prompt ?? input.user_prompt ?? input.message ?? input.text ?? "";
}

function isNeverstopCommand(prompt) {
  return String(prompt || "").trim().startsWith("/neverstop:");
}

function emit(json) {
  process.stdout.write(`${JSON.stringify(json)}\n`);
}

function phaseMessage(lease) {
  if (!lease) {
    return null;
  }
  if (lease.phase === "retry_waiting") {
    return `Neverstop is waiting to retry in the background until ${lease.next_attempt_at}. Use /neverstop:status or /neverstop:takeover.`;
  }
  return `Neverstop background work is still active (${lease.phase}). Use /neverstop:status or /neverstop:takeover.`;
}

async function main() {
  const input = readInput();
  if (isNeverstopCommand(extractPrompt(input))) {
    return;
  }

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
    decision: "block",
    reason: phaseMessage(lease),
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `Neverstop has an active background lease in phase ${lease.phase}. The user must resolve it with /neverstop:status or /neverstop:takeover before normal foreground prompts continue.`
    }
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
