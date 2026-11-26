# 事件订阅与自动化任务重构方案（v2 · 去掉决策规则，来源只供订阅）

> 工单 tk-92 ｜ 基线分支 `beta` @ `8a6cef4` ｜ 本轮只出设计，不含实现代码
> 关联现状文档：[CONFIGURATION.md](../CONFIGURATION.md)（事件总线配置）、[AUTOMATION.md](../AUTOMATION.md)（自动化）、[OPERATIONS.md](../OPERATIONS.md)（日志事件表）
> 前序设计：[event-decision-rules-design.md](./event-decision-rules-design.md)（决策规则，本方案推翻其「规则是判定依据」这一核心结论）

---

## 0. 结论先行

### 0.1 一句话方案

**删掉「决策规则」这一层，把「事件源」和「自动化任务」拆成两端：**

- **事件源插件**只回答「**有什么事件可订阅**」，不再自带订阅任务、不再绑定判定逻辑；
- **自动化任务**是唯一的订阅单位，由用户用**自然语言**创建，任务里同时包含「订阅什么事件 + 怎么判断 + 触发后执行什么」；
- 新建任务从弹窗改成 **Chat 会话**：会话里跑一个「创建自动化任务」的 skill 流程，边聊边把任务建出来；**点任务卡片能恢复原会话继续改**。

### 0.2 为什么这样切

用户原话里最关键的一句是：「**事件来源订阅是给决策规则去使用的，需要手动添加规则列表，操作成本非常的高**」。

这说明当前的真正痛点不是「规则写起来麻烦」，而是**规则这个中间层本身就不该存在**：

| 现状 | 用户要做什么 | 为什么贵 |
|-|-|-|
| 订阅 GitHub 仓库 | 面板加一条 `events.sources.github-N`，勾事件类型 | 一次订阅 = 一个配置条目 = 一次决策规则的 `eventType` |
| 写决策规则 | 面板再开一个弹窗，填 `eventType`、四问、`workflowPrompt`、阈值 | `eventType` 要跟订阅里的类型**逐字对齐**，错一个字符就静默不生效 |
| 两者都做完 | 才知道这条事件会不会被处理 | 反馈环太长，且**没有一条链路能把「我要什么」说完整** |

现在这套「订阅 → 规则」的映射，是**配置结构强加给用户的**。用户真正想说的是一句话：「帮我订阅下飞书消息，和 Teamwork 相关的优化的事情只要我答应了就立即去做」。这句话里已经包含了事件源、过滤条件、判定语义、执行动作 —— 但当前系统没有任何入口能接住它。

所以方案不是「把决策规则的表单做友好」，而是**把规则这一层从数据模型里删掉，让自然语言直接落到「自动化任务」这一个对象上**。

### 0.3 三个被方案明确回答的原始问题

| 原始问题 | 本方案的回答 |
|-|-|
| 「飞书消息」这种来源怎么变成任务？ | 来源插件只声明**可订阅的事件类型目录**（`feishu.message` 等）；用户在 Chat 里说「订阅飞书消息」，会话流程把它解析成一条自动化任务，任务里写明「事件源 = feishu / 事件类型 = feishu.message / 关键词 = Teamwork, 承诺」 |
| 「Github 的请阅、Feishu 的订阅来源 都只是提供可以订阅的事件源」 | 重构 `packages/event` 的端口：从「EventSource（会 poll 出事件）」拆成「**EventCatalog（声明可订阅什么）**」+「**EventWatcher（负责按订阅拉取）**」；插件只实现 Catalog |
| 「每个自动化任务点击卡片时都会恢复之前的会话内容」 | 任务与**会话**一一绑定，任务里存 `conversationId`；点卡片 → 恢复该会话的 Pi session → 继续改任务 |

### 0.4 本轮不做什么（授权范围）

- 不改任何业务代码（`packages/*/src`、`src/**` 一行不动）；
- 不删除或迁移现有 `events.rules` 数据 —— **只出迁移方案，不执行**；
- 不改数据库 schema —— 只出 schema 方案；
- 不改运行时配置与发布流程；
- 文档里**未确认的取舍列备选方案，不替用户拍板**（集中在 §7「待确认取舍清单」）。

---

## 1. 现状调研（代码位置）

### 1.1 当前完整链路

```text
面板「配置 → 事件总线 → 事件来源」
  └─ events.sources.<id> = { kind: github, repo, events[] }      ← 订阅：手动加仓库
       └─ 面板「决策规则」
            └─ events.rules[] = { eventType, questions×4, workflowPrompt, thresholds }
                 ↑ 两处 eventType 必须逐字对齐，不对齐就静默不生效

EventManager.reloadSources()                        src/events/manager.ts:121
  └─ 按 events.sources 装配 EventSource 实例
       ├─ 内置 GithubEventSource                    src/events/sources/github.ts:45
       └─ 插件来源 loadEventPlugins()               packages/event/src/plugins/loader.ts:60

定时轮询 pollSource()                              src/events/manager.ts:273
  └─ pipeline.ingest(sourceId, config, envelope)   src/events/pipeline.ts:86
       └─ rule = ruleForEvent(config.events.rules, eventType)   ← 没规则 → status='undecided'
            └─ insertEvent()  落库 events 表       src/store/db.ts:459

EventManager.runTick() → pipeline.tick()           src/events/pipeline.ts:141
  └─ claimPendingEvents() → process(event)          src/events/pipeline.ts:214
       └─ decision.decide({ event, source, rule, projects, decision })
            └─ EventDecisionService.decide()        src/events/decision.ts:62
                 ├─ ruleDecisionPort（规则端口）    src/events/decision.ts:253
                 └─ createConfigurableDecisionPort（jev / llm）  src/events/wiring.ts:45
       └─ gateOf()（时间窗 + 配额 + 在办工单上限）   src/events/pipeline.ts:462
       └─ dispatch() → 合成 Trigger → engine.decide() → Ticket   src/events/pipeline.ts:344
            └─ EventKickoff.start()：私聊 owner + 建话题        src/events/kickoff.ts:59
            └─ Worker 执行 → 报告回写来源 publish()             src/events/manager.ts:238
```

### 1.2 关键事实表

| 事实 | 代码位置 | 对本方案的影响 |
|-|-|-|
| 规则存在与否**决定事件是否被判定**（`undecided` vs `pending`） | `src/events/pipeline.ts:106` | 删规则 = 事件永远不判定。要换成「订阅 = 判定依据」 |
| `eventType` 精确匹配，一个类型只能一条规则 | `src/events/rules.ts:206` `src/web/client/event-rules-model.ts:48` | 规则不能删干净，得换成「订阅任务 → 事件」的匹配 |
| 事件**不绑定项目**，项目由判定模型产出 | `packages/core/src/event.ts:67` | 新模型里「归属项目」要么在任务里写死，要么继续靠判定 |
| 判定失败可重试，连续 5 次转人工 | `src/events/pipeline.ts:25` | 重试语义可复用 |
| `rule_id` / `rule_version` 落库在 `events` 表 | `src/store/db.ts:459` | 删规则后这两列要么废弃、要么改指订阅任务 id |
| 规则变更会重新激活 `undecided` 事件 | `src/store/db.ts:1013` `src/cli/index.ts:2030` | 订阅任务变更时的激活逻辑要重写 |
| 判定只跑一次，结论记在事件上 | `src/events/pipeline.ts:174` | 可复用为「订阅任务命中一次」 |
| GitHub 来源**自带订阅语义**（一个实例 = 一个仓库 + 一组事件类型） | `src/events/sources/github.ts:45` | 这正是要拆掉的部分：来源不该持有「订阅了哪几个事件」 |
| 来源插件协议已有 `options` 字段声明机制 | `packages/event/src/plugins/types.ts:18` | 「可订阅事件目录」可以复用这套声明形状 |
| 事件来源插件 SDK 已经是独立包 `@router-agent/event` | `packages/event/` | 端口改造有独立包边界，不用动 `src/` 的包依赖方向 |
| 面板已有「GitHub 设置」弹窗（仓库列表 + 事件多选） | `src/web/client/github-subscriptions.tsx:93` | 面板现状：来源卡片管「订阅了什么」 |
| 面板已有「添加决策规则」弹窗（四问表单） | `src/web/client/event-rules.tsx:30` | 面板现状：规则卡片管「怎么判」 |
| 收件箱页有「规则命中」聚合区 | `src/web/client/events-panel.tsx:198` | 删规则后要换成「订阅命中」聚合 |
| 自动化任务已在配置里（`automation.tasks`），调度器已就绪 | `src/config.ts:355` `src/automation/scheduler.ts:59` | **定时任务这一半不需要重写**，只需要接上「事件触发」 |
| 自动化任务已有 `prompt` / `script` / `schedule` / `project` / `runtimeId` | `packages/core/src/automation.ts:28` | 任务定义几乎够用，缺的是「订阅什么」 |
| 对话式创建自动化已有雏形：`captureDraft()` 落草稿 → 面板确认 | `src/automation/service.ts:602` | **这是 Chat 会话化的起点**，不是从零做 |
| `looksLikeAutomationIntent()` 已做确定性预筛 | `src/automation/intent.ts:31` | 预筛逻辑可复用 |
| Pi 会话可落盘、按 `SessionKeyParts` 复用 | `src/router/session-registry.ts:99` | 「点卡片恢复会话」有现成底座 |
| 卡片按钮回调已有中立协议（`CardAction.value` 是任意 JSON） | `packages/channel/src/port.ts:73` | 卡片里带 `automationId` / `conversationId` 天然可行 |
| 飞书消息本身走 channel 链路，不走事件链路 | `src/events/sources/feishu.ts:1` | 飞书事件源一期仍是占位，与本方案不冲突 |

### 1.3 面板现状（一句话）

```text
配置 → 事件总线
  ├─ 事件来源（卡片）：GitHub 一张卡 + 自定义来源卡
  │    └─ 点「设置」→ 弹窗：仓库列表 + 每仓库事件类型多选     ← 订阅在这里做
  ├─ 决策规则（卡片）：每条规则一张卡
  │    └─ 点「编辑」→ 弹窗：eventType + 四问 + workflowPrompt + 阈值   ← 判定在这里做
  └─ 判定方式与兜底 / 成本与时间窗

自动化页
  ├─ Tab「自动化任务」：卡片列表 + 「新建自动化」弹窗（名称/类型/提示词/运行时/项目/时间）
  ├─ Tab「执行记录」：表格
  └─ 「待确认草稿」区：飞书自然语言整理出的草稿，卡片「编辑并保存」
```

---

## 2. 目标设计

### 2.1 概念模型

```text
┌──────────────── EventCatalog（事件目录 · 插件提供）────────────────┐
│  只声明「有什么事件可订阅」                                          │
│  sourceId: github                                                  │
│  types: [ github.issues.opened, github.pull_request.merged, ... ]   │
│  params: 需要哪些连接参数（repo / token / ...）                     │
└───────────────────────────────────────────────────────────────────┘
                              ▲ 读目录
                              │
┌──────────────────── Subscription（订阅 · 自动化任务的一部分）─────┐
│  catalog: github                                                  │
│  types:   [ github.issues.opened ]                                │
│  params:  { repo: "blankPen/router-agent" }                       │
│  filter:  { keywords: ["Teamwork"], semantic: "…有价值的…" }       │
└───────────────────────────────────────────────────────────────────┘
                              ▲ 产生
                              │
┌────────────────── AutomationTask（自动化任务 · 唯一订阅单位）───────┐
│  trigger:  { kind: 'event', subscription: {...} }                   │
│          | { kind: 'schedule', schedule: {...} }                    │
│  action:   { prompt | script, skill, project, runtimeId }           │
│  conversationId: 绑定创建它的 Chat 会话                             │
└───────────────────────────────────────────────────────────────────┘
                              ▲ 落库
                              │
                    Chat 会话（自然语言创建 + 卡片恢复）
```

**三个对象的边界：**

| 对象 | 回答的问题 | 谁创建 | 存在哪 |
|-|-|-|-|
| **EventCatalog** | 「这个来源有什么事件可订阅？」 | 插件作者 | 代码（`packages/event`） |
| **Subscription** | 「我要订阅哪些事件、怎么过滤？」 | 用户（自然语言） | 自动化任务的一部分 |
| **AutomationTask** | 「事件来了之后做什么？」 | 用户（自然语言） | `config.yaml` 的 `automation.tasks` |

### 2.2 决策规则 → 订阅任务：概念映射

删掉规则不是「删一个模块」，而是**把规则承载的信息拆散到新归属处**：

| 规则里原来有什么 | 去哪了 |
|-|-|
| `eventType`（订阅哪个类型） | → 订阅的 `types[]`（由来源目录校验合法性） |
| `intent`（用户原话） | → 任务的 `description` + 会话历史（**保留原文，不丢**） |
| `questions.is_valid.instructions` | → 订阅的 `filter.semantic`（自然语言过滤条件） |
| `questions.autorun.criteria`（auto / review） | → 订阅的 `mode`：`auto`（直接执行）/ `review`（进事件列表等人批）/ `notify`（只记录+通知） |
| `questions.priority.criteria` | → 任务的 `priority`（P0~P4，判定时由模型给或写死） |
| `questions.project.criteria` | → 任务的 `project`（**从判定产物改为任务属性**，见 §7 待确认 A1） |
| `questions.skill.criteria` | → 任务的 `skill`（沿用 `EVENT_SKILLS` 闭集） |
| `workflowPrompt`（给 Worker 的执行流程） | → 任务的 `prompt`（本来就是自动化任务的字段） |
| `guardrails.riskLabels` | → 提升为**宿主级全局护栏**（不再每条规则配一遍），见 §3.5 |
| `thresholds.isValid` / `projectPick` | → 订阅的 `filter.threshold`（可省略，省略即由模型自评） |
| `version` | → 任务版本（沿用 `automation.tasks` 的 `updatedAt`，不另起版本号） |

