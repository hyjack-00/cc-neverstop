# Claude Code 插件方案说明

## 总目标

做两个相互配合的 Claude Code 插件：

1. **后台重试插件**
   在某些特定的网络 / 限流 / API 失败场景下，自动启动一个后台 `-p` 重试进程。

2. **前后台互斥插件**
   只要后台 `-p` 重试进程还在运行，就阻止前台交互式 Claude Code 继续接收普通输入，强制用户先接管后台，再继续前台工作。

这样可以同时满足两点：

* 后台重试走 `claude -p`，因此不会污染 session picker。官方文档明确说明 `claude -p` 创建的 sessions 不会出现在 picker，但仍可通过 `session_id` 或名字恢复。([Claude][1])
* 前台和后台不会同时操作同一个 session。官方文档说明多个终端同时写同一个 session 时，消息会交错，而且运行中每个终端只看到自己的消息。([Claude][1])

---

## 插件一：后台重试插件

### 目标

当 Claude Code 因为特定类型的 API 失败结束时，自动在后台继续执行。

### 使用的 hook

使用 `StopFailure` hook。

官方文档说明 `StopFailure` 会在 turn 因 API error 结束时触发，并提供：

* `session_id`
* `error`
* `error_details`
* `last_assistant_message`

并且 `error` 的可选值包括：

* `rate_limit`
* `authentication_failed`
* `billing_error`
* `invalid_request`
* `server_error`
* `max_output_tokens`
* `unknown`

同时，`StopFailure` **没有 decision control**，只能用于通知、记录或外部编排。([Claude][2])

### 第一版建议处理的错误类型

只对以下类型自动后台重试：

* `rate_limit`
* `server_error`
* `unknown`

其余类型默认不自动重试，只记录状态。

### 行为

当命中上述失败类型时：

1. 读取当前失败的 `session_id`
2. 检查当前是否已有后台 worker 正在运行
3. 如果没有，则启动一个后台进程：

```bash
claude --resume <session_id> -p "continue task"
```

4. 记录后台 worker 的状态

### 需要维护的状态

建议维护一个简单状态文件，例如：

```json
{
  "session_id": "...",
  "worker_pid": 12345,
  "status": "running"
}
```

同时要有全局锁，保证**同一时刻只有一个后台 worker**。

---

## 插件二：前后台互斥插件

### 目标

只要后台 worker 还活着，就不允许前台交互式 Claude Code 正常输入，防止前后台同时操作同一个 session。

### 使用的 hook

#### 1. `UserPromptSubmit`

官方文档说明：

* `UserPromptSubmit` 会在用户提交 prompt 时触发
* 这个 hook 可以决定是否让这个 prompt 被继续处理
* 还可以向上下文加入额外信息。([Claude][2])

### 行为

当用户在前台输入时：

1. 检查是否存在活跃后台 worker
2. 如果存在，则直接 block 当前 prompt
3. 返回固定提示，例如：

```text
后台任务仍在运行。请先执行 /worker:takeover
```

也就是说，这个插件负责实现：

* 前台和后台严格互斥
* 只要后台没停，前台就不能继续普通对话

#### 2. `SessionStart`

官方文档说明 `SessionStart` 可以向 Claude 注入 `additionalContext`。([Claude][2])

### 行为

当前台 session 启动或 resume 时：

* 如果后台 worker 还在运行，就提示：

```text
当前有后台任务在运行。请使用 /worker:status 或 /worker:takeover。
```

这样用户一进入前台就知道当前状态。

---

## 需要提供的命令

### `/worker:status`

显示：

* 当前是否有后台 worker
* 对应的 `session_id`
* 对应的 `worker_pid`

### `/worker:takeover`

行为：

1. 如果后台 worker 存在：

   * 终止它
   * 更新状态文件为 stopped
2. 输出一条明确提示：

```text
请执行：claude --resume <session_id>
```

---

## 关于“刷新前台 Claude Code 界面”这件事

这里要区分三件事：

### 1. 刷新当前前台界面

我没有查到官方 hook / plugin API 可以直接“刷新当前交互界面”或让当前前台 session 自动感知后台 `-p` 的新输出。官方文档只说明：

* `SessionStart` 可以加上下文
* `UserPromptSubmit` 可以 block
* `StopFailure` 只能记录/通知
  并没有提供“刷新当前前台视图”的机制。([Claude][2])

### 2. 直接让前台退出

官方命令文档里有：

* `/exit`
* `/quit`

它们可以退出 CLI。([Claude][3])

但是我没有看到官方插件/hook API 可以**强制替用户执行 `/exit`**。
因此，第一版设计里不要依赖“插件自动把前台退出”。

### 3. 建议的交互方式

第一版建议这样处理：

* 插件只负责：

  * 阻止前台继续输入
  * 明确提示用户“先 takeover”
* 用户执行 `/worker:takeover`
* 插件停掉后台 worker 后，输出：

  * 请先 `/exit`
  * 然后重新运行：

    ```bash
    claude --resume <session_id>
    ```

也就是说：

**第一版不做自动刷新，不做自动退出，只做强提示 + 强互斥。**

---

## 不要做的事情

第一版不要尝试：

1. 修改 session picker 的显示规则
2. 隐藏旧 session
3. 删除本地 session
4. 直接 attach 到正在运行的 `-p` 进程
5. 让多个 worker 并发运行
6. 修改 Claude Code 的本地 session 存储文件

---

## 最小实现顺序

### 插件一：后台重试插件

1. 建状态文件和锁
2. 实现 `StopFailure`
3. 在指定错误类型下启动唯一后台 worker

### 插件二：前后台互斥插件

1. 实现 `UserPromptSubmit`，在后台 worker 存活时 block
2. 实现 `SessionStart` 提示
3. 实现 `/worker:status`
4. 实现 `/worker:takeover`

---

## 插件安装（一句话）

本地测试时可直接用：

```bash
claude --plugin-dir /path/to/plugin
```

官方 CLI 参考里提供了 `--plugin-dir` 作为按目录加载插件的方式。([Claude][4])

---

## 一句话任务描述

实现两个 Claude Code 插件：

* **插件一：后台重试插件**
  监听 `StopFailure`，在 `rate_limit`、`server_error`、`unknown` 等失败类型下，为当前 `session_id` 启动唯一后台 `claude --resume <session_id> -p "continue task"` worker。

* **插件二：前后台互斥插件**
  监听 `UserPromptSubmit` 和 `SessionStart`。当后台 worker 存活时，阻止前台继续普通输入，并通过 `/worker:status` 与 `/worker:takeover` 两个命令让用户查看状态、停止后台、再手动 `/exit` + `claude --resume <session_id>` 回到前台。

