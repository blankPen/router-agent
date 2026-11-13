# 智能诊断工具改造设计（doctor → 日志 → 分流三段式）

> 目标：把现在的「读日志 + 模型总结」排查助手，升级成「先查配置、再扫错误告警、最后按问题性质分流」的诊断工具。
>
> 版本：v1.0（设计定稿；本轮只出文档，不改业务代码、不提交实现）
> 仓库基线：`main` @ `ddc3e2b`（v0.3.31）
> 编写：ra worker（tk-78）
> 关联现状文档：[OPERATIONS.md](OPERATIONS.md)（日志事件表与排查助手说明）

---

## 0. 结论先行

1. **现状不是「没有诊断」，而是「诊断链缺头缺尾」**。中间那段（日志扫描 → 结论）做得很完整：5000 行 / 4MB 回看、错误优先分诊、证据与结论强一致、模型失败自动退化成规则知识库。缺的是头（配置与环境的自检）和尾（按问题性质分流到「修配置 / 上报 / 直接给结论」）。
2. **doctor 已经是一套成熟能力，但只活在 CLI 里**。`ra doctor` 有 10 项固定检查 + 运行时相关检查（飞书身份、事件订阅预检、群可见性、机器人是否在群、模型配置、端口、运行状态、Worker runtime 自检），却完全没进 Web 面板，也没进助手。助手给模型的 `read_config` 工具返回的是**启动时的配置快照**（`publicConfig(config)`），查不出「机器人不在群里」「事件订阅没开」这类真正的配置故障。
3. **日志扫描要独立于面板过滤器**。现在助手的扫描范围受面板上的 level / keyword 过滤影响，用户在「只显示 INFO」的视图里问「为什么没反应」，那 3 条 error 根本进不了证据池，助手只能回「日志里没有命中已知问题模式」。
4. **分流缺一类**。现在只有 `config`（用户自己能改）与 `defect`（应上报），缺「纯分析类」——用户只是问「`worker:status-failed` 是什么意思」「现在的架构是怎样的」，这类问题应该**直接给结论、不给任何按钮**。现在这类问题往往被规则库硬塞一个「去配置页检查」的入口，属于给错方向。
5. **上报缺环境证据**。issue 正文只有「问题描述 / 排查结论 / 证据日志」三段，没有版本、没有 doctor 结论、没有脱敏配置快照。上游拿到 issue 仍然要反问「你这台机器配置对不对」，来回一轮才能定性。
6. **上报目标要可插拔**。当前只有 `gh issue create` 一条路（`blankPen/router-agent`，可用 `RA_ISSUE_REPO` 覆盖）。期望流程里的「上报 H」要求目标可配置，设计上把上报做成 `DiagnosisReporter` 端口，GitHub 只是第一个实现。
7. **落地分三期**：P0 把 doctor 抽成可复用的健康探针（CLI / 面板 / 助手共用）；P1 助手改成三段式管线并产出结构化 `DiagnosisReport`；P2 分流增强 + 上报目标适配器 + `ra diagnose` CLI。每期都可独立交付、独立回滚。

---

## 1. 背景、目标与非目标

### 1.1 背景

router-agent 的 Web 面板右下角有一个「智能问题排查助手」悬浮按钮。它做的事情是：读用户问题 → 从服务日志里挑相关条目 → 让模型总结成「结论 / 可能原因 / 建议 / 证据」→ 判定为缺陷时一键上报 GitHub issue。

用户期望的诊断流程是三段式的：

```text
[1] 先跑 doctor 检查配置     → 环境是否配好
[2] 再扫最近日志中的 error / 告警 → 运行时发生了什么
[3] 最后分流                → bug 类引导上报 H；纯分析类直接给结论
```

现在的实现只覆盖了第 2 段（而且范围受面板过滤器约束），第 1 段完全没有，第 3 段只有两类且分类维度不对。

### 1.2 目标

- 让诊断成为一条**有头有尾**的管线：自检 → 扫描 → 结论 → 分流，每一段的产物都能被用户看到、被模型引用、被写进上报内容。
- 结论**可核对**：每条判断标明依据来自哪里（日志 / 自检 / 配置 / 代码），不让模型的猜测看起来像事实。
- 分流**三分类**：`config`（用户自己能改）/ `defect`（是 bug，引导上报）/ `analysis`（纯分析，直接给结论，不给按钮）。
- 上报内容**自带环境证据**：版本、doctor 结论、脱敏配置、错误日志一次带齐，上游不用再追问。
- 自检能力**一处实现、多处复用**：`ra doctor`、Web 面板、排查助手、未来的 `ra diagnose` 共用同一套探针。

### 1.3 非目标

- 本工单**不改业务代码、不提交实现**，只产出设计。
- 不改 Router 的研判层（`decision-engine` / `prompts/orchestrator.md`）的职责边界；诊断是给**运维使用者**用的工具，不是 Router 的开单逻辑。
- 不做「自动修复」：诊断只出结论与下一步动作，不代替用户改配置、不自动建工单。
- 不把飞书侧对话入口纳入本期（见 §8 未决问题）。
- 不放宽现有诊断工具的安全边界：只读、路径封闭、限量（见 §2.5）。

---

## 2. 现状调研

### 2.1 触发入口