**关键判断：规则的「四问」在自动化任务模型里天然被覆盖。**
规则是一次性的「判定脚本」，自动化任务是「事件源 + 判定 + 执行」的合体 —— 后者本来就是前者的超集。删规则不丢能力，只是把能力换了载体。

### 2.3 事件源插件重构：从 `EventSource` 到 `EventCatalog`

#### 2.3.1 现状问题

`packages/event/src/port.ts` 现在的 `EventSource` 端口同时背了三件事：

```ts
export interface EventSource {
  readonly id: string
  readonly kind: string
  poll?(): Promise<EventEnvelope[]> | EventEnvelope[]   // ① 自己去哪找事件
  stop?(): void
  publish?(target, text): Promise<void>                   // ② 结论怎么回去
}
```

问题：

1. **①把「订阅了什么」写死在来源实例里**。`GithubEventSource` 的构造参数就是 `{ repo, events[] }` —— 这就是「一个仓库一条订阅」的来源。来源一旦知道用户订阅了哪些事件，它就**不再是「只提供可订阅事件源」**，而是自带了订阅任务。
2. **②回写能力绑在来源上**，但回写其实是「这条任务跑完之后结论往哪发」——属于任务侧。
3. 来源实例是**长生命周期、有状态的**（GitHub 来源内含增量游标），但「有哪些事件类型」是**静态声明**。两者混在一个接口里，导致插件作者必须实现轮询才能表达目录。

#### 2.3.2 拆分方案

```ts
// packages/event/src/port.ts（重构后）

/** 一个可订阅的事件类型。 */
export interface EventTypeDescriptor {
  /** 带来源前缀的完整类型 id，如 `github.issues.opened`。 */
  id: string
  /** 人话标签，面板与模型提示词里用。 */
  label: string
  /** 分组，如「Issue」「Pull Request」。 */
  group: string
}

/** 连接参数声明：来源插件自己说「我要用户提供什么」。 */
export interface EventParamDescriptor {
  key: string
  label: string
  kind: 'text' | 'password' | 'select' | 'number' | 'boolean'
  hint?: string
  options?: string[]
}

/**
 * 事件目录：插件唯一必须实现的接口。
 *
 * 只回答「有什么事件可订阅」，不拉取、不判定、不派工。
 */
export interface EventCatalog {
  readonly id: string
  /** 来源种类：github / feishu / 插件 id。 */
  readonly kind: string
  /** 来源名字（面板展示）。 */
  readonly name: string
  /** 这个来源能订阅哪些事件类型。 */
  types(): EventTypeDescriptor[]
  /** 这个来源需要哪些连接参数；没声明就是零参数。 */
  params(): EventParamDescriptor[]
}
```

#### 2.3.3 拉取职责上移到宿主

「怎么把订阅变成事件」这件事，**宿主做，不让插件做**。理由：GitHub 已经是最特殊的实现（要 `gh` CLI、要游标、要翻页），把它做成通用能力会让每个插件都重写一遍轮询、游标、去重、窗口裁剪。

宿主侧新增 `EventWatcher`（放 `src/events/`，不进 `packages/event`）：

```ts
// src/events/watcher.ts（新）
export interface EventWatcher {
  readonly catalogId: string
  /** 拉一批新事件；没有新事件返回空数组。 */
  poll(subscription: Subscription): Promise<EventEnvelope[]>
  /** 结论回写到来源；没有回写能力的事件只落库。 */
  publish?(subscription: Subscription, target: { externalId: string; url?: string }, text: string): Promise<void>
}
```

**内置 watcher 注册表：**

| watcher | 覆盖来源 | 说明 |
|-|-|-|
| `github` | `kind: github` | 复用现有 `GithubEventSource` 的全部逻辑（游标 / 翻页 / 3 天窗口 / 基线），只是**订阅从构造参数改为方法参数** |
| `feishu` | `kind: feishu` | 一期仍占位（飞书群消息走 channel 链路） |
| `plugin` | 插件自定义 | 插件若需要自己的拉取逻辑，实现 `EventPlugin.fetch?()` 扩展点（可选） |

**插件协议的新形状：**

```ts
// packages/event/src/plugins/types.ts（重构后）
export interface EventPlugin {
  kind: 'event'
  meta?: EventPluginMeta
  /** 插件声明的可配置项（面板渲染用）；保留原有语义。 */
  options?: { fields: EventOptionField[] }
  /** 插件提供的事件目录。 */
  catalog?(ctx: EventPluginContext): EventCatalog | null | Promise<EventCatalog | null>
  /**
   * 插件自带的拉取实现（可选）。
   *
   * 不实现就用宿主的通用 watcher（轮询 + 去重 + 窗口裁剪）。
   */
  fetch?(ctx: EventPluginContext): EventFetcher | null | Promise<EventFetcher | null>
}
```

#### 2.3.4 兼容策略

现存的第三方事件来源插件（npm 上的 `@router-agent/event-*`）实现的是旧 `EventSource`。**不破坏它们**：

```ts
// 适配层：packages/event/src/legacy.ts（新）
/**
 * 旧插件适配：把 EventSource 包成「目录 + fetcher」。
 *
 * 旧插件的 eventType 目录从它 poll 出来的第一条事件的类型推断 ——
 * 不准，但至少能跑；真正准的目录要靠插件升级到 catalog()。
 */
export function adaptLegacySource(source: EventSource): { catalog: EventCatalog; fetcher: EventFetcher }
```

> ⚠️ **待确认 B1**：旧插件的「可订阅事件目录」目前无从得知（`EventSource` 接口里没有这个信息）。适配层只能：
> - (a) 从 `poll()` 首条事件的 `eventType` 推断 —— 不准，且要求先跑一次；
> - (b) 要求插件升级到 `catalog()`，否则不加载 —— 破坏性但干净；
> - (c) 允许插件在 `options` 里手写 `eventTypes` 字段声明 —— 需要改插件作者的心智模型。
>
> 本方案默认选 (a) + 打印弃用告警，理由是**不破坏现有安装**。备选见 §7。

### 2.4 自然语言 → 自动化任务

#### 2.4.1 用户原话的三个例子，逐条映射

**例 1**：「帮我订阅下飞书消息，和 Teamwork 相关的优化的事情只要我答应了就立即去做」

```yaml
name: Teamwork 优化承诺跟踪
description: 订阅飞书消息，与 Teamwork 相关的优化事项，我承诺了就立即去做
type: ai
skill: clarify-intake
project: <会话所在群绑定项目>
trigger:
  kind: event
  source: feishu
  types: [feishu.message]
  params: { chatIds: [...] }        # 来源声明的参数
  filter:
    keywords: [Teamwork, 承诺, 答应]
    semantic: 与 Teamwork 相关的优化事项，且发送人作出了承诺
  mode: auto                       # 命中且判定「是承诺」→ 立即执行
execution:
  prompt: |
    收到与 Teamwork 相关的优化承诺时：
    1. 复述承诺内容与上下文
    2. 定位到对应项目并给出可执行的优化方案
    3. 承诺已生效的直接动手改，不确定的先出方案等确认
```

**例 2**：「帮我监听下 Github 的 issue，有价值的就立即执行下，待审核的就发我看下」

```yaml
trigger:
  kind: event
  source: github
  types: [github.issues.opened, github.issues.commented]
  params: { repo: blankPen/router-agent }
  filter:
    semantic: 有价值的 issue（值得投入处理）
  mode: auto                       # 有价值 → 立即执行
  reviewWhen: pending-review       # 判定为「待审核」→ 进事件列表并发给用户
```

**例 3**：「每天看下 Teamwork 的大盘数据，有异常的人员都主动帮我提醒下」

```yaml
trigger:
  kind: schedule
  schedule: { kind: daily, at: '09:00' }
execution:
  prompt: |
    查询 Teamwork 大盘数据，找出指标异常的人员，逐个提醒。
  notifyOnly: true                 # 只记录 + 通知，不改代码
```

**三种例子的共同点**：用户**从没说过「eventType」「优先级」「阈值」**这些词。所有这些都得由会话流程从自然语言里推出来，**推不出来就问**。

#### 2.4.2 会话流程（Skill）设计

「创建自动化任务」的会话流程分五步，每步都有明确的产出与终止条件：

```text
① 识别意图
   用户第一句话 → 判断是不是「要建自动化」
   复用现有 looksLikeAutomationIntent() 做确定性预筛（不烧模型）
   ↓
② 抽参数（一次模型调用）
   输入：用户原话 + 可订阅事件目录（所有 catalog 的 types 汇总）
   输出：JSON { source, types[], params, filter{keywords,semantic}, mode, schedule, project, skill, prompt }
   ↓
③ 补齐缺口（回问）
   缺口判定（缺什么就不建）：
   - 没定 source          → 问「要订阅哪个来源？」
   - source 定了没定 types → 问「要订阅这个来源的哪些事件？」
   - params 缺必填项      → 问（如「哪个仓库？」）
   - mode 拿不准          → 问「命中后直接做，还是先给你看一眼？」
   - 既没有 schedule 也没有 source → 问「什么时候触发？」
   - project 拿不准       → 问「在哪个项目里做？」
   ↓
④ 预览确认
   卡片列出：订阅什么 / 怎么过滤 / 触发后做什么 / 在哪跑 / 多久跑
   按钮：【确认创建】 【改一改】 【取消】
   ↓
⑤ 落库
   写 automation.tasks（enabled: true）+ 建 conversation 关联
```

**②的模型输出契约（严格 JSON，闭集校验）：**

```json
{
  "source": "github",
  "types": ["github.issues.opened"],
  "params": { "repo": "blankPen/router-agent" },
  "filter": {
    "keywords": ["Teamwork", "承诺"],
    "semantic": "与 Teamwork 相关的优化事项，且发送人作出了承诺"
  },
  "mode": "auto",
  "schedule": null,
  "project": "router-agent",
  "skill": "clarify-intake",
  "prompt": "……要执行的自然语言……"
}
```

**闭集约束（与现有 `EVENT_SKILLS` / 项目清单一致）：**

- `source` 必须是已加载 catalog 的 id；
- `types[]` 每项必须在该 catalog 的 `types()` 里；
- `params` 的 key 必须在该 catalog 的 `params()` 里；
- `project` 必须在项目清单里；
- `skill` 必须在 `EVENT_SKILLS` 里；
- **选不中就回问，绝不编造**（沿用现有 `resolveProject()` 的行为）。

#### 2.4.3 解析器落点

```ts
// src/automation/parse.ts（新）
export interface ParseResult {
  kind: 'task'
  task: AutomationTaskDraft
} | {
  kind: 'clarify'
  question: string
  missing: string[]      // 缺哪些项，用于回问与日志
} | {
  kind: 'none'
} | {
  kind: 'unavailable'    // 模型没配好
}

export async function parseAutomationIntent(
  text: string,
  deps: {
    client: ChatClient | null
    catalogs: EventCatalog[]
    projects: ProjectConfig[]
    skills: readonly EventSkill[]
    logger: Logger
  },
): Promise<ParseResult>
```

与现有 `AutomationService.parseDraft()`（`src/automation/service.ts:651`）的关系：

- **复用**：模型调用、`extractJsonObject`、`resolveProject` 的闭集解析、`validateSchedule`；
- **替换**：输出结构从「只有 schedule」扩展到「event 订阅 + schedule」；
- **新增**：闭集校验（source / types / params / skill）。

### 2.5 事件记录 → 事件列表 → Agent 执行

新链路（与现状的主要差别在 ① 和 ③）：

```text
① EventManager.reloadSubscriptions()
   按 automation.tasks 里 trigger.kind=event 的任务装配订阅
   每个订阅 → watcher.poll(subscription)
       ↓
② pipeline.ingest(subscriptionId, subscription, envelope)
   幂等键从 (sourceId, externalId) 扩展为 (subscriptionId, externalId)
   ★ 事件落库时直接带上 subscriptionId（哪条任务要它）
   status: 'pending'（有订阅命中）而不是 'undecided'
       ↓
③ pipeline.process(event)
   找到 subscription → 按 subscription.filter 判断
   ├─ filter 关键词：确定性匹配（不烧模型）
   ├─ filter.semantic：模型判定（一次）
   ├─ 判定结果三选一（来自 subscription.mode）：
   │    ├─ 无效 / 不相关        → status='invalid'
   │    ├─ mode=review 或 判定「待审核」→ status='review'（进事件列表 + 通知用户）
   │    └─ mode=auto            → status='pending'，直接进 ④
   └─ 归属项目 / skill：优先取任务属性，缺省由模型给（闭集）
       ↓
④ dispatch()（复用现有逻辑）
   合成 Trigger → engine.decide() → Ticket
   ★ scope 里拼入任务的 prompt（替代原 rule.workflowPrompt）
   ★ Trigger.source = `automation:<taskId>`（替代 `event:<sourceId>`）
       ↓
⑤ Worker 执行 → 报告回写
   回写目标：subscription 指定的 watcher.publish()
   ★ 回写内容按任务配置（可只记录不评论）
```

#### 2.5.1 「进事件列表等 Agent 执行」的口径

用户原话里有三种落点，方案里必须区分清楚：

| 用户说法 | 落点 | 状态 |
|-|-|-|
| 「立即去做」 | 直接开单 → Worker | `pending` → `ticketId` |
| 「待审核的就发我看下」 | 进事件列表 + 通知 | `review` |
| 「有异常的主动帮我提醒下」 | 只记录 + 通知，**不开单** | `done`（不产生工单） |

