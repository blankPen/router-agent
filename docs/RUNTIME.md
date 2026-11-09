# Worker 运行时

Worker 不在 Router 进程里跑。每张工单开工时，Router 按 `runtime.default` 选一个 **WorkerRuntime** 适配器，由它负责：创建隔离 workspace、拉起 Agent、投递工单、读取状态、接住追问。内核与 Router 只依赖 `WorkerRuntime` 端口，换运行时不需要改业务代码。

一份配置只有一个默认运行时，但**项目清单按运行时分开维护**：Orca 用仓库选择器（`name:` / `id:` / `path:`），Claude Code 与 ACP 用本地仓库绝对路径。切换运行时不会把 Orca 的选择器当成文件路径；旧工单也不会被新的默认运行时接管，而是继续用 Assignment 里记录的运行时。

## 内置运行时

| runtime id | 拉起方式 | workspace | 状态读取 | 追问 / 恢复 | 适用场景 |
|-|-|-|-|-|-|
| `orca`（默认） | Orca 创建 worktree + Claude Code 终端 | `orca worktree create --repo … --base-branch …` | Orca `AgentStatus`（`connected` / `orphaned` / `lastOutputAt`） | 终端常驻，追问直接投递；巡检优先读 Claude 会话记录 | 本机已用 Orca 管仓库，想同时看到终端 |
| `claude-code` | `git worktree` + `claude --bg` 后台会话 | 本地 git 仓库绝对路径 | `claude agents --json --all` | 会话结束后用 `claude --bg --resume <sessionId>` 追问；进程退出不自动 resume | 不用 Orca，直接跑 Claude Code |
| `acp` / `acp-*` | ACP 子进程：`initialize` → `session/new` → `session/prompt` | `git worktree`（本地绝对路径） | ACP `session/update` | Agent 声明 `loadSession` 时用 `session/load` 恢复 | 想接 Codex / Gemini / OpenCode 等 |

`acp` 是自定义命令入口；`acp-*` 是内置 ACP Agent，共用同一套 `AcpRuntime`。

## 在 Web 面板里选（推荐）

「初始化 → 2. 选择运行时」与「配置 → 派工与服务 → Worker 运行时」是同一组卡片：

- 自动检测 CLI 是否安装、版本、来源（PATH / ra 托管）、ACP 扩展依赖与登录状态；
- **安装 CLI** 跳转该 Agent 的官方安装页；**安装 ACP 扩展** 由 ra 把 npm 适配包装到 `~/.router-agent/runtimes/<agent>`；
- **检测 / 试启动** 做一次真实 ACP 握手（`initialize` + `session/new`），避免只看版本号；
- 点卡片即切换 `runtime.default`，只影响新工单；已开工的工单保留原运行时。

![Web 初始化页的运行时卡片：内置运行时与 ACP Agent 的可用性检测](assets/readme/setup-runtime-dark.png)

## 用 CLI 选

```bash
ra config set runtime.default claude-code
ra runtime list                    # 本机 ACP Agent 状态、版本、来源
ra runtime install acp-claude      # 装到 ~/.router-agent/runtimes/claude
ra runtime check acp-claude        # 完整 initialize + session/new 握手
ra runtime login acp-codex         # 交互式登录
ra runtime uninstall acp-codex     # 卸载 ra 托管的适配器
```

## 运行时配置

```yaml
runtime:
  default: acp-codex        # orca | claude-code | acp | acp-*
  # 运行时专属的非安全参数
  options:
    claude-code:
      model: claude-sonnet-5-5
    acp:                    # 自定义 ACP 命令
      command: opencode
      args: [acp]
      env: {}
  # 非 orca 运行时使用独立项目清单，和顶层 projects 互不影响
  projects:
    claude-code:
      - name: router-agent
        repo: /Users/me/router-agent   # 本地仓库绝对路径
        defaultBranch: main
    acp-codex:
      - name: router-agent
        repo: /Users/me/router-agent
        defaultBranch: main
```

