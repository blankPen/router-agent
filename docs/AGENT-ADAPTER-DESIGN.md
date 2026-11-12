# Agent 工具适配器接口设计方案

> 目标：让 router-agent 从「Orca + Claude Code 单一路径」演进为「可插拔 Agent Runtime」。
> 新增 Claude Code CLI、Codex CLI 等运行时，只实现适配器，不改 Router 内核。
>
> 版本：v1.9（设计定稿 + 一期 P0–P3 实施 + 实现代码评审修复；Claude Code CLI 已接入）
> 仓库基线：`main` @ `5f90fa6`
> 编写：ra worker（tk-15）
>
> 注：本文是设计记录；其中 Worker 规范注入的「agent 模式」后来已移除，Worker 统一使用 prompt 模式。

---

## 0. 结论先行

1. **现状不是「没有抽象」，而是「抽象漏了」**：`WorkerRuntime` 端口已经存在，但必选动作只有 `start/deliver/registerContext/stop`，可选动作只有 `read/session`；终端活性、屏幕输出、worktree 回收、PR 线索、仓库发现、会话记录读取全部以 Orca 私有方法/私有类型的形式漏到了 `RouterService`。
2. **必须补齐的不是一个接口，而是实现层的三层中立构件**：工作区（WorkspaceProvider）、Agent 进程（AgentRuntime）、Agent 活动（ActivitySource）；对内核仍只暴露一个 `WorkerRuntime` 公共契约，符合 README 里「WorkerRuntime 是唯一扩展点」的承诺。
3. **能力协商优先于强行统一**：不同 Agent CLI 的能力差异很大（是否有常驻进程、是否支持结构化输入、会话记录在哪）。端口用 `capabilities` 显式声明，Router 按能力降级，禁止用 `as OrcaTerminalInfo` 这种方式假设所有运行时都长得像 Orca。
4. **报告协议是跨运行时不变量**：`ra report` + `state.json` 兜底已经与运行时无关，必须保留，并作为新运行时接入的硬性验收项（Agent 必须能执行 shell 命令）。
5. **迁移必须零行为回归**：Orca 路径先做「等价包装」，用同一套契约测试与现有测试兜住，再逐个引入新运行时；任何阶段都可独立 revert。
6. **多运行时共存靠 `assignment.runtimeId` 路由**，不是全局单运行时；`config.runtime.default` 只决定新工单，旧工单永远回到自己创建时的运行时。
7. **一期范围锁定**：P0–P3，即 Orca 等价拆解 + Claude Code CLI 运行时；Codex CLI 与旧路径清理放二期（P4–P5）。

---

## 1. 背景、目标与非目标

### 1.1 背景

当前系统的真实形态是：

```text
飞书消息 → Router（Pi 研判）→ Engine → OrcaRuntime
                                            ├── orca worktree create --agent claude
                                            ├── orca terminal send
                                            ├── orca terminal list / read
                                            └── orca worktree rm
```

用户希望后续能接入 **Claude Code CLI**、**Codex CLI** 等不同 Agent 工具，只要实现一个适配器接口即可扩展。仓库里已有 `WorkerRuntime` 端口，但它只抽象了「派工/投递/停止」，没有抽象「工作区生命周期」「Agent 进程状态」「Agent 活动读取」；同时服务层直接引用了 `OrcaTerminalInfo`、`OrcaCommandError`、`judgeIdle` 等 Orca 概念，导致新运行时无法真正落地。

### 1.2 目标

- 定义稳定的 **Agent 适配器契约**，覆盖工单执行全生命周期：
  1. 工作区创建 / 查询 / 回收；
  2. Agent 进程启动 / 输入投递 / 停止；
  3. Agent 活性与活动读取（供巡检、僵尸判定、重启对账）；
  4. 仓库发现与启动自检（供 `ra init` / `ra doctor`）；
  5. 可选的 PR 线索（没有也能靠 `gh` 兜底）。
- 让 `RouterService`、`Engine`、`Store`、`Outbox`、`Effects` 不再 import 任何运行时私有类型。
- 给出 Orca、Claude Code CLI、Codex CLI 三个运行时的具体实现路径与差异矩阵。
- 给出分阶段实施计划、测试策略和回滚方案。

### 1.3 非目标

- **不替换 Router 的研判层**（Pi / `DecisionEngine` / `tool-spec.ts`）。研判工具适配器是另一个问题域：它解决的是「同一批 `router_*` 工具如何暴露给不同模型 SDK」，与 Worker 运行时无关。本方案只标注边界，不合并设计。
- 不在本方案定稿前改业务实现；本工单只产出设计。
- 不引入 ACP / MCP 作为一期必须项。端口保持协议无关，未来可以让某个 adapter 内部走 ACP，而不是重做内核。
- 不改变工单状态机、报告协议、PR 闭环语义。
- 不做跨机器调度（本方案默认 Router 与 Worker 在同一台 macOS 上）。

---

## 2. 现状盘点：Orca 到底绑在哪

### 2.1 耦合分层

| 层 | 现状 | 位置（证据） | 判定 |
|-|-|-|-|
| L0 领域内核 | 只认 `Ticket/Assignment/Report/Stage`，无 Orca | `packages/core/src/*`、`src/store/db.ts` | 已解耦，保持 |
| L1 工作区创建 | `orca worktree create --repo --name --base-branch --branch --agent claude --surface terminal --prompt` | `packages/runtime/src/orca/commands.ts:21-36`，`packages/runtime/src/orca/index.ts:188-215` | 强耦合，必须抽象 |
| L2 Agent 启动 | Agent 与 worktree 在同一条 Orca 命令里创建，Agent 固定 `claude` | `commands.ts:28`、`index.ts:210` | 强耦合，必须抽象 |
| L3 输入投递 | `orca terminal send --terminal <handle> --text <text> --enter` | `commands.ts:48-50`、`index.ts:217-222` | 强耦合，必须抽象 |
| L4 活性/状态 | `orca terminal list --json` + `connected/orphaned/writable/lastOutputAt` | `index.ts:235-241`、`packages/runtime/src/orca/report-poller.ts:156-176` | 强耦合，必须抽象 |
| L5 活动读取 | 优先 Claude Code JSONL（`~/.claude/projects/<slug>/*.jsonl`），兜底 Orca 终端屏幕 | `packages/runtime/src/orca/session.ts:7-102`、`index.ts:244-263`、`src/service.ts:1373-1396` | 双重耦合，必须抽象 |
| L6 工作区回收 | `orca worktree show` / `orca worktree rm --worktree path:<dir>` | `commands.ts:65-77`、`index.ts:265-274`、`src/service.ts:1165-1205` | 强耦合，必须抽象 |
| L7 PR 线索 | `worktree.linkedPR / linkedGitLabMR` | `src/service.ts:1475-1497` | 中耦合，可降级 |
| L8 仓库发现/自检 | `orca status`、`orca repo list --json`，解析器放在 `sources/lark.ts` | `src/cli/doctor.ts:59-78`、`src/cli/init.ts:124-147`、`src/sources/lark.ts:117-160` | 中耦合，需要抽象 |
| L9 服务装配 | `new OrcaRuntime(...)` 硬编码；`runtime.default` 只接受 `'orca'` | `src/cli/index.ts:642-649`、`src/config.ts:158/300-304/899-901`、`src/router/api.ts:118` | 中耦合，需要注册表 |
| L10 Worker 手册 | 手册直接写「你在一个独立的 Orca worktree 里工作」「Claude Code」；agent 模式写入 `~/.claude/agents/` | `packages/runtime/src/spec/prompt-mode.md:3`、`packages/runtime/src/spec/index.ts:46-56` | 中耦合，需要拆分「任务契约」与「启动方式」 |
| L11 报告通道 | `ra report` HTTP + `state.json` 兜底，与运行时无关 | `src/cli/report.ts`、`packages/runtime/src/orca/report-poller.ts:1-154` | 已解耦，保留 |
| L12 效果队列 | `launch-worker / stop-worker / cleanup-workspace` 只带 `ticketId` | `src/service.ts:536-552` | 已解耦，保留 |

### 2.2 关键漏抽象点（必须修）

1. **`WorkerRuntime` 端口外的私有方法**：`RouterService` 把 `inspect / inspectWorktree / removeWorktree` 通过交叉类型挂在 `runtime` 上（`src/service.ts:40-44`、`443-447`；`CreateServiceDeps` 的 `1633-1638` 只含 `inspect/removeWorktree`），端口本身没有声明。
2. **中立类型泄漏**：`service.ts:14` 直接 import `OrcaTerminalInfo`、`OrcaCommandError`；`checkIdle`/`isZombie`/`recover`/`probeTicket` 全部按 Orca 字段写判断。
3. **选择器格式泄漏**：`removeWorktree('path:' + workdir)`、`inspectWorktree('path:' + workdir)`，`path:` 是 Orca CLI 的选择器语法。
4. **「无 inspect」被当成僵尸**：`isZombie()` 在 `!this.runtime.inspect` 时直接 `return true`（`service.ts:1028`）。任何没有活性接口的新运行时，工单都会在 `zombieHours` 后被误判为僵尸。这必须改成「未知 ≠ 僵尸」。
5. **投递失败可能每秒重试**：`deliverPendingInputs()` 失败后调 `workerGone()`；没有 `inspect` 时它恒返回 `false`（`service.ts:1557-1565`），于是每秒重试。
6. **PR 发现只剩一半**：`PrTracker.findByBranch()` 已实现（`src/sources/github.ts:79-82`）但从未被 `RouterService` 调用；目前新 PR 主要靠 Orca 的 `linkedPR` 发现。新运行时没有这个能力时，Agent 必须自己 `ra report --pr-number`，否则 PR 跟踪不到。
7. **Agent 与 worktree 绑死**：Orca 的 `worktree create --agent claude` 把「建目录」和「起 Agent」合成一步，导致「工作区端口」和「运行时端口」无法独立实现。

### 2.3 已经做对、必须保留的部分

- `Engine` 是唯一状态写入口（`src/core/engine.ts`）。
- `EffectsProcessor` 的 `launch-worker / stop-worker / cleanup-workspace` 只依赖 `ticketId`，运行时无关（`src/core/effects.ts`）。
- `ReportPoller` 轮询 `~/.router-agent/workers/<ticketId>/state.json`，运行时无关（`packages/runtime/src/orca/report-poller.ts:68-110`）。
- `ra report` 协议与 CLI（`src/cli/report.ts`）完全运行时无关。
- `Assignment` 已存 `runtime_id / handle / workdir`（`src/core/model.ts:106-115`、`src/store/db.ts:227`），天然支持多运行时。

---

## 3. 设计原则

1. **端口-适配器**：内核只依赖 `packages/runtime/src/port.ts` 中的中立模型；运行时实现放 `packages/runtime/src/runtimes/<id>/`。
2. **能力协商，不做最低公分母**：运行时声明能力，Router 按能力降级；缺能力时明确降级，不静默假设。
3. **结构化优先，文本兜底**：活性优先读进程/会话元数据，活动优先读 Agent 会话 JSONL；终端屏幕永远是最后兜底，且只用于给人看的摘要。
4. **重启可还原**：`handle` 必须是运行时可持久化、重启后仍能还原上下文的标识（Orca=terminal handle，Claude=sessionId，Codex=sessionId）；禁止只存在内存 map。
5. **报告协议是硬契约**：任何运行时都必须让 Agent 能执行 `ra report`（shell 工具或等价能力），并遵守 `【Router 输入 in_xxx】` 投递格式。
6. **零行为回归**：Orca 路径的输出、日志、错误文案、阶段流转保持一致；每阶段都有回滚开关。
7. **参数数组，不拼 shell**：沿用 `CommandRunner` 的 `spawn(bin, argv)` 模式（`packages/infra/src/process.ts:15-45`），新增长驻进程 spawner 同样禁止 shell 拼接。
8. **安全默认值**：新运行时默认最小权限（工作区可写、网络按需、非交互审批策略显式配置），不默认 `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`。

---

## 4. 目标架构

### 4.1 分层

```text
┌─────────────────────────────────────────────────────────────┐
│ RouterService / Engine / Store / Outbox / Effects            │
│ 只依赖：WorkerRuntime（组合端口）+ 中立状态模型                │
└───────────────────────────┬─────────────────────────────────┘
                            │
                  WorkerRuntime（唯一扩展点）
                            │
        ┌───────────────────┼────────────────────┐
        │                   │                    │
 WorkspaceProvider    AgentRuntime        ActivitySource
 工作区生命周期        进程生命周期         活动读取
        │                   │                    │
   ┌────┴────┐         ┌────┴─────┐         ┌────┴──────┐
 Orca      Git        Orca       Claude     Claude      Codex
 worktree  worktree   terminal   CLI        sessions    rollouts
```

### 4.2 一个公共契约 + 三个内部构件

- **公共契约**：`WorkerRuntime`（5.4），实现者只需要实现它。
- **内部构件**（可选、可复用，不进入 `port.ts`）：
  - `WorkspaceProvider`：create / inspect / remove / listRepos；
  - `AgentRuntime`：launch / send / status / stop / output；
  - `ActivitySource`：read。
- 允许某些运行时不完全拆开（例如 Orca 的 create+launch 合并），但**对外语义必须一致**。

### 4.3 目录规划

```text
packages/runtime/src/
  port.ts                      # 端口与中立模型（唯一契约）
  registry.ts                  # RuntimeRegistry / createRuntimes 注册表
  status.ts                    # judgeIdle 的中立版本（从 orca/ 上移）
  report-poller.ts             # 从 orca/ 上移（本来就与运行时无关）
  spec/
    contract.md                # 运行时中立的任务契约
    claude-agent.md            # Claude 专属的启动说明（agent 模式）
  workspaces/
    git-worktree.ts            # GitWorktreeProvider（Claude/Codex 共用）
    orca.ts                    # OrcaProvisioner（内部实现，可合并 create+launch）
  activity/
    claude-sessions.ts         # 从 orca/session.ts 上移
    codex-sessions.ts          # 新增
  runtimes/
    orca/index.ts              # OrcaRuntime（组合内部构件），行为与今天一致
    claude-code/index.ts        # Claude Code CLI
    codex-cli/index.ts         # Codex CLI
```

> 迁移期保留 `packages/runtime/src/orca/*` 的 re-export，避免一次性搬文件导致 review 噪音；P1 完成后再删旧路径。

---

## 5. 接口定义（草案）

> 公共契约见 5.4；5.1–5.3 是**内部可复用构件**，不要求出现在 `port.ts`，也不要求每个运行时都用。
> 这样既避免「两套互不引用的契约」，又给 Claude/Codex 这类新运行时留下清晰的分层实现路径。

### 5.1 内部构件：工作区（不进入公共契约）