第三种（只提醒）在现状里**没有对应状态** —— 现状的 `done` 语义是「工单做完了，结论已回写」。需要新增一个执行语义（见 §3.4 的 `execution: 'notified'`）。

#### 2.5.2 定时任务这一半

**完全复用现状**：

- `automation.tasks[].schedule` 已有；
- `AutomationScheduler.tickAutomations()` 已有；
- `AutomationExecutor` / `BuiltinAutomationTools` 已有；
- `automation_runs` 执行记录已有。

定时任务的 `trigger` 就是 `{ kind: 'schedule', schedule: {...} }`，与事件订阅共用同一个任务对象。**这就是本方案「统一」的核心收益**：用户不用在两个心智模型之间切换。

### 2.6 新建自动化任务：Chat 会话模式

#### 2.6.1 三种入口，一个流程

| 入口 | 交互 | 落点 |
|-|-|-|
| 面板「新建自动化」按钮 | 开一个**嵌入式会话面板**（不是表单弹窗） | 同一条会话流程 |
| 飞书里发一句「帮我每天…」 | 现有 `looksLikeAutomationIntent` 预筛命中 → 进会话流程 | 同一条会话流程 |
| 卡片点击 | **恢复已有会话**，继续改 | 同一个 `conversationId` |

#### 2.6.2 会话与任务的绑定

```ts
// packages/core/src/automation.ts（新增）
export interface AutomationConversation {
  id: string
  /** 绑定的自动化任务 id；还没建出来时为空。 */
  taskId?: string
  /** 会话来源：web-panel / feishu:<chatId> */
  source: string
  /** 发起人。 */
  requester: string
  /** 飞书话题 id（可空）。 */
  threadId?: string
  status: 'active' | 'completed' | 'abandoned'
  createdAt: string
  updatedAt: string
}
```

**存储**：新增 `automation_conversations` 表（`state.db`）+ 复用 `chat_sessions` 表存 Pi session 文件路径。

```sql
CREATE TABLE IF NOT EXISTS automation_conversations (
  id            TEXT PRIMARY KEY,
  task_id       TEXT,
  source        TEXT NOT NULL DEFAULT '',
  requester     TEXT NOT NULL DEFAULT '',
  chat_id       TEXT NOT NULL DEFAULT '',
  thread_id     TEXT NOT NULL DEFAULT '',
  session_key   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_conversations_task ON automation_conversations (task_id);
```

**session_key 规则**（与现有 `SessionRegistry` 对齐）：

```text
面板会话：   automation:<conversationId>
飞书会话：   automation:<conversationId>        ← 仍然按 conversationId 隔离，不按群
```

> 为什么不用现有的 `channel:<ch>:<chat>:user:<actor>` 键？
> 因为自动化会话要**能被卡片恢复**，而卡片点击的发起人不一定和当初创建会话的人一样。绑到 `conversationId` 上，天然做到「谁点都能恢复到同一条会话」。

#### 2.6.3 恢复会话的技术路径

现有 `PiDecisionEngine` 的会话复用机制（`src/router/pi-decision-engine.ts:573`）**正好够用**：

```ts
// 伪代码
const convo = store.getAutomationConversation(conversationId)
const session = {
  key: `automation:${convo.id}`,
  chatId: convo.chatId || convo.id,
  actorId: convo.requester,
  threadId: convo.threadId || '',
}
await decisionEngine.assess({
  session,
  systemPrompt: automationSystemPrompt,     // 新的 skill 流程 prompt
  userPrompt: buildAutomationUserPrompt(...),
  ...
})
```

**恢复 = 用同一个 `sessionKey` 再开一轮 Pi 会话**。Pi 的 session 文件在 `sessionDir` 下，键一样就自动接着上次说（`SessionRegistry.acquire` → `pi.SessionManager.open`）。

**新增的工具**（给会话里的模型用，走现有 `PiToolDefinition` 机制）：

| 工具 | 作用 | 权限 |
|-|-|-|
| `automation_list_catalogs` | 列出所有可订阅的事件源与类型 | 只读 |
| `automation_search_types` | 在目录里按关键词找事件类型 | 只读 |
| `automation_create_task` | 落库自动化任务 | 写 |
| `automation_update_task` | 修改已有任务 | 写 |
| `automation_preview_task` | 生成预览卡片 | 只读 |

工具定义加在 `src/router/tool-spec.ts`（与现有 `router_*` 工具并列），但**只在自动化会话里放行**（`setActiveToolsByName` 已存在于 `ManagedSessionLike`，见 `src/router/session-registry.ts:55`）。

#### 2.6.4 卡片形态

**会话内的预览卡片**（确认用）：

```text
┌────────────────────────────────────────┐
│ 新建自动化任务                          │
├────────────────────────────────────────┤
│ 来源：GitHub                            │
│ 订阅：Issue 新建、Issue 评论            │
│ 参数：blankPen/router-agent             │
│ 过滤：keywords = 有价值、待审核          │
│       语义 = 值得投入处理的 issue        │
│ 命中后：立即执行 / 待审核先给我看        │
│ 执行：定位根因并修复，提交 PR            │
│ 项目：router-agent  运行时：orca        │
│ 触发：事件触发（无定时）                │
├────────────────────────────────────────┤
│ [ 确认创建 ]  [ 改一改 ]  [ 取消 ]      │
└────────────────────────────────────────┘
```

**任务列表卡片**（点「修改」进恢复流程）：

```text
┌────────────────────────────────────────┐
│ Teamwork 优化承诺跟踪          [自动执行]│
│ GitHub · Issue 新建 / 评论              │
│ filter: Teamwork、承诺                   │
├────────────────────────────────────────┤
│ [ 修改 ]  [ 暂停 ]  [ 手动跑一次 ]      │
└────────────────────────────────────────┘
```

**卡片按钮的 `value` 载荷**：

```json
{ "automationId": "auto_xxx", "conversationId": "acv_xxx", "action": "edit" }
```

现有 `CardAction.value` 是任意 JSON（`packages/channel/src/port.ts:73`），`normalizeCardAction` 直接透传（`packages/channel-feishu/src/sources/feishu-reply.ts:197`）—— **不用改通道协议**。

#### 2.6.5 点击卡片 → 恢复会话的时序

```text
用户点卡片「修改」
  ↓  feishu card.action.trigger → normalizeCardAction → CardAction
  ↓  service.handleCardAction()（src/service.ts:2211）
  ↓  识别 value.automationId / value.conversationId
  ↓  取 AutomationConversation → 拼 SessionKeyParts
  ↓  向会话投递一条 Input（等价于用户发了一句「修改这个自动化」）
  ↓  AgentLoop 拉起该 session → skill 流程续跑
  ↓  模型带着「上一轮建了什么」的上下文继续
  ↓  用户说「改成只看 PR」 → 模型调 automation_update_task → 落库 → 回卡片确认
```

> ⚠️ **待确认 B2**：现有 `handleCardAction` 只处理 `questions` 表里的选择题（`src/service.ts:2211` 的 `getQuestion(questionId)`），且需要 `ticket_id` / `assignment_id`（`questions` 表 NOT NULL）。自动化卡片不是工单选择题，需要：
> - (a) **扩展 `questions` 表**支持「无工单的卡片」→ 要放宽 NOT NULL，改动大；
> - (b) **新增 `automation_cards` 表**记录卡片状态，`handleCardAction` 里分流处理 → 不动现有表，推荐；
> - (c) **不走卡片回调**，卡片按钮只发一条消息到群里（`ReplyAction` 里的 `url` 改成 deep link）→ 实现最简单，但失去「点了就进会话」的体验。
>
> 本方案默认选 (b)。

---

## 3. 数据模型与存储

### 3.1 决策规则模块的移除方案

#### 3.1.1 代码删除清单

| 文件 | 处理 | 理由 |
|-|-|-|
| `src/events/rules.ts` | **删** | 规则模板 / 校验 / 匹配全在这里 |
| `src/events/rule-compile.ts` | **删** | 只服务于「规则草稿编译」，被会话流程的解析器取代 |
| `src/web/client/event-rules.tsx` | **删** | 规则卡片与编辑弹窗 |
| `src/web/client/event-rules-model.ts` | **删** | 规则表单纯函数 |
| `src/events/decision.ts` | **改** | `ruleDecisionPort` → `guardrailDecisionPort`；`EventDecisionInput.rule` → `subscription` |
| `src/events/decision-model.ts` | **改** | 判定提示词从「规则的四问」改成「订阅的过滤条件」 |
| `src/events/pipeline.ts` | **改** | 匹配规则 → 匹配订阅 |
| `src/events/manager.ts` | **改** | `ruleEventTypes()` → 订阅集合 |
| `src/events/skills.ts` | **保留** | `EVENT_SKILLS` 闭集继续用（改成任务属性） |
| `src/config.ts` | **改** | 删 `events.rules` 字段、`validateEventRules`、`LIST_PATHS` 里的 `'events.rules'`、`parseEvents` 里的 rules 解析 |
| `src/router/api.ts` | **改** | 删 `GET /api/events/rules`、`POST /api/events/rules/compile`、`POST/DELETE /api/events/rules` |
| `src/cli/index.ts` | **改** | 删 `rules()` / `compileRule` / `ruleStats()` 端口与 `rulesChanged` 激活逻辑 |
| `src/web/client/app.tsx` | **改** | 删 `events-rules` 渲染分支 |
| `src/web/client/fields.ts` | **改** | 删 `events-rules` 配置块 |
| `src/web/client/events-panel.tsx` | **改** | 「规则命中」区 → 「订阅命中」区 |
| `src/web/client/events-config.tsx` | **改** | 「事件来源」块 → 「事件目录」块（只读展示可订阅什么） |
| `src/events/wiring.ts` | **改** | 装配改造 |

#### 3.1.2 配置（`config.yaml`）迁移

```yaml
# 迁移前
events:
  sources:
    github-1: { enabled: true, kind: github, repo: blankPen/router-agent, events: [...] }
  rules:
    - id: rule-github-action-error
      eventType: github.workflow_run.failure
      intent: "所有 GitHub Action 失败都处理并自动执行。"
      questions: { is_valid: {...}, autorun: {...}, priority: {...}, project: {...} }
      workflowPrompt: 分析失败步骤，修复并提交 PR。
      guardrails: { riskLabels: [...] }
      thresholds: { isValid: 0.5, projectPick: 0.4 }
      version: 1
```

```yaml
# 迁移后
automation:
  tasks:
    - id: auto_github_action_error
      name: GitHub Action 失败处理
      description: 所有 GitHub Action 失败都处理并自动执行。
      type: ai
      skill: ci-fix
      project: router-agent
      repo: /Users/me/router-agent
      branch: main
      trigger:
        kind: event
        source: github
        types: [github.workflow_run.failure]
        params: { repo: blankPen/router-agent }
        filter:
          semantic: 该事件属于 GitHub Action 失败且需要处理
        mode: auto
      execution:
        prompt: 分析失败步骤，修复并提交 PR。
      createdBy: migration:events.rules
      createdAt: <迁移时间>
      updatedAt: <迁移时间>
```

**迁移规则（逐条规则 → 逐条任务）：**

| 规则字段 | 迁移到任务 | 备注 |
|-|-|-|
| `id` | `id: auto_<rule.id 去 rule- 前缀>` | 保持可追溯 |
| `intent` | `description` | 原文保留 |
| `workflowPrompt` | `execution.prompt` | 原文保留 |
| `eventType` | `trigger.source` + `trigger.types` | **按前缀切分**：`github.workflow_run.failure` → source=`github`，types=[`github.workflow_run.failure`] |
| `questions.is_valid.instructions` | `trigger.filter.semantic` | 去掉「用户意图：」尾巴 |
| `questions.autorun.criteria.auto` | `trigger.mode = 'auto'` | criteria 有 `auto` 键 → auto |
| `questions.autorun.criteria.review` | `trigger.mode = 'review'` | 只有 `review` → review |
| `questions.priority.criteria` | `execution.priority` | 4 档 → P3→P0 映射；非 4 档取中位 |
| `questions.project.criteria` | `execution.project` | criteria 里除 `unknown` 外的键名当项目名；多个 → 留空并转人工 |
| `questions.skill.criteria` | `execution.skill` | 键名直接用（都在 `EVENT_SKILLS` 里） |
| `guardrails.riskLabels` | **丢弃**（提到全局，见 §3.5） | 每条规则的标签集合并成全局并集 |
| `thresholds.isValid` | `trigger.filter.threshold` | 省略即用全局默认 |
| `version` | 丢弃 | 任务的 `updatedAt` 足够 |

**无法自动迁移的情况（必须人工处理）：**

1. `eventType` 不带来源前缀或前缀未知 → 无法确定 source。→ **进「待人工处理」清单**，不自动建任务；
2. `questions.project.criteria` 里有多个项目名 → 无法确定归属。→ 建任务但 `execution.project` 留空，事件命中后转人工；
3. `guardrails.skills` 引用了未知 skill → 丢弃该值，退回全局 `EVENT_SKILLS`；
4. `eventType` 是 `*`（兜底规则）→ **无法表达**（新模型没有兜底规则概念）。→ 进人工清单。

> ⚠️ **待确认 A2**：`eventType: '*'` 的兜底规则怎么迁？备选：
> - (a) 丢弃（推荐：新模型靠「订阅带 types」精确匹配，本来就不需要兜底）；
> - (b) 展开成该来源的全部类型（可能几十条任务）；
> - (c) 迁移成一条 `types: ['*']` 的特殊订阅（需要给 watcher 加通配语义，复杂）。

#### 3.1.3 事件表（`events`）的列迁移

现状（`src/store/db.ts:459`）：

