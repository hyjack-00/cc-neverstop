# Validation Guide

## Static validation

```bash
claude plugins validate /workspace/skills/cc-neverstop
```

```bash
node --test tests/neverstop.test.mjs
```

## What the automated tests cover

- retry delay progression and 6 hour retry window
- `CLAUDE_CONFIG_DIR` extraction and env summary
- relative `CLAUDE_CONFIG_DIR` resolution against the workspace root
- corrupt state recovery from live lease snapshots
- prompt blocking vs `/neverstop:*` allow-through
- takeover stopping the recorded background process
- status/takeover/prompt-hook fallback discovery of an alternate-profile lease without `CLAUDE_CONFIG_DIR` in the caller env
- workspace-root discovery from nested directories
- refusing to replace a lease when only the child is still alive
- supervisor inheritance of the full parent environment

## Simulated rate-limit path

The tests and hook fixtures cover the deterministic `StopFailure(error=rate_limit)` path without spending real Claude quota.

## Real rate-limit validation

The live burn test is intentionally restricted to the default `~/.claude` profile.

Expected operator rules:

- do not set a non-default `CLAUDE_CONFIG_DIR`
- run from the intended workspace
- load the plugin from repo root

Example:

```bash
unset CLAUDE_CONFIG_DIR
claude --plugin-dir /workspace/skills/cc-neverstop
```

Then use a deliberately large task in `/workspace/powerpoint` and monitor:

- terminal output
- `leases/*.log`
- `/neverstop:status`

Success criteria:

- a real `rate_limit` triggers `StopFailure` and the lease enters retry behavior, or
- if quota is not exhausted, the repo still retains deterministic proof plus operator instructions.

## Latest live attempt

- Date: 2026-04-17 Asia/Shanghai
- Workspace: `/workspace/powerpoint`
- Profile: default `~/.claude` only
- Observed result: session utilization advanced to 92% and entered `allowed_warning`, but no real `StopFailure(rate_limit)` was observed during the run
- Conclusion: deterministic hook-path tests pass; live quota burn evidence exists, but the real retry path was not triggered in this session