```ts
/** 工作区申请：由 Router 生成，provider 负责落地。 */
export interface WorkspaceRequest {
  ticketId: string
  /** 项目选择器；语义由 provider 解释（Orca displayName / git 路径 / owner/repo）。 */
  repo: string
  /** 起始分支（base branch）。 */
  baseBranch: string
  /** 建议的工作分支名；provider 可微调，实际值以返回为准。 */
  workBranch: string
  /** 建议的展示名（如 ra-tk-15-agent-adapter）。 */
  name: string
  /** Router 预分配的目录；为空则由 provider 决定。 */
  workdir?: string
}

export interface Workspace {
  /** provider 内稳定标识，对应 StartResult.workspaceRef；为空时由 workdir 推导。 */
  workspaceRef: string
  workdir: string
  /** 实际使用的工作分支（可能被 provider 加后缀）。 */
  branch: string
  /** provider 私有信息；内核不得依赖。 */
  meta?: Record<string, unknown>
}

export interface WorkspaceInfo {
  workdir: string
  branch: string
  dirty?: boolean
  /** 可选能力：provider 能直接给出 PR 线索（Orca 有，git 没有）。 */
  linkedPr?: { number: number; url: string; state?: 'open' | 'merged' | 'closed' }
}

export interface RepoDescriptor {
  name: string
  path: string
  kind?: string
}

export interface WorkspaceProvider {
  readonly id: string
  create(req: WorkspaceRequest): Promise<Workspace>
  inspect(ref: string): Promise<WorkspaceInfo | null>
  remove(ref: string, opts?: { force?: boolean }): Promise<void>
  listRepos?(): Promise<RepoDescriptor[]>
}
```

### 5.2 内部构件：Agent 运行时

```ts
/** 运行时中立的任务契约：只讲“做什么/怎么上报”，不讲某个 CLI 的参数。 */
export interface WorkerBrief {
  ticketId: string
  title: string
  scope: string
  workBranch: string
  /** 由 spec 层渲染的正文（工单、授权范围、交付规则、上报命令）。 */
  contract: string
}

export interface ReportPaths {
  statePath: string
  eventsPath: string
}

/** 目录由 Router 在 start 前创建；adapter 不得假设已存在，也不得改写路径。 */

/** 中立工具策略；adapter 负责映射到各 CLI 的开关。 */
export interface ToolPolicy {
  fileAccess: 'read-only' | 'read-write'
  /** deny=不给 shell；allowlist=只放行 shellAllow 中的命令；allow=任意 shell。 */
  shell: 'deny' | 'allowlist' | 'allow'
  /** shell=allowlist 时生效，按命令前缀匹配，例如 ['ra report','ra doc','git','gh']。 */
  shellAllow?: string[]
  allowNetwork: boolean
}

export interface LaunchRequest {
  workspace: Workspace
  ticket: Ticket
  brief: WorkerBrief
  report: ReportPaths
  tools: ToolPolicy
  /** 运行时私有参数（模型、审批模式等），不进入内核。 */
  options?: Record<string, unknown>
}

export type AgentPhase = 'starting' | 'running' | 'blocked' | 'exited' | 'lost' | 'unknown'

export interface AgentStatus {
  /** 进程/会话是否仍可继续。 */
  alive: boolean
  /** 语义阶段：内核只认这个，不认 provider 字段。idle 由 Router 按 lastActivityAt 计算。 */
  phase: AgentPhase
  /** 现在能否再投递输入。 */
  acceptingInput: boolean
  /** 最后一次可观测活动时间（ISO）；用于 idle / zombie 判定。 */
  lastActivityAt?: string
  exitCode?: number
  exitSignal?: string
  /** provider 细节（connected/orphaned/pid...）；只进日志，不进判断。 */
  detail?: Record<string, unknown>
}

export interface AgentOutput {
  status: 'running' | 'exited' | 'unknown'
  lines: string[]
  source?: string
}

export interface AgentRuntime {
  readonly id: string
  launch(req: LaunchRequest): Promise<{ handle: string; sessionId?: string }>
  send(ref: WorkerRef, inputs: InboundMessage[], opts?: DeliverOptions): Promise<DeliveryReceipt>
  /** null = 无法判断；lost = 已确认丢失。 */
  status(ref: WorkerRef): Promise<AgentStatus | null>
  stop(ref: WorkerRef, reason: string): Promise<void>
  output?(ref: WorkerRef, opts?: { limit?: number }): Promise<AgentOutput | null>
}
```

### 5.3 内部构件：活动读取

```ts
export interface ActivitySource {
  readonly id: string
  /** ActivityQuery 见 5.4：必须带 handle + ticketId，可选 workdir/sessionId。 */
  read(query: ActivityQuery): Promise<SessionSnapshot | null>
}
```

### 5.4 公共契约（内核唯一依赖）

> **实现者只需要实现这一个接口。** `WorkspaceProvider / AgentRuntime / ActivitySource` 是实现层可复用的内部构件（见 5.1–5.3），**不进入 `port.ts`**；避免出现「两套互不引用」的契约。

```ts
/** Router 传给运行时的引用：handle 不透明，其余字段让运行时能定位自己的 meta/会话。 */
export interface WorkerRef {
  handle: string
  ticketId: string
  workdir?: string
  /** 运行时自己的会话 ID（Claude/Codex 用；Orca 可空）。Router 不落库，adapter 可从 meta 读取。 */
  sessionId?: string
}

/** 工作区引用：回收/查询时使用，不依赖 Orca 的 `path:` 选择器语法。 */
export interface WorkspaceRef {
  ticketId: string
  workdir: string
  /** provider 自己的稳定标识；为空时由 workdir 推导。 */
  workspaceRef?: string
}

export interface StartResult {
  handle: string
  workdir: string
  /** 实际工作分支（可能被 provider 加后缀）；供 PR 兜底查询。 */
  branch?: string
  /** 会话 ID；写入 runtime 的 meta.json，供 resume/活动定位。 */
  sessionId?: string
  workspaceRef?: string
}

/** start() 的完整输入：Router 负责拼装，adapter 只消费。 */
export interface WorkerContext {
  ticket: Ticket
  assignment: Assignment
  /** 预分配目录；为空表示由运行时决定。 */
  workdir: string
  /** 运行时中立的工单契约（工单、授权范围、交付规则、ra report 用法）。 */
  brief: WorkerBrief
  /** Router 保证目录存在；adapter 不得改写路径。 */
  report: ReportPaths
  /** Router 决定策略，adapter 只做映射。 */
  tools: ToolPolicy
}

export interface ActivityQuery {
  ref: WorkerRef
  opts?: { maxBytes?: number; maxEvents?: number }
}

/** 投递回执：Router 据此决定是否重投；accepted 不等于 ack。 */
export type DeliveryReceipt =
  | { status: 'accepted'; inputIds: string[] }
  | { status: 'queued'; inputIds: string[]; reason?: string }
  | { status: 'rejected'; inputIds: string[]; reason: string; retryable?: boolean; retryAfterMs?: number }

export interface DeliverOptions {
  /** 第几次投递（从 1 开始）；同一 attempt 的并发调用必须幂等。 */
  attempt?: number
  /** Router 显式重投：adapter 必须允许同一 input.id 再次进入（串行重投）。 */
  redeliver?: boolean
}

export interface RuntimeCapabilities {
  agent: {
    /** 能给出结构化活性；没有则 Router 不做进程级 idle/zombie 判定。 */
    liveStatus: boolean
    /** 能给出进程退出码/退出时间（用于区分「正常结束」与「崩溃」）。 */
    processExit: boolean
    /** 能读终端/日志尾部，供巡检兜底。 */
    output: boolean
    /** 能读 Agent 自己的结构化会话记录。 */
    activity: boolean
    /** 支持非 TTY 的结构化输入投递（Claude `--bg --resume` / Codex resume）；TTY 注入也算支持。 */
    structuredInput: boolean
    /** 支持显式唤醒信号（status?），headless 运行时通常为 false。 */
    nudge: boolean
  }
  workspace: {
    /** 能自动回收工作区。 */
    cleanup: boolean
    /** 能直接给出 PR 线索。 */
    prLink: boolean
    /** 能列出可用仓库（doctor / init）。 */
    discovery: boolean
  }
}

export interface WorkerRuntime {
  readonly id: string
  readonly capabilities: RuntimeCapabilities

  start(ctx: WorkerContext): Promise<StartResult>
  deliver(ref: WorkerRef, inputs: InboundMessage[], opts?: DeliverOptions): Promise<DeliveryReceipt>
  stop(ref: WorkerRef, reason: string): Promise<void>

  /** 可选：显式唤醒/探活；只有 capabilities.agent.nudge=true 时才实现。 */
  nudge?(ref: WorkerRef): Promise<void>
  /** 可选：结构化活性；返回 null 表示「无法判断」，不是「已丢失」。 */
  status?(ref: WorkerRef): Promise<AgentStatus | null>
  /** 可选：输出尾部；没有则巡检跳过这一路。 */
  output?(ref: WorkerRef, opts?: { limit?: number }): Promise<AgentOutput | null>
  /** 可选：结构化活动；优先于 output。 */
  activity?(query: ActivityQuery): Promise<SessionSnapshot | null>

  /** 可选：工作区查询/回收；不再使用 Orca 的 `path:` 选择器。 */
  inspectWorkspace?(ref: WorkspaceRef): Promise<WorkspaceInfo | null>
  removeWorkspace?(ref: WorkspaceRef): Promise<void>
  /** 可选：仓库发现（doctor / init）。 */
  listRepos?(): Promise<RepoDescriptor[]>
  /** 可选：启动前自检。 */
  doctor?(): Promise<DiagnosticCheck[]>
  /** 兼容保留：当前 Router 未调用，只有 OrcaRuntime 与测试在用；新运行时可不实现。 */
  registerContext?(ref: WorkerRef, items: ContextItem[]): Promise<void>
}
```

**`status()` 的三态语义（必须严格遵守）**：

| 返回值 | 含义 | Router 处理 |
|-|-|-|
| `null` | 运行时暂时无法判断（provider 不可用 / 查询失败 / 没有 status 能力） | 不判死、不判僵尸；下一轮再看 |
| `phase: 'unknown'` | 已查询但结果不确定（如 Orca orphaned 且不可写） | 同 `null`，但日志保留 provider 细节 |
| `phase: 'blocked'` | 进程活着，但卡在权限/用户输入（Claude `state=blocked, waitingFor=permission prompt`） | 置 attention、通知人；不自动 resume（会 fork 副本） |
| `phase: 'lost'` | 已确认会话/进程不存在 | 走 `handleLostWorker`，转人工 |
| `alive: false` + `phase: 'exited'` | 进程已退出；是否可 resume 看 `acceptingInput` | 可 resume 则保留，否则转人工 |
| `alive: true` | 进程/会话仍可用 | 正常 idle/active 判定 |

**`WorkerContext` 的生产者（P0 必须落地）**：

- `buildWorkerContext({ ticket, assignment, home, workersDir, config, mode })` 由 Router 调用：
  - `workdir`：预分配目录；为空则 adapter 决定；
  - `report`：`{ statePath: join(workersDir, ticket.id, 'state.json'), eventsPath: join(workersDir, ticket.id, 'events.log') }`；Router 落盘前 `mkdir -p`；
  - `tools`：来自 `config.worker.tools`（默认 `shell: 'allowlist'`、`shellAllow` 含 `ra report / ra doc / git / gh` 与常用构建测试命令、`allowNetwork: false`）；
  - `brief`：由 `buildWorkerBrief()` 唯一渲染：
    - Orca 路径调用 `buildOrcaBrief()`，内部**逐字节复用当前 `buildWorkerPrompt()` 的输出**（P0 加 snapshot 测试，防止零行为回归）；
    - 新运行时路径调用 `buildNeutralBrief()`，基于 `spec/contract.md` 渲染工单、授权范围、交付规则与 `ra report` 用法。
- `OrcaRuntime.start()` 改为消费 `ctx.brief.contract`，不再在 adapter 内部拼 prompt；这是 P0 的范围，不是 P3。
- `AppConfig` 新增 `worker.tools`；P0 先给默认值，P2 再接入 `loadConfig` 与 `config set`。

### 5.5 错误模型与基础设施端口

```ts
export type WorkerErrorCode =
  | 'workspace:create-failed'
  | 'workspace:missing-repo'
  | 'workspace:missing-branch'
  | 'workspace:remove-failed'
  | 'agent:launch-failed'
  | 'agent:not-accepting-input'
  | 'agent:gone'
  | 'agent:timeout'
  | 'runtime:unavailable'
  | 'runtime:unknown'

export class WorkerRuntimeError extends Error {
  constructor(
    code: WorkerErrorCode,
    reason: string,
    opts?: { retryable?: boolean; cause?: string; detail?: Record<string, unknown> },
  )
  readonly code: WorkerErrorCode
  readonly retryable: boolean
  /** 给人看的原因；进飞书话题。 */
  readonly reason: string
  /** 底层原因；进日志。 */
  readonly cause?: string
  /** provider 私有诊断（orcaCode / operationId / exitCode...）；只进日志，进话题前必须脱敏。 */
  readonly detail?: Record<string, unknown>
}

/** doctor / init 共用的诊断条目。 */
export interface DiagnosticCheck {
  name: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
  hint?: string
}

/** 长驻进程端口；与 CommandRunner 分开，便于测试注入与进程组管理。 */
export interface ExitInfo {
  code: number | null
  signal: string | null
  at: string
}

/** 进程身份：持久化到 meta，用于重启后避免 PID 复用误判。 */
export interface ProcessIdentity {
  pid: number
  startedAt: string
  argv: string[]
  cwd: string
}

export interface ProcessSpawner {
  spawn(argv: string[], opts: {
    cwd: string
    /** 必填：显式 allowlist，禁止默认继承 process.env。 */
    env: NodeJS.ProcessEnv
    /** 落盘日志；调用方负责 0600 权限、大小上界与轮转。 */
    logPath: string
    detached?: boolean
    /** 进程退出时回调；adapter 用它写 exit.json / 更新状态。 */
    onExit?: (info: ExitInfo) => void
  }): Promise<{ identity: ProcessIdentity; wait(): Promise<ExitInfo> }>
  /** 校验 pid + startedAt + argv + cwd；任一不匹配即视为不是本进程。 */
  alive(identity: ProcessIdentity): Promise<boolean>
  /** 先 SIGTERM 进程组，超时后 SIGKILL；幂等。 */
  stop(pid: number, opts?: { graceMs?: number }): Promise<void>
}
```