```sql
rule_id TEXT,        -- 命中的规则 id
rule_version INTEGER -- 命中的规则版本
```

新模型：

| 列 | 处理 | 说明 |
|-|-|-|
| `rule_id` | **改名** → `subscription_id` | 存订阅（= 任务 id），保留列名做一次性 rename，SQLite 用 `ALTER TABLE ... RENAME COLUMN` |
| `rule_version` | **保留但不再写** | 历史事件已有值，保留供审计；新事件留空 |
| 新增 `subscription_id` | 见上 | |
| 新增 `trigger_kind` | 可选 | `event` / `notify`，用于区分「只通知」的任务 |

**为什么改名而不只是复用**：不改名的话，日志里 `ruleId` 与「订阅」概念对不上，排查时永远要翻译一次。改名是 `ALTER TABLE events RENAME COLUMN rule_id TO subscription_id`，配合 `migrate()` 里已有的补列逻辑（`src/store/db.ts:563`）做一次性迁移。

**历史事件的处理**：已判定的事件**不回溯重判**（沿用现状「判定只跑一次」原则）。`subscription_id` 为空的历史事件在面板上显示为「历史事件（无订阅）」，仍可查看与关闭，但不再参与新的订阅命中统计。

#### 3.1.4 迁移的执行方式

> ⚠️ **授权范围内明确不删数据、不改 schema**。以下是**方案**，执行留给后续工单。

```bash
# 建议做成显式的 CLI 子命令，与现有 ra migrate sessions / threads 同构
ra migrate event-rules --dry-run    # 只报告：会生成哪些任务、哪些进人工清单
ra migrate event-rules --apply      # 写入
ra migrate event-rules --verify     # 校验条数与内容一致
```

**幂等**：靠 `createdBy: 'migration:events.rules'` 标记 + 任务 id 固定（`auto_<ruleId>`），重复执行不会重复建。

**回滚**：
- 配置层：迁移前把 `config.yaml` 备份成 `config.yaml.bak.<时间戳>`；回滚 = 换回备份文件；
- 事件表层：只改了列名，没删数据，`ALTER TABLE ... RENAME COLUMN` 反向 rename 即可；
- 规则数据：迁移后 `events.rules` **仍留在 config.yaml 里**（不删），确认新任务跑通后再手工删 —— 这样回滚只是把新任务删掉，规则原样还在。

### 3.2 自动化任务的数据模型扩展

```ts
// packages/core/src/automation.ts（新增）

/** 触发方式：事件订阅 / 定时计划。 */
export type AutomationTriggerKind = 'event' | 'schedule'

/** 事件订阅的触发器。 */
export interface EventTrigger {
  kind: 'event'
  /** 来源 catalog id。 */
  source: string
  /** 订阅的事件类型（带来源前缀）；必须是该 catalog 声明过的。 */
  types: string[]
  /** 来源声明的连接参数（repo / token / chatIds …）。 */
  params: Record<string, string>
  /** 过滤与判定条件。 */
  filter: EventFilter
  /** 命中后的处置方式。 */
  mode: 'auto' | 'review' | 'notify'
}

/** 定时触发的触发器。 */
export interface ScheduleTrigger {
  kind: 'schedule'
  schedule: AutomationSchedule
}

export type AutomationTrigger = EventTrigger | ScheduleTrigger

/** 事件过滤与判定条件。 */
export interface EventFilter {
  /** 关键词：任一命中即算相关（确定性匹配，不烧模型）。 */
  keywords?: string[]
  /** 自然语言判定条件：模型按这句话判断「要不要处理」。 */
  semantic?: string
  /** 置信度阈值；省略用全局默认。 */
  threshold?: number
  /** 判定为「待审核」的关键词/语义条件（mode=auto 时也可用）。 */
  reviewWhen?: { keywords?: string[]; semantic?: string }
}
```

**任务定义扩展（`AutomationTaskConfig` / `Automation`）：**

```ts
export interface Automation {
  // ... 现有字段不动 ...
  id: string
  name: string
  description: string
  type: 'ai' | 'script'
  prompt: string
  script?: string
  /** 触发器：事件订阅或定时计划。新增。 */
  trigger: AutomationTrigger
  /** 执行方式（skill id）；从 EVENT_SKILLS 闭集里选。新增。 */
  skill?: string
  /** 事件类任务的优先级；定时任务可留空。新增。 */
  priority?: EventPriority
  schedule: AutomationSchedule   // 保留字段：schedule 触发时是它；event 触发时留空
  runtimeId: string
  project: string
  repo: string
  branch: string
  enabled: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}
```

**兼容性**：`schedule` 字段保留在原位（不删），避免破坏现有 `automation.tasks` 配置与 `nextRunAt` 逻辑。判定规则：

```ts
function triggerOf(task: Automation): AutomationTrigger {
  // 旧任务没有 trigger 字段 → 按 schedule 推导（向后兼容）
  return task.trigger ?? { kind: 'schedule', schedule: task.schedule }
}
```

**`schedule` 与 `trigger.schedule` 的重复**：新任务两处都写（`trigger.schedule` 是权威，`schedule` 是兼容镜像）。写入时统一由 `triggerOf` / `toLegacyShape` 双向同步，避免两份数据打架。

> ⚠️ **待确认 A3**：要不要干脆删掉顶层 `schedule`，全部走 `trigger.schedule`？代价是所有读 `task.schedule` 的地方（`src/automation/scheduler.ts:96`、`src/web/client/automation-model.ts:130`、`packages/core/src/automation-schedule.ts`）都要改；好处是没有两份真相。
> 本方案默认**保留顶层 `schedule` 作为兼容镜像**（改动小、可回滚）。

### 3.3 订阅在配置里的落点

**不在 `events.sources` 里放订阅。** `events.sources` 降级为「**已配置的来源连接**」（插件入口 + 连接参数），而「订阅了什么」全在 `automation.tasks[].trigger`。

```yaml
events:
  enabled: true
  # 来源只登记「这个来源怎么连」，不含订阅语义
  sources:
    github:
      enabled: true
      kind: github
      # 插件来源的入口与选项
      plugin: "@router-agent/event-github"
    feishu:
      enabled: true
      kind: feishu
  # ★ events.rules 整段删除
  decision:
    provider: llm
    confidenceThreshold: 0.6
    fallback: review
  policy:
    ...（不变）

automation:
  tasks:
    - id: auto_teamwork_promise
      trigger:
        kind: event
        source: github
        types: [github.issues.opened]
        params: { repo: blankPen/router-agent }
        ...
```

**「连接参数」放哪的问题**：`events.sources.<id>.options` 现在放插件选项；订阅的参数（repo / chatIds）随任务走。**同一来源不同订阅可以有不同参数**（比如两个 GitHub 仓库）—— 这正是要解开的耦合。

> ⚠️ **待确认 A4**：`events.sources` 这层留不留？
> - (a) **保留但瘦身**（推荐）：只留「这个来源装没装、怎么连」，订阅全在任务里。现有 `events.sources.github-1` 这种「一仓库一条」的形态要迁 —— 一仓库多订阅时来源条目会重复。
> - (b) **彻底删掉 `events.sources`**：来源目录完全由插件注册决定，配置里只留插件入口。但插件入口现在也住在 `events.sources.<id>.plugin` 里，要另找地方放。
> - (c) **保留且不改**：来源条目继续一仓库一条，任务里只引用 `sourceId` + `types`。改动最小，但「来源 = 订阅」的耦合还在，与需求第 2 条的意图相悖。

### 3.4 事件状态机的扩展

现状（`packages/core/src/event.ts:15`）：

```ts
export type EventStatus = 'undecided' | 'pending' | 'review' | 'done' | 'invalid'
export type EventExecution = 'none' | 'deferred' | 'retry' | 'failed'
```

新模型：

| 状态 | 含义 | 变化 |
|-|-|-|
| `undecided` | **删除**。新模型里事件要么命中订阅（进 `pending`），要么根本不订阅（不入库）。 | 删 |
| `pending` | 命中订阅，待判定 / 待派发 | 保留 |
| `review` | 命中但判定为「待审核」，等人批 | 保留 |
| `done` | 工单做完了，结论已回写 | 保留 |
| `invalid` | 判定为无效 / 不相关 | 保留 |
| `notified` | **新增**：`mode=notify` 的任务只记录 + 通知，不开单 | 新增 |

```ts
export type EventExecution = 'none' | 'deferred' | 'retry' | 'failed' | 'notified'
```

`notified` 放 `execution` 而不是 `status`，理由：`status` 是「业务状态」，`notified` 是「执行方式的结果」，与 `deferred` / `retry` / `failed` 并列更一致。

**判定链的变化：**

```text
现状：ingest → 找规则（没有 → undecided）→ 判定 → 闸门 → 开单
新：  ingest → 找订阅（没有 → 不入库）→ 过滤判定 → 闸门 → 开单 / 进 review / 只通知
```

**「没有订阅就不入库」是重要变化**：现状是「全部事件都入库，没规则的挂 `undecided`」，收件箱能看到所有收进来的动静。新模型下，来源只按订阅拉取 —— **没订阅的来源根本不装配 watcher**，自然不会有事件。

> ⚠️ **待确认 A5**：要不要保留「全部事件入库」的观测价值？
> - (a) **不保留**（推荐）：省存储、省判定成本，语义最干净 —— 「没订阅 = 没这回事」；
> - (b) 保留一个「只记录不判定」模式（`mode: 'record'`）：事件入库但永不判定，用于「我想知道发生过什么但不要处理」。代价是多一个 mode 与状态语义。

### 3.5 护栏的提升

规则的 `guardrails.riskLabels`（`security` / `prod` / `production` / `incident` / `payment` / `release`）现在是**每条规则各配一遍**。删规则后，提升为**宿主级全局护栏**：

```yaml
events:
  policy:
    riskLabels: [security, prod, production, incident, payment, release]
```

护栏语义不变（`src/events/decision.ts:253` 的 `ruleDecisionPort`）：命中风险标签 → 强制 P0 + 强制人审，模型不能覆盖（`mergeOutput` 里 `needsReview` 与 `P0` 都不被模型降级）。

**护栏判定从「规则层」移到「订阅判定层」**：现在 `labelsOf(event)` 读事件的 GitHub labels，判定在 `ruleDecisionPort` 里。新模型里这段逻辑搬进 `guardrailDecisionPort`，输入不变。

> ⚠️ **待确认 A6**：全局护栏是否要能按任务覆盖（某条任务想自动处理 `payment` 类事件）？
> - (a) **不能覆盖**（推荐）：护栏是安全底线，与需求「立即去做」的诉求冲突时，人先看一眼；
> - (b) 可覆盖，但覆盖需要显式声明 + 记录审计日志。

---

## 4. 事件源插件重构细节

### 4.1 插件协议对照

| | 现在 | 重构后 |
|-|-|-|
| 插件必须实现 | `create(ctx) → EventSource` | `catalog(ctx) → EventCatalog` |
| 插件可选实现 | — | `fetch(ctx) → EventFetcher`（自带的拉取逻辑） |
| 事件类型目录 | 隐含在 `poll()` 的输出里 | `catalog.types()` **显式声明** |
| 连接参数 | `options.fields`（面板字段） | `catalog.params()`（语义化，模型可直接读） |
| 回写 | `source.publish()` | `fetcher.publish()` 或宿主通用实现 |
| 面板渲染 | `options.fields` | `catalog.params()` + `catalog.types()` |

### 4.2 GitHub 的迁移（具体例子）

现在的 `GithubEventSource`（`src/events/sources/github.ts`）有一堆状态：增量游标、基线、翻页、3 天窗口、PR 详情补齐。**这些逻辑全部保留**，只是驱动方式变了：

```ts
// 现在
const source = new GithubEventSource(id, { kind: 'github', repo, events: [...] }, deps)
await source.poll()

// 重构后
const watcher = githubWatcher({ runner, logger, clock, cursor })
await watcher.poll({ source: 'github', types: [...], params: { repo } })
```

**游标键的变化**：现在按 `repo` 建键（`cursorKey(repo)`），重构后要按 **`(subscriptionId, repo)`** 建键 —— 同一个仓库被两条任务订阅时，两条订阅各自有独立水位。

> ⚠️ **待确认 A7**：同一仓库被多任务订阅时，游标怎么建？
> - (a) **按订阅独立游标**（推荐）：语义最干净，但同一个仓库会被拉多次（GitHub API 调用翻倍）；
> - (b) **按 (source, params) 共享游标 + 扇出**：省 API 调用，但「一条事件被两条订阅命中」需要额外去重逻辑（同一 `externalId` 在不同 subscription 下是两条事件，还是一条事件两个 subscription？）。
> - 影响面：游标键变了会影响 `event:github-baseline` / `event:github-window-skipped` 日志的 `cursorKey` 字段与告警排查习惯。

**GitHub 目录的声明：**

```ts
// src/events/catalogs/github.ts（新）
export const githubCatalog: EventCatalog = {
  id: 'github',
  kind: 'github',
  name: 'GitHub',
  types: () => GITHUB_EVENT_TYPES.map(type => ({
    id: withGithubPrefix(type.id),
    label: type.label,
    group: type.kind,          // issues / pull_request / workflow_run
  })),
  params: () => [
    { key: 'repo', label: '仓库', kind: 'text', hint: 'owner/repo' },
  ],
}
```

**注意**：现在面板上的事件类型 id **不带前缀**（`issues.opened`），事件入库时**带前缀**（`github.issues.opened`）。重构后目录里统一用**带前缀的完整 id**（因为一个面板可能同时有 GitHub 与自建来源，同名类型要能区分）。迁移时配置里的旧 id 要加前缀。

