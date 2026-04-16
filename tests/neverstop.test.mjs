import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { computeRetryDelayMs } from "../scripts/lib/policy.mjs";
import { captureProcessRef } from "../scripts/lib/process.mjs";

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
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
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
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      input: JSON.stringify({ cwd: REPO_ROOT, prompt: "hello" }),
      encoding: "utf8"
    });
    const allowed = spawnSync("node", ["scripts/hook-user-prompt-submit.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
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
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
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
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      encoding: "utf8"
    });
    const status = spawnSync("node", ["scripts/neverstop-status.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
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