`allowedTools` / `permissionMode` / `sandbox` / `shellAllow` / `allowNetwork` / `fileAccess` 这些安全字段不允许写在 `runtime.options` 里，写了会直接启动失败。Worker 权限统一由 `worker.tools` 与 adapter 内置基线决定。

## ACP Agent 目录

任何实现了 [Agent Client Protocol](https://agentclientprotocol.com) 的 Agent，都可以用同一套 `AcpRuntime` 接入。ra 启动后自动探测本机可用的 ACP Agent，未安装 / 版本不兼容 / 未登录的项会在面板里置灰并给出原因。

| runtime id | Agent | 启动方式 | 可在线安装 | 断线恢复 | 说明 |
|-|-|-|-|-|-|
| `acp-claude` | Claude Code | `claude-agent-acp` | ✅ | ✅ `session/load` | 需先登录 Claude Code |
| `acp-codex` | Codex | `codex-acp` | ✅ | ❌ | 需本机 `codex` CLI；先 `codex-acp login`；默认带 `--message-streaming` |
| `acp-opencode` | OpenCode | `opencode acp` | ❌ | ✅ | 本机安装后自动识别，建议先 `ra runtime check` |
| `acp-gemini` | Gemini CLI | `gemini --acp` | ❌ | — | 实验性 ACP 模式 |
| `acp-copilot` | GitHub Copilot CLI | `copilot --acp --stdio` | ❌ | — | |
| `acp-cursor` | Cursor CLI | `cursor-agent acp` | ❌ | — | 旧版本可能没有 `acp` 子命令 |
| `acp-goose` | Goose | `goose acp` | ❌ | — | |

`AcpRuntime` 负责：spawn Agent 子进程 → `initialize` → `session/new` → `session/prompt`；从 `session/update` 读取助手文本与工具调用；把 Agent 的 `session/request_permission` 按 `worker.tools` 策略自动放行或拒绝；进程退出后，若 Agent 声明 `loadSession`，追问时会用 `session/load` 恢复会话。

当前不做客户端侧的 `fs/*` 与 `terminal/*` 代理：`initialize` 里声明不支持，Agent 需使用自己的文件 / 命令工具。Agent 必须预先完成登录（ACP 的 `auth_required` 会以启动失败上报）。

## Worker 工具策略

`worker.tools` 是派给 worker 的工具基线（默认读写 + 白名单 shell）：

| 字段 | 取值 | 说明 |
|-|-|-|
| `fileAccess` | `read-only` / `read-write` | 只读时只给 `Read` / `Glob` / `Grep`，读写再加 `Write` / `Edit` |
| `shell` | `deny` / `allowlist` / `allow` | `allowlist` 时按 `shellAllow` 的命令前缀放行（如 `git` 放行 `git ...`） |
| `shellAllow` | 命令前缀数组 | 仅在 `shell: allowlist` 时生效 |
| `allowNetwork` | `true` / `false` | 预留字段：当前只解析，未用于收窄网络 |

`worker.tools` 对 `claude-code` 生效（映射成 Claude 的 `allowedTools`）；`acp-*` 运行时的 `session/request_permission` 也按同一策略自动放行或拒绝；`orca` 运行时里 worker 的权限由 Orca 启动的 Claude Code 自身决定。安全字段只能由这里和 adapter 内置基线决定，`runtime.options` 写了同名键会直接启动失败。

## Worker 规范注入

`workerSpec.mode` 有两种：

- `prompt`：把 Worker 手册拼进启动 prompt（默认，已验证可行）。
- `agent`：只发工单，由全局 `~/.claude/agents/router-agent-worker.md` 提供规范（`ra init` 会生成）。

两种模式都不改项目自己的 `CLAUDE.md`。

这些规范 markdown 统一存放在状态目录的 `specs/` 下，可在 Web 面板「配置 → 规范文件」直接编辑或恢复默认。`agent` 模式的全局规范文件仍由 `ra init` 写入，修改 Worker 手册后重新执行一次 `ra init` 即可同步。