### 4.3 飞书的现状与未来

飞书消息**已经由 channel 链路处理**（`packages/channel-feishu` 的长连接消费），事件链路不重复接管（`src/events/sources/feishu.ts:1` 的注释明说了）。

用户的需求里「订阅飞书消息」是个**重要信号**：他期望飞书消息能进自动化任务体系。两条路：

| | (a) 事件链路实现飞书来源 | (b) channel 链路加「入事件队列」出口 |
|-|-|-|
| 改动范围 | 新写飞书事件 watcher（要处理长连接、去重、回写） | 在 channel ingress 后加一个分流口 |
| 与现有消息链路的关系 | 两套飞书消费（`lark-cli event consume` 会冲突！） | 一套 |
| 语义 | 消息 = 事件 | 消息 = 消息，但可被订阅 |
| 风险 | 高：现有 `FeishuConsumer` 与新 watcher 会抢同一个事件流 | 中：要在 ingress 层判断「这条消息是否被订阅」 |

> ⚠️ **待确认 A8（重要）**：飞书消息订阅走 (a) 还是 (b)？
> - 本方案**建议 (b)**：飞书消息已经在 channel 链路里进来了，事件链路再消费一次会双开长连接。做法是给 channel ingress 加一个「事件订阅出口」—— 当消息命中某条 `mode=event` 的自动化订阅时，除正常消息处理外，再往事件队列写一条事件。
> - (b) 的代价：channel 侧要能读「订阅清单」，即 `packages/channel` 要能拿到订阅信息 → 违反「runtime 与 channel 互不依赖」？不违反 —— 订阅信息由**宿主注入**（`ChannelIngress` 的 opts 传入），channel 包本身不依赖 event 包。
> - (a) 的代价更大但语义更纯。若用户坚持「飞书消息是一种事件源」，需要先把现有 `FeishuConsumer` 改造成「同时喂给消息链路与事件链路」的单消费者。

### 4.4 插件 SDK 的版本策略

`packages/event` 是独立发布的 npm 包（当前 `0.3.40`）。端口不兼容变更需要：

1. **发布 `@router-agent/event@0.4.0`**（minor，语义变更）；
2. 旧的 `EventSource` 接口保留为 deprecated，一并导出 `adaptLegacySource` 适配器；
3. 宿主同时支持新旧两种插件（`catalog()` 优先，缺失则走适配器）。

### 4.5 插件作者的迁移指引（要写进 `docs/MONOREPO.md` 与 README）

```ts
// 旧
export default {
  kind: 'event',
  meta: { id: 'my-source', name: 'My Source' },
  create(ctx) {
    return {
      id: 'my-source',
      kind: 'my-source',
      async poll() { return [{ externalId: '1', title: 'x', body: 'y' }] },
    }
  },
}

// 新
export default {
  kind: 'event',
  meta: { id: 'my-source', name: 'My Source' },
  catalog(ctx) {
    return {
      id: 'my-source',
      kind: 'my-source',
      name: 'My Source',
      types: () => [
        { id: 'my-source.item.created', label: '新条目', group: '条目' },
      ],
      params: () => [
        { key: 'endpoint', label: '接口地址', kind: 'text' },
      ],
    }
  },
  // 可选：自带拉取逻辑；不实现就用宿主通用 watcher
  async fetch(ctx) {
    return {
      async poll(subscription) { /* ... */ },
    }
  },
}
```

---

## 5. Chat 会话模式的实现细节

### 5.1 会话流程的 prompt 与 skill

**新增 spec 文件**：`src/specs/router/automation-builder.md`（内置规范，走现有 `src/specs/index.ts` 的覆盖机制，用户可在面板改）。

内容要点：

```markdown
# 自动化任务构建器

你的唯一目标：把用户的一句话变成一条**可执行的自动化任务**。

## 任务 = 订阅什么 + 触发后做什么

- 事件触发：`trigger = { source, types[], params, filter, mode }`
- 定时触发：`trigger = { kind: 'schedule', schedule }`

## 可用的事件源与类型
（由宿主在 user prompt 里注入 catalog 目录）

## 硬约束
1. `source` 必须是目录里列出来的 id；`types` 必须是该 source 目录里的类型。
2. `params` 的 key 必须是该 source 声明的参数。
3. `project` 必须是候选项目之一；`skill` 必须是候选处理方式之一。
4. 拿不准就回问，不要编造。

## 缺失必填项时
一次只问一个问题，问清后再继续。
```

**这是「skill 流程」在现有架构里的落点** —— 注意：现有的「skill」有两套含义：

| 含义 | 位置 | 本方案的关系 |
|-|-|-|
| Worker 交付技能（`SKILL.md`） | `packages/runtime/src/spec/worker/SKILL.md` | **不动**。那是 Worker 侧规范 |
| 事件处理方式（`EVENT_SKILLS` 闭集） | `src/events/skills.ts:17` | **保留**，改成任务的 `skill` 属性 |
| 路由器侧规范（`specs/router/*.md`） | `src/specs/index.ts` | **新增** `automation-builder.md` |

> 用户原话说「这个会话会有如何创建自动化任务的 skill 流程以及关了了哪些可用的 skill」。翻译成代码：
> - 「skill 流程」→ `automation-builder.md` 规范 + 一组 `automation_*` 工具；
> - 「哪些可用的 skill」→ `EVENT_SKILLS` 闭集（任务可选的处理方式），在会话里作为候选清单注入提示词。

### 5.2 会话状态机

```text
┌─────────┐  用户说「帮我建个自动化」
│  idle   │──────────────────────────────┐
└─────────┘                              ▼
                                   ┌───────────┐
                                   │  parsing  │ 模型抽参数
                                   └───────────┘
                                        │ 完整？
                          ┌─────────────┴─────────────┐
                     缺项 │                           │ 不缺
                          ▼                           ▼
                    ┌───────────┐              ┌───────────┐
                    │ clarifying│ 回问（一次一个）│ previewing│ 出卡片
                    └───────────┘              └───────────┘
                          │ 补齐                       │
                          └─────────────┬─────────────┘
                                        ▼
                                  ┌───────────┐
                                  │ confirmed │ 落库 automation.tasks
                                  └───────────┘
                                        │
                                        ▼
+─────────────────────────────────────────────+
|  completed（任务已建，可点卡片恢复继续改）    |
+─────────────────────────────────────────────+
```

**会话状态的存储**：不放 `status.db` 的新表（避免与任务表职责重叠），而是**复用 `automation_conversations` 表的 `status` 列** + 会话内的 Pi session 文件本身。

**「缺项」清单（模型输出 `missing: string[]`）：**

| 缺项 | 回问话术示例 |
|-|-|
| `source` | 「要订阅哪个来源？目前可用：GitHub、飞书、自定义来源 X。」 |
| `types` | 「GitHub 下面想订阅哪些？我可以给你列出来。」 |
| `params.repo` | 「订阅哪个仓库？给我 owner/repo 就行。」 |
| `mode` | 「命中之后直接执行，还是先给你看一眼？」 |
| `schedule` | 「什么时候跑？每天几点、每周几、还是 cron？」 |
| `project` | 「在哪个项目里做？」 |
| `skill` | 「这类事情按什么方式处理？」 |

### 5.3 与现有 `captureDraft` 的关系

现状（`src/automation/service.ts:602`）：飞书消息 → `parseDraft()` → 落 `automation_drafts` 表 → 面板「待确认草稿」区人工确认。

新模型：

| 维度 | 现状 | 新模型 |
|-|-|-|
| 产物 | 一条 `AutomationDraft` | 一条 `AutomationTask` + 一条 `AutomationConversation` |
| 交互 | 面板弹窗里编辑字段 | 会话里对话式修改 |
| 确认 | 面板点「编辑并保存」 | 卡片点「确认创建」 |
| 入口 | 只有飞书消息 | 面板按钮 + 飞书消息 + 卡片 |
| 迭代 | 改完就没了 | 点卡片恢复会话继续改 |

**迁移**：`automation_drafts` 表保留（历史草稿仍可查看），但不再写入新草稿。新流程直接落正式任务（因为对话里已经确认过了）。

> ⚠️ **待确认 A9**：「确认即落库」还是「仍要面板二次确认」？
> - (a) **会话内确认即落库**（推荐）：对话里已经预览并确认过，再要求去面板确认一次是重复劳动；
> - (b) 仍落草稿、面板确认：更保守，但违背「降低操作成本」的初衷，且草稿与会话两套状态容易不一致。

### 5.4 面板侧改动

**「新建自动化」弹窗 → 会话面板：**

```text
现状：[弹窗：名称 / 类型 / 提示词 / 运行时 / 项目 / 执行时间]

新：  [会话面板：消息流 + 底部输入框]
      助手：「要建个什么样的自动化？比如『每天看下 X 的数据，有异常就提醒我』」
      用户：「帮我每天看下 Teamwork 的大盘数据，有异常的人员都主动帮我提醒下」
      助手：「（抽参数）订阅哪个来源？」
      用户：「不用订阅，就是定时跑」
      助手：（预览卡片）
      用户：（点「确认创建」）
```

**任务卡片加「修改」按钮** → 打开同一个会话面板，带上 `conversationId`。

**技术实现**：Web 面板是 React SPA（`src/web/client/app.tsx`）。会话面板需要一个**流式**的对话 UI —— 现有面板的 API 都是同步请求。需要新增：

```text
POST /api/automations/conversations              → 建会话，返回 conversationId
POST /api/automations/conversations/:id/messages → 发消息（同步返回本轮结果）
GET  /api/automations/conversations/:id           → 拉会话历史（轮询）
POST /api/automations/conversations/:id/confirm   → 确认创建
```

同步返回 + 轮询历史是最小改动方案（现有面板其它地方也是轮询）。流式（SSE）体验更好但改动大。

> ⚠️ **待确认 A10**：面板会话 UI 要不要做流式（SSE）？
> - (a) **同步返回 + 轮询历史**（推荐）：与现有面板技术栈一致，改动小；
> - (b) SSE 流式：体验好，但要改 Web 客户端的请求层（`src/web/client/api.ts` 目前只有 `getJson` / `sendJson` / `saveConfigPatch`）。

---

## 6. 事件记录 → 事件列表 → Agent 执行的链路

### 6.1 完整时序

```text
t0  用户在 Chat 会话里说：「帮我订阅 Github 的 issue，有价值的就立即执行」
t1  会话流程抽参数 → 缺 project → 回问
t2  用户回答 → 参数齐了 → 出预览卡片
t3  用户点「确认创建」→ 落库 automation.tasks（trigger.kind=event）
     日志：automation:task-created { taskId, source, types, mode }
t4  EventManager 下一轮 reloadSubscriptions() 发现新订阅
     日志：event:subscription-registered { taskId, source, types }
t5  watcher.poll(subscription) 拉到事件
     日志：event:source-poll-failed（失败时）/ 正常不入日志
t6  pipeline.ingest(subscriptionId, subscription, envelope)
     幂等：(subscriptionId, externalId)
     日志：event:ingested { eventId, subscriptionId, source, types }
t7  pipeline.process(event)
     关键词过滤（确定性）→ 不命中 → event:filtered-out { eventId, reason }
     语义判定（模型）→ event:filter-evaluated { eventId, matched, confidence }
     护栏检查 → 命中风险标签 → 强制 P0 + 强制人审
     日志：event:guardrail-matched { eventId, label }
t8  分流
     ├─ mode=notify  → execution='notified'，通知用户，结束
     ├─ 判定需人审   → status='review'，通知用户，等批准
     └─ mode=auto    → status='pending'，进闸门
t9  闸门 gateOf()：时间窗 / 配额 / 在办工单上限
     不允许 → execution='deferred'，等下一轮
     日志：event:deferred { eventId, reason }
t10 dispatch()：合成 Trigger（source = `automation:<taskId>`）→ engine.decide()
     日志：event:dispatched { eventId, taskId, ticketId, project, skill }
t11 EventKickoff：私聊 task 的通知人 + 建话题
     日志：event:kickoff { ticketId, taskId, chat, threadId }
t12 Worker 执行 → 上报 → 结论回写（按 subscription 决定是否评论到 GitHub）
     日志：event:completed { eventId, ticketId }
     └─ mode=notify 的任务没有 t10~t12，整条链路在 t8 结束
```

### 6.2 幂等键的扩展

现状：`UNIQUE (source_id, external_id)`（`src/store/db.ts:489`）。

新模型：同一事件可能被多条订阅命中（两个任务都订阅了同一个 GitHub issue）。两种语义：

| | (a) 每订阅一条事件 | (b) 一条事件，多订阅关联 |
|-|-|-|
| 表结构 | `UNIQUE (subscription_id, external_id)` | `events` 表 + `event_subscriptions` 关联表 |
| 事件列表 | 同一条 issue 出现两次（分属两个任务） | 出现一次，标「命中 2 条订阅」 |
| 派工 | 两个任务各开一张单 | 需要决定派给谁（多任务冲突） |
| 实现复杂度 | 低 | 高（多对多 + 冲突策略） |

**本方案默认选 (a)**：

- 理由：用户的心智是「我订阅了一件事 → 这件事归我的任务管」，任务之间独立、可分别暂停；
- (b) 的多任务冲突需要额外仲裁规则，是新的一套复杂语义；
- 代价：同一 issue 被两个任务订阅时会被处理两次 —— 但这本来也是用户的意图（「A 任务处理，B 任务也处理」）。

**迁移**：`UNIQUE (source_id, external_id)` → `UNIQUE (subscription_id, external_id)`。SQLite 改唯一索引要重建表：

