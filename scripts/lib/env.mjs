import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_SUMMARY_PREFIXES = ["CLAUDE_"];

export function inheritParentEnv(parentEnv = process.env, extras = {}) {
  return {
    ...parentEnv,
    ...extras
  };
}

function resolveHomeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function resolveConfigDir(env = process.env, baseDir = process.cwd()) {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured) {
    return path.resolve(baseDir, configured);
  }
  return path.join(resolveHomeDir(env), ".claude");
}

export function summarizeClaudeEnv(env = process.env, baseDir = process.cwd()) {
  const keys = Object.keys(env)
    .filter((key) => ENV_SUMMARY_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .sort();

  return {
    config_dir: resolveConfigDir(env, baseDir),
    inherited_keys: keys,
    used_default_config_dir: !env.CLAUDE_CONFIG_DIR
  };
}

export function maybeWriteEnvCapture(env, filePath) {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(env, null, 2)}\n`, "utf8");
}
