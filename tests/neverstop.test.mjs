import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { resolveConfigDir, summarizeClaudeEnv } from "../scripts/lib/env.mjs";
import { computeRetryDelayMs, computeRetryWindowMs } from "../scripts/lib/policy.mjs";
import { captureProcessRef } from "../scripts/lib/process.mjs";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";

const REPO_ROOT = "/workspace/skills/cc-neverstop";

async function withTempPluginData(fn) {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "neverstop-test-"));
  try {
    return await fn(pluginData);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
}

test("retry delay reaches and stays at 30 minutes", () => {
  const minutes = [0, 1, 2, 3, 4, 5, 6, 7].map((attempt) => computeRetryDelayMs(attempt) / 60000);
  assert.deepEqual(minutes, [0, 1, 2, 4, 8, 16, 30, 30]);
});

test("retry window is 6 hours", () => {
  assert.equal(computeRetryWindowMs(), 6 * 60 * 60 * 1000);
});

test("env summary extracts CLAUDE_CONFIG_DIR and Claude-related keys", () => {
  const env = {
    CLAUDE_CONFIG_DIR: "/tmp/custom-claude",
    CLAUDE_CODE_ENTRYPOINT: "interactive",
    ANTHROPIC_API_KEY: "secret",
    PATH: process.env.PATH
  };
  assert.equal(resolveConfigDir(env), "/tmp/custom-claude");
  assert.deepEqual(summarizeClaudeEnv(env), {
    config_dir: "/tmp/custom-claude",
    inherited_keys: ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR"],
    used_default_config_dir: false
  });
});

test("relative CLAUDE_CONFIG_DIR resolves against the workspace root", () => {
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: ".claude-alt" }, REPO_ROOT), path.join(REPO_ROOT, ".claude-alt"));
});

test("corrupt state recovers active lease from a live lease snapshot", async () => {
  await withTempPluginData(async (pluginData) => {
    const sleeper = spawnSync("bash", ["-lc", "sleep 3 >/dev/null 2>&1 & echo $!"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    });
    const pid = Number(String(sleeper.stdout).trim());
    assert.ok(Number.isFinite(pid) && pid > 0);

    const stateDirResult = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>console.log(m.resolveStateDir(process.cwd())))'], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      encoding: "utf8"
    });
    const stateDir = String(stateDirResult.stdout).trim();
    const leasesDir = path.join(stateDir, "leases");
    mkdirSync(leasesDir, { recursive: true });
    writeFileSync(path.join(stateDir, "state.json"), "{not-json\n", "utf8");
    writeFileSync(
      path.join(leasesDir, "lease.json"),
      `${JSON.stringify({
        lease_id: "lease-1",
        session_id: "sess-1",
        phase: "running",
        supervisor: captureProcessRef(pid),
        child: null
      })}\n`,
      "utf8"
    );

    const result = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>{const s=m.loadState(process.cwd()); console.log(JSON.stringify({leaseId:s.active_lease?.lease_id || null,recovered:Boolean(s.state_recovered_from_parse_error)}));})'], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      encoding: "utf8"
    });

    process.kill(pid, "SIGTERM");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"leaseId":"lease-1"/);
    assert.match(result.stdout, /"recovered":true/);
  });
});

