import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { leaseHasLiveProcesses } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_ROOT = path.join(os.tmpdir(), "neverstop");
const HISTORY_LIMIT = 20;

function nowIso() {
  return new Date().toISOString();
}

function defaultState(workspaceRoot) {
  return {
    schema_version: STATE_VERSION,
    workspace_root: workspaceRoot,
    active_lease: null,
    history: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const slugBase = path.basename(workspaceRoot) || "workspace";
  const slug = slugBase.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const root = process.env[PLUGIN_DATA_ENV] ? path.join(process.env[PLUGIN_DATA_ENV], "state") : FALLBACK_ROOT;
  return path.join(root, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), "state.json");
}

export function resolveLeasesDir(cwd) {
  return path.join(resolveStateDir(cwd), "leases");
}

export function resolveLockDir(cwd) {
  return path.join(resolveStateDir(cwd), "lock");
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveLeasesDir(cwd), { recursive: true });
}

export function resolveLeaseFile(cwd, leaseId) {
  ensureStateDir(cwd);
  return path.join(resolveLeasesDir(cwd), `${leaseId}.json`);
}

export function resolveLeaseLogFile(cwd, leaseId) {
  ensureStateDir(cwd);
  return path.join(resolveLeasesDir(cwd), `${leaseId}.log`);
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function atomicWriteJson(filePath, payload) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fsyncFile(tmpFile);
  fs.renameSync(tmpFile, filePath);
}

export function loadState(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return defaultState(workspaceRoot);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(workspaceRoot),
      ...parsed,
      schema_version: STATE_VERSION,
      workspace_root: workspaceRoot,
      history: Array.isArray(parsed.history) ? parsed.history : []
    };
  } catch {
    const recoveredLease = recoverLeaseFromSnapshots(workspaceRoot);
    return {
      ...defaultState(workspaceRoot),
      active_lease: recoveredLease,
      state_recovered_from_parse_error: true
    };
  }
}

function recoverLeaseFromSnapshots(cwd) {
  const leasesDir = resolveLeasesDir(cwd);
  if (!fs.existsSync(leasesDir)) {
    return null;
  }

  const files = fs
    .readdirSync(leasesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const filePath = path.join(leasesDir, file);
      const stat = fs.statSync(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of files) {
    try {
      const lease = JSON.parse(fs.readFileSync(candidate.filePath, "utf8"));
      if (leaseHasLiveProcesses(lease)) {
        return lease;
      }
    } catch {
      // Ignore corrupt snapshots and continue searching.
    }
  }

  return null;
}

export function saveState(cwd, state) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  ensureStateDir(workspaceRoot);
  const nextState = {
    schema_version: STATE_VERSION,
    workspace_root: workspaceRoot,
    active_lease: state.active_lease ?? null,
    history: Array.isArray(state.history) ? state.history.slice(0, HISTORY_LIMIT) : []
  };
  atomicWriteJson(resolveStateFile(workspaceRoot), nextState);
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function newLease({ sessionId, errorType, deadlineAt }) {
  const now = nowIso();
  return {
    lease_id: `neverstop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    owner_plugin: "neverstop",
    session_id: sessionId,
    mode: "respawn",
    phase: "starting",
    exclusive: true,
    attempt: 0,
    started_at: now,
    updated_at: now,
    retry_deadline_at: deadlineAt,
    next_attempt_at: now,
    last_error_type: errorType,
    supervisor: null,
    child: null
  };
}

export function writeLeaseSnapshot(cwd, lease) {
  atomicWriteJson(resolveLeaseFile(cwd, lease.lease_id), lease);
}

export function summarizeLease(lease, statusOverride) {
  if (!lease) {
    return null;
  }
  return {
    lease_id: lease.lease_id,
    session_id: lease.session_id,
    phase: statusOverride ?? lease.phase,
    attempt: lease.attempt,
    started_at: lease.started_at,
    updated_at: lease.updated_at,
    retry_deadline_at: lease.retry_deadline_at,
    next_attempt_at: lease.next_attempt_at,
    last_error_type: lease.last_error_type
  };
}

export function archiveActiveLease(cwd, finalPhase) {
  return updateState(cwd, (state) => {
    if (!state.active_lease) {
      return;
    }
    const archived = {
      ...summarizeLease(state.active_lease, finalPhase),
      archived_at: nowIso()
    };
    state.history.unshift(archived);
    state.active_lease = null;
  });
}

export function touchLease(lease, patch = {}) {
  return {
    ...lease,
    ...patch,
    updated_at: nowIso()
  };
}