```sql
-- 迁移脚本要点
-- 1. 建新表
CREATE TABLE events_new ( ... subscription_id TEXT NOT NULL DEFAULT '', UNIQUE (subscription_id, external_id) ... );
-- 2. 拷贝：历史事件 subscription_id 填迁移后的任务 id（或空串）
INSERT INTO events_new SELECT ..., '', ... FROM events;
-- 3. 换表
DROP TABLE events; ALTER TABLE events_new RENAME TO events;
```

> ⚠️ **待确认 A11**：历史事件的 `subscription_id` 填什么？
> - (a) `''`（空串）+ 一个特殊常量表示「历史事件，无订阅」；
> - (b) 从 `rule_id` 反查迁移后的任务 id —— 能回链，但需要迁移顺序严格（先迁任务再迁事件）；
> - (c) 按 `rule_id` 的规则 id 拼出任务 id（`auto_<ruleId>`），即使任务已被人工改过也能对上大部分。
> 本方案默认 (c)：规则 id 与迁移后的任务 id 有确定的映射关系，能回链最好。

### 6.3 事件列表（收件箱）的展示变化

```text
现状列：优先级 | 事件 | 判定 | 状态 | 操作
       判定列显示：项目 / skill / 理由 / 置信度 / ruleId

新列：  优先级 | 事件 | 归属 | 状态 | 操作
       归属列显示：任务名（不是 ruleId）/ 项目 / skill / 理由 / 置信度
```

**「规则命中」聚合区 → 「订阅命中」聚合区**：按 `subscriptionId`（= 任务 id）聚合命中数，标题显示任务名。零命中的订阅提示「事件类型可能没订对 / 来源没拉到东西」。

### 6.4 「进事件列表等 Agent 执行」的两种解读

用户原话：「如果是相关的事件就记录到事件列表中，描述清楚上下文背景，等待 Agent 执行」。

这对应两种读法：

| 读法 | 链路 | 谁来决定要不要做 |
|-|-|-|
| (i) 事件先全部进列表，由 **Agent** 判断该不该做 | 事件 → 事件列表 → Agent 领取 → 执行 | Agent（= Worker / runtime） |
| (ii) 事件进列表，**Router** 判定后开单 | 事件 → 判定 → 开单 → Worker | Router（= 现有 `EventDecisionService`） |

**本方案走 (ii)**：现有链路已经是 (ii)，判定逻辑（`EventDecisionService`）保留，只是「判定依据」从规则换成订阅的过滤条件。(i) 会把判定责任推给 Worker，每次事件都烧一次 runtime，代价高且不可控。

但 (ii) 有个缺口：**判定与「执行 prompt」是分开的**。用户在例 1 里说「只要我答应了就立即去做」—— 这个「判断是不是承诺」的语义，既是过滤条件，也是执行语义。方案里 `filter.semantic` 与 `execution.prompt` 各管一段：

```yaml
filter:
  semantic: 与 Teamwork 相关的优化事项，且发送人作出了承诺   ← 判定「要不要做」
execution:
  prompt: 收到承诺后立即动手改，不必再等确认                ← 判定「怎么做」
```

会话流程解析时，**同一个语义可能同时影响两者**（例如「立即去做」既表示 `mode=auto`，也表示 prompt 里的「不用再等确认」）。这靠模型在解析阶段一并产出。

### 6.5 「描述清楚上下文背景」的落地

用户明确要求事件记录要有上下文背景。现状 `EventRecord` 已有 `title` / `body` / `url` / `raw` / `context`（`packages/core/src/event.ts:67`）。新增：

| 字段 | 内容 | 来源 |
|-|-|-|
| `context.background` | 命中的关键词 / 判定理由 / 订阅摘要 | 判定阶段填 |
| `context.filtered` | 命中的订阅 id 与任务名 | 判定阶段填 |

写进 `events.context`（JSON 列，已有），**不改表结构**。

Worker 拿到的上下文（现状 `pipeline.requestOf()`，`src/events/pipeline.ts:533`）要相应扩展：

```text
事件标题：…
事件正文：…
事件类型：github.issues.opened；优先级：P1
归属项目：router-agent
处理方式：ci-fix（CI 修复）
命中过滤条件：keywords=[有价值的] semantic=值得投入处理的 issue
来源链接：https://github.com/…
判定理由：…
```

---

## 7. 待确认取舍清单

以下每一项都影响实现，**都需要用户拍板**。本方案给了默认值，但默认值不代替决策。

| # | 议题 | 选项 | 本方案默认 | 影响面 |
|-|-|-|-|-|
| A1 | 事件类任务的「归属项目」从判定产物改成任务属性？ | (a) 任务属性（写死）(b) 继续判定 (c) 任务给了就用、没给就判定 | (a) | `EventDecisionService`、闭集校验、`EventVerdict` |
| A2 | `eventType: '*'` 的兜底规则怎么迁？ | (a) 丢弃 (b) 展开 (c) 通配订阅 | (a) | 迁移脚本 |
| A3 | 删不删顶层 `schedule` 字段？ | (a) 保留兼容镜像 (b) 彻底删 | (a) | `automation-schedule.ts`、scheduler、面板 |
| A4 | `events.sources` 这层留不留？ | (a) 瘦身保留 (b) 彻底删 (c) 原样保留 | (a) | `config.ts`、面板来源卡、迁移 |
| A5 | 要不要保留「全部事件入库」的观测能力？ | (a) 不保留 (b) 加 `mode: record` | (a) | `EventStatus`、watcher |
| A6 | 全局护栏（风险标签）能不能按任务覆盖？ | (a) 不能 (b) 可覆盖但记审计 | (a) | `guardrailDecisionPort` |
| A7 | 同一仓库被多任务订阅时游标怎么建？ | (a) 按订阅独立 (b) 按 (source,params) 共享+扇出 | (a) | GitHub watcher、日志字段 |
| A8 | 飞书消息订阅走事件链路还是 channel 出口？ | (a) 新写飞书 watcher (b) channel 加事件出口 | (b) | `packages/channel`、channel-feishu、双消费冲突 |
| A9 | 会话内确认后直接落库，还是仍要面板二次确认？ | (a) 直接落库 (b) 落草稿待确认 | (a) | `automation_drafts` 表 |
| A10 | 面板会话 UI 要不要流式（SSE）？ | (a) 同步+轮询 (b) SSE | (a) | `src/web/client/api.ts` |
| A11 | 历史事件的 `subscription_id` 填什么？ | (a) 空串 (b) 反查任务 (c) 按 ruleId 推导 | (c) | 迁移脚本、事件表重建 |
| B1 | 旧事件插件（只有 `EventSource`）怎么适配？ | (a) 推断目录+弃用告警 (b) 强制升级 (c) 手写 types 字段 | (a) | `packages/event`、插件兼容 |
| B2 | 自动化卡片回调走哪条路？ | (a) 扩展 `questions` 表 (b) 新增 `automation_cards` 表 (c) 不用回调 | (b) | `handleCardAction`、飞书适配器 |
| B3 | 事件类任务与定时任务是否共用一套 `automation.tasks`？ | (a) 共用 (b) 分表 | (a) | 整个任务模型 |
| B4 | 自动化任务的通知人怎么定？ | (a) 沿用来源的 `owner` (b) 任务级通知人 (c) 两者都要 | (b) | `EventKickoff`、`AutomationTaskConfig` |

---

## 8. Web 界面草图

本轮不改任何界面代码，这里只给**目标形态的草图**，供确认方向后再排实施。

**草图怎么画的**：直接复用面板真实的 `src/web/app.css`（同一套 token、同一套组件类），只补「面板里还没有的新组件」的少量样式；用 Playwright 在 1440×900 渲染导出。因此图里的间距、圆角、配色、控件形态与面板现状是一致的，不是另起一套设计。mockup 源码在 `docs/design/mockups/`，可直接在浏览器打开。

**四个界面，对应四件事**：

| 界面 | 解决的问题 | 现状 → 目标 |
|-|-|-|
| 配置 · 事件源目录 | 「有什么可订阅的」 | 来源卡 → **目录卡**：只列事件类型与连接参数，不列订阅 |
| 自动化 · 任务列表 | 「我订阅了什么、怎么处理」 | 弹窗建任务 → **卡片 + 恢复会话** |
| 自动化 · 会话面板 | 「用一句话建任务」 | 弹窗表单 → **对话式会话**（核心变化） |
| 收件箱 | 「事件来了怎么办」 | 规则命中 → **订阅命中**；新增「已通知」态 |

---

### 8.1 配置 · 事件源目录（重构后的来源卡）

![配置页：事件源目录，只声明可订阅的事件类型](@./docs/design/figures/fig-v2-ui-catalog.png)

**关键变化**：卡片不再管「订阅了哪些事件」。

- 卡片头：来源名 + **可订阅事件类型数** + 需要哪些连接参数 + 启停开关；
- 卡片体：**逐条列出该来源的事件类型**（`github.issues.opened` …），每条右侧标「被 N 个任务订阅 / 尚未订阅」；
- 卡片脚：只留「连接参数」与「查看订阅它的任务」两个动作 —— **没有「选择事件类型」的多选框**（那正是要删掉的旧弹窗）。

**为什么这样改**：旧的「设置」弹窗让用户在这里勾事件类型，等于把「订阅」这个动作拆成两处（这里勾 + 规则里再写一遍 `eventType`），正是用户说「操作成本非常高」的根源。新形态里这一页变成**只读的目录**，订阅关系一律在任务里。

### 8.2 自动化 · 任务列表（订阅与执行一体）

![自动化页：任务卡片带触发方式、处理模式与恢复会话入口](@./docs/design/figures/fig-v2-ui-automations.png)

**一张卡片同时说明四件事**（对应任务模型里的四个字段）：

| 卡片位置 | 显示 | 字段 |
|-|-|-|
| 标题行 | 任务名 + 副标题（触发方式 · 来源 · 项目 · 运行时） | `trigger` / `project` / `runtimeId` |
| 描述行 | 一句话说明这条任务干什么 | `description` |
| 信息行 | **处理模式标签** + 订阅的事件类型 + 命中次数 | `mode` / `types[]` |
| 动作行 | **修改** / **恢复会话** / 执行一次 / 停用 / 删除 | `conversationId` 入口 |

**三种模式用颜色区分**（面板既有语义色，不新增色板）：

- 🟢 **自动执行**（`mode: auto`）：命中即开单执行；
- 🟡 **待人审**（`mode: review`）：命中后进事件列表等人确认；
- 🔵 **仅提醒**（`mode: notify`）：只记录并通知，不进执行链路。

**「恢复会话」是新按钮**，与「修改」并列：点它打开这个任务绑定的 Chat 会话（§8.3），继续迭代改这条任务。这是「点卡片恢复会话并可迭代修改」的落点。

> 现在这页的「新建自动化」弹窗（名称/类型/提示词/运行时/项目/执行时间）会被**会话面板取代**，不再保留。弹窗字段顺序与「添加决策规则」一致的问题（`src/web/client/automation-panel.tsx:1`）也一并消失。

### 8.3 自动化 · 会话面板（核心变化）

![自动化页：用自然语言在会话里创建自动化任务](@./docs/design/figures/fig-v2-ui-conversation.png)

这是本次重构**界面上的主要改动**：从「填表单」变成「说话」。

**对话流**：

```text
助手：要建个什么样的自动化？比如「订阅飞书消息里跟 Teamwork 相关的优化事项，有人答应了就立刻去做」
用户：帮我订阅飞书消息，跟 Teamwork 相关的优化事项，如果我答应了立即去做
助手：事件源我按「飞书消息」选了 feishu.message。还要一个归属项目：这条自动化改哪个仓库？
用户：router-agent
助手：（预览卡片）触发方式 / 过滤条件 / 处理方式 / 归属项目 / 运行时 + [再改改] [确认创建]
```

**几个设计约束**（与 §2.4 的会话流程一致）：

1. **缺项一次只问一个** —— 图里助手只追问「归属项目」一项，不一口气列一堆必填；
2. **闭集不外扩** —— 事件源与事件类型都来自目录（`feishu.message` 是目录里的合法值），助手不会编一个不存在的类型；
3. **确认前不落库** —— 预览卡片显式列出解析结果，人点了「确认创建」才写 `automation.tasks`；
4. **可迭代** —— 参数齐了之后用户继续说「关键词加上退款」「改成只提醒我」，助手在同一会话里改同一份草稿；
5. **每轮都留痕** —— 气泡上方的小字标出这一步在干什么（已加载目录 / 已抽取参数 / 缺 N 项），对应日志里的 `automation:session-*` 事件。

**右侧「会话清单」**：列出与本次会话相关的任务，点击可切换。任务与会话一一绑定（`conversationId`），所以从任何入口进来都能找回这条会话。

**技术落点**（与 §5.4 一致）：同步返回 + 轮询历史，不改 Web 客户端请求层；流式方案见 §7 待确认 A10。

### 8.4 收件箱 · 订阅命中与三种去向

![收件箱：按订阅聚合的事件队列，展示自动执行、待人审与仅提醒三种去向](@./docs/design/figures/fig-v2-ui-inbox.png)

**汇总条**：待审核 / 待处理 / 已通知 / 已完成 / 已过滤 / 最近更新。
「已过滤」是新增的一格 —— 记录被关键词或语义过滤掉的事件，用于回答「为什么这条没进来」；「已通知」对应 `mode: notify` 的新增执行态（§3.4）。

**「规则命中」→「订阅命中」**：按**任务**（= 订阅）聚合，不再按 `ruleId`。每行显示任务名 + 订阅的事件类型 + 处理模式 + 命中数（有效 / 人审 / 仅提醒 / 合计）。**长期 0 命中的订阅会提示「事件类型或关键词可能订错了」** —— 这是旧「规则命中」区最有用的能力，保留但换了统计维度。