| 入口 | 位置 | 现状能力 |
|-|-|-|
| Web 面板悬浮按钮（FAB） | `src/web/client/log-assistant.tsx` | 每 5s 轮询 `/api/logs?limit=200` 统计 error 数量；有错误时红点角标 + toast「检测到 N 条新的错误日志」。快捷菜单三项：智能分析异常 / 上报 GitHub issue / 打开排查面板 |
| Web 面板弹窗 | 同上 | 输入框（⌘/Ctrl+Enter 提交）+ 7 个常见问题快捷 chip；渲染结论 / 可能原因 / 建议 / 证据 / 工具清单；底部按 `next` 给「去配置页」或「一键上报 GitHub issue」 |
| HTTP API | `src/router/api.ts` | `GET /api/logs/assistant`（`llmConfigured` + `suggestions`）、`POST /api/logs/assistant`（`{question, level?, keyword?}` → `{diagnosis}`）、`POST /api/logs/assistant/issue`（`{question, diagnosis, title?}` → `{issue:{number,url}}`） |
| CLI | — | **无**。`ra doctor` 是独立的启动前自检命令，与助手不联通、结果也不进助手 |
| 飞书 | — | **无**。飞书侧只能通过 Router 研判开单，由 Worker 人工排查 |

### 2.2 调用链

```text
Web FAB
  └─ POST /api/logs/assistant {question}
       └─ src/router/api.ts → LogAssistantPort.diagnose()
            └─ src/router/log-assistant.ts :: createLogAssistant().diagnose()
                 ├─ readLogTail(logPath, {lines: 5000})          ← 4MB / 5000 行窗口
                 ├─ filterEntries(panel level / keyword)          ← 受面板过滤影响
                 ├─ matchSymptoms(scoped)                        ← 7 类「事件名→症状」知识库
                 ├─ selectEvidence(scoped, question)              ← 打分挑 ≤40 条，错误→告警→信息
                 ├─ ensureEvidence(evidence, scoped, hitEvents)  ← 结论提到的事件必须可见
                 ├─ 有模型 → askModel(client, q, evidence, tools)
                 │     └─ ≤6 轮工具调用：read_config / list_code / read_code / search_code
                 │     └─ extractJsonObject(raw) → LogDiagnosis
                 │  无模型 / 调用失败 → ruleDiagnosis()          ← 事件名命中 → causes/actions/next
                 └─ 返回 LogDiagnosis {summary, causes[], actions[], evidence[], source,
                                      degraded?, toolsUsed?, next[]}
                      ├─ UI 渲染（结论 / 原因 / 建议 / 证据 / 按钮）
                      └─ next 含 kind=issue → POST /api/logs/assistant/issue
                             └─ createIssueReporter().create() → gh issue create --repo blankPen/router-agent
                                   └─ buildIssueBody() → 四段正文
```

关键实现位置：

| 关注点 | 文件 |
|-|-|
| 助手主体（知识库、证据挑选、模型总结、规则降级） | `src/router/log-assistant.ts`（803 行） |
| 只读工具集（读配置 / 列目录 / 读文件 / 搜代码） | `src/router/diagnosis-tools.ts`（214 行） |
| 日志读文件（面板增量读 + 助手长尾读） | `src/router/log-tail.ts`（185 行） |
| 自检 | `src/cli/doctor.ts`（279 行） |
| 上报 issue | `src/router/issue-report.ts`（161 行） |
| API 端点 | `src/router/api.ts:607-666` |
| 装配 | `src/cli/index.ts:1514-1530` |
| 前端 | `src/web/client/log-assistant.tsx`（421 行） |

### 2.3 已覆盖的诊断项

内置知识库 `SYMPTOMS`（`src/router/log-assistant.ts`）共 7 类，是规则式排查与快捷 chip 的共同来源：

| id | 标题 | 分类 | 关键事件 | 处置 |
|-|-|-|-|-|
| `message-ignored` | 消息进来了但被过滤 / 机器人没反应 | config | `trigger:dropped`、`trigger:duplicate`、`feishu:bot-identity-failed`、`identity:resolve-failed` 等 | 去「飞书消息 · 允许名单」 |
| `config-not-effective` | 配置改了不生效 | config | `config:parse-failed`、`config:patch-rejected`、`config:write-failed` 等 | 去配置页逐项核对 |
| `ticket-not-created` | 消息没有变成工单 / 没派工 | config | `decision:engine-failed`、`loop:trigger-failed`、`chat:reply-failed` | 去「准入策略 · 接单模式」 |
| `worker-stuck` | Worker 卡住 / 执行失败 | defect | `worker:status-failed`、`codex:turn-failed`、`codex:process-exit`、`effect:failed`、`idle:stale` | 上报 issue |
| `service-error` | 服务自身报错 / 面板打不开 | defect | `api:request-failed`、`session:migration-required`、`feishu:consumer-start-failed` | 上报 issue |
| `reply-not-sent` | 回复 / 通知没发出去 | defect | `outbox:failed`、`channel:not-registered`、`feishu:card-fallback` | 上报 issue |
| `pr-tracking` | PR / MR 状态查不到 | defect | `pr:track-failed`、`pr:inspect-failed`、`report:evidence-missing` | 上报 issue |