**环境变量白名单（硬约束）**：Agent 进程只继承 `PATH`、`HOME`、`TMPDIR`、`LANG`、最小 `RA_*`（`RA_HOME` / `RA_PORT`）、运行时自身认证变量（如 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`）。飞书 App Secret、数据库路径、云厂商凭证等一律剥离；`ProcessSpawner.spawn` 的 `env` 必填，实现不得在缺省时回退到 `process.env`。

**prompt 传递（硬约束）**：工单契约通过 stdin 或临时文件传给 Agent CLI，不放在 argv/位置参数里，避免 `ps` 与失败日志泄露整段 prompt；`summarizeArgs` 对未知位置参数只记长度。

`OrcaCommandError` 不再被 `RouterService` 引用；`OrcaRuntime` 内部把它映射成 `WorkerRuntimeError`，保留 `orcaCode / operationId / args / stdout / stderr` 到 `detail`，现有 `reportLaunchFailure()` 的诊断字段不丢。

---

## 6. 能力矩阵与降级规则

### 6.1 三个运行时的能力矩阵

| 能力 | Orca（现状） | Claude Code CLI | Codex CLI |
|-|-|-|-|
| 工作区创建 | Orca worktree | `git worktree add` | `git worktree add` |
| 工作区回收 | Orca worktree rm | `git worktree remove` | `git worktree remove` |
| Agent 启动 | `orca worktree create --agent claude` | `claude --bg ...` | `codex exec ...` |
| 输入投递 | `orca terminal send` | working/blocked 排队；done/stopped 后 `claude --bg --resume <sessionId>`（不带 flags） | 结束后 `codex exec resume <session> <prompt>` |
| 结构化活性 | terminal list | `claude agents --json --all`（state/status/waitingFor） | 子进程 PID + rollout 文件 |
| 进程退出信息 | terminal list 的 connected/orphaned | `state=done/stopped`（无 exitCode） | 子进程 exit code + signal |
| 显式唤醒 | `terminal send status?` | 不支持（会起新一轮模型调用） | 不支持 |
| 投递回执 | terminal send 成功即 accepted | `accepted / queued / rejected` | `accepted / queued / rejected` |
| 输出尾部 | terminal read --screen | 捕获 stdout / stream-json 日志 | 捕获 stdout / `--json` 日志 |
| 结构化活动 | Claude JSONL（借 Claude） | `~/.claude/projects/<slug>/<session>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| PR 线索 | `linkedPR` | 无，靠 `gh pr list --head` | 无，靠 `gh pr list --head` |
| 仓库发现 | `orca repo list` | 配置文件 / `git` 目录 | 配置文件 / `git` 目录 |
| 工具策略 | Agent 规范 + Orca 启动参数 | `--allowedTools` / `--permission-mode` | `-s workspace-write` / 配置覆盖 |

> Claude / Codex 的 CLI 事实已在本机实测：Claude Code `2.1.322` 的 `claude --bg`、`claude agents --json --all`、`claude --bg --resume <session-id>`、`claude stop/attach/logs` 均可用于后台会话管理；`--bg --resume` 要继续同一 id，必须「先 `claude stop` 停掉后台 worker」+「传完整 session id」+「不带新 flags」，否则 CLI 会复制出一个副本。Codex `0.166.0` 支持 `codex exec --json`、`-C <dir>`、`--output-last-message`、`codex exec resume <session-id> <prompt>`。完整实测记录见附录 C。

### 6.2 降级规则（Router 侧）

| 缺失能力 | 降级行为 | 必须避免 |
|-|-|-|
| `agent.liveStatus` | 不做进程级 idle 判定；只用上报/输入时间做闲置治理 | 把「无法判断」当成僵尸 |
| `agent.processExit` | 只按 `lastActivityAt` 判停滞；不区分正常/异常退出 | 把崩溃退出当作可 resume 的 idle |
| `agent.nudge` | 不主动发 `status?`；只等上报或用户输入 | 对 headless 运行时发 `status?` 烧 token |
| `agent.structuredInput` | 只用 TTY 注入；进程退出后不再重投 | 对已退出进程反复 resume |
| `agent.output` | 巡检只走 activity；两者都没有则跳过 | 解析 TUI 文本当状态 |
| `agent.activity` | 退回 output 摘要 | 假设 Claude 的 JSONL 一定存在 |
| `workspace.cleanup` | 不自动删目录，通知用户手动处理 | 静默留下脏工作区 |
| `workspace.prLink` | 用 `gh pr list --head <工作分支>` 兜底 | 因为没有 linkedPR 就永远追不到 PR |
| `workspace.discovery` | doctor 跳过仓库检查；init 手输 | 因 Orca 不可用导致 init 完全不可用 |

### 6.3 巡检唤醒（idle nudge）的差异化

当前 `checkIdle()` 在终端长时间无输出时会发一条 `status?` 唤醒（`src/service.ts:913-918`）。这套语义只对「常驻 TTY」成立；对 headless 运行时，发 `status?` 等于再起一轮模型调用，会烧 token。规则：

| 运行时形态 | 唤醒策略 |
|-|-|
| 常驻 TTY（Orca） | `runtime.nudge(ref)`；Orca 内部执行 `orca terminal send status?`，不产生 Input 行、不参与 ack |
| Claude/Codex 仍在运行（`working` / 子进程存活） | **不唤醒**；只根据 `status.lastActivityAt` 判 idle/stale |
| Claude `done/stopped`、Codex 进程已退出且可 resume | 仅在 `acceptingInput=true` 且用户有新输入时 resume；不主动发 `status?` |
| 无 `liveStatus` / 无 `nudge` | 不做唤醒，交给上报心跳与闲置治理 |

实现位置：`checkIdle()` 先读 `runtime.status?.()` 与 `capabilities.agent.nudge`；只有 Orca 这类常驻 TTY 运行时才调用 `nudge()`。`deliver()` 只接收业务输入，必须带 `in_` 前缀；`status?` 不再走 `deliver`。

### 6.4 状态分类与处理矩阵

先抽一个统一分类函数，所有调用点只消费分类结果，禁止各自解释字段：

```ts
type AgentVerdict = 'keep' | 'lost' | 'transfer' | 'unknown'

function classifyAgentStatus(s: AgentStatus | null): AgentVerdict {
  if (!s) return 'unknown'
  if (s.phase === 'lost') return 'lost'
  if (s.phase === 'exited') return s.acceptingInput ? 'keep' : 'transfer'
  if (s.phase === 'blocked') return 'keep' // 活着但等人/权限；由 Router 置 attention，不自动 resume
  if (s.phase === 'unknown') return 'unknown'
  return 'keep' // starting / running
}
```

| 调用点 | `keep` | `lost` | `transfer` | `unknown`（null / 抛错） |
|-|-|-|-|-|
| `checkIdle` | 按 `lastActivityAt` 判 idle/stale | `handleLostWorker` | `setAttention` + 通知一次 | 跳过本轮，不判死 |
| `isZombie` | 按 `lastActivityAt` 与阈值判定 | `true` | `true` | `false`（未知不等于僵尸） |
| `recover` | 复用会话 | `handleLostWorker` | `setAttention`，保留 assignment 等人工 | 保持现状，下一轮再看 |
| `workerGone` | `false` | `true` | `true` | `false`（不误杀） |
| `deliverPendingInputs` | 正常投递 | `handleLostWorker` | 不投递，`setAttention` | 按退避重试，不判死 |

> `transfer` 与 `lost` 的区别：`lost` 是「确定没了」，直接转人工并结束 assignment；`transfer` 是「进程退出了但会话可能还在，需要人决定是否重来」，只置 attention，不自动结束。P1 用同一组测试覆盖四种 verdict。
>
> `blocked` 是 `keep` 的特例：进程活着但卡在权限/输入。`checkIdle` 不 `nudge`，`probe` 不当作停滞，Router 置 attention 并通知一次；用户可 `claude attach <id>` 人工处理，或由 Router `stop` 后带新输入 `--resume`（会保留会话）。

**状态来源映射（各 adapter 必须遵守）**：

| provider 信号 | `AgentStatus` / 返回值 |
|-|-|
| 查询命令失败 / 超时 / 无 status 能力 | `null` |
| 会话 handle 在 provider 中不存在 | `phase='lost', alive=false` |
| Orca `connected=false` | `phase='lost', alive=false` |
| Orca `orphaned && !writable` | `phase='unknown', alive=false`（不判死） |
| Orca `orphaned && writable` | `phase='running', alive=true` |
| Orca `writable` | `acceptingInput` |
| Orca `lastOutputAt` | `lastActivityAt`（idle 由 Router 计算） |
| 进程已退出 + 会话可 resume | `phase='exited', acceptingInput=true` |
| 进程已退出 + 会话不可 resume | `phase='exited', acceptingInput=false` |

---

## 7. 关键设计决策（ADR）

### D1：对内核只暴露一个 `WorkerRuntime`，内部构件是可选的实现手段

**决策**：保留 `WorkerRuntime` 作为唯一公共契约；`WorkspaceProvider / AgentRuntime / ActivitySource` 是实现层内部构件，不进入 `port.ts`，不强制每个运行时拆成三份。

**理由**：Orca 的 `worktree create --agent claude` 把建目录和起 Agent 合并成一步，强行拆开会改变已验证的行为（`--surface terminal`、`--no-parent`、`--setup skip`、失败重试句柄）。对外契约稳定，对内实现自由。

**替代方案**：内核直接依赖三个端口。否决——会让 `RouterService` 的装配复杂度翻倍，且与 README 对外承诺不一致。

### D2：`handle` 保持不透明字符串，但必须配合 `ticketId/workdir/sessionId` 可还原

**决策**：`assignments.handle` 继续存字符串；Orca 存 terminal handle，Claude 存 `claude --bg` 打印的 short id（UUID 型 `sessionId` 写 meta），Codex 存 sessionId。所有生命周期方法接收 `WorkerRef { handle, ticketId, workdir?, sessionId? }`，运行时据此定位自己的 `~/.router-agent/workers/<ticketId>/meta.json`。

**理由**：不改表结构、不改 API、不破坏现有数据；`ticketId` 是 meta 目录的稳定键，`workdir` 是工作区定位键，`sessionId` 是会话定位键。

**约束**：
- 禁止把「只在内存 map 里有的对象」作为 handle；重启后 `status/stop/deliver/activity` 必须仅凭 `WorkerRef` 可工作。
- adapter 在 spawn **之前**原子写入 `meta.json`（`status=starting, pid=0`），spawn 后补 `process/sessionId/logPath`；进程退出后写 `exit.json`；字段定义见 9.4；
- `meta.json` 找不到时 `status()` 返回 `null`（我们自己的元数据缺失，无法判断），不能默认存活，也不能直接判丢失；
- **只有 provider 查询成功且明确返回不存在**（如 Orca `inspect(handle)===null`、进程身份校验失败且会话文件不存在）才返回 `phase='lost'`；
- 进程身份校验必须使用 9.4 的 `ProcessIdentity { pid, startedAt, argv, cwd }`，任一不匹配即视为丢失，避免 PID 复用误杀或误判存活。

### D3：状态判定用中立 `AgentStatus`，禁止 provider 字段进入内核

**决策**：`checkIdle`、`isZombie`、`recover`、`workerGone` 只读 `alive / phase / acceptingInput / lastActivityAt`；`connected/orphaned/lastOutputAt` 只保留在 adapter 的 `detail` 里。

**理由**：这是当前最大的泄漏面，也是新运行时「看起来实现了但一跑就误判」的根因。

**配套修正**：`isZombie()` 在「无 status 能力 / `status()` 返回 `null`」时返回 `false`，由上报心跳和闲置治理兜底，不再默认判僵尸。

### D4：输入投递语义统一为「至少一次 + ack + 幂等」，不统一传输方式

**决策**：`deliver(ref, inputs, opts)` 返回 `DeliveryReceipt { accepted | queued | rejected }`；语义是「这些输入已被运行时接收」，但最终完成仍以 Agent 的 `ra report --ack` 为准。Orca 的 TTY 注入、Claude 的 `--bg --resume`、Codex 的 `exec resume` 都是合法实现。

**理由**：不同 CLI 的输入模型不同；强行统一成 TTY 会把新运行时逼回伪终端方案，强行统一成 headless 又会改变 Orca 已验证的交互体验。

**配套约束（并发去重与可靠重投是两件事）**：
- **并发去重**：adapter 以 `(input.id, attempt)` 为键；同一 attempt 的并发 `deliver` 只 handoff 一次，持久化到 meta 的 `lastHandedOffInputId + attempt`；
- **串行重投**：Router 对「已 accepted/queued 但未 ack」的输入按指数退避（30s/60s/120s，上限 10 分钟）再次调用，并带 `{ attempt: n+1, redeliver: true }`；adapter 看到更大的 attempt 或 `redeliver=true` 必须允许再次 resume，不能被幂等水位线吞掉；
- **Orca TTY**：保持现状，每次重投都 `terminal send` 同一输入 id（TUI 侧可能重复显示，但这是已验证行为）；
- **queued 的消费**：adapter 在「当前进程退出 / 本轮结束 / 下一次 deliver」时消费队列；Router 不假设 queued 已送达，继续按 attempt 重投直到 ack；
- **rejected**：`retryable=true` 按 `retryAfterMs` 退避；`retryable=false` 或超过上限转人工；
- 同一 `sessionId` 仍加单飞锁，禁止并发 resume；但串行重投必须可达。

### D5：活动读取独立于运行时

**决策**：`ActivitySource` 单独实现，adapter 可组合不同来源（Orca 运行时组合 Claude 会话 + 终端输出；Claude CLI 只用 Claude 会话；Codex 只用 Codex rollout）。

**理由**：活动格式由 **Agent 产品** 决定，不由 **进程托管方式** 决定。今天 Orca 里跑的也是 Claude Code，所以 `orca/session.ts` 读的是 Claude 的 JSONL；把它留在 Orca 目录下会误导后续实现。

### D6：报告协议是跨运行时不变量

**决策**：`ra report` + `state.json` 兜底保持不变；新运行时的 `ToolPolicy` 必须保证 shell 可执行 `ra`，且 `PATH` 在 Agent 启动环境中可见。

**理由**：这是 Router 唯一能稳定拿到「回合/状态/PR/回复」的通道。如果某个 Agent 工具不能执行 shell，则它不能作为 Worker 运行时（只能作为研判层）。

### D7：工作区优先复用 Git，不把 Orca 当通用依赖

**决策**：Claude CLI / Codex CLI 使用 `GitWorktreeProvider`（`git worktree add/remove/list --porcelain`）；Orca 仍是 Orca 的 provider。

**理由**：这两个 CLI 本身只需要一个 cwd，不需要 Orca 的终端管理；直接依赖 `git` 可以减少一层故障面，也让 Linux 支持更容易。

### D8：配置用注册表，`runtime.default` 兼容旧值

**决策**：`runtime.default` 从字面量 `'orca'` 放宽为 `string`；新增 `RuntimeRegistry / createRuntimes` 注册表，按 `assignment.runtimeId` 取运行时；未知运行时报 `runtime:unknown`，不静默回退。

**理由**：当前配置解析只接受 `'orca'`（`src/config.ts:899-901`），必须放宽；但旧配置要继续可用。

### D9：PR 发现补上 `gh pr list --head`

**决策**：`trackPullRequests()` 在 `prNumber` 为空时，按以下顺序兜底：
1. `provider.inspectWorkspace({ticketId, workdir}).linkedPr`（Orca）；
2. `inspectWorkspace(...).branch` 拿实际工作分支（provider 可能加后缀）；
3. `prTracker.findByBranch(repo, branch)`（`gh pr list --head`）。

**理由**：Claude/Codex 运行时没有 Orca 的 `linkedPR`；不补这条路径，新运行时只能依赖 Worker 自觉上报 PR，闭环会退化。

