---
description: Stop the active Neverstop background lease and tell the user how to resume manually
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/neverstop-takeover.mjs" $ARGUMENTS`

Present the command output exactly as-is.