**事件表**：

- 「判定」列 → **「归属」列**：显示**任务名**（不再是 `ruleId`）+ 项目 + skill + 理由 + 置信度；
- 「状态」列新增 **已通知**（`s-done` 之外单独一态），对应仅提醒模式；
- 「待审核」的行左边仍有一道警示色条（面板既有做法），配「转自动 / 忽略」两个动作。

**上下文背景**：事件摘要行下面那段灰字就是「描述清楚上下文背景」的落点 —— 命中了哪个关键词、语义判定为什么这么判、护栏为什么把人拦下来。完整字段见 §6.5。

---

### 8.5 界面改动清单与影响面

| 界面 | 文件 | 改动性质 |
|-|-|-|
| 配置 · 事件源目录 | `src/web/client/events-config.tsx:36` | 改：来源卡换成目录卡，删掉事件类型多选弹窗 |
| GitHub 订阅弹窗 | `src/web/client/github-subscriptions.tsx:93` | **删**：整块「设置」弹窗随 `events.sources` 瘦身（A4）一起退场 |
| 决策规则面板 | `src/web/client/event-rules.tsx:30` | **删**：模块整体移除（§3.1.1） |
| 自动化 · 任务列表 | `src/web/client/automation-panel.tsx:54` | 改：卡片加模式标签、订阅信息、「恢复会话」按钮；删「新建自动化」弹窗 |
| 自动化 · 会话面板 | 新增 `src/web/client/automation-conversation.tsx` | **新增**：对话流 + 预览卡片 + 会话清单 |
| 收件箱 | `src/web/client/events-panel.tsx:73` | 改：「判定」列→「归属」列；「规则命中」→「订阅命中」；新增「已通知 / 已过滤」 |
| 预览卡片 | 新增 `src/web/client/automation-preview-card.tsx` | **新增**：会话里确认前的参数预览 |
| 任务卡「恢复会话」 | `src/service.ts:2211` 卡片回调链路 | 改：卡片动作带 `conversationId`（§2.6.5） |

**新增的样式**（全部挂在面板既有 token 上，不新建第二套样式体系）：

```text
.conv / .conv-msg / .conv-bubble / .conv-compose   会话流与输入框
.preview-card / .preview-row / .preview-foot       参数预览卡
.tag.mode-auto / .tag.mode-review / .tag.mode-notify 三种处理模式标签
.catalog-item                                      事件目录条目
.side-panel / .side-row                            会话清单侧栏
```

**与工单「只出设计」的关系**：以上全部是**方案**，本轮一行界面代码都没改；mockup 只是把目标形态画出来，便于在动代码之前先对齐方向。

---

## 9. 分阶段实施步骤

每阶段独立可发布、可回滚。**建议按顺序推进，阶段 1 与 2 是后面所有工作的地基。**

### 阶段 0 · 文档与决策（当前工单）

- [x] 本方案文档
- [x] Web 界面草图（§8，含 4 张 mockup）
- [ ] 用户对 §7 的 A1~A11、B1~B4 拍板
- [ ] 用户确认 §8 的界面方向

**产出**：拍板后的方案定稿。

### 阶段 1 · 事件目录与插件协议（不动现有链路）

**目标**：插件侧的新接口就位，但宿主仍按老路跑。

1. `packages/event`：新增 `EventCatalog` / `EventTypeDescriptor` / `EventParamDescriptor`；`EventPlugin` 加 `catalog?` / `fetch?`；导出 `adaptLegacySource`。
2. `packages/event`：`EventSource` 标记 `@deprecated`，保留导出。
3. 宿主：`src/events/catalogs/github.ts`、`src/events/catalogs/feishu.ts` 两个内置目录。
4. 宿主：`src/events/catalog.ts` 汇总所有目录（内置 + 插件），供 API 与会话流程使用。
5. API：`GET /api/events/catalogs` 返回目录树（来源 → 类型 → 参数）。
6. 面板：配置页「事件来源」区新增「可订阅事件」只读视图（**不删现有来源卡**）。
7. 测试：`packages/event/tests/` 目录契约测试；`tests/events/catalog.test.ts`。

**风险**：低。纯新增，不动既有行为。

**回滚**：删新文件即可。

### 阶段 2 · 订阅模型与任务扩展（数据层）

**目标**：自动化任务能表达「订阅什么」，但触发仍只走定时。

1. `packages/core/src/automation.ts`：新增 `AutomationTrigger` / `EventTrigger` / `ScheduleTrigger` / `EventFilter`。
2. `src/config.ts`：`AutomationTaskConfig` 加 `trigger` / `skill` / `priority`；`parseAutomation` 兼容旧任务（无 `trigger` → 按 `schedule` 推导）；`validateAutomationTasks` 校验 trigger 闭集。
3. `src/store/db.ts`：`automation_conversations` 表 + CRUD。
4. `packages/core/src/automation.ts`：`AutomationConversation` 类型。
5. 测试：`tests/automation/config.test.ts` 扩 trigger 校验；旧配置兼容用例。

**风险**：低。旧配置不带 `trigger` 时行为不变。

**回滚**：字段可选，旧任务照跑。

### 阶段 3 · Chat 会话流程（创建与恢复）

**目标**：能用自然语言建任务、能点卡片恢复会话。

1. `src/specs/router/automation-builder.md` 新规范 + `src/specs/index.ts` 注册。
2. `src/automation/parse.ts`：解析器（`parseAutomationIntent`），闭集校验 source / types / params / project / skill。
3. `src/automation/session.ts`：会话编排（状态机、缺失项回问、预览、确认、落库）。
4. `src/router/tool-spec.ts`：新增 5 个 `automation_*` 工具；`PiDecisionEngine` 支持按会话放行工具集（`setActiveToolsByName`）。
5. `src/service.ts`：`handleCardAction` 分流处理自动化卡片（按 B2 结论）。
6. API：`/api/automations/conversations*` 四个端点。
7. 面板：会话面板（消息流 + 输入框 + 预览卡片）；任务卡「修改」按钮。
8. 飞书：`captureDraft` 路径改为走会话流程（不再落 `automation_drafts`）。
9. 测试：`tests/automation/parse.test.ts`（解析与闭集）、`tests/automation/session.test.ts`（状态机）、`tests/web/automation-conversation.test.ts`。

**风险**：中。涉及 Pi 会话复用与飞书交互，需要真机联调。

**回滚**：会话入口可关（配置开关），退回弹窗创建。

### 阶段 4 · 事件订阅执行链路（核心替换）

**目标**：事件触发真正跑起来，规则链路退役。

1. `src/events/watcher.ts`：通用 watcher（轮询 + 去重 + 窗口裁剪）。
2. `src/events/subscriptions.ts`：从 `automation.tasks` 推导订阅集合。
3. `src/events/manager.ts`：`reloadSources` → `reloadSubscriptions`；按订阅装配 watcher。
4. `src/events/pipeline.ts`：匹配规则 → 匹配订阅；`ingest` 带 `subscriptionId`；`dispatch` 用任务的 `prompt` 与 `skill`。
5. `src/events/decision.ts`：`ruleDecisionPort` → `guardrailDecisionPort`；判定输入换订阅。
6. `src/events/decision-model.ts`：判定提示词按订阅的 `filter` 组织。
7. `src/store/db.ts`：`events` 表改 `subscription_id` + 重建唯一索引；`EventRecord` 加 `subscriptionId`。
8. `src/events/skills.ts`：`EVENT_SKILLS` 保留，成为任务属性。
9. 护栏全局化：`events.policy.riskLabels`。
10. `mode=notify` 的执行路径（`execution: 'notified'`）。
11. 测试：迁移 `tests/events/*` 现有用例（规则 → 订阅）；新增订阅命中、过滤、护栏、notify 用例。

**风险**：高。这是核心链路替换。

**回滚**：配置开关 `events.subscriptionMode: legacy | v2`（默认 `legacy`），灰度切换；阶段 5 前默认走老路。

### 阶段 5 · 决策规则模块删除

**目标**：代码与配置里彻底没有「决策规则」。

1. 删 `src/events/rules.ts` / `rule-compile.ts` / `src/web/client/event-rules*.ts(x)`。
2. `src/config.ts`：删 `events.rules` 字段与解析；`LIST_PATHS` 去 `'events.rules'`。
3. `src/router/api.ts`：删 3 个规则端点。
4. `src/cli/index.ts`：删 `rules()` / `compileRule` / `ruleStats()` 端口。
5. `src/web/client/app.tsx` / `fields.ts`：删 `events-rules` 块。
6. `src/web/client/events-panel.tsx`：「规则命中」→「订阅命中」。
7. `docs/OPERATIONS.md`：事件表增删条目。
8. `docs/CONFIGURATION.md` / `docs/AUTOMATION.md` / `README*`：同步。
9. 测试：删 `tests/events/rule-compile.test.ts`、`tests/web/event-rules.test.ts`、`tests/web/rule-modal.test.ts`；其余用例改名。

**风险**：中。纯删除，但依赖阶段 4 已跑通。

**回滚**：git revert。

### 阶段 6 · 数据迁移与清理

**目标**：存量配置与数据平滑过渡。

1. `ra migrate event-rules --dry-run / --apply / --verify`。
2. 迁移规则 → 任务（§3.1.2 的映射表）。
3. `events` 表重建（`subscription_id` + 唯一索引）。
4. 历史事件回填 `subscription_id`。
5. 人工清单：`ra migrate event-rules` 输出待人工处理的规则。
6. `config.yaml.bak.<ts>` 自动备份。
7. 观察期：迁移后**保留** `events.rules`（不删），确认无异常后再手工清理。

**风险**：高（数据操作）。必须先 `--dry-run`。

**回滚**：换回 `config.yaml.bak`；事件表反向 rename。

### 阶段 7 · 飞书消息订阅（依赖 A8 结论）

- (b) 方案：`packages/channel` 的 ingress 加事件出口；`packages/channel-feishu` 不动双消费。
- (a) 方案：`FeishuConsumer` 改造成单消费者双出口；`src/events/sources/feishu.ts` 填实。

**风险**：高（A 方案）。B 方案中等。

### 阶段 8 · 收尾

- `docs/design/` 本文档更新为「已落地」。
- `docs/MONOREPO.md` 补事件来源插件新协议。
- `packages/event` 发布 `0.4.0`。
- README / README.en 同步入口链接。

---

## 10. 影响面清单

### 10.1 按包

| 包 | 改动 | 阶段 |
|-|-|-|
| `packages/core` | `automation.ts` 加 trigger / conversation 类型；`event.ts` 加 `notified`；`github-events.ts` 目录 id 统一带前缀 | 2 / 4 |
| `packages/event` | 端口拆 Catalog / Fetcher；插件协议加 `catalog?` / `fetch?`；`adaptLegacySource`；发 `0.4.0` | 1 / 4 / 8 |
| `packages/channel` | （B2/A8-b）ingress 加事件出口；不动 channel 协议 | 7 |
| `packages/channel-feishu` | 卡片按钮载荷支持自动化卡片（`value` 已是任意 JSON，可能零改动） | 3 / 7 |
| `packages/runtime` | 不动 | — |

### 10.2 按宿主模块

| 文件 | 改动摘要 | 阶段 |
|-|-|-|
| `src/config.ts` | 删 `events.rules`；`automation.tasks` 加 `trigger` / `skill` / `priority`；`validateAutomationTasks` 扩校验；`LIST_PATHS` 调整；`publicConfig` 调整 | 2 / 5 |
| `src/store/db.ts` | 新表 `automation_conversations`；`events` 表改列与唯一索引；CRUD | 2 / 4 / 6 |
| `src/events/rules.ts` | 删 | 5 |
| `src/events/rule-compile.ts` | 删 | 5 |
| `src/events/decision.ts` | `ruleDecisionPort` → `guardrailDecisionPort`；输入换订阅；全局风险标签 | 4 |
| `src/events/decision-model.ts` | 判定提示词按订阅 filter 组织 | 4 |
| `src/events/pipeline.ts` | 匹配订阅；`ingest` 带 subscriptionId；`dispatch` 用任务 prompt/skill；`scopeOf` 改写 | 4 |
| `src/events/manager.ts` | `reloadSubscriptions`；按订阅装配 watcher；护栏检查 | 4 |
| `src/events/wiring.ts` | 装配改造 | 4 |
| `src/events/skills.ts` | 保留，语义从「规则候选」变「任务属性」 | 4 |
| `src/events/sources/github.ts` | 改为 watcher 形态；游标键按订阅 | 4 |
| `src/events/sources/feishu.ts` | 占位保持（等阶段 7） | 7 |
| `src/events/catalogs/*.ts` | **新增**：内置目录 | 1 |
| `src/events/watcher.ts` | **新增**：通用 watcher | 4 |
| `src/events/subscriptions.ts` | **新增**：订阅推导 | 4 |
| `src/events/kickoff.ts` | 通知人来源改任务级（B4 结论） | 4 / 7 |
| `src/automation/service.ts` | 删 `captureDraft` / `parseDraft` 旧路径；接会话流程 | 3 |
| `src/automation/parse.ts` | **新增**：解析器 | 3 |
| `src/automation/session.ts` | **新增**：会话编排 | 3 |
| `src/automation/intent.ts` | 预筛扩展（覆盖「订阅」类说法） | 3 |
| `src/router/tool-spec.ts` | 新增 5 个 `automation_*` 工具 | 3 |
| `src/router/pi-decision-engine.ts` | 支持按会话放行工具集 | 3 |
| `src/router/agent-loop.ts` | 自动化会话的消息接入 | 3 |
| `src/router/api.ts` | 删规则端点；加会话与目录端点 | 3 / 5 |
| `src/service.ts` | `handleCardAction` 分流自动化卡片 | 3 |
| `src/cli/index.ts` | 删规则端口；接会话流程；加 `ra migrate event-rules` | 5 / 6 |
| `src/web/client/app.tsx` | 删 `events-rules` 分支；加会话面板 | 3 / 5 |
| `src/web/client/fields.ts` | 删 `events-rules` 块 | 5 |
| `src/web/client/event-rules.tsx` / `event-rules-model.ts` | 删 | 5 |
| `src/web/client/events-config.tsx` | 「事件来源」→「事件目录」；加任务侧订阅入口 | 1 / 5 |
| `src/web/client/events-panel.tsx` | 「规则命中」→「订阅命中」；列调整 | 4 / 5 |
| `src/web/client/automation-panel.tsx` | 弹窗 → 会话面板；任务卡加「修改」 | 3 |
| `src/web/client/automation-model.ts` | 任务模型加 trigger / skill；校验 | 2 / 3 |
| `src/web/client/github-subscriptions.tsx` | 仓库订阅移入任务侧；只留目录视图 | 4 / 5 |
| `src/web/client/api.ts` | 会话端点的 fetch 封装 | 3 |
| `src/web/client/automation-conversation.tsx` | **新增**：会话面板（对话流 + 预览卡 + 会话清单） | 3 |
| `src/web/client/automation-preview-card.tsx` | **新增**：确认前的参数预览卡 | 3 |
| `src/specs/index.ts` + `src/specs/router/automation-builder.md` | **新增**规范 | 3 |
| `src/cli/migrate/` | **新增** `event-rules` 迁移命令 | 6 |