覆盖特点是**偏「消息链路」**：接入 → 研判 → 建单 → 派工 → 执行 → 投递 → PR。缺的是**配置与环境类诊断项**（机器人是否在群里、事件订阅是否开启、模型是否可用、端口是否冲突），而这些恰恰是 doctor 已经能查的。

### 2.4 输出形式

- **结构**：`LogDiagnosis { summary, causes[{title,detail,events[],category?}], actions[], evidence[], source: 'llm'|'rules', degraded?, toolsUsed?, next[] }`。
- **面板呈现**：结论一句话 → 可能原因列表 → 建议的下一步 → 证据日志（按分诊顺序）→ 工具清单 → 底部动作按钮（去配置页 / 一键上报 issue）。
- **上报正文**（`buildIssueBody`）：问题描述 → 排查结论（可能原因 + 建议）→ 错误日志（`error` 级单独提到最前）→ 证据日志 → 落款「由 router-agent Web 面板的智能排查助手生成；版本 vX」。
- **降级可见**：模型没配或调用失败时 `source='rules'`、`degraded` 写明原因；面板提示「未配置模型，助手按内置的事件规则排查」。
- **日志事件**：`logs:assistant-answered`（info）、`logs:assistant-model-failed`（warn）、`api:log-assistant-failed`（error）、`issue:created`（info）、`issue:create-failed`（error）、`api:issue`（info）、`api:issue-create-failed`（error）。

### 2.5 值得保留的现状约束

改造时不能弄丢的东西：

1. **只读 + 路径封闭 + 限量**：诊断工具没有任何写、删、执行命令的能力，路径必须落在安装目录内，单次读文件 400 行 / 20000 字符，搜索最多 30 条命中。
2. **证据与结论强一致**：`ensureEvidence` 保证「结论里提到的事件 = 证据里看得见的事件」。
3. **发模型前脱敏**：正文类字段（`text` / `reply` / `summary` / `content` …）替换为「（内容已省略）」；`read_config` 返回脱敏配置。
4. **规则降级永远有话说**：现场机器常常还没配模型，靠固定的事件名知识库照样能给出结论。
5. **并发串行化**：面板连点「分析」时排队，避免把模型打爆。
6. **上报失败给中文动作**：`gh` 没装 / 没登录 / 凭据失效 / 无权限 / 仓库不存在各有明确提示，不给裸英文报错。

---

## 3. 期望流程与差距分析

期望三段式：

```text
[1] doctor 查配置   → 环境是否配好（配置、飞书、群、机器人、模型、运行时、端口）
[2] 扫 error / 告警 → 运行时到底发生了什么（独立于面板过滤器）
[3] 分流            → bug 类 → 引导上报 H ；纯分析类 → 直接给结论
```

| # | 期望 | 现状 | 差距 | 严重度 |
|-|-|-|-|-|
| G1 | 先跑 doctor 查配置 | 助手完全不跑 doctor；模型的 `read_config` 工具返回**启动时的配置快照**，不查飞书身份 / 事件订阅 / 群可见性 / 机器人是否在群 / 模型可用性 | 缺一整段环境探针；「机器人不在群里」这类最常见故障给不出结论 | 高 |
| G2 | 扫最近日志的 error / 告警 | 有 `selectEvidence`，但输入是 `filterEntries(面板 level/keyword)` 之后的结果 | 用户在过滤视图里提问时，error 根本进不了证据池；结论会退化成「没有命中已知问题模式」 | 高 |
| G3 | 分流：bug → 上报；纯分析 → 直接给结论 | 分类只有 `config` / `defect`；规则模式命中 config 类就硬塞「去配置页」入口 | 缺 `analysis` 类；纯解释类问题被推去改配置 | 高 |
| G4 | 上报要带得走上下文 | issue 正文只有问题 / 结论 / 证据日志 | 缺版本、doctor 结论、脱敏配置快照、运行时信息；上游无法一次定性 | 中 |
| G5 | 上报目标是 H（可配置） | 只有 `gh issue create`，仓库靠 `RA_ISSUE_REPO` 换 | 上报通道写死；换目标要改代码 | 中 |
| G6 | 多入口可用 | 只有 Web 面板 | CLI 无 `ra diagnose`；飞书侧无入口；`ra doctor` 的结果不能直接变成一次诊断 | 中 |
| G7 | 结论可核对 | 只有 `toolsUsed`（用了哪些工具） | 没有「这条判断依据是什么」的标注；模型把猜测说成事实时用户看不出来 | 低 |

关于「上报 H」：本文按**可配置的上报目标（issue tracker）**理解。仓库现有实现是 GitHub（`blankPen/router-agent`，`RA_ISSUE_REPO` 可覆盖）。若 H 是公司内某个具体系统，实施时只需新增一个 `DiagnosisReporter` 实现，诊断管线本身不用改——这是 §4.6 把上报做成端口的原因。

---

## 4. 方案设计

### 4.1 目标管线

```text
                     ┌─────────────────────────────┐
用户问题 ───────────▶│ 1. 健康自检 HealthProbe      │──▶ HealthReport
                     ├─────────────────────────────┤
                     │ 2. 日志扫描 scanLogs         │──▶ LogScan(errors/warns) + evidence
                     ├─────────────────────────────┤
                     │ 3. 结论生成 LLM / 规则        │──▶ Finding[]
                     ├─────────────────────────────┤
                     │ 4. 分流 classify             │──▶ NextAction[]
                     └─────────────────────────────┘
                                    │
                                    ▼
                          DiagnosisReport（结构化，可渲染 / 可上报 / 可转发）
```

