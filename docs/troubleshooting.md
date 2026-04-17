# Troubleshooting

## `/neverstop:status` shows the wrong workspace

`neverstop` resolves the workspace root by walking up to the nearest `.git`. If you run Claude from a nested directory inside the repo, it should still converge on the repo root.

## Background worker cannot find the session

Check `/neverstop:status` and confirm the `Config Dir` matches the profile that created the session.

If the session came from the default profile, `Config Dir` should resolve to `~/.claude`.

If you used a relative `CLAUDE_CONFIG_DIR`, `neverstop` resolves it relative to the workspace root before hashing state or printing the resume command.

## Foreground is blocked while nothing seems to be happening

If the lease is in `retry_waiting`, the background worker is sleeping until the next retry window. This still counts as exclusive ownership.

Use:

```text
/neverstop:status
```

If you want to stop the background path and resume manually:

```text
/neverstop:takeover
```

## Can I attach another terminal to the same session?

No.

If `neverstop` owns the session in the background, opening a second terminal and attaching to the same `session_id` violates the plugin's operating model.

Why this matters:

- the background worker may still be issuing prompts against that same session
- your manual terminal would create a second writer for the same Claude conversation
- lease state, retry state, and actual session ownership would diverge

The safe sequence is:

1. run `/neverstop:status`
2. run `/neverstop:takeover`
3. resume using the exact command printed by takeover

Do not resume first and hope the plugin state will catch up later.

## Alternate provider profiles

`neverstop` inherits the full parent environment at runtime. That allows it to keep using the same provider-specific routing variables that the original Claude process had.

If a later `status`, `takeover`, or prompt hook runs without the original `CLAUDE_CONFIG_DIR`, `neverstop` will still search same-workspace state buckets and surface the active lease it finds.

For real rate-limit validation, only the default `~/.claude` profile should be used.
