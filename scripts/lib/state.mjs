import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveConfigDir } from "./env.mjs";
import { leaseHasLiveProcesses } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const STATE_VERSION = 2;
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

function stateRoot() {
  return process.env[PLUGIN_DATA_ENV] ? path.join(process.env[PLUGIN_DATA_ENV], "state") : FALLBACK_ROOT;
}

function resolveStateDirFor(workspaceRoot, configDir) {
  const slugBase = path.basename(workspaceRoot) || "workspace";
  const slug = slugBase.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const configSlugBase = path.basename(configDir) || "config";
  const configSlug = configSlugBase.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "config";
  const hash = createHash("sha256").update(`${workspaceRoot}\u0000${configDir}`).digest("hex").slice(0, 16);
  return path.join(stateRoot(), `${slug}-${configSlug}-${hash}`);
}

export function resolveStateDir(cwd, configDir = null) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return resolveStateDirFor(workspaceRoot, configDir ?? resolveConfigDir(process.env, workspaceRoot));
}

function resolveStateFileFor(workspaceRoot, configDir) {
  return path.join(resolveStateDirFor(workspaceRoot, configDir), "state.json");
}

export function resolveStateFile(cwd, configDir = null) {
  return path.join(resolveStateDir(cwd, configDir), "state.json");
}

export function resolveLeasesDir(cwd, configDir = null) {
  return path.join(resolveStateDir(cwd, configDir), "leases");
}

export function resolveLockDir(cwd, configDir = null) {
  return path.join(resolveStateDir(cwd, configDir), "lock");
}

export function ensureStateDir(cwd, configDir = null) {
  fs.mkdirSync(resolveLeasesDir(cwd, configDir), { recursive: true });
}

export function resolveLeaseFile(cwd, leaseId, configDir = null) {
  ensureStateDir(cwd, configDir);
  return path.join(resolveLeasesDir(cwd, configDir), `${leaseId}.json`);
}

export function resolveLeaseLogFile(cwd, leaseId, configDir = null) {
  ensureStateDir(cwd, configDir);
  return path.join(resolveLeasesDir(cwd, configDir), `${leaseId}.log`);
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

function readStateFile(stateFile, workspaceRoot) {
  if (!fs.existsSync(stateFile)) {
    return defaultState(workspaceRoot);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(workspaceRoot),
      ...parsed,
      schema_version: STATE_VERSION,
      workspace_root: parsed.workspace_root ?? workspaceRoot,
      history: Array.isArray(parsed.history) ? parsed.history : []
    };
  } catch {
    const recoveredLease = recoverLeaseFromSnapshots(path.join(path.dirname(stateFile), "leases"));
    return {
      ...defaultState(workspaceRoot),
      active_lease: recoveredLease,
      state_recovered_from_parse_error: true
    };
  }
}

export function loadState(cwd, configDir = null) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const resolvedConfigDir = configDir ?? resolveConfigDir(process.env, workspaceRoot);
  return readStateFile(resolveStateFileFor(workspaceRoot, resolvedConfigDir), workspaceRoot);
}

function recoverLeaseFromSnapshots(leasesDir) {
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

export function saveState(cwd, state, configDir = null) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const resolvedConfigDir = configDir ?? resolveConfigDir(process.env, workspaceRoot);
  ensureStateDir(workspaceRoot, resolvedConfigDir);
  const nextState = {
    schema_version: STATE_VERSION,
    workspace_root: workspaceRoot,
    active_lease: state.active_lease ?? null,
    history: Array.isArray(state.history) ? state.history.slice(0, HISTORY_LIMIT) : []
  };
  atomicWriteJson(resolveStateFileFor(workspaceRoot, resolvedConfigDir), nextState);
  return nextState;
}

export function updateState(cwd, mutate, configDir = null) {
  const state = loadState(cwd, configDir);
  mutate(state);
  return saveState(cwd, state, configDir);
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
    config_dir: null,
    env_summary: null,
    supervisor: null,
    child: null
  };
}

export function writeLeaseSnapshot(cwd, lease, configDir = null) {
  atomicWriteJson(resolveLeaseFile(cwd, lease.lease_id, configDir), lease);
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
    config_dir: lease.config_dir ?? null,
    started_at: lease.started_at,
    updated_at: lease.updated_at,
    retry_deadline_at: lease.retry_deadline_at,
    next_attempt_at: lease.next_attempt_at,
    last_error_type: lease.last_error_type
  };
}

export function archiveActiveLease(cwd, finalPhase, configDir = null) {
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
  }, configDir);
}

export function touchLease(lease, patch = {}) {
  return {
    ...lease,
    ...patch,
    updated_at: nowIso()
  };
}

function candidateContexts(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const currentConfigDir = resolveConfigDir(process.env, workspaceRoot);
  const contexts = [
    {
      workspace_root: workspaceRoot,
      config_dir: currentConfigDir,
      state: loadState(workspaceRoot, currentConfigDir)
    }
  ];

  if (!fs.existsSync(stateRoot())) {
    return contexts;
  }

  for (const entry of fs.readdirSync(stateRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const stateFile = path.join(stateRoot(), entry.name, "state.json");
    if (!fs.existsSync(stateFile)) {
      continue;
    }
    try {
      const state = readStateFile(stateFile, workspaceRoot);
      if (state.workspace_root !== workspaceRoot) {
        continue;
      }
      const configDir = state.active_lease?.config_dir || null;
      if (configDir === currentConfigDir) {
        continue;
      }
      contexts.push({
        workspace_root: workspaceRoot,
        config_dir: configDir,
        state
      });
    } catch {
      // Ignore unreadable state buckets.
    }
  }

  return contexts;
}

export function findActiveLeaseContext(cwd, options = {}) {
  const leaseId = options.leaseId ?? null;
  const includeHistory = options.includeHistory ?? false;
  const contexts = candidateContexts(cwd)
    .filter((context) => {
      if (leaseId) {
        return context.state.active_lease?.lease_id === leaseId;
      }
      return Boolean(context.state.active_lease) || (includeHistory && Boolean(context.state.history[0]));
    })
    .sort((left, right) => {
      const leftLive = leaseHasLiveProcesses(left.state.active_lease) ? 1 : 0;
      const rightLive = leaseHasLiveProcesses(right.state.active_lease) ? 1 : 0;
      if (leftLive !== rightLive) {
        return rightLive - leftLive;
      }
      const leftUpdated = Date.parse(left.state.active_lease?.updated_at || left.state.history[0]?.archived_at || 0);
      const rightUpdated = Date.parse(right.state.active_lease?.updated_at || right.state.history[0]?.archived_at || 0);
      return rightUpdated - leftUpdated;
    });

  return contexts[0] ?? null;
}
