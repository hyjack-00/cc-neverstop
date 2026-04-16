#!/bin/bash
set -euo pipefail

node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-stop-failure.mjs"