管线是**串行三步 + 结论**：`HealthReport` 与 `LogScan` 都要进模型上下文（自检结果常常直接就是答案，例如「机器人在群内：fail」），也都要进上报正文。

### 4.2 模块划分与分层

诊断属于**宿主应用能力**（依赖 config、runtime 端口、channel-feishu），放 `src/`，不新开 package：

```text
src/router/diagnostics/
  health-probe.ts   ← 从 src/cli/doctor.ts 抽出的探针实现（CLI / 面板 / 助手共用）
  scan.ts           ← 日志扫描：按错误/告警聚合、挑证据
  findings.ts       ← Finding 定义、分类与依据标注
  classify.ts       ← 三分类分流规则（config / defect / analysis）
  pipeline.ts       ← 编排：自检 → 扫描 → 结论 → 分流 → DiagnosisReport
  reporter.ts       ← DiagnosisReporter 端口 + GitHub 实现
  render.ts         ← DiagnosisReport → 面板 JSON / issue 正文 / 纯文本
```

依赖方向不变（`core ← infra ← runtime/channel ← src/`）：

- `health-probe.ts` 依赖 `src/config.ts` 的 `AppConfig`、`#infra/process.js` 的 `CommandRunner`、`#runtime/port.js` 的 `WorkerRuntime`、以及 `@router-agent/channel-feishu` 的解析函数——**全部向下**，不违反 `packages/*` 不得 import `src/` 的约束。
- `src/cli/doctor.ts` 变成薄壳：只负责 CLI 的装配与输出格式，探针实现搬进 `health-probe.ts`。

### 4.3 接口与数据结构

```ts
// ---------------------------------------------------------------------------
// 1. 健康自检
// ---------------------------------------------------------------------------

/** 检查结论。skip = 该检查在当前运行阶段不适用（例如服务已在跑时的「端口空闲」）。 */
export type HealthStatus = 'ok' | 'warn' | 'fail' | 'skip'

export interface HealthCheck {
  /** 检查项名，与 `ra doctor` 现有文案保持一致，避免两处说法不同。 */
  name: string
  status: HealthStatus
  /** 一行可读结论。 */
  detail: string
  /** 怎么修。 */
  hint?: string
  /** 分组，面板按组折叠展示。 */
  group?: 'config' | 'channel' | 'runtime' | 'model' | 'service'
  /** 该检查项对应的配置页 section id（如 sec-feishu），用于「去改配置」跳转。 */
  section?: string
}

export interface HealthReport {
  checks: HealthCheck[]
  /** 整体结论：取所有检查项里最差的一个。 */
  status: 'ok' | 'warn' | 'fail'
  /** 当前版本号。 */
  version: string
  /** 生成时刻（ISO 8601）。 */
  generatedAt: string
  /** 耗时（毫秒）。 */
  durationMs: number
}

/** 健康探针端口：CLI、面板、助手共用同一个实现。 */
export interface HealthProbe {
  run(): Promise<HealthReport>
}

export interface HealthProbeDeps {
  config: AppConfig
  orca: CommandRunner
  lark: CommandRunner
  llm: () => { ok: boolean; detail: string }
  portFree: () => Promise<boolean>
  servicePid: number | null
  runtime?: WorkerRuntime
  runtimeChoices?: RuntimeChoice[]
  /** 运行阶段：启动前自检可以查端口与进程；服务在跑时这两项应 skip。 */
  phase?: 'preflight' | 'runtime'
}
```

```ts
// ---------------------------------------------------------------------------
// 2. 日志扫描
// ---------------------------------------------------------------------------

/** 同一事件名的聚合条目：一次排查里同一个错误可能重复几十次。 */
export interface LogScanItem {
  /** 事件名（域:动作）。 */
  message: string
  level: 'error' | 'warn'
  /** 出现次数。 */
  count: number
  /** 最近一次出现时间。 */
  lastAt: string
  /** 首次出现时间。 */
  firstAt: string
  /** 最近一次的字段摘要。 */
  detail?: string
}

export interface LogScan {
  /** 按出现次数降序的 error 聚合。 */
  errors: LogScanItem[]
  /** 按出现次数降序的 warn 聚合。 */
  warns: LogScanItem[]
  /** 送进模型的证据（≤ MAX_ASSISTANT_EVIDENCE 条，已按分诊排序）。 */
  evidence: LogEvidence[]
  /** 实际回看的行数。 */
  scannedLines: number
  /** 回看窗口覆盖的时间范围；跨 0 表示只有一端。 */
  window?: { from?: string; to?: string }
}
```