**约束**：
- 实际工作分支不从 `workBranch(ticket)` 重算，必须来自 `inspectWorkspace().branch`（adapter 内部从 `meta.workBranch` 读取）；provider 不实现 `inspectWorkspace` 时才退回 `workBranch(ticket)` 并记日志说明可能不精确；
- `repo` 是本地路径（`path:/abs`）时，`gh pr list --repo` 需要 `owner/name`，必须先通过 `git remote get-url origin` 推导；推导失败则跳过兜底并记日志，不能把本地路径当 `owner/repo`。

### D10：工具策略中立化，映射到各 CLI

**决策**：`ToolPolicy` 只描述 `fileAccess / shell / shellAllow / allowNetwork`；adapter 负责映射：
- Orca：写进 worker 规范 / 启动 prompt（交互式终端保留人工审批）；
- Claude：`--allowedTools` 用命令级白名单（默认 `Read,Write,Edit,Glob,Grep` + `Bash(ra report:*),Bash(ra doc:*),Bash(git:*),Bash(gh:*)` + 常用构建/测试命令 `pnpm/npm/npx/node/yarn/bun/python/pytest/cargo/go/make/mvn/gradle`，**不放行裸 `Bash`、不放行 `ra config/stop/serve`**）+ `--permission-mode acceptEdits`；`--permission-prompts none` 需显式开启；
- Codex：`-s workspace-write`（默认）+ 关闭网络；`--dangerously-bypass-approvals-and-sandbox` 仅显式配置。

**安全参数不可被 `runtime.options` 覆盖**：`allowedTools / permissionMode / sandbox / shellAllow / allowNetwork` 只由 `worker.tools` 与内置安全基线生成；`runtime.options` 只能放模型、超时、并发等非安全参数。`loadConfig` 发现 options 试图放宽安全策略时拒绝启动。

**理由**：这是「Agent 工具适配」的真正差异点之一；不抽象会把 Claude 的工具名或 Codex 的沙箱参数写进内核。`fileAccess` 在 Claude 上只是约定（没有 OS 级文件沙箱），必须在文档和 doctor 里明确，不能宣称已强制隔离。

### D11：按 `assignment.runtimeId` 路由，而不是全局单运行时

**决策**：`RuntimeRegistry` 按 id 持有多个 runtime；所有生命周期操作先解析 assignment，再用 `registry.get(assignment.runtimeId)`。`config.runtime.default` 只决定新工单用哪个运行时。

**理由**：切换默认运行时后，旧 Orca 工单的 handle 不能交给 Claude/Codex；同一实例必须允许 Orca 与 Claude 工单共存。

**约束**：
- **已有 assignment** 的 `stop/deliver/status/activity/cleanup`：从 `latestAssignment(ticketId).runtimeId` 反查；
- **launch / relaunch**（首次派工还没有 assignment）：用 `registry.default()`，或由 effect payload 显式带 `runtimeId`；`launch-worker` 不适用「从 latestAssignment 反查」；
- 手工绑定 Assignment 时校验 `runtimeId` 已注册，不允许写入未知运行时；
- 运行时不存在时抛 `runtime:unknown`，转人工，不回退到默认运行时；
- `loadConfig` / `ra serve` 启动时校验 `runtime.default` 已注册；P2 只注册 `orca`，因此 P2 阶段配置成 `claude-code` 必须在启动期 fail-fast，而不是等第一张工单派工时才报错。

### D12：默认安全边界：环境变量白名单 + 最小工具权限 + 单实例锁

**决策**：
- Agent 子进程只继承显式 allowlist 的环境变量；prompt 走 stdin/临时文件，不进 argv；
- Claude 默认 `permission-mode=acceptEdits` + 命令级 `Bash(ra report:*) / Bash(ra doc:*) / Bash(git:*) / Bash(gh:*)`，**不放行裸 `Bash`、不放行 `ra config/stop/serve`**；Codex 默认 `-s workspace-write` 且关闭网络；`allowNetwork` 默认 `false`；
- `ra serve` 使用独占文件锁保证单实例；同一工单的 launch/cleanup 按 ticket 加进程内互斥，同一 repo 的 worktree 操作串行化；
- `ra report` 增加 `--port` / `RA_PORT`，不再依赖读取完整 `config.yaml`；`ra doc` 优先走 Router 代理，避免 Agent 直接持有飞书凭证；`ra config` 默认脱敏，`ra stop / config set / serve` 不进入 Worker 白名单。

**残余风险（必须写进文档与 doctor）**：git/gh 需要真实 `HOME`，因此 Agent 仍可能读到 `~/.router-agent/config.yaml` 里的模型/飞书凭证、`~/.ssh` 等；此外 Bash 前缀白名单不是安全沙箱（`ra report; rm` 这类拼接仍可能绕过），只能降低风险，不能证明隔离。一期只能通过最小权限 + 命令白名单缓解；彻底隔离需要 macOS `sandbox-exec` / 容器 / 独立 OS 用户，列为后续安全加固项。

**理由**：工单内容来自飞书，属于不可信输入；新运行时会把「一个工单一个可执行 Agent」变成常态，默认权限必须比 Orca 交互式终端更保守。

---

## 8. Orca 适配器改造映射

### 8.1 拆分方式（行为不变）

```text
OrcaRuntime (id='orca')
├── OrcaProvisioner                # 内部实现，不强制实现 5.1 的严格 create 语义
│   ├── createAndLaunch(req)  → orca worktree create --agent claude ...
│   ├── inspect(ref)          → orca worktree show
│   ├── remove(ref)           → orca worktree rm
│   └── listRepos()           → orca repo list --json
├── OrcaTerminalRuntime
│   ├── send / status / output / stop → orca terminal ...
│   └── launch 由 createAndLaunch 完成
└── ClaudeSessionActivity
    └── read(query) → 先按 sessionId 精确匹配，找不到再退最新文件
```

> 说明：Orca 的 `createAndLaunch` 把「建 worktree」和「起 Agent」合成一条命令，因此它**不必**严格实现 `WorkspaceProvider.create()`；`WorkerRuntime.start()` 是唯一对外契约。Claude/Codex 等新运行时才使用严格的 `GitWorktreeProvider + AgentRuntime` 组合。

### 8.2 行为保持清单

- `worktree create` 参数完全不变：`--repo` 选择器、`--name`、`--base-branch`、`--branch`、`--agent claude`、`--surface terminal`、`--prompt`、`--no-parent`、`--setup skip`、`--json`（`commands.ts:21-36`）。
- `meta.json` 旧字段全部保留，按 9.4 的 v2 增量扩展（`schemaVersion/process/sessionId/logPath/status/lastHandedOff*`）；Orca 写入时机不变。
- 失败诊断字段 `orcaCode / operationId / cause / args / stdout / stderr` 不变，只是从 `OrcaCommandError` 转成 `WorkerRuntimeError.detail`。
- `judgeIdle` 的最终判定由 Router 的 `classifyAgentStatus` + `idleAfterMs` 计算；Orca adapter 只提供 `lastActivityAt / acceptingInput / phase`，不再直接产出 idle/orphaned 结论。
- `checkIdle` 在 Orca 下仍然只在 `capabilities.agent.liveStatus=true` 时运行。

**Orca 字段 → `AgentStatus` 映射**：

| Orca 信号 | `AgentStatus` | 说明 |
|-|-|-|
| `orca terminal list` 命令失败/超时 | `null` | 无法判断，不判死 |
| `inspect(handle) === null`（列表里没有该 handle） | `alive=false, phase='lost'` | 终端确实没了；不能映射成 null |
| `connected=false` | `alive=false, phase='lost'` | 终端确实没了 |
| `orphaned && !writable` | `alive=false, phase='unknown'` | 现 `checkIdle` 不动作；保持「不判死」，但也不推断存活。注意这会让 `isZombie` 从「可能按 lastOutputAt 判真」变成 `false`，属于有意的保守化，P1 加回归测试 |
| `orphaned && writable` | `alive=true, phase='running'` | 实测 CLI 创建的终端可能 orphaned 但可用 |
| `lastOutputAt` | `lastActivityAt` | idle 由 Router 按 `idleAfterMs` 计算，adapter 不产出 idle |
| `writable` | `acceptingInput` | 只有可写才允许 `deliver` |
| 其他/异常 | `null` | 不判死、不判僵尸 |

### 8.3 需要顺手修掉的问题

| 问题 | 修法 |
|-|-|
| `isZombie` 把「无 inspect」当僵尸 | 改为「无 status / null → 不判僵尸」，并统一 6.4 矩阵 |
| `deliver` 失败每秒重试 | 增加 `delivery-failure:<ticket>` 游标（attempts/lastInputId/nextAt），按 `retryable` 退避；超限转人工 |
| 投递成功但未 ack 仍每 tick 重投 | 按 `(input.id, attempt)` 去重 + 单飞；Router 退避后带 `attempt+1 / redeliver=true` 串行重投，adapter 必须允许再次 resume |
| launch 半成功留下 worktree/branch | `start()` 失败时把已创建的 `workdir/branch` 放进 `WorkerRuntimeError.detail`；Router 落库后入队 cleanup；adapter best-effort 回滚 |
| 进程退出但未上报被当作 idle | `status` 区分 `exited` + `exitCode`；非 0 退出在 grace 窗口后转人工，不进入可 resume 的 idle |
| 崩溃/挂起没有看门狗 | 增加 wall-clock 超时（默认 2h）与输出停滞超时（默认 15min）；`markZombie` 停止已挂起进程，或明确提示人工保留 |
| `findByBranch` 未使用 | 接进 `trackPullRequests` 的兜底路径（见 D9） |
| `relaunchAgent` 死代码 | 要么接到「worker 丢失后重开」流程，要么删除 |
| `OrcaCommandError` 泄漏到 service | 在 adapter 边界映射为 `WorkerRuntimeError`；`describeLaunchError` 改读中立字段 |
| 全局单 runtime | 按 `assignment.runtimeId` 从注册表取 runtime（见 D11） |

---

## 9. 新运行时落地方案

### 9.1 Claude Code CLI Adapter

**先回答追问能力**：Claude Code CLI **可以在 CLI 层实现追问**，但有三条路径，语义不同：

1. **`claude --bg` + `claude agents` 会话管理（推荐，也是本次实测采用的方案）**
   - 首轮：`claude --bg "<任务描述>"` 起后台会话，打印 short id；
   - 追问：本轮结束后 `claude --bg --resume <sessionId> "<追问>"`，**不能带新的 flags**（会 fork 副本），会话 id 不变；
   - 当前会话还在 `working` / `blocked` 时执行 `--bg --resume` 会**新建一个副本**（新 id），因此 Router 必须等 `state=done/stopped` 再追投，或先 `claude stop` 再 resume；
   - `claude agents` 是 agent view，`claude agents --json --all` 是给脚本用的结构化视图；`claude attach` 可以人工接管/复原会话。
2. **`claude -p --input-format stream-json --output-format stream-json`**：`--print` 模式支持实时流式输入，能在一轮进行中追加消息；但 Router 要自己持有长驻进程、解析 JSON 事件，复杂度高，且失去 agent view。
3. **Claude Agent SDK / ACP**：程序化控制最完整，但引入额外依赖与协议，同样失去 CLI 的 agent view；一期不需要。

**结论**：不需要因为「追问」强制上 SDK 或 ACP。一期用 `--bg` + `--resume`，把「追问在当前轮结束后生效」作为明确语义；只有未来要求「轮内实时打断/插话」时，才评估 `stream-json` 或 SDK/ACP。

**「追问在当轮结束后生效」是什么意思**：

- **一轮** = Claude 的一次完整回复周期（可能包含多次工具调用），不是整张工单；
- 后台会话在 `working` 时没有安全的「插话」接口：`--bg --resume` 会 fork 副本，`attach` 是交互式接管，不适合 Router 自动操作。所以 Router 把追问存进 `inputs`，等当前轮 `done`（或显式 `claude stop`）后，再用 `--bg --resume` 送给同一个会话；
- 这和你直接在 Claude Code 终端里「它正在干活时先打一句话」的体验一致：那句话不会立刻打断当前轮，而是排在当前轮之后执行；区别是 Router 会持久化、可重试、可审计；
- 例子：10:00 开工 → 10:01 用户在飞书追问「顺便把测试补上」→ 10:05 当前轮结束 → Router 自动 `claude --bg --resume <sessionId> "顺便把测试补上"`，同一个会话继续；
- 如果用户要求**立刻打断**：Router 先 `claude stop <id>`（会话保留），再带追问 resume；代价是当前轮未完成的工作可能被中断；
- 如果必须「边干边插话」：需要 `claude -p --input-format stream-json` 或 SDK/ACP；一期不采用，按上面的回合制语义实现。

**工作区**：`GitWorktreeProvider`
```bash
git worktree add -b <workBranch> -- <workdir> <baseBranch>
git worktree list --porcelain
git worktree remove -- <workdir>
```

**启动（首轮）**：
- worker 契约写入 `~/.router-agent/workers/<ticketId>/brief.md`，prompt 只指向文件，避免 argv / `ps` 泄露整段手册；
- 启动：
```bash
claude --bg --name <ticketId>-<slug> \
  --add-dir <workersDir>/<ticketId> \
  --permission-mode acceptEdits \
  --model <model> \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash(ra report:*),Bash(ra doc:*),Bash(git:*),Bash(gh:*),Bash(pnpm:*),Bash(npm:*),Bash(npx:*),Bash(node:*),Bash(python:*),Bash(pytest:*)" \
  -- "Read <briefPath> and execute the ticket. Report via ra report."
```
- `--bg` 打印 short id（实测如 `e46aaf7e`），adapter 解析后作为 `handle`；
- adapter 读取 `claude agents --json --all` 中该 id 的 `sessionId`（UUID）、`pid`、`startedAt`、`state`、`status`、`waitingFor`，写入 meta v2（9.4）；
- `env` 使用显式 allowlist；**不需要 `ProcessSpawner`**，进程生命周期由 Claude 自己的后台管理负责。

**状态**：`claude agents --json --all` 过滤 `kind=background` 且 `id=handle`：

| Claude 字段 | `AgentStatus` |
|-|-|
| `state=working, status=busy` | `phase='running', alive=true, acceptingInput=false` |
| `state=blocked, status=waiting, waitingFor='permission prompt'` | `phase='blocked', alive=true, acceptingInput=true`；Router 置 attention，不自动 resume |
| `state=done` / `state=stopped` | `phase='exited', acceptingInput=true`（可 resume） |
| 查询成功但 id 不存在 | `phase='lost', alive=false` |
| 查询命令失败 / 超时 | `null` |

`startedAt` 是毫秒时间戳，转 ISO；`lastActivityAt` 取 session JSONL 的 mtime 或最后一条事件时间。`claude logs` 是 TUI 渲染（含 ANSI/spinner），只作为最后兜底并清洗，不用于状态判定。