### 10.3 测试影响面

| 测试文件 | 影响 |
|---|---|
| `tests/events/rule-compile.test.ts` | **删**（阶段 5） |
| `tests/web/event-rules.test.ts` | **删**（阶段 5） |
| `tests/web/rule-modal.test.ts` | **删**（阶段 5） |
| `tests/events/pipeline.test.ts` | 改：规则 → 订阅；新增过滤 / 护栏 / notify 用例 |
| `tests/events/decision.test.ts` | 改：`ruleDecisionPort` → `guardrailDecisionPort`；判定输入换订阅 |
| `tests/events/manager.test.ts` | 改：来源装配 → 订阅装配 |
| `tests/events/api.test.ts` | 改：删规则端点断言 |
| `tests/events/config.test.ts` | 改：删 rules 解析用例 |
| `tests/events/kickoff.test.ts` | 改：通知人来源 |
| `tests/events/sources.test.ts` | 改：GitHub watcher 形态 |
| `tests/automation/config.test.ts` | 改：trigger 校验 |
| `tests/automation/service-draft.test.ts` | 改：旧草稿路径 → 会话流程 |
| `tests/automation/intent.test.ts` | 改：预筛覆盖「订阅」说法 |
| `tests/web/automation-model.test.ts` | 改：trigger / skill |
| `tests/web/config-schema.test.ts` | 改：删 `events-rules` 块 |
| `tests/config.test.ts` | 改：删 `events.rules` |
| `tests/store/store.test.ts` | 改：events 表结构 |
| `tests/architecture/packages.test.ts` | 可能要改：包边界白名单只放行 `core` / `infra` / `runtime` / `channel`（`tests/architecture/packages.test.ts:89`），若 `channel` 要引 `event` 的类型需一并放开 —— 或按 A8-b 把订阅清单做成中立结构留在 `core` |
| **新增** `tests/events/catalog.test.ts` | 目录契约 |
| **新增** `tests/events/subscriptions.test.ts` | 订阅推导 |
| **新增** `tests/events/watcher.test.ts` | 通用 watcher |
| **新增** `tests/automation/parse.test.ts` | 自然语言解析与闭集 |
| **新增** `tests/automation/session.test.ts` | 会话状态机 |
| **新增** `tests/automation/migrate.test.ts` | 迁移映射 |
| **新增** `tests/web/automation-conversation.test.ts` | 面板会话 |

### 10.4 文档影响面

| 文档 | 改动 |
|---|---|
| `docs/CONFIGURATION.md` | 「事件总线」章重写：删决策规则章，来源 → 目录，订阅 → 任务 |
| `docs/AUTOMATION.md` | 加 trigger 模型、会话流程、事件触发 |
| `docs/OPERATIONS.md` | 事件表增删：`event:subscription-*` / `event:filtered-out` / `event:guardrail-matched` / `automation:task-created` / `automation:session-*`；删 `event:rule-*` |
| `docs/MONOREPO.md` | 事件来源插件协议新形状 + 迁移指引 |
| `docs/API.md` | 删规则端点；加会话与目录端点 |
| `docs/ARCHITECTURE.md` | 事件链路图更新 |
| `docs/design/event-decision-rules-design.md` | 加一句「已被本方案取代」，避免后来人照旧方案做 |
| `README.md` / `README.en.md` | 入口链接 |

### 10.5 外部影响面

| 外部 | 影响 |
|---|---|
| 已安装的第三方事件来源插件 | 端口不兼容 → 需适配层（B1）或插件升级 |
| `@router-agent/event` npm 包 | 发 `0.4.0`，旧版本仍可用 |
| 用户现有的 `config.yaml` | `events.rules` 被忽略（阶段 5 后）；`automation.tasks` 缺 `trigger` 时按 `schedule` 推导 |
| 用户现有的 `state.db` | `events` 表结构变更；需备份 |
| 飞书群里的机器人 | 新的卡片形态；旧卡片不受影响 |

---

## 11. 风险与回滚策略

### 11.1 风险登记

| # | 风险 | 概率 | 影响 | 缓解 | 回滚 |
|-|-|-|-|-|-|
| R1 | **删规则后判定依据变弱**：原来规则里的四问很具体，新模型的 `filter.semantic` 由模型从一句话生成，可能不如人工填的准 | 高 | 高 | 迁移时把 `is_valid.instructions` 原样搬进 `filter.semantic`；保留 `mode` 与风险标签两个确定性闸门；观察期看「转人工率」 | 阶段 4 的 `events.subscriptionMode` 开关切回 legacy |
| R2 | **同一事件被多任务订阅时重复处理** | 中 | 中 | 面板在任务卡上显示「与其它 N 条任务订阅了同一来源」；`mode=auto` 的任务默认独占（见 A11 备选） | 手工关掉重复任务 |
| R3 | **迁移丢语义**：规则里手写的东西没法一一映射 | 中 | 中 | `--dry-run` 报告每一条的映射结果与差异；不确定的进人工清单，不自动迁 | `config.yaml.bak` 换回 |
| R4 | **事件表重建丢数据** | 低 | 高 | 重建前 `VACUUM INTO` 备份；迁移脚本事务化；`--verify` 比对条数 | 从备份恢复 `state.db` |
| R5 | **会话流程解析不准**：模型把一句话理解错，建出错的自动化 | 高 | 中 | 预览卡片必须人工点「确认」；闭集校验（source/types/params/project/skill）挡住越界；关键项缺失就回问 | 关闭会话入口，退回弹窗 |
| R6 | **飞书双消费**：A8 选 (a) 时两个 `lark-cli event consume` 抢同一个事件流 | 中 | 高 | A8 选 (b) 从根上避免；若选 (a) 必须先改造 `FeishuConsumer` 为单消费者 | 阶段 7 独立发布，可单独回滚 |
| R7 | **自然语言创建的自动化误触发**：订阅条件太宽，事件洪水 | 中 | 高 | 迁移期默认 `mode=review`；配额闸门（`dailyEventLimit` / `perSourceDailyLimit`）继续生效；面板上订阅有独立的配额建议 | 把任务改成 `mode=review` 或暂停 |
| R8 | **卡片回调落不了地**：B2 选错，卡片点了没反应 | 中 | 中 | B2 选 (b) 不动现有 `questions` 表；卡片按钮之外同时提供「回复指令」降级路径 | 去掉卡片按钮，只保留会话面板 |
| R9 | **旧插件全部失效**：B1 选 (b) 时第三方插件装不上 | 低（若选 b） | 高 | 默认选 (a) 适配层 + 弃用告警 | — |
| R10 | **删规则模块时漏删引用点** | 中 | 中 | 阶段 5 一次性删完并跑 `pnpm check`；`tsc` 会抓出所有编译期引用；`grep -rn "events.rules\|EventRule"` 兜底 | git revert |

### 11.2 回滚策略

**三条铁律：**

1. **每个阶段独立可回滚**，不出现「必须一次上完」的阶段；
2. **数据迁移前必备份**（`config.yaml.bak.<ts>` + `state.db` 的 `VACUUM INTO` 备份）；
3. **核心链路切换有开关**：阶段 4 引 `events.subscriptionMode: legacy | v2`（默认 `legacy`），阶段 5 删完规则前先把开关切到 `v2` 跑一周，再删 legacy 代码。

**回滚矩阵：**

| 阶段 | 回滚动作 | 代价 |
|---|---|---|
| 1（目录） | 删新文件 / 关面板入口 | 零 |
| 2（任务模型） | 字段可选，旧任务照跑；不用回滚 | 零 |
| 3（会话） | 配置开关关会话入口，退回弹窗 | 用户多一步操作 |
| 4（订阅链路） | `subscriptionMode: legacy` | 事件不按新模型处理 |
| 5（删规则） | git revert | 需要重新构建 |
| 6（数据迁移） | 换回 `config.yaml.bak`；`state.db` 从备份恢复 | 迁移后新增的自动化任务会丢（可从 `.bak` 里捞） |
| 7（飞书） | 独立发布，单独回滚 | 飞书消息订阅不可用 |

**观测指标（回滚判断依据）：**

| 指标 | 正常范围 | 超标即回滚 |
|---|---|---|
| 事件转人工率 | 与现状持平 | 翻倍 → R1 风险成立 |
| 事件重复处理率 | < 5% | > 20% → R2 |
| 自动化任务创建失败率 | < 10% | > 30% → R5 |
| 事件平均处理延迟 | < 5 分钟 | > 30 分钟 → R7（洪水） |
| `event:decision-failed` 占比 | < 5% | > 20% → 判定链路有问题 |

---

## 12. 附录

### 12.1 关键代码位置速查

| 关注点 | 文件:行 |
|-|-|
| 规则模板与校验 | `src/events/rules.ts:77` |
| 规则编译（自然语言 → 规则草稿） | `src/events/rule-compile.ts:25` |
| 事件入队（规则匹配点） | `src/events/pipeline.ts:86` |
| 事件判定（规则先判、模型兜底） | `src/events/decision.ts:62` |
| 规则判定端口（风险标签护栏） | `src/events/decision.ts:253` |
| 判定提示词（依赖规则问题） | `src/events/decision-model.ts:89` |
| 事件派发（合成 Trigger → 工单） | `src/events/pipeline.ts:344` |
| 事件闸门（时间窗 / 配额） | `src/events/pipeline.ts:462` |
| Worker 授权范围拼装 | `src/events/pipeline.ts:519` |
| Worker 请求正文拼装 | `src/events/pipeline.ts:533` |
| 来源装配 | `src/events/manager.ts:121` |
| 来源轮询 | `src/events/manager.ts:273` |
| GitHub 来源（游标 / 翻页 / 窗口） | `src/events/sources/github.ts:45` |
| 事件源端口（要拆的那个） | `packages/event/src/port.ts:48` |
| 事件插件协议 | `packages/event/src/plugins/types.ts:37` |
| 事件表 schema | `src/store/db.ts:459` |
| 自动化任务模型 | `packages/core/src/automation.ts:28` |
| 自动化调度器 | `src/automation/scheduler.ts:59` |
| 自动化草稿捕获（旧入口） | `src/automation/service.ts:602` |
| 自动化意图预筛 | `src/automation/intent.ts:31` |
| 自动化工具集 | `src/automation/tools.ts:96` |
| 自动化面板 | `src/web/client/automation-panel.tsx:54` |
| 决策规则面板 | `src/web/client/event-rules.tsx:30` |
| GitHub 订阅弹窗 | `src/web/client/github-subscriptions.tsx:93` |
| 收件箱（事件列表） | `src/web/client/events-panel.tsx:73` |
| Pi 会话复用 | `src/router/session-registry.ts:99` |
| 会话持久化（SQLite） | `src/router/session-persistence.ts:8` |
| 卡片回调处理 | `src/service.ts:2211` |
| 卡片动作中立协议 | `packages/channel/src/port.ts:73` |
| 事件开工私聊 + 建话题 | `src/events/kickoff.ts:59` |
| 配置解析（events / automation） | `src/config.ts:1050` / `src/config.ts:953` |
| 配置热更新前缀 | `src/config.ts:1700` |

### 12.2 术语对照

| 术语 | 说明 | 与现状的关系 |
|-|-|-|
| 事件目录（EventCatalog） | 插件声明的「可订阅事件类型 + 连接参数」 | **新增**（从 `EventSource` 拆出） |
| 订阅（Subscription） | 「订阅哪个来源的哪些事件 + 怎么过滤」 | **新增**；替代规则的「订阅 + 判定」双重职责 |
| 自动化任务（AutomationTask） | 订阅 + 执行动作的合体 | 扩展现有 `Automation` |
| 触发器（Trigger） | 任务的触发方式：事件 / 定时 | **新增** |
| 决策规则（EventRule） | 手工配置的判定脚本 | **删除** |
| 事件判定（EventDecision） | 事件要不要处理、多急、归哪个项目 | **保留**，依据从规则换成订阅 |
| 护栏（Guardrail） | 风险标签强制人审 | 提升为全局 |
| 处理方式（EventSkill） | 任务按什么套路执行 | **保留**，从判定产物变成任务属性 |