```ts
// ---------------------------------------------------------------------------
// 3. 结论与依据
// ---------------------------------------------------------------------------

/**
 * 结论分类：
 * - config：配置 / 环境问题，用户自己能改（对应 doctor 的 fail/warn 项）；
 * - defect：确实是 bug 或体验缺陷，引导上报；
 * - analysis：纯分析类问题（解释事件含义、介绍现状），直接给结论，不给动作按钮。
 */
export type FindingCategory = 'config' | 'defect' | 'analysis'

/** 判断的依据来源，用于让用户核对结论从哪来。 */
export type EvidenceSource = 'logs' | 'health' | 'config' | 'code'

export interface Finding {
  title: string
  /** 为什么得出这个结论。 */
  detail: string
  /** 支撑的事件名。 */
  events: string[]
  category: FindingCategory
  /** 依据来源；模型必须标明，否则按 'logs' 处理并视为不确定。 */
  source: EvidenceSource
  /** 置信度：没有日志 / 自检支撑的结论不得标 high。 */
  confidence: 'high' | 'medium' | 'low'
}
```

```ts
// ---------------------------------------------------------------------------
// 4. 动作与最终报告
// ---------------------------------------------------------------------------

export type NextAction =
  /** 引导去配置页改（config 类）。 */
  | { kind: 'fix-config'; label: string; section?: string; hint?: string }
  /** 引导上报（defect 类）：正文由 DiagnosisReport 生成。 */
  | { kind: 'report'; label: string; target: string; title: string; body: string }
  /** 直接给结论（analysis 类）：没有按钮，只有一句话答复。 */
  | { kind: 'answer'; label: string; text: string }
  /** 需要更多信息（结论不明确时）。 */
  | { kind: 'ask'; label: string; text: string }

export type DiagnosisStatus = 'resolved' | 'needs-action' | 'needs-info' | 'unknown'

export interface DiagnosisReport {
  /** 结构版本号，便于以后改字段时兼容旧数据。 */
  schema: 1
  version: string
  question: string
  status: DiagnosisStatus
  /** 一句话结论。 */
  summary: string
  findings: Finding[]
  /** 建议的下一步（文本版，与 next 一一对应）。 */
  actions: string[]
  /** 自检结果；自检失败时是主结论的依据。 */
  health?: HealthReport
  /** 日志扫描结果。 */
  scan?: LogScan
  /** 证据日志（与 findings 里提到的事件一致）。 */
  evidence: LogEvidence[]
  /** llm = 模型总结；rules = 规则降级。 */
  source: 'llm' | 'rules'
  /** 降级原因。 */
  degraded?: string
  /** 用到的工具。 */
  toolsUsed?: string[]
  next: NextAction[]
  generatedAt: string
}
```

兼容性：`LogDiagnosis` 是 `DiagnosisReport` 的子集形态，改造期可以让 `LogDiagnosis` 继续存在并由 `DiagnosisReport` 派生，避免前后端同时大改（前端 `src/web/client/log-assistant.tsx` 里的同名接口随之演进）。

### 4.4 doctor 复用：从「CLI 命令」到「健康探针」

这是本次改造最关键的一步。当前 `runDoctor(deps)` 已经是一个纯函数（deps 注入、可测），但**装配留在 CLI**：`src/cli/index.ts:348` 现场拼 `orca` runner、`lark` runner、`llm()`、`portFree()`、`servicePid`。

改造分三步：

1. **抽探针**：把 `runDoctor` 的实现搬到 `src/router/diagnostics/health-probe.ts`，导出 `createHealthProbe(deps): HealthProbe`；`src/cli/doctor.ts` 保留 `formatChecks` 与 CLI 装配，`ra doctor` 行为不变。
2. **引入运行阶段**：现有检查里「服务端口空闲」「运行状态」两项只在**启动前**有意义——服务进程自己跑着，端口必然占用、服务 PID 就是自己。若在服务内直接复用，会稳定报两个 fail，把结论带偏。因此 `HealthProbeDeps.phase` 区分 `preflight`（CLI）与 `runtime`（服务内），`runtime` 阶段这两项返回 `skip` 而不是 `fail`。
3. **服务内装配**：服务进程已经持有 config、orca/lark runner、runtime 实例，缺的是 `portFree` 与 `servicePid`——`runtime` 阶段本来就 skip，可以直接传 `() => false` / `null`，但要在代码里写明原因，而不是留个会误导人的假实现。

服务内自检的**副作用**要显式承认：它会调用 `orca status`、`lark im +chat-members-list` 等外部命令，有耗时与配额。因此：

- 只在用户点「开始诊断」时跑，**不放进面板轮询**；
- 探针内部有超时（沿用 CLI 现有实践）与并发去重（同一次诊断内不重复跑）。

### 4.5 日志扫描独立于面板过滤器

现在 `diagnose()` 先 `filterEntries(entries, {level, keyword})` 再挑证据。改造后：

- **扫描层**：`scanLogs(path, { windowLines: 5000, windowBytes: 4MB })` 直接读文件尾部，产出 `errors` / `warns` 聚合（按事件名去重、计次、记首末时间）。
- **证据层**：证据池 = 「与问题相关的条目」+「所有 error / warn 的代表条目」+「命中知识库的事件条目」，仍然受分诊排序（error → warn → info）与 `ensureEvidence` 约束。
- **面板过滤器只影响展示**：不再决定「助手能看到什么」。用户在日志页选的 level/keyword 仍然传给助手，但助手**在其之上追加**全局 error / warn 摘要，并在结论里说明「另外扫到 N 条未命中过滤条件的错误」。

这一步直接消除 G2：无论面板处于什么过滤状态，诊断都能看到最近的全部错误与告警。

### 4.6 分流规则

