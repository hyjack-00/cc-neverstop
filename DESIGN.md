# Neverstop 设计说明

## 总目标

`neverstop` 是一个单插件、双模块的 Claude Code 插件：

- `respawn`：在特定 `StopFailure` 场景下自动在后台继续工作
- `exclusive`：只要后台 lease 仍然占用 workspace，就阻止前台继续普通对话

之所以不再做两个独立安装插件，是因为二者已经共享同一套：

- workspace-scoped state
- 锁语义
- lease 生命周期
- 命令命名空间

拆成两个 installable plugin 会引入跨插件兼容和状态协商，复杂度高于收益。

## 交互模型

### 后台 lease

插件不把“后台 Claude 进程”和“后台重试等待”当成两个不同对象，而是统一为一个 `active_lease`。

只要 lease 处于以下 phase 之一，前台都视为被占用：

- `starting`
- `running`
- `retry_waiting`
- `takeover_requested`
- `stopping`

这意味着：

- 正在真正运行 `claude -p` 时前台被占用
- 正在指数退避睡眠、等待下一次重试时前台同样被占用

### 用户命令

插件只公开两个命令：

- `/neverstop:status`
- `/neverstop:takeover`

这两个命令必须始终绕过互斥 block，否则会产生自锁。

## Hook 约束

### `StopFailure`

- 用于触发后台恢复编排
- 只对以下错误类型自动恢复：
  - `rate_limit`
  - `server_error`
  - `unknown`
- 该 hook 不做复杂循环，只在锁内确保存在唯一 supervisor

### `UserPromptSubmit`

- 用于前后台互斥
- 当存在活跃 lease 时：
  - 普通 prompt 返回 `decision: "block"`
  - `reason` 明确告诉用户去看 `/neverstop:status` 或执行 `/neverstop:takeover`
- `/neverstop:*` 前缀必须直接放行

### `SessionStart`

- 用于注入状态提示
- 返回：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "..."
  }
}
```

- 第一版只做提示，不做自动刷新，不做自动退出

## 目录结构

```text
cc-neverstop/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/stop-failure.sh
  hooks/user-prompt-submit.sh
  hooks/session-start.sh
  commands/status.md
  commands/takeover.md
  scripts/hook-stop-failure.mjs
  scripts/hook-user-prompt-submit.mjs
  scripts/hook-session-start.mjs
  scripts/neverstop-status.mjs
  scripts/neverstop-takeover.mjs
  scripts/neverstop-supervisor.mjs
  scripts/lib/state.mjs
  scripts/lib/lock.mjs
  scripts/lib/process.mjs
  scripts/lib/workspace.mjs
```

原则：

- `hooks/` 只做薄入口
- `commands/` 只做 slash-command 入口
- `scripts/` 承担所有状态机和进程控制
- `scripts/lib/` 放复用能力

## 状态设计

状态目录固定为：

```text
${CLAUDE_PLUGIN_DATA}/state/<workspace-slug>-<workspace-hash>/
  state.json
  lock/
  leases/<lease-id>.json
  leases/<lease-id>.log
```

`state.json` 结构：

```json
{
  "schema_version": 1,
  "workspace_root": "/abs/path",
  "active_lease": {
    "lease_id": "neverstop-...",
    "owner_plugin": "neverstop",
    "session_id": "...",
    "mode": "respawn",
    "phase": "retry_waiting",
    "exclusive": true,
    "attempt": 3,
    "started_at": "2026-04-17T00:00:00.000Z",
    "updated_at": "2026-04-17T00:05:00.000Z",
    "retry_deadline_at": "2026-04-17T05:00:00.000Z",
    "next_attempt_at": "2026-04-17T00:09:00.000Z",
    "last_error_type": "rate_limit",
    "supervisor": {
      "pid": 12345,
      "start_marker": "..."
    },
    "child": {
      "pid": 12378,
      "start_marker": "..."
    }
  },
  "history": []
}
```

关键点：

- `retrying` 不是另一种任务，而是 `phase = retry_waiting`
- exclusive 只读 lease，不猜具体后台进程在做什么
- 状态写入必须使用临时文件 + rename
- 锁按 workspace 作用域，而不是全局

## Supervisor 设计

`StopFailure` 不直接无限次重新拉起 `claude -p`。它只负责创建一个 detached Node supervisor。

supervisor 负责：

- 持有 lease
- 运行 `claude --resume <session_id> -p "continue task"`
- 更新 `running` / `retry_waiting` / `completed` / `failed`
- 按指数退避继续尝试
- 响应 `/neverstop:takeover`

为避免后台 child 自己再触发一轮新的 respawn：

- child 进程环境变量里显式带上 `NEVERSTOP_SUPERVISOR_CHILD=1`
- `StopFailure` hook 发现该变量时直接 no-op

## 重试策略

- 仅对 `rate_limit`、`server_error`、`unknown` 自动恢复
- 第一次立即尝试
- 后续间隔指数退避：
  - `1m`
  - `2m`
  - `4m`
  - `8m`
  - `16m`
  - 之后封顶 `30m`
- 总自动恢复窗口固定为首次失败后 `5h`
- 超过窗口后：
  - phase 变为 `failed`
  - 不再自动恢复
  - 用户仍可查看 `/neverstop:status`
  - 用户可执行 `/neverstop:takeover`

## `/neverstop:takeover`

行为：

1. 给当前 lease 标记 `takeover_requested`
2. 停掉 supervisor 及其 child 进程树
3. 将 lease 收敛到 `stopped`
4. 输出：

```text
Background lease stopped.
Resume with:
claude --resume <session_id>
```

## 明确不做的事情

第一版不做：

- 自动 attach 到后台进程
- 自动刷新当前 UI
- 自动执行 `/exit`
- 修改 session picker
- 修改 Claude Code 本地 session 存储
- 兼容或迁移旧的 `cc-limit-guard` 状态

## 验证

至少做这些验证：

- `claude plugin validate <repo-root>`
- `/neverstop:*` 命令可被调用且不会被互斥 hook 自己挡住
- 活跃 lease 存在时普通 prompt 被 block
- `retry_waiting` 状态也会 block 前台
- `takeover` 能打断 `running` 和 `retry_waiting`
- 仓库内不残留 `cc-limit-guard` / `rate-limit-guard` / `/worker:` 命名
