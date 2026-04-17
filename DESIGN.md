# Neverstop Design

## Overview

`neverstop` is a single Claude Code plugin with two internal responsibilities:

- `respawn`: background recovery after selected `StopFailure` errors
- `exclusive`: foreground mutual exclusion while the background lease is active

The plugin is intentionally a single installable unit because lease state, lock semantics, command namespace, and runtime routing are shared.

## Goals

- keep eligible Claude sessions alive after retryable failures
- avoid foreground/background split-brain on the same workspace
- keep background resume attached to the same config/session namespace as the original Claude process
- make takeover explicit and user-controlled

## Lease Model

All background ownership is represented as a single workspace-scoped `active_lease`.

Important fields:

- `lease_id`
- `session_id`
- `workspace_root`
- `config_dir`
- `env_summary`
- `phase`
- `attempt`
- `retry_deadline_at`
- `next_attempt_at`
- `last_error_type`
- `supervisor`
- `child`

The full parent environment is inherited at runtime, but it is not stored in lease files.

## Active Phases

Foreground prompts are blocked while the lease is in one of:

- `starting`
- `running`
- `retry_waiting`
- `takeover_requested`
- `stopping`

Terminal phases:

- `stopped`
- `failed`
- `completed`

## Hook Behavior

### `StopFailure`

- handles `rate_limit`, `server_error`, and `unknown`
- creates a detached supervisor only when neither the recorded supervisor nor the child is still alive
- stores routing/debug metadata including the resolved config dir
- passes the full parent environment to the supervisor

### `UserPromptSubmit`

- blocks normal prompts while an active lease exists
- always allows `/neverstop:*`

### `SessionStart`

- injects foreground context explaining the current active lease state

## Background Resume Routing

The effective resume key is:

- `workspace_root`
- `session_id`
- the inherited parent environment

`CLAUDE_CONFIG_DIR` is especially important because it relocates Claude settings, credentials, plugins, and session history. `neverstop` therefore:

- resolves the config dir for status/debugging
- resolves relative `CLAUDE_CONFIG_DIR` values against the workspace root
- shows it in `/neverstop:status`
- keeps the full runtime environment when spawning background work
- falls back to scanning same-workspace state buckets when later hooks or commands arrive without the original config env

## Retry Policy

- immediate first retry
- exponential backoff:
  - `1m`
  - `2m`
  - `4m`
  - `8m`
  - `16m`
  - then capped at `30m`
- total retry window: `6h`

When the window expires, the lease transitions to `failed`.

## Takeover

`/neverstop:takeover`:

1. marks the active lease as `takeover_requested`
2. terminates the recorded supervisor and child
3. archives the lease as `stopped`
4. tells the user to run:

```bash
CLAUDE_CONFIG_DIR=<recorded-config-dir> claude --resume <session_id>
```

All destructive operations key on `lease_id`, not `session_id`.

## Storage

State root:

```text
${CLAUDE_PLUGIN_DATA}/state/<workspace-slug>-<config-slug>-<workspace+config-hash>/
```

Contents:

- `state.json`
- `leases/<lease-id>.json`
- `leases/<lease-id>.log`
- `lock/`

Writes use atomic temp-file + rename semantics.

## Validation Strategy

1. deterministic automated tests
2. plugin manifest validation
3. simulated `rate_limit` hook-path verification
4. optional real rate-limit reproduction using the default `~/.claude` profile only

## Non-Goals

The plugin does not attempt to:

- auto-attach to a running background process
- auto-refresh the current Claude UI
- auto-run `/exit`
- mutate Claude’s local session store
- support legacy migration from unrelated old plugins