分流输入是 `HealthReport` + `LogScan` + `Finding[]`，输出 `NextAction[]`。判定顺序：

```text
1. 自检有 fail 项，且症状与该检查项相关
      → config：NextAction = fix-config（带 section）
      → 同时若日志里有 error，仍追加 report（缺陷不能被配置引导挡住，沿用现有规则）

2. 自检全过（或无相关 fail），但日志扫描里有 error
      → defect：NextAction = report（引导上报 H）

3. 既没有自检 fail，也没有 error / warn 命中，且问题是解释 / 现状类
      → analysis：NextAction = answer（直接给结论，不给按钮）

4. 证据不足以定性
      → needs-info：NextAction = ask（明确说「日志里看不到 X，需要什么」）
```

第 3 条的「解释 / 现状类」识别，两条路径：

- **模型判**：SYSTEM_PROMPT 里明确要求——「用户只要求解释现象、事件含义或现状，没有报告故障时，category 填 analysis」；模型已经输出 `category`，规则层不再改写。
- **规则判（无模型时）**：关键词命中（`什么意思` / `是什么` / `怎么用` / `有必要吗` / `解释一下` / `当前状态` / `有哪些`）+ 无 error / warn 命中 + 未命中任何 config 类症状关键词 → analysis。

判定顺序里，**config 优先于 defect** 与现状一致（现有 `nextStepsFor` 也是这个倾向），但必须保留「两类同时命中时两个入口都给」的规则：配置引导不能把缺陷上报入口吞掉。

### 4.7 上报目标适配器（引导上报 H）

```ts
/** 上报目标。 */
export interface IssueTarget {
  /** 目标 id，如 github / gitlab / feishu。 */
  id: string
  /** 展示名，如「GitHub · blankPen/router-agent」。 */
  label: string
  kind: 'github' | 'gitlab' | 'feishu' | 'custom'
  /** 该目标是否可用（如 gh 没装 / 没登录 → 不可用并给出原因）。 */
  available: boolean
  /** 不可用原因，会直接显示给用户。 */
  reason?: string
}

export interface DiagnosisReporter {
  /** 列出可用上报目标。 */
  list(): Promise<IssueTarget[]>
  /** 创建一条上报记录。 */
  create(input: {
    target: string
    title: string
    body: string
  }): Promise<{ id: string; number?: number; url?: string }>
}
```

- 现有 `createIssueReporter` 改成 `GitHubReporter` 实现，**行为不变**（仍走 `gh` CLI、仍受 `RA_ISSUE_REPO` 控制、失败提示文案不变），只是换了个端口形状。
- H 通道落地时新增一个实现即可，诊断管线不用动。
- `IssueTarget.available=false` 时，面板不显示上报按钮，改为显示原因（例如「gh 未登录，先执行 gh auth login」），避免点了才失败。

### 4.8 上报正文升级

`buildIssueBody` 升级为 `buildDiagnosisBody(report)`，在现有四段之外补两段：

```text
## 问题描述
## 排查结论
   （finding 列表 + 每条的依据与置信度）
## 环境与自检
   - 版本 v0.3.31 / 平台 macOS / 生成时间
   - doctor 结论：fail 1 项、warn 2 项（逐项列 name + detail）
   - 关键配置（已脱敏）：acceptMode=auto、chats=2、allowed=3 …
## 错误日志
## 证据日志
```

原则：**自检有 fail 时，正文里必须出现这条 fail**——上游拿到 issue 就能知道「不是环境问题还是环境问题」，不用再追问一轮。

### 4.9 结论可核对

每条 `Finding` 带 `source` 与 `confidence`：

- 面板在结论下面显示「依据：日志 / 自检 / 配置 / 代码」的小标签；
- 模型必须填 `source`，没填按 `logs` 处理且置信度不得高于 `medium`；
- SYSTEM_PROMPT 里已有的「不要编造日志里没有的事实；信息不足时明确说『日志里看不到』」保留并强化成对 `confidence` 的约束。

### 4.10 面板改造

三段式展示（改动 UI 时按 `design-taste-frontend` 的 house style 走，并交 Before / After 截图）：

```text
┌ 智能问题排查助手 ────────────────────────┐
│ [问题输入框]                    [分析]    │
│ 常见问题：消息没反应 / 配置不生效 / …     │
├──────────────────────────────────────────┤
│ ① 环境自检   ● 1 项失败  ⚠ 2 项警告      │  ← 可展开看每项
│ ② 错误与告警  近 24h：3 个错误 / 12 个告警│  ← 可跳日志页
│ ③ 结论                                        │
│    一句话结论 / 可能原因（含依据标签）      │
│    下一步：[去改配置] [上报 H] 或 直接给答案 │
│    证据日志（折叠）                          │
└──────────────────────────────────────────┘
```

交互原则沿用现状：**先看结论，再决定动作**。快捷菜单里的「上报 GitHub issue」仍然只打开面板并跑分析，不自动建单（现状注释里的理由成立，保留）。

### 4.11 CLI 与飞书入口

- **CLI**：新增 `ra diagnose "<问题>"`（可选 `--json`、`--report` 落盘），复用同一条管线；这是把「诊断」从「只能点面板」变成「能贴进工单、能写进复盘」的关键。
- **飞书**：见 §8。Router 的飞书对话职责是研判与派工，把运维诊断塞进去会和「诊断类提问默认 accept 开单」的规则打架（见 `src/router/prompts/orchestrator.md`）。本期**不做**，另开工单评估。