test("user prompt hook blocks normal prompts but allows /neverstop commands", async () => {
  await withTempPluginData(async (pluginData) => {
    const sleepProc = spawnSync("bash", ["-lc", "sleep 3 >/dev/null 2>&1 & echo $!"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    });
    const pid = Number(String(sleepProc.stdout).trim());
    assert.ok(Number.isFinite(pid) && pid > 0);

    const stateDirResult = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>console.log(m.resolveStateDir(process.cwd())))'], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });
    const stateDir = String(stateDirResult.stdout).trim();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        schema_version: 1,
        workspace_root: REPO_ROOT,
        active_lease: {
          lease_id: "lease-2",
          owner_plugin: "neverstop",
          session_id: "sess-2",
          mode: "respawn",
          phase: "retry_waiting",
          exclusive: true,
          attempt: 2,
          started_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:01:00.000Z",
          retry_deadline_at: "2026-04-17T05:00:00.000Z",
          next_attempt_at: "2026-04-17T00:05:00.000Z",
          last_error_type: "rate_limit",
          supervisor: captureProcessRef(pid),
          child: null
        },
        history: []
      })}\n`,
      "utf8"
    );

    const blocked = spawnSync("node", ["scripts/hook-user-prompt-submit.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      input: JSON.stringify({ cwd: REPO_ROOT, prompt: "hello" }),
      encoding: "utf8"
    });
    const allowed = spawnSync("node", ["scripts/hook-user-prompt-submit.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      input: JSON.stringify({ cwd: REPO_ROOT, prompt: "/neverstop:status" }),
      encoding: "utf8"
    });

    process.kill(pid, "SIGTERM");
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout, /"decision":"block"/);
    assert.equal(allowed.status, 0);
    assert.equal(allowed.stdout.trim(), "");
  });
});

test("takeover stops the recorded process and archives the lease", async () => {
  await withTempPluginData(async (pluginData) => {
    const sleeper = spawnSync("bash", ["-lc", "sleep 30 >/dev/null 2>&1 & echo $!"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    });
    const pid = Number(String(sleeper.stdout).trim());
    assert.ok(Number.isFinite(pid) && pid > 0);

    const stateDirResult = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>console.log(m.resolveStateDir(process.cwd())))'], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });
    const stateDir = String(stateDirResult.stdout).trim();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        schema_version: 1,
        workspace_root: REPO_ROOT,
        active_lease: {
          lease_id: "lease-3",
          owner_plugin: "neverstop",
          session_id: "sess-3",
          mode: "respawn",
          phase: "running",
          exclusive: true,
          attempt: 1,
          started_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:01:00.000Z",
          retry_deadline_at: "2026-04-17T05:00:00.000Z",
          next_attempt_at: null,
          last_error_type: "rate_limit",
          supervisor: captureProcessRef(pid),
          child: null
        },
        history: []
      })}\n`,
      "utf8"
    );

    const takeover = spawnSync("node", ["scripts/neverstop-takeover.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });
    const status = spawnSync("node", ["scripts/neverstop-status.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });

    let processGone = false;
    try {
      process.kill(pid, 0);
      processGone = false;
    } catch {
      processGone = true;
    }

    assert.equal(takeover.status, 0);
    assert.match(takeover.stdout, /Background lease stopped\./);
    assert.equal(status.status, 0);
    assert.match(status.stdout, /Most recent lease:/);
    assert.match(status.stdout, /Phase\s+stopped/);
    assert.equal(processGone, true);
  });
});

