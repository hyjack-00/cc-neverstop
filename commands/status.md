---
description: Show the current Neverstop background lease for this workspace
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/neverstop-status.mjs" $ARGUMENTS`

Present the command output exactly as-is.
