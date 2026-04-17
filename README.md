# Neverstop

`neverstop` is a Claude Code plugin that:

- automatically resumes selected failed Claude sessions in the background
- blocks foreground prompts while background recovery still owns the workspace
- preserves the original Claude runtime environment when resuming, including `CLAUDE_CONFIG_DIR`
- can still find the active lease if later hooks or commands are invoked without that same `CLAUDE_CONFIG_DIR`

## What It Does

When Claude Code hits a retryable `StopFailure`:

- `rate_limit`
- `server_error`
- `unknown`

`neverstop` starts a background supervisor that runs:

```bash
claude --resume <session_id> -p "continue task"
```

The resumed background run inherits the full parent environment from the Claude process that triggered the failure.

That matters because Claude Code session recovery depends on both:

- the original workspace
- the original config namespace, especially `CLAUDE_CONFIG_DIR`

## Install

Run Claude with the plugin directory:

```bash
claude --plugin-dir /workspace/skills/cc-neverstop
```

If you want a shell alias:

```bash
alias claude-neverstop='claude --plugin-dir /workspace/skills/cc-neverstop'
```

## Commands

- `/neverstop:status` shows the current lease, config dir, retry phase, and log path
- `/neverstop:takeover` stops the background lease and tells you how to resume manually

## Retry Behavior

- retryable errors: `rate_limit`, `server_error`, `unknown`
- first retry: immediate
- later retries: exponential backoff up to a 30 minute cap
- total retry window: 6 hours

If the lease is in `retry_waiting`, foreground prompts are still blocked because the background path still owns the workspace.

## Environment Inheritance

`neverstop` does not rely on `session_id` alone.

At runtime, it resumes with the original Claude execution context:

- `workspace_root`
- `session_id`
- the full parent environment from the original Claude process

It persists only non-secret routing metadata such as:

- resolved config dir
- a summary of Claude-related env keys that were present

This keeps background resume aligned with the same session history/config namespace without writing secrets into plugin state.

## Development

Validate the plugin:

```bash
claude plugins validate /workspace/skills/cc-neverstop
```

Run tests:

```bash
node --test tests/neverstop.test.mjs
```

## Documentation

- [Design](./DESIGN.md)
- [Architecture](./docs/architecture.md)
- [Validation](./docs/validation.md)
- [Troubleshooting](./docs/troubleshooting.md)
