import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: process.platform === "win32" && !command.includes("/"),
    windowsHide: true,
    stdio: options.stdio ?? "pipe"
  });
}

export function getProcessStartMarker(pid) {
  if (!Number.isFinite(pid)) {
    return null;
  }

  const procStat = `/proc/${pid}/stat`;
  if (fs.existsSync(procStat)) {
    try {
      const text = fs.readFileSync(procStat, "utf8");
      const parts = text.split(" ");
      return `proc:${parts[21] ?? ""}`;
    } catch {
      // Fall through to ps.
    }
  }

  const result = runCommand("ps", ["-p", String(pid), "-o", "lstart="]);
  if (result.status === 0) {
    const marker = String(result.stdout || "").trim();
    return marker ? `ps:${marker}` : null;
  }

  return null;
}

export function getProcessCommandLine(pid) {
  if (!Number.isFinite(pid)) {
    return null;
  }

  const cmdlinePath = `/proc/${pid}/cmdline`;
  if (fs.existsSync(cmdlinePath)) {
    try {
      const raw = fs.readFileSync(cmdlinePath);
      const text = raw.toString("utf8").replace(/\u0000+/g, " ").trim();
      return text || null;
    } catch {
      // Fall through to ps.
    }
  }

  const result = runCommand("ps", ["-p", String(pid), "-o", "command="]);
  if (result.status === 0) {
    const commandLine = String(result.stdout || "").trim();
    return commandLine || null;
  }

  return null;
}

export function getProcessState(pid) {
  if (!Number.isFinite(pid)) {
    return null;
  }

  const procStat = `/proc/${pid}/stat`;
  if (fs.existsSync(procStat)) {
    try {
      const text = fs.readFileSync(procStat, "utf8");
      const parts = text.split(" ");
      return parts[2] ?? null;
    } catch {
      // Fall through to ps.
    }
  }

  const result = runCommand("ps", ["-p", String(pid), "-o", "stat="]);
  if (result.status === 0) {
    const stat = String(result.stdout || "").trim();
    return stat ? stat[0] : null;
  }

  return null;
}

export function captureProcessRef(pid) {
  if (!Number.isFinite(pid)) {
    return null;
  }
  return {
    pid,
    start_marker: getProcessStartMarker(pid),
    cmdline: getProcessCommandLine(pid)
  };
}

export function isSameProcess(record) {
  if (!record || !Number.isFinite(record.pid)) {
    return false;
  }
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    return false;
  }

  const state = getProcessState(record.pid);
  if (state === "Z") {
    return false;
  }

  const currentStartMarker = getProcessStartMarker(record.pid);
  const currentCmdline = getProcessCommandLine(record.pid);

  if (!record.start_marker && !record.cmdline) {
    return false;
  }
  if (record.start_marker && currentStartMarker !== record.start_marker) {
    return false;
  }
  if (record.cmdline && currentCmdline !== record.cmdline) {
    return false;
  }
  return true;
}

export function leaseHasLiveProcesses(lease) {
  if (!lease) {
    return false;
  }
  return isSameProcess(lease.supervisor) || isSameProcess(lease.child);
}

export function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: options.stdio ?? "ignore",
    windowsHide: true
  });
  child.unref();
  return child.pid;
}

export function terminateProcessTree(pid, signal = "SIGTERM") {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false };
  }

  if (process.platform === "win32") {
    const result = runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
    if (result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill" };
    }
    return { attempted: true, delivered: false, method: "taskkill" };
  }

  try {
    process.kill(-pid, signal);
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    try {
      process.kill(pid, signal);
      return { attempted: true, delivered: true, method: error.code === "ESRCH" ? "process" : "process-fallback" };
    } catch (innerError) {
      if (innerError.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}
