# Neverstop Progress

## Current Phase

Completed implementation, review hardening, repository cleanup, and default-profile live validation capture.

## Last Updated

2026-04-17 Asia/Shanghai, final pass

## Active Decisions

- Runtime env policy: inherit the full parent environment at runtime; do not persist secrets to disk
- Profile routing: real quota burn tests only on the default `~/.claude` profile
- Retry window: 6 hours
- Commands: `/neverstop:status`, `/neverstop:takeover`
- Packaging: single plugin, repo root remains the plugin root
- Cross-profile visibility: commands and hooks fall back to same-workspace state buckets if `CLAUDE_CONFIG_DIR` is missing later

## Checklist

- [x] Implementer: Capture and reuse full parent env for supervisor and child launches.
- [x] Evaluator: Review env inheritance for correctness and secret-handling boundaries.
- [x] Adversarial: Review env inheritance for routing mistakes, split-brain, and stale-session risks.

- [x] Implementer: Increase retry window from 5 hours to 6 hours in code and tests.
- [x] Evaluator: Confirm retry policy is consistent across code, tests, and docs.
- [x] Adversarial: Re-check timeout/terminal-state behavior with the new window.

- [x] Implementer: Add deterministic tests for config-dir extraction, env propagation, and workspace routing.
- [x] Evaluator: Review test coverage quality and blind spots.
- [x] Adversarial: Look for uncovered concurrency and live-rate-limit paths.

- [x] Implementer: Restructure README/docs/design so the repo reads like a coherent public plugin project.
- [x] Evaluator: Review docs for clarity, installability, and architecture accuracy.
- [x] Adversarial: Review docs for misleading guarantees or missing operational warnings.

- [x] Implementer: Attempt a real default-profile rate-limit run against `/workspace/powerpoint`, capture evidence, and document the outcome.
- [x] Evaluator: Review the validation evidence and whether it proves the retry path.
- [x] Adversarial: Review the live-test method for hidden assumptions and false positives.

## Review Notes

- Fixed evaluator finding: lock heartbeat now updates `owner.json` atomically, and stale detection keys on `owner.json` mtime instead of the lock directory mtime.
- Fixed evaluator finding: relative `CLAUDE_CONFIG_DIR` values now resolve against the workspace root before state hashing.
- Fixed adversarial finding: commands/hooks now search same-workspace state buckets so alt-profile leases remain visible even if later invocations do not carry `CLAUDE_CONFIG_DIR`.
- Fixed adversarial finding: `/neverstop:takeover` now prints the recorded config namespace in the manual resume command.
- Fixed adversarial finding: `error_details` is no longer persisted to lease state, and status output no longer prints inherited env key names.
- Fixed final review finding: cross-config fallback now recovers live lease snapshots from the corrupt bucket being scanned, not from the caller's current/default bucket.

## Open Risks

- A real `StopFailure(rate_limit)` was still not observed during the default-profile burn attempt; live evidence reached `allowed_warning` at 92% utilization but stopped short of an actual retry event.
- Cross-config fallback currently assumes at most one active lease for the same workspace across all Claude profiles; simultaneous multi-profile use on one workspace would need a stronger disambiguation model.