test("status and takeover can find an alternate-profile lease without CLAUDE_CONFIG_DIR in the caller env", async () => {
  await withTempPluginData(async (pluginData) => {
    const sleeper = spawnSync("bash", ["-lc", "sleep 30 >/dev/null 2>&1 & echo $!"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    });
    const pid = Number(String(sleeper.stdout).trim());
    assert.ok(Number.isFinite(pid) && pid > 0);

    const stateDirResult = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>console.log(m.resolveStateDir(process.cwd())))'], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });
    const stateDir = String(stateDirResult.stdout).trim();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        schema_version: 2,
        workspace_root: REPO_ROOT,
        active_lease: {
          lease_id: "lease-alt-visible",
          owner_plugin: "neverstop",
          session_id: "sess-alt-visible",
          mode: "respawn",
          phase: "retry_waiting",
          exclusive: true,
          attempt: 2,
          started_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:01:00.000Z",
          retry_deadline_at: "2026-04-17T06:00:00.000Z",
          next_attempt_at: "2026-04-17T00:05:00.000Z",
          last_error_type: "rate_limit",
          config_dir: "/tmp/claude-alt-profile",
          env_summary: {
            config_dir: "/tmp/claude-alt-profile",
            inherited_keys: ["CLAUDE_CONFIG_DIR"],
            used_default_config_dir: false
          },
          supervisor: captureProcessRef(pid),
          child: null
        },
        history: []
      })}\n`,
      "utf8"
    );

    const status = spawnSync("node", ["scripts/neverstop-status.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      encoding: "utf8"
    });
    assert.equal(status.status, 0);
    assert.match(status.stdout, /Neverstop status: active/);
    assert.match(status.stdout, /Config Dir\s+\/tmp\/claude-alt-profile/);

    const blocked = spawnSync("node", ["scripts/hook-user-prompt-submit.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      input: JSON.stringify({ cwd: REPO_ROOT, prompt: "continue working" }),
      encoding: "utf8"
    });
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout, /"decision":"block"/);

    const takeover = spawnSync("node", ["scripts/neverstop-takeover.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      encoding: "utf8"
    });
    assert.equal(takeover.status, 0);
    assert.match(takeover.stdout, /CLAUDE_CONFIG_DIR="\/tmp\/claude-alt-profile" claude --resume sess-alt-visible/);
  });
});

test("cross-config fallback recovers a live lease from a corrupt alternate-profile state file", async () => {
  await withTempPluginData(async (pluginData) => {
    const sleeper = spawnSync("bash", ["-lc", "sleep 30 >/dev/null 2>&1 & echo $!"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    });
    const pid = Number(String(sleeper.stdout).trim());
    assert.ok(Number.isFinite(pid) && pid > 0);

    const stateDirResult = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>console.log(m.resolveStateDir(process.cwd())))'], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });
    const stateDir = String(stateDirResult.stdout).trim();
    const leasesDir = path.join(stateDir, "leases");
    mkdirSync(leasesDir, { recursive: true });
    writeFileSync(path.join(stateDir, "state.json"), "{broken-json\n", "utf8");
    writeFileSync(
      path.join(leasesDir, "lease-alt-corrupt.json"),
      `${JSON.stringify({
        lease_id: "lease-alt-corrupt",
        session_id: "sess-alt-corrupt",
        phase: "running",
        config_dir: "/tmp/claude-alt-profile",
        supervisor: captureProcessRef(pid),
        child: null
      })}\n`,
      "utf8"
    );

    const status = spawnSync("node", ["scripts/neverstop-status.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      encoding: "utf8"
    });

    process.kill(pid, "SIGTERM");
    assert.equal(status.status, 0);
    assert.match(status.stdout, /Neverstop status: active/);
    assert.match(status.stdout, /Lease ID\s+lease-alt-corrupt/);
  });
});

test("workspace root resolves to repo root from nested directories", () => {
  const nested = path.join(REPO_ROOT, "scripts", "lib");
  assert.equal(resolveWorkspaceRoot(nested), REPO_ROOT);
});

test("state dir differs across config dirs for the same workspace", () => {
  const defaultResult = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>console.log(m.resolveStateDir(process.cwd())))'], {
    cwd: REPO_ROOT,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: "/tmp/neverstop-state-a" },
    encoding: "utf8"
  });
  const altResult = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>console.log(m.resolveStateDir(process.cwd())))'], {
    cwd: REPO_ROOT,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: "/tmp/neverstop-state-a", CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
    encoding: "utf8"
  });

  assert.equal(defaultResult.status, 0);
  assert.equal(altResult.status, 0);
  assert.notEqual(String(defaultResult.stdout).trim(), String(altResult.stdout).trim());
});

test("stop failure does not replace an active lease when only the child is still alive", async () => {
  await withTempPluginData(async (pluginData) => {
    const sleeper = spawnSync("bash", ["-lc", "sleep 30 >/dev/null 2>&1 & echo $!"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    });
    const pid = Number(String(sleeper.stdout).trim());
    assert.ok(Number.isFinite(pid) && pid > 0);

    const stateDirResult = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>console.log(m.resolveStateDir(process.cwd())))'], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });
    const stateDir = String(stateDirResult.stdout).trim();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        schema_version: 1,
        workspace_root: REPO_ROOT,
        active_lease: {
          lease_id: "lease-child-alive",
          owner_plugin: "neverstop",
          session_id: "sess-same",
          mode: "respawn",
          phase: "running",
          exclusive: true,
          attempt: 1,
          started_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:01:00.000Z",
          retry_deadline_at: "2026-04-17T05:00:00.000Z",
          next_attempt_at: null,
          last_error_type: "rate_limit",
          supervisor: { pid: 99999999, start_marker: "missing", cmdline: "missing" },
          child: captureProcessRef(pid)
        },
        history: []
      })}\n`,
      "utf8"
    );

    const hook = spawnSync("node", ["scripts/hook-stop-failure.mjs"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginData,
        CLAUDE_PLUGIN_ROOT: REPO_ROOT,
        CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile"
      },
      input: JSON.stringify({ cwd: REPO_ROOT, session_id: "sess-same", error: "rate_limit" }),
      encoding: "utf8"
    });
    const stateAfter = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>{const s=m.loadState(process.cwd()); console.log(JSON.stringify({leaseId:s.active_lease?.lease_id || null, childPid:s.active_lease?.child?.pid || null}));})'], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });

    process.kill(pid, "SIGTERM");
    assert.equal(hook.status, 0);
    assert.match(stateAfter.stdout, /"leaseId":"lease-child-alive"/);
    assert.match(stateAfter.stdout, new RegExp(`"childPid":${pid}`));
  });
});

