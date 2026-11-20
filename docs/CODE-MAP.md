# 代码地图：核心概念 → 代码位置

本文是**「某个概念在代码里到底叫什么、定义在哪、谁在读写」的索引**。

它不解释架构（那是 [ARCHITECTURE.md](ARCHITECTURE.md)），也不列配置项（那是 [CONFIGURATION.md](CONFIGURATION.md)）。
当你听到一个还不熟悉的词——「准入」「研判」「水位」「终审」「扇出」——先在这里查它对应哪个类型、哪个文件。

> **用法**：从上往下按「概念 → 定义 → 主要读写点」查。行号会随代码变动漂移，
> 以文件与符号名为准，不要依赖行号。

---

## 0. 先看这三条

| 你想改的东西 | 从这里开始 |
|-|-|
| 一条消息进来之后发生了什么 | [§2 主链路](#2-主链路一条消息到关单) |
| 某个状态字段存在哪、谁写它 | [§3 领域概念](#3-领域概念packagescore) |
| 一个扩展点在哪（新 runtime / channel / 事件来源） | [§5 扩展点](#5-扩展点) |
| 某个词到底指什么 | [GLOSSARY.md](GLOSSARY.md) |

---

## 1. 分层与目录

```text
packages/core       领域内核（零依赖）：model / stage / policy / admission / decision / events / reply
packages/infra      基础设施：logger / process / chat / vision / plugin-loader / decision(Jev)
packages/runtime    WorkerRuntime 端口、内置 runtime、agent-sessions、workspaces、spec、report-poller
packages/channel    ChannelAdapter 端口、ChannelRegistry、飞书 adapter、入站管线
src/core            Engine（唯一状态写入口）、EffectsProcessor
src/router          AgentLoop、决策层、需求会话、API/Web 后端、派工解析
src/store           Store（SQLite 读写）+ cursors（有类型游标）
src/cli             命令行入口：init / start / report / reply / logs / update / doctor
src/web             面板前端（React 单文件 app.tsx）
src/sources         PR / MR 追踪器（**不是**消息来源）
src/specs           规范存储（persona / prompt 的落盘与读取）
```

依赖单向向下：`core ← infra ← runtime / channel ← src/`。
包边界由 `tests/architecture/packages.test.ts` 兜底。

---

## 2. 主链路：一条消息到关单

```text
① 接入    ChannelAdapter.receive → ingress → Store.insertTrigger
② 取件    RouterService.tick → Store.claimPendingTriggers → AgentLoop.handle
③ 分流    AgentLoop.handle 的 10 步（见下）
④ 研判    DecisionEngine.assess（Pi）→ DecisionProposal
⑤ 开单    Engine.decide → Ticket + Mandate
⑥ 派工    RouterService.launch → Engine.startAssignment → WorkerRuntime.start
⑦ 执行    Worker 上报 → ReportPoller.scan → Store.insertReport
⑧ 通知    Store.enqueueOutbox → EffectsProcessor → ChannelAdapter.send
⑨ 关单    Engine.closeTicket / setAttention
```

### ③ `AgentLoop.handle` 的 11 步顺序

**顺序本身是行为的一部分**——前面的步骤会「吃掉」消息。改顺序前先读
`src/router/agent-loop.ts` 里 `handle()` 上方的注释。

| 步 | 判断 | 落在 |
|-|-|-|
| 1 | `/new` 重置会话 | `handleSessionReset` |
| 2 | 记忆口令（`/记忆 …`） | `tryMemoryCommand` |
| 3 | 订阅线程扇出 | `tryFanOut` |
| 4 | 澄清会话 / 待终审需求单 | `tryIntakeBeforeGate` |
| 5 | 已关闭工单的话题 | `handleClosedThread` |
| 6 | 准入判定 + 角色分流 | `gate()` + `tryMemberIntake` |
| 7 | Gate 判定忽略 | `handle` |
| 8 | 纯附件消息 | `replyMediaOnly` |
| 9 | 只回话不开单 | `replyOnly` |
| 10 | 显式请求（含寒暄） | `trySmallTalk` → `assess('explicit')` |
| 11 | 推断请求 | `assess('inferred')` |

---

## 3. 领域概念（`packages/core`）

| 概念 | 定义 | 说明 |
|-|-|-|
| `Trigger` | `packages/core/src/model.ts` | 一条收到的消息。`disposition` 见下 |
| `TriggerDisposition` | `packages/core/src/model.ts` | `pending` / `evaluating` / `evaluated` / `fanned_out` |
| `Thread` | `packages/core/src/model.ts` | 会话线程；飞书话题 ID 与根消息 ID 的收敛结果 |
| `Mandate` | `packages/core/src/model.ts` | 授权范围（允许做什么 / 不允许做什么） |
| `Ticket` | `packages/core/src/model.ts` | 工单。`stage` 见 `Stage` |
| `Assignment` | `packages/core/src/model.ts` | 一次派工（哪张单 → 哪个 runtime → 哪个 handle） |
| `Input` | `packages/core/src/model.ts` | 投给 worker 的一条用户输入。有 `seq`，用于区分新旧输入 |
| `Report` | `packages/core/src/model.ts` | worker 的上报（progress / ready / blocked …） |
| `Question` | `packages/core/src/model.ts` | 需要人回答的问题（选择题回写） |
| `Subscription` | `packages/core/src/model.ts` | 线程订阅关系；扇出靠它 |
| `Intake` | `packages/core/src/model.ts` | 需求会话（初筛 → 澄清 → 终审） |
| `DecisionRecord` | `packages/core/src/model.ts` | 决策落库记录 |
| `Stage` | `packages/core/src/model.ts` | `todo` / `running` / `review` / `blocked` / `done` |
| `Stage` 计算 | `packages/core/src/stage.ts` `computeStage` | 由输入算出阶段；标签表 `STAGE_LABELS` |
| `Policy` | `packages/core/src/policy.ts` | 准入策略：管理员名单、群 scope、bot 名单 |
| `GateResult` | `packages/core/src/policy.ts` | 准入判定结果：`explicit` / `infer` / `reply-only` / `ignore` |
| 准入判定 | `packages/core/src/policy.ts` `gate` | 角色分流的第一层 |
| 确定性准入 | `packages/core/src/admission.ts` `admissionOf` | 规则命中（bot / 媒体 / 口令 / 会话 / 工单 / 身份 / 噪声） |
| 工具范围 | `packages/core/src/tool-scope.ts` | 研判能调哪些工单工具（按是否管理员） |
| 决策层判定 | `packages/core/src/decision.ts` | 决策层的判定与校验 |
| 日志事件 | `packages/core/src/events.ts` | `messageContext`、`preview`、事件名常量 |
| 回复载荷 | `packages/core/src/reply.ts` | 卡片 / 图片 / PR 对比的统一结构 |

### 两层「准入」别搞混

| | 位置 | 回答什么问题 |
|-|-|-|
| **Gate** | `core/policy.ts` 的 `gate()` | 「这个人有没有资格让 Router 处理这条消息」 |
| **Admission** | `core/admission.ts` 的 `admissionOf()` | 「这条消息命中了什么规则，要不要走模型」 |

两层都叫「准入」，但管的不是一回事。改准入要同时看这两处。

---

## 4. 运行时与通道

| 概念 | 定义 | 说明 |
|-|-|-|
| `WorkerRuntime` | `packages/runtime/src/port.ts` | worker 运行时端口：`start` / `status` / `output` / `nudge` / `stop` |
| `WorkerContext` | `packages/runtime/src/port.ts` | 一次调用的上下文：`workdir` / `workspaceRef` / `worktree` |
| `AgentStatus` | `packages/runtime/src/port.ts` | worker 自报状态；`classifyAgentStatus`（`runtime/status.ts`）翻译成 `lost` / `transfer` / `unknown` |
| `ResumeHint` | `packages/runtime/src/port.ts` | 恢复命令提示（面板「恢复」入口） |
| 内置 runtime 清单 | `packages/runtime/src/runtimes/catalog.ts` `WORKER_RUNTIMES` | 新增内置 runtime 要在这里登记 |
| `RuntimeRegistry` | `packages/runtime/src/registry.ts` | 按 id 取 runtime；`normalizeRuntimeId` 做 id 归一 |
| ACP Agent 目录 | `packages/runtime/src/runtimes/acp-agents.ts` | `acp` / `acp-codex` / `acp-claude` … 的元数据 |
| Agent 会话 | `packages/runtime/src/agent-sessions/` | Claude / Codex 的会话文件读取与恢复。**不是**「agent 的定义」 |
| 工作区 | `packages/runtime/src/workspaces/overview.ts` | workspace 列表与回收 |
| 上报轮询 | `packages/runtime/src/report-poller.ts` | 读 worker 的 `state.json` / `events.log` |
| 证据门禁 | `packages/runtime/src/evidence-gate.ts` | UI 改动的截图证据校验 |
| `ChannelAdapter` | `packages/channel/src/port.ts` | 消息通道端口：`receive` / `send` |
| `OutboundMessage` | `packages/channel/src/port.ts` | 出站消息结构 |
| `ChannelRegistry` | `packages/channel/src/registry.ts` | 已注册通道 |
| 飞书入站 | `packages/channel/src/ingress.ts` | 飞书事件 → `Trigger` |
| PR / MR 追踪 | `src/sources/github.ts`、`gitlab.ts`、`forge.ts` | **只**跟踪 PR 状态，不消费 Issue |

---

## 5. 扩展点

### 新增一个内置 runtime

1. 在 `packages/runtime/src/runtimes/` 加适配器，实现 `WorkerRuntime`；
2. 在 `packages/runtime/src/runtimes/catalog.ts` 的 `WORKER_RUNTIMES` 登记；
3. 在根 `package.json` 加依赖，**并把版本号同步到 11 个包**；
4. 改了 `packages/*/src` 就必须 `pnpm build`——根 `package.json` 的 `imports` 指向 `dist/`，
   不 build 的话 CLI 用的还是旧产物；
5. 步骤清单见 [MONOREPO.md](MONOREPO.md)。

### 新增一个 channel

1. 在 `packages/channel/src/` 加适配器，实现 `ChannelAdapter`；
2. 在 `packages/channel/src/registry.ts` 注册；
3. 配置形状放 `packages/core/src/config.ts`（`ChannelConfigView`），**不要**反向依赖宿主的 `AppConfig`。

### 新增一个事件来源

main 分支目前**没有**这个扩展点（beta 分支新增了 `packages/event` 包）。
在 main 上要加，先把 beta 合进来再评估，别另造一套。

### 新增一个决策 Provider

实现 `DecisionProvider`（`src/router/decision/agent.ts`），
在 `src/router/engine-factory.ts` 的 `createDecisionAgent` 里挂上。

### 插件

插件元数据由 CLI 启动时注入（`ApiServerOptions.plugins`），
加载器在 `packages/infra/src/plugin-loader.ts`，安装任务在 `src/router/plugin-admin.ts`。

---

## 6. 宿主应用

| 概念 | 定义 | 说明 |
|-|-|-|
| `Engine` | `src/core/engine.ts` | **唯一的状态写入口**：`decide` / `startAssignment` / `closeTicket` / `setAttention` |
| `Store` | `src/store/db.ts` | SQLite 读写。只读写，不做业务判断 |
| 游标 | `src/store/cursors.ts` | 9 类水位的 key 与 value 结构都收在这里（`cursors` 表是无类型 KV 表） |
| `RouterService` | `src/service.ts` | 宿主服务：定时巡检、派工、投递、留存治理 |
| `AgentLoop` | `src/router/agent-loop.ts` | 消息处理主循环 |
| `DecisionEngine` | `src/router/decision-engine.ts` | 研判端口（实现是 `PiDecisionEngine`） |
| `DecisionAgent` | `src/router/decision/agent.ts` | 决策层（普通成员消息） |
| `IntakeCoordinator` | `src/router/intake-flow.ts` | 需求会话协调器（初筛 / 澄清 / 终审 / 派工解析） |
| `IntakeEngine` | `src/router/intake-engine.ts` | 需求分析 Agent 端口 |
| 派工解析 | `src/router/dispatch.ts` | `resolveDispatch`（项目 → repo/branch）、`activeDraft`（在途草稿） |
| 口令解析 | `src/router/commands.ts` | `/new`、终审通过 / 驳回、放弃澄清、重开 |
| API 路由表 | `src/router/api-routes.ts` | 40 条路由的声明式表，**数组顺序即匹配顺序** |
| API 服务 | `src/router/api.ts` `createApiServer` | HTTP 服务与静态资源 |
| 排查助手 | `src/router/log-assistant/` | 日志 → 结论。`types` / `evidence` / `symptoms` / `model` / `overview` |
| 日志读取 | `src/router/log-tail.ts` | 服务日志尾读 |
| `EffectsProcessor` | `src/core/effects.ts` | 幂等副作用执行（通知、状态变更） |
| 日志器 | `packages/infra/src/logger.ts` | `createLogger` 写 `<RA_HOME>/logs/router-agent.log` |
| 规范存储 | `src/specs/index.ts` | persona / prompt 的落盘与读取 |
| 运行时目录 | `packages/runtime/src/spec/` | worker 侧的规范注入（`contract.md` 等） |
| 提示词 | `src/router/prompts/*.md` | `admission` / `conversation` / `decision` / `intake-*` / `orchestrator` / `soul` |

---

## 7. 日志事件

事件名、来源、关键字段的完整表见 [OPERATIONS.md](OPERATIONS.md#日志)。

- 事件名是 `域:动作` 的 kebab-case（`trigger:ingested`、`outbox:sent`）；
- `domain` / `event` / `category` / `trace` 由日志实现自动补，业务代码不写；
- 每条事件至少带一个可定位字段：`triggerId` / `ticketId` / `inputId` / `key` / `chat` / `path` / `handle`；
- 新增事件**必须**同步 [OPERATIONS.md](OPERATIONS.md#日志) 的事件表。

---

## 8. 数据库表速查

表定义在 `src/store/db.ts` 的 `SCHEMA`。

| 表 | 装什么 |
|-|-|
| `triggers` | 收到的消息及其处置状态 |
| `threads` | 线程与话题 ID 收敛 |
| `thread_aliases` | 话题 ID ↔ 根消息 ID 的别名 |
| `decisions` | 决策记录 |
| `tickets` | 工单 |
| `mandates` | 授权范围 |
| `assignments` | 派工记录 |
| `inputs` | 投给 worker 的用户输入 |
| `reports` | worker 上报 |
| `questions` | 待人回答的问题 |
| `intakes` | 需求会话 |
| `chat_sessions` / `chat_session_resets` | 会话落盘与重置 |
| `subscriptions` | 线程订阅 |
| `outbox` | 待投递的通知（幂等键 `key`） |
| `effects` | 幂等副作用 |
| `cursors` | 9 类水位（无类型 KV，见 [OPERATIONS.md](OPERATIONS.md#游标表cursors)） |
| `counters` | 自增计数器（工单序号等） |
| `reactions` | 消息表情回应 |

---

## 9. 构建 / 测试 / 发布

| 命令 | 作用 |
|-|-|
| `pnpm typecheck` | 类型检查（提交前必须绿） |
| `pnpm test` | 全量测试（提交前必须绿） |
| `pnpm build` | 构建产物。**改了 `packages/*/src` 后必须跑**，否则 CLI 用的是旧产物 |
| `pnpm check` | `typecheck` + `test` |
| `pnpm vitest run tests/xxx.test.ts` | 只跑一个测试文件 |

发布流程见 [PUBLISHING.md](PUBLISHING.md)。

---

## 10. 找不到东西时

| 症状 | 先查 |
|-|-|
| 「消息没反应」 | [OPERATIONS.md](OPERATIONS.md#查看与排查) 的日志排查一节 |
| 「工单状态不对」 | `Engine.decide`（`src/core/engine.ts`）与 `computeStage` |
| 「通知没发出去」 | `outbox` 表 + `outbox:sent` / `outbox:failed` 事件 |
| 「工单被自动关了」 | `cursors` 表的 `retention:*` 三类水位 |
| 「不知道该改哪个文件」 | 本文 §3 / §4 / §6 |
| 「这个词到底指什么」 | [GLOSSARY.md](GLOSSARY.md) |