**追问投递**：
- `working`：通过 `claude attach <id>` 把输入敲进 TUI 输入框并回车，CLI 会把它当作「本轮中途发来的消息」交给当前回合（与用户在 TUI 里连续追问一致，不产生新会话）；注入后用会话记录校验是否真的收下，校验不过则退回 `queued`；
- `blocked`：`deliver` 返回 `queued`，输入留在 `inputs` 表并置 attention（权限/人工），等状态变成 `done/stopped` 再投；此时插话不会被执行；
- `done/stopped`：先 `claude stop <id>` 停掉后台 worker（会话与对话都保留），再 `claude --bg --resume <完整 sessionId> "<short input>"`，**不带任何新 flags**；输入正文写临时文件，prompt 只指向文件；
- 必须传完整 session id（`claude agents --json` 打印的 UUID）：传 short id 会被 CLI 判成另开一个会话；
- 同一 `sessionId` 单飞；按 `(input.id, attempt)` 去重；如果 `--resume` 仍产生新 id（fork），adapter 必须停掉副本、保留原会话并退避重投，禁止静默切换 handle。

**活动**：`ClaudeSessionActivity` 按 `sessionId` 精确匹配 `~/.claude/projects/<slug>/<sessionId>.jsonl`；找不到返回 `null`，不退化成「最新文件」，避免串工单。

**停止 / 清理 / 人工接管**：
- `stop` → `claude stop <id>`（保留会话，支持再次 resume）；
- 清理 → 先 `claude stop`，再用 `GitWorktreeProvider` 删除 worktree；**不要用 `claude rm` 清理 Router 管理的 worktree**（它会连带删除它认为属于该会话的 worktree，对非 Claude 创建的 worktree 行为不明确）；删除会话记录如需使用 `claude rm`，必须限定 `cwd` 且单独显式执行；
- `claude attach <id>` 是人工入口：用户可在 agent view 里恢复、接管、回答权限提示，Router 不代劳。

**风险**：
- `state=blocked` 是权限/人工输入卡点；headless 场景默认用 `acceptEdits` + 命令级 `allowedTools` 尽量不触发，但无法完全避免；
- `--bg --resume` 在不满足条件时会 fork 副本（会话还在跑 / 被别的进程打开 / 状态读不到）；adapter 必须把“新 id”当错误而不是成功；
- `cli` 版本升级可能改变 `agents --json` 字段；解析器要按版本容错，失败返回 `null`；
- Claude 没有 OS 级文件沙箱：`fileAccess` 只是约定；需要强制隔离时用 macOS `sandbox-exec` 或容器，一期不做，但必须在 doctor 里提示风险。

### 9.2 Codex CLI Adapter

**工作区**：同上 `GitWorktreeProvider`。

**启动（首轮）**：
```bash
# 契约正文通过 stdin 传入；沙箱默认 workspace-write，网络默认关闭（具体配置键按版本实测）
codex exec --json -C <workdir> -s workspace-write - < contract.txt
```
从 `--json` 事件流或 `~/.codex/sessions/**/rollout-*.jsonl` 的 `session_meta.payload.session_id` 捕获 sessionId；同时记录 `session_meta.payload.cwd` 做二次校验。

**追问投递**：
```bash
codex exec resume <sessionId> --json - < input.txt
```
（`--json` 是否在 `resume` 子命令上可用需实测；不可用则退回 stdout 文本。输入同样走 stdin，不放 argv。）

**状态**：同 Claude，子进程 + rollout 文件；`exitCode` 来自 `ProcessSpawner.wait()`。

