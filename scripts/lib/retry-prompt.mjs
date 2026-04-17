import fs from "node:fs";
import path from "node:path";

const RETRY_PROMPT_RELATIVE_PATH = path.join("prompts", "retry-prompt.txt");
const DEFAULT_RETRY_PROMPT = "continue task";

export function resolveRetryPromptPath(pluginRoot) {
  return path.join(pluginRoot, RETRY_PROMPT_RELATIVE_PATH);
}

export function loadRetryPrompt(pluginRoot) {
  const filePath = resolveRetryPromptPath(pluginRoot);
  try {
    const text = fs.readFileSync(filePath, "utf8").trim();
    return text || DEFAULT_RETRY_PROMPT;
  } catch {
    return DEFAULT_RETRY_PROMPT;
  }
}