### 4.12 日志事件

新增事件（同步 `docs/OPERATIONS.md` 的日志事件表）：

| 事件 | 级别 | 关键字段 | 含义 |
|-|-|-|-|
| `diagnosis:started` | info | `question`（preview）、`phase` | 收到一次诊断请求 |
| `diagnosis:health-failed` | warn | `fail`、`warn`（计数）、`items` | 自检有 fail / warn 项 |
| `diagnosis:health-skipped` | info | `items` | 运行期跳过的检查项（如端口、运行状态） |
| `diagnosis:scan-completed` | info | `errors`、`warns`、`lines` | 日志扫描完成 |
| `diagnosis:answered` | info | `status`、`category`、`source`、`degraded` | 给出结论 |
| `diagnosis:reported` | info | `target`、`id` | 上报成功 |
| `diagnosis:report-failed` | error | `target`、`detail` | 上报失败 |

`logs:assistant-*` 三个既有事件保留一段时间做兼容，再在一次发布里下掉。

---

## 5. 落地步骤

每一步都遵循仓库的红 → 绿流程：**先写会失败的测试，再写刚好让它通过的实现**。

### P0：健康探针抽离与复用（无行为变更）

| 步骤 | 内容 | 验收 |
|-|-|-|
| P0-1 | 新建 `src/router/diagnostics/health-probe.ts`，把 `runDoctor` 搬成 `createHealthProbe(deps)`；`src/cli/doctor.ts` 改成薄壳 | `ra doctor` 输出与改造前逐项一致（对同一份配置跑两次比对） |
| P0-2 | 加 `phase: 'preflight' \| 'runtime'`；runtime 阶段把「服务端口 / 运行状态」标为 `skip` | `HealthProbe` 契约测试：runtime 阶段这两项是 skip 且整体 status 不因它们变 fail |
| P0-3 | 暴露 `GET /api/diagnostics/health`（面板与 `ra diagnose` 共用），返回 `HealthReport` | API 契约测试：探针失败时返回 500 + `api:diagnostics-health-failed` |

P0 结束时，`ra doctor` 行为不变，但探针可以被服务端复用。

### P1：三段式诊断管线

| 步骤 | 内容 | 验收 |
|-|-|-|
| P1-1 | `scan.ts`：`scanLogs()` 产出 `LogScan`（错误 / 告警聚合 + 证据池），**不受面板过滤器影响** | 契约测试：面板过滤为 info 时，扫描仍返回 error 聚合计数 |
| P1-2 | `pipeline.ts`：编排 自检 → 扫描 → 结论 → 分流，产出 `DiagnosisReport` | 契约测试：自检 fail 时报告里 `health.status='fail'` 且结论引用了该检查项 |
| P1-3 | `classify.ts`：三分类分流（config / defect / analysis），保留「两类同时命中两个入口都给」 | 契约测试：config + defect 同时命中 → `next` 含 fix-config 与 report 两种动作 |
| P1-4 | SYSTEM_PROMPT 升级：要求输出 `category`（三值）、`source`、`confidence`；明确 analysis 的判据 | 解析层测试：非法 JSON / 缺字段时降级到规则且 `degraded` 有值 |
| P1-5 | 面板三段式展示 + `Finding` 依据标签 | UI 测试 + Before / After 截图（同场景 / 同视口 / 同主题） |

### P2：上报与入口

| 步骤 | 内容 | 验收 |
|-|-|-|
| P2-1 | `reporter.ts`：`DiagnosisReporter` 端口 + `GitHubReporter`（行为不变） | 端口契约测试：目标不可用时 `available=false` 且带原因 |
| P2-2 | `render.ts`：`buildDiagnosisBody` 增加「环境与自检」段 | 快照测试：自检有 fail 时正文含该检查项名 |
| P2-3 | 新增 H 通道实现（具体系统待定，见 §8） | 通道契约测试 |
| P2-4 | `ra diagnose "<问题>"` CLI | CLI 契约测试：输出与面板同源 |
| P2-5 | 补齐 §4.12 的日志事件并同步 `docs/OPERATIONS.md` | 每个新增 warn / error 事件至少一条测试断言事件名与关键字段 |

### 不在本期范围

- 飞书对话入口（§8）
- 自动修复 / 自动改配置
- 诊断结果的持久化与趋势统计（工单里已有事件日志，暂不另起）

---

## 6. 测试策略

**只测公开契约**，断言结果值而不是「没抛异常」。

| seam | 契约 | 代表用例（`subject_scenario_outcome`） |
|-|-|-|
| `HealthProbe.run()` | 返回 `HealthReport`，status 取最差项 | `runtime_phase_skips_port_and_pid_checks` |
| `scanLogs()` | 错误 / 告警聚合与证据池 | `scan_reports_error_groups_regardless_of_panel_filter` |
| `classify()` | 三分类与动作集合 | `analysis_question_yields_answer_without_action_buttons` |
| `pipeline.diagnose()` | 端到端产出 `DiagnosisReport` | `health_failure_becomes_primary_finding` |
| `buildDiagnosisBody()` | 正文分段与环境段 | `issue_body_contains_failed_health_check` |
| `DiagnosisReporter.create()` | 上报结果与失败原因 | `unavailable_target_reports_reason_without_creating` |