**活动**：`CodexSessionActivity` 解析 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`：
- 先按 `session_meta.payload.session_id` 精确匹配，再用 `cwd` 二次校验；匹配不到返回 `null`，禁止取“最新一个”；
- `response_item.payload.type=message, role=assistant` 提取文本；
- 工具调用按 Codex 的事件结构归一成 `SessionEvent { kind: 'tool', tool }`；
- 只读文件尾部，保持 `maxBytes/maxEvents` 有界；限制候选文件数（例如最近 20 个）与目录深度。

**风险**：
- Codex 的沙箱/审批默认值比 Claude 更严格；非交互模式下的命令失败要有清晰提示。
- 事件格式随版本变化，解析器要按版本容错，未知事件跳过。

### 9.3 GitWorktreeProvider 的边界

- 只做 `git worktree`，不做 Agent 启动；
- `repo` 选择器支持 `path:/abs` 或本地配置路径；远程 `owner/repo` 需要先 clone，一期不支持；
- `remove` 默认不带 `--force`，脏工作区交给 git 拒绝；
- 与 Orca 一样，`create` 返回实际分支（可能被占用后加后缀）；
- **参数安全**：所有位置参数前加 `--`，`branch/baseBranch` 先用 `git check-ref-format --branch` 校验并拒绝 `-` 前缀，防止 git 选项注入；
- **路径约束**：`path:` 必须 `realpath` 后落在配置的仓库根目录内；`workdir` 必须落在受管 worktrees 根目录内，拒绝 `..`、任意绝对路径与符号链接逃逸；
- **失败回滚**：`git worktree add` 成功但 Agent 启动失败时，adapter 对本次新建的 worktree/branch 做 best-effort 清理（`git worktree remove --force` + `git branch -D`），失败则把 `workdir/branch` 放进错误 detail，交给 Router 入队 cleanup；
- **PR 兜底**：本地路径仓库的 `owner/name` 从 `git remote get-url origin` 推导；推导失败则跳过 `gh pr list --repo`，只依赖 Worker 上报。

### 9.4 运行时自有元数据：`meta.json` v2

所有运行时共用一个 `~/.router-agent/workers/<ticketId>/meta.json`，但字段语义必须统一。v2 在现有字段上增量扩展，旧字段保留：

```ts
export interface WorkerMetaV2 {
  schemaVersion: 2
  ticketId: string
  assignmentId: string
  runtime: string
  handle: string
  workdir: string
  statePath: string
  eventsPath: string
  repo: string
  /** 起始分支（base branch）；与 ticket.branch 同义。 */
  branch: string
  /** 实际工作分支（可能被 provider 加后缀）；D9 用它做 gh pr list --head。 */
  workBranch: string
  /** Claude/Codex 等非 Orca 运行时：进程身份，用于重启后校验与 stop。Orca 无独立进程，留空。 */
  process?: ProcessIdentity
  sessionId?: string
  logPath?: string
  /** adapter 内部状态，只用于诊断。 */
  status: 'starting' | 'running' | 'exited' | 'lost'
  /** 最近一次成功 handoff 的输入与 attempt；并发去重用，不阻止串行重投。 */
  lastHandedOffInputId?: string
  lastHandedOffAttempt?: number
  startedAt: string
}
```

**写入时机（逐运行时）**：
- **Orca**：`worktree create` 返回后写一次（现状不变）；`branch`=起始分支，`workBranch`=实际分支；没有 `process`/`sessionId`；
- **Claude**：调用 `claude --bg` 前写 `status='starting'`；拿到 short id 后查 `agents --json --all`，补 `sessionId/pid/startedAt`；`process.argv` 记录启动命令（不含 brief 正文）；`state=blocked/done/stopped` 只更新 meta 的 `status`，不写 `exit.json`；
- **Codex**：spawn 前原子写 `{ status:'starting', process:{pid:0,...} }`，spawn 后补 `pid/startedAt/argv/cwd/sessionId/logPath`；进程退出后写 `exit.json` 并更新 `status='exited'`；
- `meta.json` 用临时文件 + rename 原子替换；找不到 meta 时 `status()` 返回 `null`，不能默认存活，也不能直接判 lost；
- **字段歧义消除**：`branch` 永远是起始分支，`workBranch` 永远是实际工作分支；D9 / PR 兜底只读 `workBranch`。

### 9.5 前端/CLI 展示

`Assignment.runtimeId` 已存在，`ra ticket` / Web 面板可以显示 `orca / claude-code / codex-cli`；不需要改状态机。

---

## 10. RouterService 改造清单

| 位置 | 现状 | 改造 |
|-|-|-|
| `src/service.ts:14` | import `OrcaTerminalInfo / OrcaCommandError` | 删除；只 import `worker/port.js` 中立类型 |
| `service.ts:40-44 / 443-447 / 1633-1638` | `runtime` 交叉类型挂 `inspect/inspectWorktree/removeWorktree` | 删除交叉类型；端口新增 `status/output/activity/inspectWorkspace/removeWorkspace`（今天端口没有声明这些） |
| `service.ts:488 / 709 / 836 / 1172 / 1521` | 所有操作都用全局 `this.runtime` | 已有 assignment 的操作按 `assignment.runtimeId` 路由；launch/relaunch 用 `registry.default()` 或 effect 显式 runtimeId（D11） |
| `service.ts:884-929 checkIdle` | 只认 Orca 终端字段 | 改读 `runtime.status?.()`；按 6.3 决定是否 `nudge`；无能力则跳过 |
| `service.ts:1023-1040 isZombie` | 无 inspect 直接判僵尸 | 消费 `classifyAgentStatus`：keep 才按 `lastActivityAt` 判；unknown→false；lost/transfer→true |
| `service.ts:1165-1205 cleanupWorkspace` | `removeWorktree('path:' + workdir)` | `removeWorkspace({ticketId, workdir})`；`not-found` 视为成功；无能力则通知 |
| `service.ts:1373-1396 probeTicket` | `inspect` + `session` + `read` | `status` 可选 + `activity(query)` 优先 + `output` 兜底 |
| `service.ts:1475-1497 trackPullRequests` | 只靠 Orca `linkedPR` + `gh view` | 补 `inspectWorkspace().linkedPr`、`workBranch`、`findByBranch`（D9） |
| `service.ts:1518-1552 recover` | 依赖 `inspect.connected/orphaned` | 消费 `classifyAgentStatus`；unknown 保持，lost 转人工，transfer 置 attention |
| `service.ts:1557-1565 workerGone` | 依赖 `inspect` | 消费 `classifyAgentStatus`；unknown→false；lost/transfer→true |
| `service.ts:819-852 deliverPendingInputs` | 失败/未 ack 每秒重投 | 增加 `delivery-failure` 游标 + 指数退避；`attempt+1/redeliver` 串行重投；按 `DeliveryReceipt` 与 `retryable` 分流 |
| `service.ts:1686-1719 describeLaunchError` | `instanceof OrcaCommandError`，`LaunchErrorDetail.orcaCode` | 改读 `WorkerRuntimeError.code/cause/detail`；`orcaCode` 改为中立 `providerCode` |
| `src/router/api.ts:9 / 118` | import `WorkerStateFile` 旧路径；写死 `runtime.default` | 改从 `worker/port.js` 导入；手工绑定校验 runtimeId 存在 |
| `worker/orca/report-poller.ts:156-176 judgeIdle` | Orca 字段判定 | 上移到 `worker/status.ts`，输入 `AgentStatus`；映射表见 8.2 |
| `worker/orca/report-poller.ts:68-110 ReportPoller` | 与运行时无关但路径在 orca 下 | P0 上移到 `worker/report-poller.ts`，旧路径 re-export |
| `worker/spec/index.ts:22-36 buildWorkerPrompt` | 在 OrcaRuntime 内拼手册 | 抽出 `buildWorkerBrief`（中立）；**Orca 继续使用现有 `prompt-mode.md` 原文**，保证零行为变化；新运行时用 `contract.md` + 自己的启动包装 |
| `worker/naming.ts` | 注释写 Orca | 改成运行时中立说明（逻辑本来就是 git） |
| `worker/spec/prompt-mode.md` | 写死 Orca / Claude | 拆成 `contract.md`（中立）+ `claude-agent.md`（专属） |

**验收口径**：`grep -rn "Orca\|orca" src/service.ts src/router/api.ts src/core src/store` 应该只剩注释/配置说明；例外只允许 `worker/runtimes/orca/**` 与 re-export 层。

---

## 11. 配置、CLI 与自检

### 11.1 配置

```yaml
runtime:
  default: orca            # 兼容旧值；可为 claude-code / codex-cli（必须已注册，否则启动失败）
  options:                 # 只放非安全参数：模型、超时、并发
    claude-code:
      model: sonnet
      turnTimeoutMs: 7200000
    codex-cli:
      model: gpt-5-codex
      turnTimeoutMs: 7200000

# 中立工具策略：Router 生成，adapter 只映射；安全参数不可被 runtime.options 覆盖
worker:
  tools:
    fileAccess: read-write
    shell: allowlist
    shellAllow: ["ra report", "ra doc", "git", "gh", "pnpm", "npm", "npx", "node", "python", "pytest"]
    allowNetwork: false
```

- `src/config.ts` 的 `runtime` 从 `{ default: 'orca' }` 放宽为 `{ default: string; options?: Record<string, unknown> }`。
- `loadConfig` 必须真正解析 `doc.runtime.default / doc.runtime.options`（当前写死 `{ default: 'orca' }`，见 `config.ts:232/399`）；非法值或未注册值抛 `runtime:unknown`，旧配置缺省仍是 `orca`。
- `config set runtime.default claude-code` 不再被 `value !== 'orca'` 拒绝（`config.ts:899-901`）。
- `src/router/api.ts:118` 手工绑定 Assignment 时用配置的 runtime，并校验 `runtimeId` 已注册，而不是写死 `'orca'`。
- `ToolPolicy` 由 `worker.tools` 生成；`allowedTools / permissionMode / sandbox / shellAllow / allowNetwork` 等安全参数只能来自 `worker.tools` 与 adapter 内置安全基线，`runtime.options` 不允许覆盖；`loadConfig` 发现放宽尝试直接拒绝。
- `shellAllow` 按命令前缀匹配：`ra report` / `ra doc` 可用，`ra config` / `ra stop` / `ra serve` 不在白名单。

### 11.2 注册表

```ts
// packages/runtime/src/registry.ts
export class RuntimeRegistry {
  constructor(
    private runtimes: Map<string, WorkerRuntime>,
    private defaultId: string,
  ) {}
  get(id: string): WorkerRuntime {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new WorkerRuntimeError('runtime:unknown', `未知 runtime: ${id}`)
    return runtime
  }
  default(): WorkerRuntime { return this.get(this.defaultId) }
}

// P2 只注册已经存在的运行时；新增运行时在主 PR 里追加 case，避免单独合并时编译失败。
export function createRuntimes(config: AppConfig, deps: RuntimeDeps): RuntimeRegistry {
  const runtimes = new Map<string, WorkerRuntime>()
  runtimes.set('orca', new OrcaRuntime(deps))
  // P3: runtimes.set('claude-code', new ClaudeCodeRuntime(deps))
  // P4: runtimes.set('codex-cli', new CodexCliRuntime(deps))
  return new RuntimeRegistry(runtimes, config.runtime.default)
}
```

`RuntimeDeps` 包含 `commandRunner / processSpawner / workersDir / home / specMode / claudeProjectsDir? / codexHome? / envAllowlist`，便于测试注入。

### 11.3 doctor / init

- `runDoctor` 的 Orca 检查改成「当前 runtime 的自检」：
  - `runtime.doctor?.()` 返回 `DiagnosticCheck[]`；
  - Orca 实现：`orca status` + `orca repo list`；
  - Claude/Codex 实现：可执行文件存在、版本、认证状态（`claude --version` / `codex --version`，认证能检测则检测，不能则跳过）。
- `ra init` 的仓库选择：`runtime.listRepos?.()`；无能力时退回手输，不因为 Orca 不在而阻塞。
- `parseOrcaStatus / parseOrcaRepos` 从 `sources/lark.ts` 移到 `worker/runtimes/orca/parse.ts`（它们与飞书无关，放 lark.ts 是历史遗留）。

---

## 12. 兼容性与数据模型

- **数据库**：不改表。`assignments.runtime_id / handle / workdir` 足够；`sessionId / process / workBranch / lastHandedOff*` 由 adapter 写在 `~/.router-agent/workers/<ticketId>/meta.json`（v2，见 9.4），Router 通过 `WorkerRef { ticketId, workdir, sessionId? }` 让 adapter 自己读取。实际工作分支从 `meta.workBranch` 或 `inspectWorkspace().branch` 获取，不新增列。若未来某 provider 需要不可推导的 ref，再加 nullable 列 `workspace_ref`（独立迁移，不在本期）。
- **旧工单**：`runtime_id='orca'` 继续工作；所有生命周期操作按 `assignment.runtimeId` 路由，不会被新默认运行时接管。
- **旧配置**：缺 `runtime` 时默认 `orca`；`runtime.default: orca` 继续有效；`loadConfig` 必须解析该字段（当前是写死值）。
- **旧 effect**：`launch-worker / stop-worker / cleanup-workspace` 的 payload 不变；已有 assignment 的 handler 从 latest assignment 反查 runtimeId，launch 用 `registry.default()`，也可在 payload 追加可选 `runtimeId` 覆盖。
- **报告协议**：完全不变；`state.json` 仍是兜底。
- **日志/审计**：`launch` 日志继续带 `handle/workdir`；新运行时追加 `runtimeId`，不改变现有字段。
- **meta 半状态**：`meta.json` 原子写入；找不到 meta 时 `status()` 返回 `null`，不默认存活、也不直接判丢失。

---

## 13. 实施计划（可分阶段合并）

> **交付节奏**：一期 = P0 + P1 + P2 + P3，**Claude Code CLI 运行时随一期一起交付**；二期 = P4 + P5（Codex CLI 与旧路径清理）。
> 每一阶段仍保持独立可合并、可 revert；P3 不拆到二期。

### P0 · 契约先行（不改行为，可独立合并）

- 新增 `packages/runtime/src/port.ts` 的中立模型与 `WorkerRuntime` v2（含 `WorkerRef / StartResult / DeliveryReceipt / AgentStatus | null`）；
- **同时**把 `report-poller.ts` / `judgeIdle` 上移到 `packages/runtime/src/`（旧路径 re-export），否则 `service.ts:13` 的旧 import 会让「去 Orca 化」验收失败；
- `OrcaRuntime` 实现新签名（`status` 包装 `inspect`、`output` 包装 `read`、`activity` 包装 `session`、`inspectWorkspace/removeWorkspace` 包装旧方法）；
- `RouterService` 改成只依赖端口；`describeLaunchError` 改读 `WorkerRuntimeError`；`src/router/api.ts` 的旧路径 import 一并修正；
- 新增 `buildWorkerContext()` 与 `buildWorkerBrief()`：report 路径由 `workersDir` 推导，tools 来自 `config.worker.tools`；Orca 走 `buildOrcaBrief()`，输出必须与当前 `buildWorkerPrompt()` 逐字节一致；
- `AppConfig` 新增 `worker.tools` 默认值（先不接 CLI）；
- 新增 `tests/worker/contract.test.ts`，先只跑 Orca fake；新增 Orca prompt snapshot 测试。
- **验收**：现有测试全绿；`ra simulate` / 现有 Orca 路径行为不变；`grep` 验收通过（含 `src/router/api.ts`）。
- **回滚**：直接 revert 本 PR；旧路径 re-export 保证下游 import 不变。

### P1 · 拆 Orca 实现 + 失败模式修复

- Orca 拆成 `OrcaProvisioner / OrcaTerminalRuntime / ClaudeSessionActivity`，`OrcaRuntime` 组合；
- 修掉 8.3 表中的问题：`isZombie` 未知误判、投递失败/未 ack 重投、launch 半成功残留、进程退出未上报、`findByBranch` 未接线、`describeLaunchError` 强类型；
- 实现 Orca `nudge()`（内部 `terminal send status?`），`checkIdle` 不再用 `deliver` 发送控制信号；
- 重写 `judgeIdle` 单测，按 6.4 的 `classifyAgentStatus` 映射表覆盖。
- **验收**：Orca 真实链路（`docs/VERIFICATION.md`）重跑通过；新增 6.4 矩阵测试、launch 失败无残留测试、重复 deliver 幂等测试。
- **回滚**：revert 本 PR；P0 的契约与 re-export 保留。

### P2 · 配置、注册表与装配

- `loadConfig` 真正解析 `runtime.default / runtime.options`（当前写死）；启动期校验 default 已注册，未知值 fail-fast；
- `RuntimeRegistry` 按 id 取运行时；已有 assignment 的生命周期操作按 `assignment.runtimeId` 路由；launch/relaunch 用 `registry.default()` 或 effect 显式 runtimeId；
- `ra serve` 用注册表；`runtime.default` 只决定新工单；P2 只注册 `orca`，配置其他值直接启动失败；P3 在同一期追加 `claude-code`；
- doctor/init 改为 runtime 自检/仓库发现；
- 加 `ra serve` 单实例锁 + 工单 launch lease + repo 级 worktree 串行化。
- **验收**：旧 Orca 工单与手工绑定继续工作；未知 runtime 明确报错；单实例测试通过。
- **回滚**：注册表只注册 `orca`，`runtime.default=orca`。

### P3 · Claude Code CLI 运行时（一期必须交付）

- **前置安全项**：`ra report` 支持 `--port` / `RA_PORT`；`ra doc` 走 Router 代理（或使用只读最小 `RA_HOME`），避免 Agent 依赖完整 `config.yaml`；
- `GitWorktreeProvider`（含 `--`、分支校验、路径约束、失败回滚）；
- `ClaudeCodeRuntime`：`claude --bg` 启动、`claude agents --json --all` 读状态、`claude --bg --resume` 追问、`claude stop` 停止；brief 写文件，env allowlist，单飞 + 按 `(input.id, attempt)` 幂等；
- `ClaudeSessionActivity` 复用，按 sessionId 精确定位；`claude logs` 仅作兜底且必须清洗 ANSI；
- 明确语义：追问在当前轮结束后生效；`blocked` 置 attention 等人工，不自动 resume；不实现轮内实时插话。
- **验收**：在临时仓库跑通「接单 → 改文件 → `ra report` → PR → 闭环」；`ra doctor` 通过；launch 失败无残留；重复 tick 只投递一次；`--resume` 产生新 id 时明确报错；Router 重启后能从 `agents --json --all` 找回 done/stopped 会话。
- **风险**：权限/认证/模型额度；`blocked` 权限提示；CLI 版本字段变化。
- **回滚**：不注册 `claude-code`；默认仍 `orca`。

**一期总验收（P0–P3 一起）**：
- Orca 路径行为不变，现有测试全绿；
- `runtime.default` 可在 `orca` / `claude-code` 间切换，旧工单按 `assignment.runtimeId` 走原运行时；
- Claude 临时仓库完整链路跑通：接单 → 改文件 → `ra report` → PR → 闭环；
- 追问在当轮结束后自动送达；`blocked` 能转人工；Router 重启后能找回 done/stopped 会话；
- `ra doctor` 能同时检查 Orca 与 Claude CLI 的可执行文件、认证与仓库可见性；
- 安全项：env allowlist、`ra report` 免 config、prompt 走文件、无裸 `Bash`。

### P4 · Codex CLI 运行时（二期）

> 2026-11-10 更新：已先交付 `codex-app`（Codex App Server 直连）运行时，支持 thread/resume、turn/steer、原生审批与桌面端 `codex://threads/<id>` 深链；详见 [RUNTIME.md](RUNTIME.md)。本节的 `codex-cli` 方案保留为 App Server 不可用时的兜底。

- `CodexCliRuntime`（`codex exec --json` + `codex exec resume`，stdin 传 prompt，沙箱/网络默认保守）；
- `CodexSessionActivity`（sessionId + cwd 双条件，候选文件有界）；
- 版本容错与事件解析测试。
- **验收**：同上链路；会话活动能生成语义摘要；非 0 退出能转人工。
- **风险**：事件格式随版本变化；沙箱策略导致命令失败。
- **回滚**：不注册 `codex-cli`；默认仍 `orca`。

### P5 · 清理与文档（二期）

- 删除旧 `OrcaRuntime` 兼容层与死代码 `relaunchAgent`；
- 列出并修正所有旧路径 importer：`src/service.ts`、`src/router/api.ts`、`src/cli/index.ts`、`tests/**`；
- 同步 `scripts/build-web.mjs` 的 Markdown 资产数组与 `packages/runtime/src/spec/index.ts` 的文件名；
- README 更新「WorkerRuntime 是唯一扩展点」的能力矩阵；
- 新增 `docs/AGENT-ADAPTER.md`（本设计定稿版）。
- **验收**：`pnpm typecheck && pnpm build && pnpm test` 全绿；`ra doctor` 三运行时可切换。

---

## 14. 测试策略

### 14.1 契约测试（核心）

新增 `tests/worker/contract.test.ts`，**排入 P0/P1 验收**，对每个 runtime 跑同一套用例：

1. `start()` 返回非空 handle + workdir + 可用的 `WorkerRef`；
2. `deliver()` 返回 `DeliveryReceipt`；输入带 `in_xxx` 前缀；同一 `(input.id, attempt)` 的并发调用只 handoff 一次；`attempt+1 / redeliver=true` 的串行重投必须可达；
2.1 `nudge()` 只发控制信号，不产生 Input 行；`deliver()` 收到非 `in_` 前缀 id 视为契约违规；
3. `status()` 在未知 handle / 找不到 meta 时返回 `null`，不抛未捕获异常，也不返回 `lost`；
4. `stop()` 幂等：连续调用两次不报错；
5. `activity()` 读不到时返回 `null`；同 workdir 两个会话文件时只读目标 sessionId；
6. `removeWorkspace()` 对不存在目录视为成功；
7. `start()` 失败后不得残留 worktree/branch（或必须把 workdir 放进错误 detail）；
8. 所有错误都是 `WorkerRuntimeError`，`code` 在枚举内。

Orca 运行时用 fake `CommandRunner` 录放（现有 `tests/worker/orca.test.ts` 可复用）；Claude/Codex 用 fake `ProcessSpawner` + 临时会话文件。

### 14.2 回归测试

- 现有测试必须全绿（README 写 341，实际 `it/test` 数量以当前基线为准，不在方案里锁死数字）；
- 新增：
  - `isZombie` / `checkIdle` / `recover` / `workerGone` 对 `null` / `lost` / `exited` 的 6.4 矩阵逐项覆盖；
  - `deliver` 抛 `agent:gone` 后转失联；连续 tick 下未 ack 的重投按退避，不每秒执行；
  - `trackPullRequests` 在无 `linkedPr` 时调用 `findByBranch`，本地路径仓库不走 `gh --repo`；
  - 旧 `runtime_id='orca'` 工单与新 `claude-code` 工单共存时，各走各的运行时；
  - capability 降级矩阵逐项覆盖；
  - 环境变量 allowlist、prompt 不进 argv、日志脱敏、路径越界拒绝。

### 14.3 真实链路验收

- Orca：按 `docs/VERIFICATION.md` 的流程重跑。
- Claude CLI：临时 git 仓库 + `RA_*` 环境变量，跑完整链路；验证 `ra report` 能从 Agent shell 发出；验证失败重试不产生第二个 worktree。
- Codex CLI：同上；额外验证会话活动解析、非 0 退出转人工、网络默认关闭。

### 14.4 静态约束

- `tests/architecture.test.ts`（新增）：扫描 `src/service.ts`、`src/router/api.ts`、`packages/core/src/**`，禁止出现 `Orca` / `orca` 类型导入与字段访问（白名单：`worker/runtimes/orca/**`、re-export 层、注释）。
- `pnpm typecheck` + `pnpm build`。

---

## 15. 风险、开放问题与待实测清单

### 15.1 风险

| 风险 | 影响 | 缓解 |
|-|-|-|
| 不同 CLI 的权限/审批模型差异大 | 非交互任务卡住或失败 | 能力矩阵 + 明确默认值 + doctor 预检 |
| Claude 缺少 OS 级文件沙箱 | 默认 `read-write` 可能读到主目录/密钥 | 默认不放行裸 `Bash`；命令级白名单；doctor 明示“约定而非强制”；后续接 `sandbox-exec`/容器 |
| 子进程继承 Router 全量环境变量 | 飞书/模型/DB 密钥泄露给 Agent | `ProcessSpawner.env` 必填 + allowlist；测试覆盖 |
| Agent 可读真实 `HOME`（git/gh 需要） | `~/.router-agent/config.yaml`、`~/.ssh` 对 Agent 可见 | `ra report` 用 `--port`/`RA_PORT` 脱离 config；`ra doc` 走 Router 代理；后续 OS 沙箱/独立用户 |
| Bash 前缀白名单可被拼接绕过 | `ra report; rm` 之类命令仍可能执行 | 明确「白名单≠沙箱」；关键场景用 `sandbox-exec`/容器；doctor 提示风险 |
| prompt 走 argv | `ps` / 失败日志泄露整段工单 | stdin 或临时文件传参；`summarizeArgs` 位置参数只记长度 |
| Claude 追问在当前轮结束后才生效 | 用户追问延迟 | 端口语义允许「排队 + resume」，在话题里说明；需要轮内插话时再评估 stream-json / SDK |
| 未 ack 的输入被每 tick 重投 | Claude 下反复 `--bg --resume`，可能 fork 副本、烧 token | 按 `(input.id, attempt)` 幂等 + 单飞 + 指数退避 + 上限转人工 |
| 会话文件格式随版本变化 | 巡检摘要失效或读错会话 | 解析器版本容错 + sessionId 精确匹配 + 读不到退回 output |
| Orca 行为回归 | 现有用户路径受损 | 等价包装 + 契约测试 + 分阶段 revert |
| 新运行时没有 `linkedPR` | PR 闭环退化 | 补 `gh pr list --head` + 本地仓库 remote 推导 |
| Agent 无法执行 `ra` | 无法上报 | 接入前自检 `ra --version`；不支持则不能作为 Worker |
| 多实例/重复派工 | 重复 worktree、双份进程与 token | `ra serve` 独占锁 + 工单 launch lease + repo 级串行 |
| 进程崩溃/挂起 | 工单占并发槽、工作区不回收 | exit.json + 非 0 退出转人工 + wall-clock/停滞超时 + markZombie 调 stop |

### 15.2 待实测（实现前必须做）

1. Claude Code：`claude --bg --resume <sessionId>` 在 `blocked`（权限提示）状态下是否也 fork 副本；如果是，确认「blocked 只能人工 attach 或先 stop」的降级策略。
2. Claude Code：`acceptEdits` + 命令级 `Bash(ra report:*)` 在后台会话中是否按预期放行/拒绝；`blocked` 的常见触发条件与提示文案。
3. Codex：`codex exec resume <session> --json -` 是否存在并支持 stdin；`--json` 事件里 session id 的位置。
4. Codex：`-s workspace-write` 下 `git push` / `gh` 是否可用；网络关闭配置键的确切名称。
5. 两个 CLI 在 worktree 目录内的 `ra` 可见性（PATH / nvm / fnm），以及 env allowlist 下认证变量是否足够。
6. 会话文件在并发多工单时的定位准确性（sessionId + cwd 双条件，同 workdir 多会话）。
7. Codex 子进程退出码/信号在 detached 进程组下的捕获方式；Router 重启后 PID + startedAt + argv + cwd 校验的可靠性。
8. 同一工单重复 launch / 重复 deliver 时，git worktree 与 session 的单飞锁行为。
9. Claude `claude agents --json --all` 字段在版本升级中的稳定性；`state` 是否还有 `working/done/blocked/stopped` 之外的值。
10. `claude logs` 的 ANSI 清洗与 TUI 噪音过滤效果；是否只作为最后兜底。
11. `--add-dir` 是否随 `--bg` 会话保存；若 resume 后读不到 brief/input 文件，需要把文件写进 workdir 并加入 .git/info/exclude。

### 15.3 开放问题（需要产品/架构确认）

1. 追问语义默认按「当轮结束后生效」设计（与 Claude Code TUI 的输入排队一致）；是否接受？若必须轮内实时插话，需要 `stream-json` 或 SDK/ACP。
2. 一期 Claude CLI 已纳入交付，但默认运行时是否仍保持 Orca？是否先在某个项目/群绑定上试切 Claude？
3. 用户是否需要在飞书里感知「当前工单跑在哪个 Agent 运行时」？
4. Claude/Codex 的模型额度与 Router 的 Pi 额度是否分开计费/限额？

---

## 16. 评审记录（多轮评审）

> 本节记录 3 个独立视角的评审（接口完整性、可实施性、安全运维），以及作者一致性复核与第 5 轮独立闭环核验；所有修正已回写到对应章节。

### Round 1 · 接口完整性

- 检查点：每个 Orca 触点是否都有端口承接；内核是否还引私有类型；公共契约是否自洽。
- 发现与修正：
  1. `status/stop` 只收 handle，Claude/Codex 无法定位 pid/meta；`activity` 只收 workdir，丢失 sessionId → 统一改为 `WorkerRef { handle, ticketId, workdir?, sessionId? }` 与 `ActivityQuery`。
  2. §5 出现「子端口契约」与「扁平 WorkerRuntime」两套互不引用的类型 → 子端口降级为内部构件，公共契约只保留 `WorkerRuntime`（D1 / 5.4）。
  3. `registerContext` 在草案中消失 → 明确保留为可选兼容方法（当前 Router 未调用）。
  4. `status()` 非空类型与契约测试「返回 null」冲突 → 改为 `AgentStatus | null`，null 表示无法判断（5.4）。
  5. `checkIdle` 的 `status?` 控制信号与「输入必须带 in_ 前缀」冲突 → 新增可选 `nudge()`，业务输入与控制信号分离（D4 / 6.3）。
  6. `LaunchRequest` 的 `brief/report/tools` 没有生产来源 → 收进 `WorkerContext`，由 Router 拼装（5.4 / 10）。
- 结论：公共契约可覆盖现有全部触点，且不再有两套契约。

### Round 2 · 可实施性与迁移

- 检查点：分阶段是否可独立合并；旧数据/旧配置/旧工单是否兼容；测试能否兜住行为等价。
- 发现与修正：
  1. 全局单 `runtime` 不读 `assignment.runtimeId`，切换默认运行时会让旧 Orca 工单被新运行时接管 → 新增 D11 注册表按 assignment 路由。
  2. 未 ack 的输入会被每 tick 重投，headless 下变成 resume 风暴 → D4 增加幂等、单飞、指数退避、上限转人工。
  3. P0 验收与范围错位：`report-poller/judgeIdle`、`describeLaunchError`、`api.ts` 旧 import 未纳入 → P0 同步迁移并修正。
  4. `judgeIdle` 既要「语义不变」又要「字段中立」 → 补 Orca 字段到 `AgentStatus` 的映射表（8.2）。
  5. P2 注册表直接引用 P3/P4 才存在的类，无法单独编译 → P2 只注册 orca，新运行时在自己的 PR 追加；回滚改为 revert PR + 默认 orca，不再声称 feature flag。
  6. `start.branch` 被丢弃，D9 拿不到实际工作分支 → 改为通过 `inspectWorkspace().branch` 获取，不新增列。
  7. `loadConfig` 写死 `runtime.default` → 明确 P2 解析 `doc.runtime.default/options`。
  8. 本地路径仓库用 `gh pr list --repo` 会失败 → D9 增加 `git remote get-url origin` 推导。
- 结论：P0-P2 可在不引入新运行时的前提下完成并验证，P3/P4 各自独立可合并。

### Round 3 · 安全、运维与边界

- 检查点：默认权限、命令注入、子进程生命周期、失败重试、日志泄露、并发。
- 发现与修正：
  1. 初稿默认 `Bash` 全放行 + `acceptEdits`，等于给工单任意 shell → 改为命令级白名单 `Bash(ra report:*) / Bash(ra doc:*) / Bash(git:*) / Bash(gh:*)`，不放行裸 `Bash` 与 `ra config/stop/serve`；明确 Claude 没有 OS 级文件沙箱。
  2. 子进程默认继承 `process.env`，飞书/模型/DB 密钥会暴露 → `ProcessSpawner.env` 必填 + allowlist（D12 / 5.5）。
  3. `git worktree add` 位置参数可被 `-` 开头值注入，`path:` 可越界 → 全部加 `--`、`check-ref-format`、realpath 边界校验（9.3）。
  4. launch 半成功会留下 worktree/branch 且重试必冲突 → 失败时把 workdir/branch 放入错误 detail + best-effort 回滚 + Router 入队 cleanup。
  5. 进程退出但未上报被当作可 resume idle；挂起没有看门狗 → 增加 exit.json、非 0 退出转人工、wall-clock/停滞超时、markZombie 调 stop。
  6. PID/meta 无法从 handle 定位 → `WorkerRef` 带 ticketId/workdir；meta 原子写；PID + startedAt + 命令行三重校验。
  7. `activity` 按 mtime 猜最新会话，可能串工单 → sessionId 精确匹配 + cwd 二次校验 + 多候选返回 null。
  8. prompt 走 argv、stdout 进日志/巡检 → stdin/临时文件传参 + 统一 redact + stdout/stderr/detail 永不进飞书 + agent.log 0600。
  9. 缺少单实例锁与工单级互斥 → `ra serve` 独占锁 + launch lease + repo 级串行化。
  10. Agent 需要真实 `HOME` 跑 git/gh，仍可能读到 `config.yaml`/`~/.ssh` → `ra report --port` 脱离 config、`ra doc` 走代理；OS 级隔离列为后续加固项，不在「已解决」里含糊带过。
  11. `runtime.options` 可覆盖审批模式，等同绕过安全基线 → 安全参数只由 `worker.tools` 与内置基线生成；options 只放模型/超时/并发，`loadConfig` 拒绝放宽。
- 结论：默认安全边界可接受；剩余不确定项集中在 CLI 行为，不影响接口定稿。

### Round 4 · 作者最终一致性复核

- 检查点：接口签名、状态枚举、错误码、配置示例、阶段计划、证据索引是否互相一致。
- 修正：
  1. 删除 `AgentPhase` 中与 `null` 语义重复的 `unknown`；
  2. `WorkerErrorCode` 加入 `runtime:unknown`，与注册表一致；
  3. 统一 `DeliveryReceipt`、`WorkerRef`、`ActivityQuery` 的命名；
  4. 把「341 个测试」改为「现有测试全绿」，避免基线数字漂移；
  5. 同步目录规划、附录 A 证据索引与 10/13 节的文件路径。
### Round 5 · 最终闭环核验（独立复审）

- 检查点：前四轮修正是否真正闭环，而不是「某节修了、另一节仍矛盾」。
- 发现与修正：
  1. D4「input.id 幂等」会吞掉串行重投 → 拆成「并发去重（id+attempt）」与「串行重投（attempt+1 / redeliver）」两件事。
  2. `inspect` 命令失败与 `inspect` 返回 null（终端不存在）被混为一谈 → 前者 `null`，后者 `lost`；`AgentPhase` 恢复 `unknown` 表示已查询但不确定；`idle` 从 adapter 移除，由 Router 计算。
  3. `nudge()` 定义了但 6.3/P1 仍写 `deliver(status?)` → 统一为 `runtime.nudge()`，Orca 内部 terminal send，不产生 Input 行。
  4. 6.4 对 `exited && acceptingInput=false` 在 checkIdle/recover 下结论相反 → 抽 `classifyAgentStatus()` 返回 keep/lost/transfer/unknown，四处统一消费。
  5. `brief/report/tools` 没有生产者 → 新增 `buildWorkerContext()` + `buildWorkerBrief()`，Orca 走字节级一致的 `buildOrcaBrief()`，并列进 P0。
  6. `launch-worker` 首次派工没有 assignment，不能反查 runtimeId → launch 用 `registry.default()` 或 effect 显式 runtimeId；P2 启动期校验已注册运行时。
  7. meta 字段集合分散在 3 节且 Orca 没有 pid → 新增 9.4 `WorkerMetaV2`（schemaVersion、process、workBranch、lastHandedOff*）与逐运行时写入时机；`ProcessIdentity` 四重校验。
  8. 过宽的 `ra` 通配与 `runtime.options` 可绕过安全基线 → 收敛到 `ra report` / `ra doc`，安全参数只由 `worker.tools` 与内置基线生成，options 只放模型/超时/并发。
- 结论：接口、状态、迁移、安全四条线已闭环；可以进入人工评审，开发从 P0 开始。

### Round 6 · 用户反馈：Claude CLI 追问与 agent view

- 反馈：建议用 `claude agents` 的 agent view 驱动、`claude --bg "任务描述"` 追问；并质疑 Claude Code CLI 是否根本无法追问、是否必须用 ACP / SDK。
- 实测（附录 C）：CLI **可以**追问，但有条件——会话 `done/stopped` 且 `--bg --resume` **不带新 flags** 时继续同一 id；`working/blocked` 或带 flags 会 fork 新 id。轮内实时追投需要 `-p --input-format stream-json` 或 SDK/ACP。
- 设计修正：
  1. 9.1 从「自建 headless spawn + resume」改为「`claude --bg` + `claude agents --json --all` + `claude stop`」，不再需要 Claude 的 `ProcessSpawner`；
  2. `AgentPhase` 增加 `blocked`（权限/人工卡点）；`blocked` 置 attention，不自动 resume；
  3. `status()` 必须用 `agents --json --all`，否则 `done/stopped` 会话查不到；
  4. `deliver()` 在 `working/blocked` 只排队，`done/stopped` 才 resume；`--resume` 产生新 id 视为错误；
  5. 明确追问语义为「当前轮结束后生效」，并把「轮内实时插话」列为开放问题。
- 结论：一期不需要 SDK/ACP；`--bg` 方案更贴合现有 Router 的「回合制工单」模型，且保留 agent view 的人工接管能力。

### Round 7 · 一期范围确认

- 反馈：追问「当轮结束后生效」需要更直白的解释；一期把 Claude CLI 一起实现。
- 修正：
  1. 在 9.1 增加追问语义小节与时间线例子，明确「一轮 = 一次完整回复周期，不是整张工单」，并与 Claude Code TUI 的输入排队类比；
  2. 第 13 节明确「一期 = P0–P3（含 Claude Code CLI）」，P4/P5 为二期；
  3. 增加「一期总验收」清单，覆盖 Orca 回归、Claude 链路、追问、重启恢复、安全项；
  4. 开放问题改为「是否接受当轮结束语义」与「默认运行时是否仍为 Orca」。
- 结论：一期范围锁定为 Orca 等价拆解 + Claude CLI 可用；Codex 与清理放二期。

---

### Round 8 · 实现代码评审

- 评审对象：一期实现 diff（WorkerRuntime v2 / Registry / Claude CLI / GitWorktree / service 路由）。
- 发现并修复：
  1. accepted 未 ack 的输入仍会每 tick 重投 → accepted 后按 30s/60s/120s…（上限 10min）退避；新输入到达时立即投递；
  2. `sessionId` 只在 start 的 2–4s 窗口捕获 → deliver/status 从 `agents --json` 回填，不再把缺 sessionId 当永久 lost；
  3. `claudeProjectSlug` 只替换斜杠 → 改为所有非字母数字替换成 `-`，与 Claude 真实目录规则一致；
  4. 本地路径仓库的 PR 追踪把绝对路径传给 `gh --repo` → 新增 `repoSlug()`，从 `git remote get-url origin` 解析 owner/repo；
  5. `worker.tools` 未接线 → Claude adapter 由 `ToolPolicy` 生成 `allowedTools`；`runtime.options` 禁止覆盖安全参数；
  6. `agents` 查询失败/会话缺失时仍 resume → 分别返回 queued/rejected，只有 done/stopped 才 resume；
  7. 失联后重派工撞同名分支 → `GitWorktreeProvider` 自动加数字后缀；
  8. Claude 无 nudge 导致 stale 不可达 → 无 nudge 时按 `lastActivityAt + idleAfterMs + staleAfterMs` 直接判 stale；
  9. `claude stop` 对不存在会话文案不匹配 → 加入 `No job matching` 幂等判断；
  10. 补测：slug、GitWorktreeProvider、sessionId 回填、queued/rejected、stop 幂等、accepted 退避。
- 结论：一期实现可交付；未完成项仍按第 17 节记录。

## 17. 一期实施记录（P0–P3）

已落地：

- `packages/runtime/src/port.ts`：`WorkerRuntime` v2、`WorkerRef / StartResult / DeliveryReceipt / AgentStatus / WorkerRuntimeError`；
- `packages/runtime/src/status.ts`：`classifyAgentStatus`，`checkIdle / isZombie / recover / workerGone` 统一消费；
- `packages/runtime/src/registry.ts`：`RuntimeRegistry`，按 `assignment.runtimeId` 取运行时；默认运行时启动期校验；
- `src/service.ts`：去 Orca 类型、按 assignment 路由、`buildWorkerContext`、launch 半成功清理、投递 receipt；
- `packages/runtime/src/orca/*`：Orca 适配新契约（status/output/activity/inspectWorkspace/removeWorkspace/nudge）；
- `packages/runtime/src/runtimes/claude-code/*`：`claude --bg` + `claude agents --json --all` + `claude --bg --resume`（无 flags）+ `claude stop`；
- `packages/runtime/src/workspaces/git-worktree.ts`：git worktree、分支/路径校验、失败回滚；
- 配置：`worker.tools`、`runtime.default/options` 解析；`ra init` 在 Claude 运行时下问本地路径；
- `ra report --port` / `RA_PORT`；`ra serve` 单实例锁；doctor 追加当前运行时自检。

验证：

- `pnpm typecheck` 通过；
- `pnpm test`：431 passed / 5 skipped；
- `pnpm build` 通过。

未在本期完成（按计划留到二期或后续加固）：

- P4 Codex CLI 运行时；
- P5 旧路径清理与文档收尾；
- `ra doc` 的 Router 代理（当前 Claude Worker 仍可直接调用 `ra doc`）；
- 工单级 launch lease（当前只有进程级单实例锁）；
- macOS `sandbox-exec` / 容器级文件与网络隔离。

---

## 附录 A · 现状证据索引

| 主题 | 文件:行 |
|-|-|
| WorkerRuntime 端口 | `packages/runtime/src/port.ts:51-62` |
| OrcaRuntime | `packages/runtime/src/orca/index.ts:174-311` |
| Orca CLI 参数 | `packages/runtime/src/orca/commands.ts:21-81` |
| Claude 会话解析 | `packages/runtime/src/orca/session.ts:7-102` |
| 终端活性判定 | `packages/runtime/src/orca/report-poller.ts:156-176` |
| 服务层 Orca 类型泄漏 | `src/service.ts:14`、`40-44`、`443-447`、`1633-1638` |
| 空闲/僵尸判定 | `src/service.ts:884-929`、`1023-1040` |
| 工作区回收 | `src/service.ts:1165-1205` |
| 进展巡检 | `src/service.ts:1341-1396` |
| PR 跟踪 | `src/service.ts:1475-1497`、`src/sources/github.ts:74-82` |
| 重启对账 | `src/service.ts:1518-1552` |
| 配置写死 orca | `src/config.ts:157-158`、`232`、`399`、`899-901` |
| CLI 装配 | `src/cli/index.ts:642-649` |
| 手工绑定写死 runtime | `src/router/api.ts:118`、旧路径 import `:9` |
| 子进程环境继承 | `packages/infra/src/process.ts:19-23` |
| 失败诊断强类型 | `src/service.ts:1686-1719`、`1760`、`1774` |
| 投递未 ack 重投 | `src/service.ts:819-852`、`src/store/db.ts:729-756` |
| 单实例 pid 覆盖 | `src/cli/index.ts:619-622` |
| doctor Orca 检查 | `src/cli/doctor.ts:59-78` |
| init 仓库选择 | `src/cli/init.ts:124-147` |
| Orca JSON 解析器放错文件 | `src/sources/lark.ts:117-160` |
| Worker 手册 | `packages/runtime/src/spec/prompt-mode.md:3`、`packages/runtime/src/spec/index.ts:46-56` |
| 报告协议 | `src/cli/report.ts`、`packages/runtime/src/orca/report-poller.ts:1-154` |
| 效果队列 | `src/service.ts:536-552`、`src/core/effects.ts` |

## 附录 B · 新运行时接入 Checklist

- [ ] 实现 `WorkerRuntime`，`id` 唯一，`capabilities` 如实声明。
- [ ] `start()` 返回可持久化 `WorkerRef` 所需的 handle + workdir + branch；失败时把已创建的 workdir/branch 放进错误 detail。
- [ ] `deliver()` 返回 `DeliveryReceipt`，支持 `【Router 输入 in_xxx】`，按 input.id 幂等、同 session 单飞，最终可被 ack。
- [ ] `status()` 的 `lastActivityAt` 可用于 idle/zombie 判定；无法判断返回 `null`，确认丢失才返回 `lost`。
- [ ] `activity()` 按 sessionId + cwd 精确定位；或实现 `output()`；两者至少一个。
- [ ] `removeWorkspace()` 幂等；不存在视为成功。
- [ ] `stop()` 幂等，能杀进程组；进程退出写 exit.json。
- [ ] 错误统一抛 `WorkerRuntimeError`，`code` 在枚举内，`retryable` 有意义。
- [ ] Agent 启动环境使用 env allowlist；prompt 走 stdin/临时文件；能执行 `ra report` / `ra doc`（PATH 检查）。
- [ ] `doctor()` 覆盖可执行文件、认证、仓库可见性、沙箱/权限风险提示。
- [ ] 注册表按 `assignment.runtimeId` 路由；旧工单不被新默认运行时接管。
- [ ] 通过 `tests/worker/contract.test.ts` 全套契约测试 + 安全/生命周期回归。
- [ ] 在临时仓库跑通完整链路并留验证记录。

## 附录 C · Claude Code CLI 后台会话实测（2026-11-08）

环境：Claude Code `2.1.318`，macOS。

### C.1 命令与字段

- 启动：`claude --bg --name <name> --permission-mode plan --model haiku "<prompt>"`，输出 `backgrounded · <short-id> · <name>`。
- 列表：`claude agents --json --all` 返回数组，元素字段为 `id / pid / cwd / kind / startedAt / sessionId / name / state / status / waitingFor`。
- 观察到的状态组合：
  - `state=working, status=busy`：运行中；
  - `state=done, status=idle`：完成；
  - `state=blocked, status=waiting, waitingFor='permission prompt'`：等权限；
  - `state=stopped`：`claude stop` 之后，仅在 `--all` 中可见。
- `claude logs <id>`：原始 TUI 输出，含 ANSI、spinner、状态栏；不适合直接做结构化进度，需清洗且只作兜底。
- `claude stop <id>`：停止但保留会话；`claude attach <id>` 可恢复/接管；`claude rm <id>` 删除会话及其 worktree（对非 Claude 创建的 worktree 行为不明确，Router 清理不要依赖它）。

### C.2 追问行为（关键）

- 会话 `done` 且**不带新 flags**：`claude --bg --resume <sessionId> "<prompt>"` → 继续同一 id，输出 `woke session <id> with its saved options`。
- **带新 flags**：`claude --bg --resume <sessionId> --model ... "<prompt>"` → `started a copy as <new-id>`，不是原会话。
- 会话 `working` 或 `blocked`：`claude --bg --resume` → `started a copy as <new-id>`，不会把输入插进正在运行的会话。
- 结论：**Claude Code CLI 可以做追问**，但只在「本轮结束 / 已 stop」且「不带新 flags」时保持同一会话；轮内实时追投需要 `claude -p --input-format stream-json`（CLI 自带）或 Claude Agent SDK / ACP。一期推荐 `--bg` 方案，把「追问在下一轮生效」作为明确语义。

### C.3 对适配器的影响

- `handle` 用 short id，`sessionId` 从 `agents --json --all` 补全并写 meta；
- `status()` 必须用 `--json --all`（`done/stopped` 会话不在默认 `--json` 里）；
- `deliver()` 在 `working/blocked` 只排队，绝不 resume；`blocked` 置 attention；
- `stop()` 用 `claude stop`；清理 worktree 用 GitWorktreeProvider，不用 `claude rm`；
- 不需要 `ProcessSpawner`；Claude 自己的后台管理承担进程生命周期。

### C.4 复核（2.1.322，2026-11-12）

2.1.318 的结论「`done` + 不带新 flags → 继续同一 id」已经不成立，本机复测矩阵如下（`claude agents --json --all` 观察 id 是否变化）：

| 场景 | CLI 输出 | 结果 |
|-|-|-|
| `state=done`（后台 worker 仍存活）→ `--bg --resume <完整 id>` | `note: session X is already running in the background, so this started a copy as Y` | **复制** |
| 先 `claude stop X` → `--bg --resume <完整 id>` | `note: woke session X with its saved options (--dangerously-skip-permissions, --model)` | **同一会话原地续跑** |
| 先 `claude stop X` → `--bg --resume <完整 id> -- "<prompt>"` | 同上 | 同一会话（`--` 不是 flag） |
| 先 `claude stop X` → `--bg --resume <short id>` | `note: started a copy of that conversation as Y. To continue a session under its own id, pass its full session id ...` | **复制** |

要点：
- 后台 worker 在本轮结束后**仍然存活**（`state=done`、`status=idle`，但 `pid` 还在），这才是 `done` 状态下依然 fork 的根因；`--` 分隔符无害；
- 「新 flag」指会改变会话自身配置的参数（`--model` / `--permission-mode` / `--allowedTools` / `--add-dir` 等）。会话已经保存了自己的选项，resume 时再传新选项无法合并，CLI 只能复制：`background session X keeps its own saved options, so the flags you passed started a copy as Y`；
- `claude stop` 停的是后台 worker 进程，**对话记录完整保留**（`claude stop` 自带说明：`Its conversation is kept`），`claude --resume works once it is stopped`；因此 stop → resume 是同一会话继续下一轮，不会丢上下文；
- 结论：一个话题 = 一个会话是可达成的。

### C.5 轮内插话（2.1.322 实测）

`--bg --resume` 只能「续下一轮」，做不到 TUI 那种「本轮中途插一句话」。实测发现唯一能进当前轮的通道是 `claude attach`：

| 场景 | 做法 | 结果 |
|-|-|-|
| `state=working` | `claude attach <id>`，往 stdin 写文本 + 回车 | 会话记录当前回合出现 `The user sent a new message while you were working: …`，agent 在本轮就回应 |
| `state=done`（后台 worker 仍存活） | 同上 | 不新开会话，直接在同一会话里开始下一轮 |
| 已 `claude stop` | 同上 | 同样可用（attach 会唤醒会话） |
| `claude -p --input-format stream-json --resume <id>` | — | 被拒绝：`That session is running in the background` |

实现要点：
- 不需要 PTY，普通 pipe 即可（Node `spawn` 的 stdin 直接写）；
- TUI 输入框会保留未提交内容：注入前先发 `Ctrl-U` 清行，写完等 2–3 秒再回车，避免被当成粘贴；
- 偶发重复提交（同一条消息出现两次），所以必须用会话记录（`input-<id>` 标记）校验；校验不过退回 `queued`，不能当成已送达；
- 同一 `input.id` 按 meta 水位线幂等，Router 重投不会重复插话；
- 人工 `claude attach` 与 Router 注入可以并存（实测互不抢占）。

## 附录 D · ACP Runtime 实现（2026-11-09）

`AcpRuntime`（`packages/runtime/src/runtimes/acp/`）是协议层实现：一个客户端同时适配所有实现 ACP 的 Agent。

### D.1 协议与消息

- 传输：Agent 子进程 + stdio JSONL（JSON-RPC 2.0），与 ACP v1 一致。
- 启动序列：`initialize`（`protocolVersion: 1`、`clientCapabilities`、`clientInfo`）→ `session/new`（`cwd`、`mcpServers: []`）→ `session/prompt`（内容块 `{ type: 'text', text }`）。
- 追问：同一进程继续 `session/prompt`；进程退出后，若 `agentCapabilities.loadSession=true`，重启 Agent 并 `session/load { sessionId, cwd, mcpServers }`，历史重放期间的 `session/update` 被抑制，避免活动重复。
- 活动：`session/update` 的 `agent_message_chunk` 落为文本事件，`tool_call` 落为工具事件；`tool_call_update / plan / usage_update` 只更新状态，不重复落库。
- 停止：先发 `session/cancel` 通知，再关闭子进程；`stop()` 幂等。

### D.2 权限与能力

- `session/request_permission` 由客户端应答：按 `worker.tools` 选择 `allow_*` / `reject_*` 选项；没有匹配选项时回 `cancelled`，绝不挂起。
- 映射：读/搜索/思考放行；编辑/移动/删除看 `fileAccess`；执行看 `shell`（allowlist 按命令前缀）；网络看 `allowNetwork`；未知工具按只读拒绝。
- 客户端不实现 `fs/*` 与 `terminal/*` 代理：`initialize` 声明不支持，相关反向请求返回 `-32601`，Agent 需使用自己的文件与命令工具。
- `capabilities`：`liveStatus/processExit/activity/structuredInput = true`，`output = false`，`nudge = false`；工作区走 `GitWorktreeProvider`，`cleanup = true`。

### D.3 已知限制

- Claude Code 与 Codex 需要外部 ACP 适配器（`claude-agent-acp` / `codex-acp`），不是原生 ACP；适配器版本需与上游 CLI 对齐。
- `session/load` 的支持程度因 Agent 而异；不支持时追问会以 `acp:agent-gone` 拒绝，需要人工重派。
- Agent 必须预先完成认证；`session/new` 返回 `-32000 auth_required` 时以 `agent:launch-failed` 上报，并在 detail 里带认证方法。
- 远程 ACP（HTTP/WebSocket）仍是 draft，当前只支持本地 stdio。

### D.4 验证记录

- 单测：`tests/worker/acp.test.ts` 用 `tests/fixtures/fake-acp-agent.mjs` 覆盖握手、首轮、追问、忙碌排队、权限放行/拒绝、进程退出后 `session/load` 恢复。
- 真实 Agent：本机 `opencode 2.1.4` 的 `opencode acp` 完成 `initialize` 与 `session/new`；`session/prompt` 因上游模型不可用返回错误（协议链路正常，环境缺模型配置）。

### D.5 动态运行时与按需安装（2026-11-09 追加）

多 ACP Agent 并行接入后，运行时不再只有一个 `acp`：

- **运行时 id**：目录里的每个 Agent 注册为 `acp-<agent>`（`acp-claude` / `acp-codex` / `acp-opencode` / `acp-gemini` / `acp-copilot` / `acp-cursor` / `acp-goose`）。旧的 `acp` 保留为自定义命令入口。
- **静态目录**：`packages/runtime/src/runtimes/acp/agents.ts`，纯常量，Web 可 import。包含启动命令、默认参数、可在线安装的 npm 包、版本探测参数、外部依赖（如 codex app-server）、登录命令与 `loadSession` 能力。
- **注册表**：`createRuntimes` 保持同步，注册目录里的全部运行时；命令解析只做文件存在性检查（`runtime.options.<id>.command` → `~/.router-agent/runtimes/<agent>/node_modules/.bin` → PATH），不 spawn。未安装的运行时也注册，`start()` 在创建 worktree 之前抛 `runtime:unavailable`，附原因和 `ra runtime install` 提示。
- **探测**：`detect.ts` 分三层：
  - L0：命令 + 版本探测（每项 2.5s，缺失项不 spawn）；
  - L1：外部依赖能力探测（codex 的 `app-server --help`、`login status`）；
  - L2：完整 `initialize + session/new`，只在 `ra runtime check` / Web「检查」时执行。
  启动时先读 `~/.router-agent/runtimes/detect.json` 缓存，HTTP 先 listen，再后台刷新；默认运行时不可用不阻止启动。
- **安装**：`install.ts` 只接受目录里的包与版本，写到 `.staging` 后校验 bin，再原子换名到 `runtimes/<agent>`；旧目录进 `.backup`，失败回滚。每个 agent 一个原子锁目录，防 CLI / 服务并发安装。
- **Web**：`/api/config` 与 `/api/runtimes` 下发探测结果；下拉框对未安装 / 不兼容 / 未登录项置灰并显示原因；安装是显式确认 + job 轮询，成功后提示重启。
- **安全**：`publicConfig` 遮蔽 `runtime.options.*.env` 明文；安装接口只监听 127.0.0.1、只接受目录 id。