test("stop failure records config dir metadata and supervisor inherits full parent env", async () => {
  await withTempPluginData(async (pluginData) => {
    const capturePath = path.join(pluginData, "supervisor-env.json");
    const hook = spawnSync("node", ["scripts/hook-stop-failure.mjs"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: REPO_ROOT,
        CLAUDE_PLUGIN_DATA: pluginData,
        CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile",
        CLAUDE_CODE_ENTRYPOINT: "interactive",
        ANTHROPIC_API_KEY: "test-key",
        NEVERSTOP_TEST_CAPTURE_ENV: "1",
        NEVERSTOP_TEST_CAPTURE_ENV_PATH: capturePath
      },
      input: JSON.stringify({
        cwd: REPO_ROOT,
        session_id: "sess-env",
        error: "rate_limit"
      }),
      encoding: "utf8"
    });
    assert.equal(hook.status, 0);

    const stateResult = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>{const s=m.loadState(process.cwd()); console.log(JSON.stringify({configDir:s.active_lease?.config_dir || null, envSummary:s.active_lease?.env_summary || null}));})'], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });
    assert.equal(stateResult.status, 0);
    assert.match(stateResult.stdout, /"configDir":"\/tmp\/claude-alt-profile"/);
    assert.match(stateResult.stdout, /"CLAUDE_CONFIG_DIR"/);

    let capturedEnv = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        capturedEnv = JSON.parse(readFileSync(capturePath, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    assert.ok(capturedEnv);
    assert.equal(capturedEnv.CLAUDE_CONFIG_DIR, "/tmp/claude-alt-profile");
    assert.equal(capturedEnv.CLAUDE_CODE_ENTRYPOINT, "interactive");
    assert.equal(capturedEnv.ANTHROPIC_API_KEY, "test-key");

    const takeover = spawnSync("node", ["scripts/neverstop-takeover.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });
    assert.equal(takeover.status, 0);
  });
});

test("child stop failure repairs a missing supervisor for retryable errors", async () => {
  await withTempPluginData(async (pluginData) => {
    const capturePath = path.join(pluginData, "repair-supervisor-env.json");
    const stateDirResult = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>console.log(m.resolveStateDir(process.cwd())))'], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });
    const stateDir = String(stateDirResult.stdout).trim();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        schema_version: 2,
        workspace_root: REPO_ROOT,
        active_lease: {
          lease_id: "lease-repair",
          owner_plugin: "neverstop",
          session_id: "sess-repair",
          mode: "respawn",
          phase: "running",
          exclusive: true,
          attempt: 2,
          started_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:01:00.000Z",
          retry_deadline_at: "2026-04-17T06:00:00.000Z",
          next_attempt_at: null,
          last_error_type: "rate_limit",
          config_dir: "/tmp/claude-alt-profile",
          env_summary: {
            config_dir: "/tmp/claude-alt-profile",
            inherited_keys: ["CLAUDE_CONFIG_DIR"],
            used_default_config_dir: false
          },
          supervisor: { pid: 99999999, start_marker: "missing", cmdline: "missing" },
          child: null
        },
        history: []
      })}\n`,
      "utf8"
    );

    const hook = spawnSync("node", ["scripts/hook-stop-failure.mjs"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: REPO_ROOT,
        CLAUDE_PLUGIN_DATA: pluginData,
        CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile",
        NEVERSTOP_SUPERVISOR_CHILD: "1",
        NEVERSTOP_ACTIVE_LEASE_ID: "lease-repair",
        NEVERSTOP_TEST_CAPTURE_ENV: "1",
        NEVERSTOP_TEST_CAPTURE_ENV_PATH: capturePath
      },
      input: JSON.stringify({
        cwd: REPO_ROOT,
        session_id: "sess-repair",
        error: "rate_limit"
      }),
      encoding: "utf8"
    });
    assert.equal(hook.status, 0);

    const stateAfter = spawnSync("node", ["-e", 'import("./scripts/lib/state.mjs").then(m=>{const s=m.loadState(process.cwd()); console.log(JSON.stringify({phase:s.active_lease?.phase || null,nextAttemptAt:s.active_lease?.next_attempt_at || null,supervisorPid:s.active_lease?.supervisor?.pid || null,lastError:s.active_lease?.last_error_type || null}));})'], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });

    assert.equal(stateAfter.status, 0);
    assert.match(stateAfter.stdout, /"phase":"(retry_waiting|starting)"/);
    assert.match(stateAfter.stdout, /"lastError":"rate_limit"/);
    assert.doesNotMatch(stateAfter.stdout, /"supervisorPid":99999999/);

    let capturedEnv = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        capturedEnv = JSON.parse(readFileSync(capturePath, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(capturedEnv);
    assert.equal(capturedEnv.CLAUDE_CONFIG_DIR, "/tmp/claude-alt-profile");

    const takeover = spawnSync("node", ["scripts/neverstop-takeover.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_CONFIG_DIR: "/tmp/claude-alt-profile" },
      encoding: "utf8"
    });
    assert.equal(takeover.status, 0);
  });
});
