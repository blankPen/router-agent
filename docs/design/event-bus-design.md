# 多来源事件总线（Event Bus）设计方案

> 工单 tk-87 ｜ 基线分支 `ra/tk-86-llm` ｜ 本轮只出设计，不含实现代码
> 参照项目：[KKKKhazix/agent-autoloop](https://github.com/KKKKhazix/agent-autoloop)（规则驱动 + 插件化事件源 + 拿不准才问人）

---

## 0. 先回答本轮追问：现在的事件来源与流转是什么样

### 0.1 结论先行

你的理解方向是对的，但有三点和现状不符，先对齐再设计方案：

| 你的判断 | 成立吗 | 实际情况 |
| --- | --- | --- |
| 服务主动轮询获取事件 | **部分成立，但对象不是「事件源」** | 现在唯一的事件入口是**飞书**，而且不是我们轮询，是 `lark-cli event consume` 常驻长连接，由飞书推送给我们。仓库里的 GitHub 相关代码只做**PR 状态跟踪**（工单闭环用）和**上报 issue**（把排查结论写成 issue），**没有 GitHub Issue 的监听/轮询**。 |
| 第三方 Webhook 主动触发 | **不成立** | 代码里没有任何 webhook 接入面（全仓 `rg -i webhook` 无命中）。飞书走的是长连接消费，`packages/channel-feishu` 里 `FeishuConsumer` 负责 spawn 子进程、断线指数退避重连。 |
| event source 配置 = 一个来源开关 | **方向对，但不只一个开关** | 事件源至少要配 5 组东西：接入模式（push/pull/schedule）、凭证与连接参数、过滤规则（哪些算事件）、优先级基线（默认 P 几）、配额与预算。不只是「开/关」。 |

一句话概括现状：**router-agent 现在只有一条入站管道（飞书消息），没有事件池、没有多来源、没有优先级排队，也没有任何 webhook / 定时任务 / Issue 监听入口。**

### 0.2 现状证据（代码位置）

| 事实 | 代码位置 |
| --- | --- |
| 唯一入站通道是飞书，走 `lark-cli event consume` 长连接 | `packages/channel-feishu/src/sources/feishu.ts:411`（`FeishuConsumer`）、`packages/channel-feishu/src/feishu/index.ts:234`（`start()`） |
| 原始事件先归一化成 `Trigger` | `packages/channel/src/port.ts`（`ChannelAdapter.normalize`）、`packages/channel/src/ingress.ts`（`ChannelIngress.handleRaw`） |
| 入库幂等（同一 externalId 只进一次） | `src/core/engine.ts:126`（`Engine.ingest` → `store.insertTrigger`） |
| 触发词 / 准入规则（确定性，不花模型钱） | `packages/core/src/policy.ts`（`gate()`）、`packages/core/src/admission.ts`（`admissionOf()`） |
| 决策模型层（LLM 研判） | `src/router/decision-engine.ts`（端口）、`src/router/pi-decision-engine.ts`（Pi 实现）、`packages/core/src/decision.ts`（`msg.user.v2` 规则化判定） |
| 开单与派工 | `src/core/engine.ts`（`decide()` → Ticket/Mandate）、`src/router/dispatch.ts`（repo/branch 解析） |
| GitHub 只有 PR 跟踪 + 上报 issue | `src/sources/github.ts`、`src/sources/forge-tracker.ts`、`src/router/issue-report.ts` |
| webhook 能力 | **不存在**（`rg -i webhook` 无命中） |
| 定时任务能力 | 只有系统级轮询（PR 状态、更新检查、群目录刷新），**不是事件源** |

### 0.3 现状流转：一条飞书消息的完整路径

```text
飞书平台
  │  长连接推送（lark-cli event consume，子进程常驻，失败指数退避重连）
  ▼
FeishuAdapter.normalize()      归一化成 Trigger
  ▼
ChannelIngress.handleRaw()      归一化 → 富化（引用回查 / 附件 OCR）→ 入库 → 加回执表情
  ▼
Engine.ingest()                 幂等入库，disposition = pending
  ▼
AgentLoop.tick()                批量领取 pending（batchWindowMs 内合并），逐条处理
  ├─ /new 会话重置
  ├─ 订阅扇出（fanOut 给在办工单）
  ├─ 需求会话续接（intake.handleBeforeGate）
  ├─ 已关闭工单话题 → 确定性回复
  ├─ gate() / admissionOf()      纯规则：管理员直进 Router，普通成员进决策层，机器人/寒暄直接丢
  ├─ Jev / Pi 决策模型            语义判断（是否跟进、类型、紧迫度、项目相关性）
  └─ Engine.decide()             accept → Ticket + Mandate → 派工；否则 ignore
  ▼
Worker（Orca / Codex / Claude Code …）跑任务 → 上报 → Router 回消息
```

**关键差异（这就是本方案要补的）**：现状是**同步串行**的——消息进来就在下一个 tick 里被处理，没有排队、没有优先级、也没有「先做哪个」的概念。GitHub Issue 之所以「做得很粗糙」，是因为它根本没有成为一等公民：它既不是 Trigger，也没有自己的队列。

### 0.4 本方案对这次追问的落点

- 「事件源开关」→ 升级为**事件源配置模型**（第 5 节）：接入模式 + 凭证 + 过滤 + 优先级基线 + 配额。
- 「轮询 vs Webhook」→ 统一抽象成**三种接入模式**（push / pull / schedule），对上层是同一件事（第 5.2 节）。
- 「GitHub Issue 监听」→ 作为 `github-issues` 事件源正式实现（第 5.4 节），走 pull 模式 + 增量游标。

---

## 1. 目标与非目标

### 1.1 目标

1. **多来源统一**：用户消息、运营群消息、GitHub Issue、第三方 Webhook、定时任务，全部归一化成同一个事件信封，进入同一条流水线。
2. **用户消息永远优先**：直接发给用户的消息保持当前体验——最高优先级、插队、不排队等待。
3. **主动来源的价值化**：把「主动收集到的事件」里的有价值部分提取出来，按序执行，不淹没在飞书消息洪流里。
4. **成本可控**：高峰期只做重要的事，低峰期批量处理低优任务；token 到预算上限自动延后而不是失败。
5. **判定效率**：规则先行、模型兜底。明确的规则命中不调模型，省 token 也省时延。
6. **人机边界清晰**：能自动完成的直派工单；需要人判断的进审核列表并通知 admin，不猜。
7. **可观测**：事件在哪一环被拦下、为什么没处理，全部能在面板与日志里看到。

### 1.2 非目标（本轮明确不做）

- 不改现有飞书消息链路的行为语义：用户消息的准入、开单、派工、回复全部保持原样，只在**前面加一层队列**。
- 不做分布式事件总线：单机 SQLite 队列，不引入 Kafka/Redis。
- 不做通用工作流引擎：只解决「事件 → 判定 → 派单/审核」这一段。
- 不做多租户 / 权限模型重构：沿用现有 `Policy`（群范围、管理员名单、acceptMode）。

---

## 2. 总体架构

### 2.1 分层总览

```text
┌─ ① 采集层 EventSource 插件 ─────────────────────────────────────┐
│  飞书用户消息   运营群消息   GitHub Issue   Webhook   定时任务      │
│  (push 长连接)  (push)      (pull 轮询)   (push HTTP) (schedule)  │
└───────────────────────────────┬───────────────────────────────────┘
                                ▼
┌─ ② 归一层 ──────────────────────────────────────────────────────┐
│  统一信封 EventEnvelope · 去重幂等 dedupeKey · 归一化文本/链接/附件   │
└───────────────────────────────┬───────────────────────────────────┘
                                ▼
┌─ ③ 事件队列池（SQLite 持久化）──────────────────────────────────┐
│  P0 插队队列 │ P1/P2 常规队列 │ P3 低峰批量队列 │ 延后队列(窗口外)   │
└───────────────────────────────┬───────────────────────────────────┘
                                ▼
┌─ ④ 判定层 ──────────────────────────────────────────────────────┐
│  规则判定 Rule Engine（先跑、便宜、可解释） → Jev 决策模型（灰区兜底） │
└───────────────────────────────┬───────────────────────────────────┘
                                ▼
┌─ ⑤ 调度层 Scheduler ────────────────────────────────────────────┐
│  时间窗口（高峰/低峰）· Token 预算 · 并发上限 · 重试与退避           │
└───────────────────────────────┬───────────────────────────────────┘
                                ▼
┌─ ⑥ 执行层 ──────────────────────────────────────────────────────┐
│  直派工单（复用现有派工链路） │ 审核列表（推 admin） │ 忽略并归档    │
└───────────────────────────────┬───────────────────────────────────┘
                                ▼
┌─ ⑦ 观测层 ──────────────────────────────────────────────────────┐
│  Web 事件面板（优先级筛选 / 待审核）· 日志事件表 · 成本统计        │
└───────────────────────────────────────────────────────────────────┘
```

### 2.2 画板：整体流转

<whiteboard type="mermaid">
flowchart TD
  subgraph L1["① 采集层 · 事件源插件"]
    S1["飞书用户消息 · push 长连接"]
    S2["运营群消息 · push 长连接"]
    S3["GitHub Issue · pull 轮询"]
    S4["Webhook · push HTTP"]
    S5["定时任务 · schedule"]
  end
  subgraph L2["② 归一层"]
    N1["统一信封 · EventEnvelope"]
    N2["去重与幂等 · dedupeKey"]
  end
  subgraph L3["③ 事件队列池"]
    Q1["P0 插队队列"]
    Q2["P1 / P2 常规队列"]
    Q3["P3 低峰批量队列"]
    Q4["按定级结果重新入队"]
  end
  subgraph L4["④ 判定层"]
    R1["规则判定 Rule Engine · 明确的不调模型"]
    J1["Jev 决策模型 · 灰区兜底"]
  end
  subgraph L5["⑤ 调度层"]
    C1["时间窗口 · 高峰 / 低峰"]
    C2["Token 预算 · 超限延后"]
    C3["并发与重试"]
  end
  subgraph L6["⑥ 执行层"]
    D1["直派工单 · 复用现有派工"]
    D2["审核列表 · 通知 admin"]
    D3["忽略并归档"]
  end
  S1 --> N1
  S2 --> N1
  S3 --> N1
  S4 --> N1
  S5 --> N1
  N1 --> N2
  N2 --> Q1
  N2 --> Q2
  N2 --> Q3
  Q1 --> R1
  Q2 --> R1
  Q3 --> R1
  R1 -->|"规则已定级"| Q4
  R1 -->|"需要语义判断"| J1
  J1 -->|"模型定级"| Q4
  Q4 --> C1
  R1 --> C1
  C1 --> C2
  C2 --> C3
  C3 --> D1
  C3 --> D2
  C3 --> D3
</whiteboard>

### 2.3 画板：一条事件的完整生命周期

<whiteboard type="mermaid">
stateDiagram-v2
  [*] --> pending: 采集入库
  pending --> evaluating: 出队判定
  evaluating --> deferred: 窗口外或预算超限
  deferred --> pending: 窗口开启或预算恢复
  evaluating --> ignored: 规则或模型判定不处理
  evaluating --> review: 需要人介入
  evaluating --> dispatched: 直接派发工单
  evaluating --> failed: 判定或派发异常
  failed --> pending: 退避后重试
  review --> dispatched: 管理员批准
  review --> ignored: 管理员驳回
  dispatched --> [*]
  ignored --> [*]
</whiteboard>

### 2.4 在现有 monorepo 里的落位

沿用 `docs/MONOREPO.md` 的依赖方向（`core ← infra ← runtime/channel ← src/`），新增两个包，不另起装配方式：

| 新增/改动 | 位置 | 职责 |
| --- | --- | --- |
| **新包** `packages/event` | 依赖 `core` + `infra` | 事件信封、优先级、队列池、规则判定、调度器（纯逻辑，不碰 IO） |
| **新包** `packages/event-source` | 依赖 `event` + `core` | 事件源插件（GitHub Issue / Webhook / 定时任务 / 运营群），沿用 `packages/channel/src/plugins` 的插件加载范式 |
| `packages/core` | 扩展 | `EventEnvelope` / `EventPriority` / `EventDecision` 等领域类型（与 `Trigger`、`Ticket` 同级） |
| `packages/core/src/admission.ts` | 复用 | 现有 `admissionOf()` 规则集直接成为规则判定层的第一批规则，不重写 |
| `src/`（宿主） | 装配 | 启动事件源插件、挂载 webhook 路由、跑调度循环、暴露面板 API |
| `src/web` | 新增页签 | 「事件」页：队列视图 + 审核列表（现有页签：`setup / tickets / logs / config / sources`） |

> 说明：`packages/channel` 继续只管「可发消息的通道」（飞书），事件源里**没有出站需求**的（Issue / 定时任务）不放进 channel，避免 channel 变成杂物间。Webhook 的 HTTP 端点挂在宿主已有的 API 服务上（`src/router/api.ts`），`packages/event-source` 只提供与框架无关的 handler。

---

## 3. 统一事件模型

### 3.1 EventEnvelope（事件信封）

所有来源归一化成同一个结构，下游只认它，不认来源：

```ts
/** 事件优先级：数字越小越先处理。 */
export type EventPriority = 'P0' | 'P1' | 'P2' | 'P3'

/** 事件状态：与画板 2.3 的状态机一一对应。 */
export type EventState =
  | 'pending'      // 在队列里等出队
  | 'evaluating'   // 正在判定
  | 'deferred'     // 窗口外 / 预算超限，延后处理
  | 'review'       // 需要人审核
  | 'dispatched'   // 已派发工单
  | 'ignored'      // 判定为不处理
  | 'failed'       // 处理异常，等重试

export interface EventEnvelope {
  /** 内部 ID（evt_xxx）。 */
  id: string
  /** 来源类型：feishu-direct / feishu-group / github-issue / webhook / schedule … */
  sourceType: string
  /** 来源实例 ID（哪个 GitHub 仓库、哪条 webhook）。 */
  sourceId: string
  /** 来源侧事件 ID，用于幂等去重。 */
  externalId: string
  /** 去重键：同一件事的多次投递必须算出同一个值。 */
  dedupeKey: string

  /** 标题（面板列表展示 + 派工标题兜底）。 */
  title: string
  /** 正文（送进决策模型 / 派工任务书）。 */
  body: string
  /** 原文载荷，便于回放与审计。 */
  raw?: unknown

  /** 来源上下文：群、发起人、话题；非聊天来源留空。 */
  context?: {
    chatId?: string
    chatName?: string
    threadId?: string
    actorId?: string
    actorName?: string
    actorType?: 'user' | 'bot' | 'system'
    repo?: string
    branch?: string
    url?: string
  }

  /** 规则给出的优先级基线；模型只能在允许范围内调整。 */
  priority: EventPriority
  /** 优先级来源说明，进日志与面板。 */
  priorityReason: string
  /** 规则/模型给出的类型标签：bug / feature / question / chore / info … */
  type?: string
  /** 预估 token 成本，用于预算控制。 */
  estimatedTokens?: number

  /** 判定与执行状态。 */
  state: EventState
  /** 处理说明：为什么不处理、为什么进审核。 */
  reason?: string
  /** 关联的工单 ID（派发后回填）。 */
  ticketId?: string
  /** 关联的审核单 ID（进审核列表时回填）。 */
  reviewId?: string

  /** 时间戳。 */
  receivedAt: string
  enqueuedAt: string
  evaluatedAt?: string
  /** 延后到什么时候再处理（窗口外 / 预算超限时回填）。 */
  notBefore?: string
  /** 重试次数。 */
  attempts: number
  /** 链路 ID：一次来源投递到最终结论全程可追。 */
  trace: string
}
```

### 3.2 来源与优先级基线

| sourceType | 接入模式 | 优先级基线 | 是否可能直派 | 备注 |
| --- | --- | --- | --- | --- |
| `feishu-direct` 飞书用户直发（@机器人 / 私聊） | push（长连接） | **P0** | 是 | 保持现有体验，插队 |
| `feishu-group` 运营群消息 | push（长连接） | P1 | 否，先审核 | 需要人确认要不要做 |
| `github-issue` GitHub Issue | pull（轮询 + 游标） | P2 | 视判定 | 只读 Issue/PR，代码变更仍由派工做 |
| `webhook` 第三方推送 | push（HTTP） | P2 | 视判定 | 必须带签名校验 |
| `schedule` 定时任务 | schedule（cron） | P3 | 是（低峰跑） | 巡检、汇总、补跑 |
| `ci` CI 结果 | push（可选） | P2 | 视判定 | 复用现有 GitHub Actions 链路 |

### 3.3 去重与幂等

- **幂等键**：`sourceId + externalId`（GitHub Issue 用 `repo#number@updated_at`，Webhook 用请求头 `X-Event-Id` 或 payload 哈希，飞书用 `message_id`）。
- **业务去重**：`dedupeKey` 用于「同一件事的重复投递」，例如同一 Issue 被评论 5 次 → `github-issue:owner/repo#12`（同一 Issue 只建一个工单，后续评论作为工单输入投递进去）。
- 去重命中要记日志（`event:duplicate`），否则用户会以为「事件丢了」。

---

## 4. 事件源：配置什么、怎么接

### 4.1 事件源不是一个开关

每个事件源配置 5 组信息：

| 配置组 | 字段 | 说明 |
| --- | --- | --- |
| **接入** | `mode`（push / pull / schedule）、`enabled` | 怎么拿到事件 |
| **连接** | 凭证、仓库、URL、cron 表达式、轮询间隔 | 连哪、连什么 |
| **过滤** | `include` / `exclude`、关键词、标签白名单、群白名单 | 什么算事件 |
| **定级** | `priority` 基线、`maxPriority` 上限 | 默认优先级；模型只能在允许范围内调 |
| **配额** | `dailyTokenBudget`、`maxPerDay`、`concurrency` | 成本与并发上限 |

```yaml
# ~/.router-agent/config.yaml 草案
eventBus:
  enabled: true
  sources:
    feishu-direct:
      enabled: true
      priority: P0
    feishu-group:
      enabled: true
      priority: P1
      requireReview: true
      includeGroups: [oc_运营群A, oc_运营群B]
    github-issue:
      enabled: true
      mode: pull
      repos: [blankPen/router-agent]
      intervalSeconds: 300
      priority: P2
      labels: [bug, needs-triage]
    webhook:
      enabled: true
      path: /api/events/webhook
      secret: ${RA_WEBHOOK_SECRET}
      priority: P2
    schedule:
      enabled: true
      cron: "0 3 * * *"
      priority: P3
      tasks: [daily-digest, stale-ticket-check]
  budget:
    dailyTokens: 200000
    peakHours: "09:00-20:00"
    offPeakHours: "20:00-09:00"
    peakOnlyPriorities: [P0, P1]
```

### 4.2 三种接入模式

| 模式 | 谁主动 | 实现方式 | 典型来源 | 注意事项 |
| --- | --- | --- | --- | --- |
| **push** | 第三方主动推给我们 | 长连接消费（飞书）/ HTTP 端点（Webhook） | 飞书消息、第三方 Webhook | Webhook 必须验签 + 限流 + 幂等；对外暴露端口需要内网穿透或反向代理 |
| **pull** | 我们主动去拉 | 定时轮询 + 增量游标（`since` / `updated_at`） | GitHub Issue / MR | 要存游标防止重复；GitHub API 有速率限制，需退避 |
| **schedule** | 时间到我们自己触发 | cron 表达式 → 生成事件 | 巡检、汇总、补跑 | 与 pull 长得像但语义不同：不依赖外部状态变化 |

> 现状只有 **push（飞书）**。pull 和 schedule 在本轮方案里第一次引入。

### 4.3 事件源插件接口（草案）

沿用 `packages/channel/src/plugins` 的插件形态（`meta` + `create(ctx)`），新增：

```ts
export interface EventSourcePlugin {
  kind: 'event-source'
  meta?: { id: string; name: string; hint: string; default?: boolean }
  /** 创建事件源实例；返回 null 表示配置不全，本次不启用。 */
  create(ctx: EventSourceContext): EventSource | null
}

export interface PollResult {
  events: unknown[]
  cursor: string
}

export interface EventSource {
  readonly id: string
  readonly mode: 'push' | 'pull' | 'schedule'
  /** push 模式：把外部原始事件交给宿主；pull/schedule 模式：宿主调用它拉取。 */
  start?(sink: (raw: unknown) => void): void   // 可返回 Promise
  stop?(): void
  /** pull 模式：返回一批新事件；游标由宿主持久化。 */
  poll?(cursor: string | null): PollResult
  /** 把外部事件归一化成 EventEnvelope；不认识的直接返回 null。 */
  normalize(raw: unknown): EventEnvelope | null
}
```

### 4.4 五类源的落地要点

**① 飞书用户消息（现有，保持不变）**
- 接入：继续用 `lark-cli event consume` 长连接；不新建通道。
- 变化：**在入库前插一层队列**。用户消息 `priority = P0`，出队时**插到最前**，不排在其它事件后面。
- 兼容：准入 `gate()` / `admissionOf()`、intake 会话、订阅扇出、派工全部沿用。P0 事件的处理时延目标 ≤ 现状（不能因为排队变慢）。

**② 运营群消息**
- 接入：同一个长连接，但按 `chatId` 判定是不是运营群（配置白名单）。
- 特性：运营群消息**默认进审核**：群里一句话可能是在聊天而不是在下需求。
- 降噪：同一群 5 分钟内相同关键词的消息合并成一条事件（`dedupeKey` 带时间窗）。

**③ GitHub Issue（重点补齐）**
- 接入：pull 模式，`gh issue list --json ...` 或 GitHub API，间隔 5 分钟，存 `updated_at` 游标。
- 归一化：标题 + 正文 + labels + 作者 + 链接；正文里的代码块与堆栈保留（截断到 2000 字）。
- 判定规则：label 含 `bug` → P2；`question` → 规则层直接归档（不建单）；`security` → 强制进审核 + 通知 admin。
- 关联：同仓库已有在办工单 → 作为**工单输入**投递（`fanOut` 语义），不新开单。

**④ Webhook**
- 接入：宿主 API 上挂 `/api/events/webhook`，`POST` JSON。
- 安全：HMAC 签名校验（`X-RA-Signature`）+ 时间戳防重放 + IP 白名单（可选）+ 请求体大小上限。
- 幂等：优先取 `X-Event-Id`，没有就按 body 哈希。
- 失败：验签失败 / 超限 → 直接 4xx 并记 `event:webhook-rejected`（不排队）。

**⑤ 定时任务**
- 接入：cron 表达式（`node-cron` 或自研最小实现，避免新依赖时先落在宿主现有定时器里）。
- 事件内容：任务定义（不是外部输入），生成 `schedule` 事件，`priority = P3`。
- 用途：每日汇总、过期工单巡检、PR 状态复查、低优积压批处理。
- 约束：只在低峰窗口跑；一次跑不完就拆分或顺延。

---

## 5. 队列池与优先级判定

### 5.1 队列池结构

- **存储**：SQLite（复用 `~/.router-agent/state.db`），新增 `events` 表；索引 `(state, priority, enqueued_at)`。
- **出队顺序**：`priority ASC` → `not_before ASC` → `enqueued_at ASC`。
- **P0 插队**：P0 事件直接置顶（`not_before = now`），不与其它事件竞争。
- **延后**：判定通过但当前是窗口外 / 预算超限 → `state = deferred` + `not_before = 窗口开启时刻`。
- **重试**：处理异常 → `failed` + 指数退避（1m / 5m / 30m / 2h），超过上限转 `ignored` 并记日志。
- **合并**：同一 `dedupeKey` 的重复事件不新增行，更新计数与最后到达时间（参考 agent-autoloop 的「同一件事合并成一轮」）。

### 5.2 规则辅助判定（Rule Engine）

规则先跑，命中即定案，**不进模型**。这是省钱和省时延的主要手段。

| 规则 | 判定内容 | 命中后 |
| --- | --- | --- |
| `source-priority` | 来源基线优先级 | 直接定级 |
| `direct-addressed` | 用户直发 / @机器人 / 私聊 | P0 + 直派倾向 |
| `admin-actor` | 发起人在管理员名单 | 提权一级（P1→P0） |
| `bot-actor` | 机器人消息 | 直接忽略（沿用 `admissionOf`） |
| `small-talk` | 纯寒暄 | 直接忽略（沿用 `isSmallTalk`） |
| `noise-pattern` | 日志粘贴、纯 URL、无诉求关键词 | 直接忽略 |
| `security-label` | `security` / `data-loss` 等标签 | 强制审核 + 通知 |
| `duplicate-burst` | 同源同键短时间内多次 | 合并成一条 |
| `repo-bound` | 已绑定项目 / 在办工单 | 转工单输入，不新开单 |
| `rate-limit` | 该来源今日已超配额 | 延后到次日 / 丢弃并告警 |

规则命中要写日志（事件名 + 命中的规则名 + 关键字段），这样「为什么这条没被处理」在面板上一眼可见。

### 5.3 Jev 决策模型：分级调用

Jev（当前是 Pi 决策层）只在**规则无法定案**时调用，且按事件类型用不同的问法与预算：

| 事件类别 | 是否需要模型 | 问题 | 预算 |
| --- | --- | --- | --- |
| 用户直发消息（P0） | 需要（现状不变） | 是否跟进 / 类型 / 紧迫度 / 项目相关性 | 沿用现状 |
| 运营群消息（P1） | 需要 | 是否是明确需求？归属项目？ | 小模型 + 短 prompt |
| GitHub Issue（P2） | 视规则结果 | 是否需要人排查？属于哪类问题？ | 小模型 + 只读工具 |
| Webhook（P2） | 视规则结果 | 是否需要动作？ | 小模型 |
| 定时任务（P3） | **不需要** | 规则完全决定 | 0 token |

**分级调用三条硬规则**：
1. **模型不能越权**：只能定「是否处理 / 类型 / 优先级（受限区间）/ 是否需要人审」，不能指定动作、工具范围、repo/branch（沿用 `packages/core/src/decision.ts` 的「模型只回答问题、动作由固定路由表派生」原则）。
2. **答案必须可解释**：落库 `reason` + `rules`，面板上能显示「因为哪条规则/哪个问题定的级」。
3. **失败降级**：模型超时/失败 → 保守降级（默认 P3 + 进审核，不丢事件），并记 `warn`。

### 5.4 出队与派发判定

<whiteboard type="mermaid">
flowchart LR
  E["事件出队"] --> K{"来源基线"}
  K -->|"用户直发"| P0["P0"]
  K -->|"运营群"| P1["P1"]
  K -->|"Issue / Webhook"| P2["P2"]
  K -->|"定时任务"| P3["P3"]
  P0 --> G{"规则判定"}
  P1 --> G
  P2 --> G
  P3 --> G
  G -->|"命中明确规则"| R["定级并放行"]
  G -->|"灰区"| J["Jev 决策模型"]
  J --> R
  R --> S{"当前是否可执行"}
  S -->|"窗口外 / 预算满"| DF["延后 deferred"]
  S -->|"可执行"| D{"是否需要人介入"}
  D -->|"否"| DP["直派工单"]
  D -->|"是"| RV["审核列表 + 通知"]
</whiteboard>

---

## 6. 成本控制与时间窗口

### 6.1 三档预算

| 预算 | 作用 | 超限行为 |
| --- | --- | --- |
| **单事件上限** | 防止一条事件烧掉整天的额度（如超长 Issue 正文） | 截断输入 / 降级为摘要后判定 |
| **来源日配额** | 防止某个来源刷屏（webhook 风暴、Issue 洪水） | 延后到次日低峰，或按规则丢弃并告警 |
| **全局日配额** | 总 token 上限 | 低优事件自动 `deferred` 到次日低峰；P0 不受影响 |

预算统计口径：按事件记录 `estimatedTokens`（判定）与 `actualTokens`（执行阶段，Worker 上报时回传），面板给「今日 / 近 7 日」两栏。

### 6.2 高峰 / 低峰窗口

```yaml
eventBus:
  budget:
    dailyTokens: 200000
    peakHours: "09:00-20:00"
    offPeakHours: "20:00-09:00"
    peakOnlyPriorities: [P0, P1]
    offPeakBatch: [P3]
```

规则：

- **高峰期（09:00–20:00）**：只处理 P0 / P1；P2 只做「判定」不做「执行」；P3 完全不跑。
- **低峰期（20:00–09:00）**：批量处理 P2 / P3；同源同批的事件合并成一次判定调用（省 token）。
- **窗口随时可调**：面板可临时改窗口（例如「今晚有发布，明早再跑批」），改完立即生效，不重启服务。
- **窗口是「延后」不是「丢弃」**：延后的事件保留在队列，窗口开启自动继续。

### 6.3 降级阶梯（预算/失败时逐级退让）

```text
Jev 决策模型（完整）
  ↓ 超预算
Jev 小模型 + 短 prompt（只判是否处理）
  ↓ 仍超预算
纯规则判定（不调模型，只按来源基线与关键词）
  ↓ 仍不可用
事件留在队列 + 面板标红「等待预算」+ 通知 admin（不丢事件）
```

### 6.4 省 token 的其它手段

- **事件摘要**：超长正文先做本地截断（`preview`）再进模型。
- **结论缓存**：同一 `dedupeKey` 的重复事件直接复用上次判定结论。
- **批量判定**：低峰期把 N 条同类事件合并成一次模型调用（批量返回 N 个结论）。
- **规则优先**：第 5.2 节的规则命中直接跳过模型（这是最大头）。

---

## 7. 分级派发：直派 vs 审核

### 7.1 判定矩阵

| 条件 | 动作 |
| --- | --- |
| P0 + 用户直发 + 管理员发起 | **直派**（保持现状体验） |
| P0 + 用户直发 + 普通成员 | 走现有 intake（澄清 → 管理员终审） |
| P1 运营群消息 | **审核**（admin 确认后才开单） |
| P2 Issue / Webhook + 规则明确（bug + 有复现 + 命中已知项目） | **直派**（限自动派发白名单项目） |
| P2 Issue / Webhook + 模型判定有价值但不确定 | **审核** |
| P2 + `security` / 数据风险 / 付费 / 对外发布 | **强制审核 + 立即通知** |
| P3 定时任务（只读巡检） | 直派（只读工具范围） |
| 规则判定为噪声 | 忽略并归档（保留可回溯记录） |

### 7.2 审核列表与通知

- **审核单**：独立实体 `ReviewItem`（事件 id、原因、建议动作、发起人、优先级、创建时间、状态）。
- **通知渠道**：飞书卡片（admin 私聊 / 运营群），卡片内容：来源、标题、摘要、优先级、建议动作（批准 / 驳回 / 降级 / 稍后处理）。
- **通知策略**：
  - P0/P1 立即推；P2 合并推送（同一批最多一张卡片，列 N 条）；P3 不推。
  - 通知失败不影响队列（记 `warn` 并重试），事件留在审核列表里等人在面板处理。
  - 超过审核 SLA（默认 24h）未处理 → 面板标「超时待处理」并汇总提醒。
- **审核动作回写**：批准 → 派发工单（回填 `ticketId`）；驳回 → 状态 `ignored` 并记原因；降级 → 改优先级后重新入队。

### 7.3 审核不是「第二次派工」

审核通过后走的是**和直派完全相同的派工链路**（`Engine.decide()` → Ticket → Mandate → 派工），审核只决定「要不要派」，不重复实现派工逻辑。

---

## 8. Web 事件面板

### 8.1 页面结构（新增「事件」页签）

现有页签：`setup / tickets / logs / config / sources`（`sources` 现在是飞书群目录）。新增 **「事件」** 页，两块视图：

```text
┌─ 事件页 ────────────────────────────────────────────────────────┐
│ [队列视图]                        [待审核]                      │
│  筛选条：优先级 / 状态 / 来源 / 时间 / 关键字      统计条：今日入队  │
│  ┌────────────────────────────────┐           ┌──────────────┐ │
│  │ P0 事件（置顶，插队处理中）      │           │ 待审核 3 条   │ │
│  │ P1 事件列表                      │           │ [批准][驳回] │ │
│  │ P2 事件列表                      │           │ 原因 + 建议   │ │
│  │ P3 事件（低峰批处理，折叠）       │           └──────────────┘ │
│  └────────────────────────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 筛选维度

| 维度 | 取值 |
| --- | --- |
| 优先级 | P0 / P1 / P2 / P3（多选，默认 P0+P1 展开） |
| 状态 | pending / evaluating / deferred / review / dispatched / ignored / failed |
| 来源类型 | feishu-direct / feishu-group / github-issue / webhook / schedule |
| 判定结果 | 规则命中 / 模型判定 / 人工审核 |
| 时间范围 | 今天 / 近 7 日 / 自定义 |
| 关键字 | 标题 + 正文 + 来源链接（复用日志页的过滤实现思路 `src/web/client/log-filters.ts`） |

### 8.3 行内信息与操作

每行展示：优先级徽标、来源图标、标题、来源链接（Issue / 消息跳转）、入队时间、等待时长、判定原因（一句话）、状态、以及成本估算。

操作：
- **展开**：看原始载荷、规则命中记录、模型问答摘要、完整判定链路（trace）。
- **手动提升/降级**：改优先级后立即重新入队。
- **立即处理**：跳过窗口立刻出队（P3 手动触发）。
- **忽略 / 重试 / 合并**：对应队列动作。
- **查看关联工单**：跳到现有工单页。

### 8.4 通知

- 面板上待审核项有红点计数（复用现有徽标机制 `ra-tk-32-web-badge`）。
- 审核项产生时推飞书卡片；面板处理后不再重复推。
- 「待审核」与「队列积压」都在面板首屏可见，不依赖用户去翻日志。

---

## 9. 数据模型（SQLite 草案）

```sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  raw TEXT,
  context TEXT,
  priority TEXT NOT NULL,
  priority_reason TEXT NOT NULL,
  type TEXT,
  estimated_tokens INTEGER,
  actual_tokens INTEGER,
  state TEXT NOT NULL,
  reason TEXT,
  ticket_id TEXT,
  review_id TEXT,
  received_at TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  evaluated_at TEXT,
  not_before TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  trace TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_queue ON events (state, priority, not_before, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_events_dedupe ON events (dedupe_key, state);

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  priority TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggestion TEXT,
  status TEXT NOT NULL,          -- open / approved / rejected / deferred
  notified_at TEXT,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_open ON review_items (status, created_at);

CREATE TABLE IF NOT EXISTS event_cursors (
  source_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

> 迁移按 `src/store/db.ts` 现有 `schema_migrations` 机制走，不引入第二个存储。

---

## 10. 日志与可观测

新增日志事件（同步进 `docs/OPERATIONS.md` 的事件表）：

| 事件 | 级别 | 关键字段 | 含义 |
| --- | --- | --- | --- |
| `event:ingested` | info | `eventId` `sourceType` `priority` `trace` | 事件入队 |
| `event:duplicate` | info | `eventId` `dedupeKey` | 重复投递被合并 |
| `event:evaluated` | info | `eventId` `decision` `rules` `priority` | 判定完成（规则/模型结论） |
| `event:deferred` | info | `eventId` `notBefore` `reason` | 因窗口/预算延后 |
| `event:dispatched` | action | `eventId` `ticketId` | 已派发工单 |
| `event:review-queued` | action | `eventId` `reviewId` `priority` | 进入审核列表 |
| `event:notified` | action | `eventId` `channel` | 审核通知已发出 |
| `event:failed` | error | `eventId` `message` | 处理异常 |
| `event:source-error` | warn | `sourceType` `message` | 事件源自身故障（轮询失败、webhook 验签失败） |
| `event:budget-exceeded` | warn | `eventId` `used` `limit` | 触发预算降级 |

规则：每个事件至少带 `eventId` + `trace`；事件来源相关事件带 `sourceType` / `sourceId`；派发类事件带 `ticketId`；审核类事件带 `reviewId`。面板「日志」页可直接按 `eventId` 过滤还原一条事件的全过程。

---

## 11. 安全与权限

- **Webhook**：HMAC 签名 + 时间戳窗口（防重放）+ body 大小上限 + 可选 IP 白名单；验签失败不排队。
- **GitHub**：只读 token（`repo` 读权限），Issue 内容不可信 → 送进模型前按「外部内容」处理，不允许其内容改变系统指令（沿用现有 prompt 的工具白名单与 `toolScope` 边界）。
- **事件源 → 工单**：只有 `P0/P1` 的管理员事件、或命中自动派发白名单的 P2 事件可以直接开单；其余一律审核。
- **定时任务**：默认只读工具范围；写操作必须显式配置并走审核。
- **日志**：事件正文进日志必须用 `preview(text, 160)` 截断，不记 token、密钥、完整 Issue 正文。

---

## 12. 落地路线

| 阶段 | 内容 | 产出 | 验收标准 |
| --- | --- | --- | --- |
| **一期：队列与优先级** | `packages/event`（信封 + 队列 + 规则层）、飞书消息入队、事件面板只读视图 | 事件表 + 面板「事件」页 | 用户消息仍然优先响应；面板能看到所有事件及判定原因 |
| **二期：来源扩展与审核** | `packages/event-source`（GitHub Issue pull / Webhook push / schedule）、审核列表 + 飞书卡片通知、事件面板可操作 | 三个新来源 + 审核闭环 | Issue 能自动建单并回链；Webhook 验签生效；审核通知可达 |
| **三期：成本与调度** | 时间窗口、Token 预算、降级阶梯、成本统计、批量判定 | 调度器 + 成本面板 | 高峰只跑 P0/P1；预算超限自动延后且不丢事件 |

每期都遵循「先红绿测试再实现」，测试重点：队列出队顺序、P0 插队、去重幂等、规则命中不调模型、窗口外延后、预算超限降级、审核动作回写。

---

## 13. 风险与取舍

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **排队把用户消息变慢** | 体验倒退（最严重） | P0 事件插队 + 单独 worker 通道；队列只在 P1 及以下生效；P0 走同步快路径 |
| **事件洪水**（webhook 风暴 / Issue 批量） | 队列膨胀、token 超支 | 来源日配额 + 合并去重 + 全局预算 + 延后 |
| **模型误判** | 派错工单、浪费时间 | 规则先行 + 模型只在灰区 + P1/P2 默认审核 + 决策可回放 |
| **外部内容注入** | Issue 正文里带指令 | 外部内容只作为数据传入；工具白名单 + `toolScope` 边界；必要时人工审核 |
| **与现有 intake / 订阅扇出冲突** | 同一消息被处理两次 | 用户消息进队列后仍走原路径（intent 不变）；扇出去重在队列层做一次 |
| **Webhook 需要对外端口** | 部署复杂度 | 默认可用本地端口 + 反代；不做公网直暴露，先在可信网络内验证 |
| **只做设计不落地** | 方案与现实脱节 | 三期拆分，每期有可验收标准；一期就能独立产生价值 |

**取舍说明**：本方案刻意**不**引入 Kafka / Redis / 工作流引擎。router-agent 是单机部署、事件量在百级/天，SQLite + 定时器足够；引入外部中间件会把部署门槛从「一个命令」拉高到「一套运维」，与 `agent-autoloop` 的轻量取向一致。

---

## 附录 A：可视化 HTML

本文的完整交互版流程图（分层、优先级、窗口、审核）在仓库里有一份自包含 HTML：

- 文件：`docs/design/event-bus-flow.html`（单文件，双击即可在浏览器打开，无外部依赖）
- 在线：https://github.com/blankPen/router-agent/blob/ra%2Ftk-87-%E8%AE%BE%E8%AE%A1%E5%A4%9A%E6%9D%A5%E6%BA%90%E4%BA%8B%E4%BB%B6%E6%80%BB%E7%BA%BF%E6%96%B9%E6%A1%88%E5%B9%B6%E8%BE%93%E5%87%BA%E9%A3%9E%E4%B9%A6%E6%96%87%E6%A1%A3-2/docs/design/event-bus-flow.html
- 设计稿 Markdown 同目录：`docs/design/event-bus-design.md`（本文的仓库版本）
- 分支：`ra/tk-87-设计多来源事件总线方案并输出飞书文档-2`（仓库 `blankPen/router-agent`，已推送）

本文第 2.2 / 2.3 / 5.4 节的飞书画板即为同一套流程图的原生版本，可直接在飞书里查看与编辑。

## 附录 B：术语

| 术语 | 含义 |
| --- | --- |
| 事件源 EventSource | 事件从哪来（飞书 / Issue / Webhook / 定时任务），插件化 |
| 接入模式 mode | push（对方推）/ pull（我们去拉）/ schedule（定时触发） |
| 事件信封 EventEnvelope | 归一化后的统一事件结构 |
| 事件队列池 | 持久化的事件队列，按优先级出队 |
| 规则判定 Rule Engine | 确定性规则先筛，避免调用模型 |
| Jev 决策模型 | 语义判定层（当前由 Pi 决策层承载） |
| 调度层 Scheduler | 时间窗口、预算、并发、重试 |
| 审核列表 ReviewItem | 需要人拍板的事件队列 |
