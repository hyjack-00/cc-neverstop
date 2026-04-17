#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { inheritParentEnv, summarizeClaudeEnv } from "./lib/env.mjs";
import { withWorkspaceLock } from "./lib/lock.mjs";
import { computeRetryWindowMs } from "./lib/policy.mjs";
import { computeRetryDelayMs } from "./lib/policy.mjs";
import { captureProcessRef, leaseHasLiveProcesses, spawnDetached } from "./lib/process.mjs";
import { findActiveLeaseContext, loadState, newLease, resolveLeaseLogFile, saveState, touchLease, writeLeaseSnapshot } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const RETRYABLE_ERRORS = new Set(["rate_limit", "server_error", "unknown"]);

function readInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function pluginRoot() {
  return path.resolve(process.env.CLAUDE_PLUGIN_ROOT || path.join(import.meta.dirname, ".."));
}

function startSupervisor({ cwd, root, leaseId, env, logFile }) {
  const stdoutFd = fs.openSync(logFile, "a");
  const stderrFd = fs.openSync(logFile, "a");

  const pid = spawnDetached(
    process.execPath,
    [path.join(root, "scripts", "neverstop-supervisor.mjs"), "--cwd", cwd, "--lease-id", leaseId],
    {
      cwd,
      env,
      stdio: ["ignore", stdoutFd, stderrFd]
    }
  );

  return captureProcessRef(pid);
}

async function main() {
  const input = readInput();
  const root = pluginRoot();
  const inheritedEnv = inheritParentEnv(process.env, {
    NEVERSTOP_PLUGIN_ROOT: root
  });

  if (process.env.NEVERSTOP_SUPERVISOR_CHILD === "1") {
    const leaseId = process.env.NEVERSTOP_ACTIVE_LEASE_ID;
    if (!leaseId || !input.error) {
      return;
    }
    const cwd = resolveWorkspaceRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const context = findActiveLeaseContext(cwd, { leaseId });
    const configDir = context?.config_dir ?? summarizeClaudeEnv(process.env, cwd).config_dir;
    await withWorkspaceLock(cwd, async () => {
      const state = loadState(cwd, configDir);
      if (state.active_lease?.lease_id !== leaseId) {
        return;
      }
      let lease = touchLease(state.active_lease, {
        last_error_type: input.error
      });
      const shouldRepairSupervisor =
        RETRYABLE_ERRORS.has(input.error) && !leaseHasLiveProcesses({ supervisor: lease.supervisor, child: null });

      if (shouldRepairSupervisor) {
        const retryAt = new Date(Date.now() + computeRetryDelayMs(lease.attempt ?? 0)).toISOString();
        const supervisor = startSupervisor({
          cwd,
          root,
          leaseId,
          env: inheritedEnv,
          logFile: resolveLeaseLogFile(cwd, lease.lease_id, configDir)
        });
        lease = touchLease(lease, {
          phase: "retry_waiting",
          exclusive: true,
          next_attempt_at: retryAt,
          child: null,
          supervisor
        });
      }
      state.active_lease = lease;
      writeLeaseSnapshot(cwd, lease, configDir);
      saveState(cwd, state, configDir);
    }, { configDir });
    return;
  }

  if (!RETRYABLE_ERRORS.has(input.error)) {
    return;
  }

  const cwd = resolveWorkspaceRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const envSummary = summarizeClaudeEnv(process.env, cwd);

  await withWorkspaceLock(cwd, async () => {
    const currentContext = findActiveLeaseContext(cwd);
    const currentConfigDir = currentContext?.config_dir ?? envSummary.config_dir;
    const state = loadState(cwd, currentConfigDir);
    if (leaseHasLiveProcesses(state.active_lease) || leaseHasLiveProcesses(currentContext?.state?.active_lease)) {
      return;
    }

    const lease = touchLease(
      newLease({
        sessionId: input.session_id,
        errorType: input.error,
        deadlineAt: new Date(Date.now() + computeRetryWindowMs()).toISOString()
      }),
      {
        next_attempt_at: new Date().toISOString(),
        config_dir: envSummary.config_dir,
        env_summary: envSummary
      }
    );

    const supervisorLogFile = resolveLeaseLogFile(cwd, lease.lease_id, envSummary.config_dir);
    lease.supervisor = startSupervisor({
      cwd,
      root,
      leaseId: lease.lease_id,
      env: inheritedEnv,
      logFile: supervisorLogFile
    });
    lease.phase = "starting";
    writeLeaseSnapshot(cwd, lease, envSummary.config_dir);
    saveState(cwd, {
      ...state,
      active_lease: lease
    }, envSummary.config_dir);
  }, { configDir: envSummary.config_dir });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