确定性约束：探针依赖的 `orca` / `lark` / `gh` 都是注入的 `CommandRunner`，测试里用假 runner，不发真实请求；时间用注入时钟，`generatedAt` 写死断言；不 sleep。

---

## 7. 风险与权衡

| 风险 | 影响 | 应对 |
|-|-|-|
| 服务进程内跑 doctor 要调外部命令（`orca status`、`lark-cli` 群成员列表） | 慢、有配额、偶发失败 | 只在用户发起诊断时跑；探针内超时；失败降级为「自检不可用」而不是「配置正常」；不进面板轮询 |
| doctor 的「端口空闲 / 运行状态」在服务内必然 fail | 结论被带偏 | 用 `phase` 区分，runtime 阶段 skip；`skip` 不参与整体 status 计算 |
| 新增 `analysis` 类后「不给按钮」的路径变多 | 用户找不到动作 | analysis 仅在「无 error / warn 命中 + 问题属解释类」时成立；无法定性时走 `needs-info` 明确说明缺什么 |
| 事件名知识库（`SYMPTOMS`）与 `docs/OPERATIONS.md` 事件表会漂移 | 规则排查漏症状 | 以事件表为唯一来源，加一条一致性测试：知识库里引用的事件名必须在事件表中存在 |
| 上报目标抽象后可能过度设计 | 增加维护面 | 端口只留 `list` / `create` 两个方法；先只实现 GitHub，H 通道等需求确定后再做 |
| 结论带模型自由文本，误判分类 | 给错方向 | 保留「两类都命中给两个入口」规则；分类不确定时不硬塞按钮（沿用现有 `nextStepsFromCauses` 的行为） |
| 放宽工具边界以便让模型查更多东西 | 安全风险 | 现有只读 / 路径封闭 / 限量约束不动；本轮改造不新增任何可执行工具 |

---

## 8. 未决问题

1. **「上报 H」具体指哪个系统**？需要确认目标系统、鉴权方式（CLI / HTTP / MCP）、正文格式要求与字段规范。设计已把上报做成 `DiagnosisReporter` 端口，确认后只新增一个实现。
2. **服务进程内是否允许调用 `lark-cli` 的读接口**（群成员列表等）？涉及飞书应用权限与稳定性；若不允许，runtime 阶段的自检只保留不需要外部命令的项（配置、模型、运行时、进程状态），飞书相关项标 `skip` 并提示「需在 CLI 执行 `ra doctor`」。
3. **面板形态**：在现有「日志」页上扩展三段式，还是独立开一个「诊断」页？倾向扩展日志页（自检与日志天然同源），但要按 `design-taste-frontend` 出 Before / After 后再定。
4. **诊断结果是否需要留存**（便于对比「昨天好今天不好」）？当前只留日志事件，未持久化诊断报告。
5. **`ra doctor` 的检查项文案要不要同步改**？改造后 `HealthCheck` 多出 `group` / `section` 字段，面板按组折叠；CLI 输出保持一行一项、不受分组影响。

---

## 附录 A：改造涉及的文件清单

| 文件 | 改动 | 阶段 |
|-|-|-|
| `src/router/diagnostics/health-probe.ts` | 新增 | P0 |
| `src/router/diagnostics/scan.ts` | 新增 | P1 |
| `src/router/diagnostics/findings.ts` | 新增 | P1 |
| `src/router/diagnostics/classify.ts` | 新增 | P1 |
| `src/router/diagnostics/pipeline.ts` | 新增 | P1 |
| `src/router/diagnostics/reporter.ts` | 新增 | P2 |
| `src/router/diagnostics/render.ts` | 新增 | P2 |
| `src/cli/doctor.ts` | 改为薄壳 | P0 |
| `src/cli/index.ts` | 装配探针 / 新增 `ra diagnose` | P0 / P2 |
| `src/router/log-assistant.ts` | 收敛为管线调用 + 兼容层 | P1 |
| `src/router/diagnosis-tools.ts` | 不改（安全边界保持） | — |
| `src/router/log-tail.ts` | 扫描层复用 `readLogTail` | P1 |
| `src/router/issue-report.ts` | 迁到 `reporter.ts` 的 GitHub 实现 | P2 |
| `src/router/api.ts` | 新增 `/api/diagnostics/health`、`/api/diagnostics` | P0 / P1 |
| `src/web/client/log-assistant.tsx` | 三段式展示与新动作 | P1 |
| `docs/OPERATIONS.md` | 新增日志事件表条目 | P2 |
| `tests/router/diagnosis-*.test.ts` | 新增契约测试 | P0–P2 |

## 附录 B：现有与新增日志事件对照

| 现有 | 新增（P2） |
|-|-|
| `logs:assistant-answered` | `diagnosis:started` |
| `logs:assistant-model-failed` | `diagnosis:health-failed` |
| `api:log-assistant-failed` | `diagnosis:health-skipped` |
| `issue:created` | `diagnosis:scan-completed` |
| `issue:create-failed` | `diagnosis:answered` |
| `api:issue` | `diagnosis:reported` |
| `api:issue-create-failed` | `diagnosis:report-failed` |
