# router-agent 事件流程方案设计（v2）

> 本版基于《事件流程方案设计》（[wiki](https://poizon.feishu.cn/wiki/PA1vwg4fMi779nkbzGocpJlHnZf)）重做：保留你定的「两条流程 / 订阅插件 / 卡片式配置 / 四类事件状态 / P0–P4 四象限」，**重点补齐「事件进来之后，Router 怎么分派、分给谁、怎么收口」**。
> 飞书 channel 流程保持现状不动；本轮只出设计，不写实现代码。

---

## 0. 本版说明

| 你的设计 | 本版处理 |
| --- | --- |
| 信息来源分两类：飞书 channel（不动）+ 事件管线（新增） | 完全采纳，作为第 1 章的双轨结构；两条轨在「派工 → Worker → 回报」汇合 |
| 事件订阅需要可扩展插件系统，像 runtime 一样支持 npm 三方包，Web 有「添加自定义插件」 | 采纳，补齐插件接口、配置形态、安装流程（第 2 章） |
| 三个订阅器：github（轮询或订阅）、feishu（本期空壳）、http（暴露接口） | 采纳，补齐 HTTP 接口契约与幂等/验签/限流（第 2 章） |
| 订阅界面用卡片展示，点设置弹窗配置 | 采纳，补齐卡片信息与弹窗字段（第 2.4、图 7） |
| 事件队列四类：无效 / 待处理 / 已处理完成 / 待审核 | 采纳为主状态；额外补三个执行态（延后 / 重试 / 失败）作为「待处理」的子状态，不打乱你的分类（第 3 章） |
| 优先级 P0–P4，按重要紧急四象限，由 Jev 一次判定 | 采纳；四象限映射 + P4 专门留给噪声，并补「规则先判、模型兜底」以省 token（第 3.2、第 5 章） |
| **事件分派：点对点固定 worker vs 统一澄清再执行** | 这一条留给我设计，结论与依据在第 4 章（含两种方案的对比表与取舍） |

与上一版的关系：上一版（[多来源事件总线（Event Bus）设计方案](https://poizon.feishu.cn/docx/DYkJdcKGQoyK2JxJJxecutqIn3f)）里的队列、面板、成本章节仍然有效，但分派部分表述太粗，本版按你的架构重写。

---

## 1. 总体架构：两条流程

### 1.1 轨道 A：飞书 channel（保持现状，一行代码不改）

用户主动触发、Root Agent 被动接收指令，链路成熟，本方案不动它：

```text
飞书消息 → Trigger（幂等入库）→ 准入 gate/admission → intake 需求分析与澄清
  → 管理员终审 → Engine.decide() 开单（Ticket + Mandate）→ launch() 派工
  → Worker 执行 → 回报 → outbox 回消息到群
```

### 1.2 轨道 B：事件管线（本轮新增）

外部事件主动推入、Root Agent 自动处理，**无对话**：

```text
订阅器接入 → 归一 + 去重 → 事件队列 → Jev 判定一次（优先级/分类/是否需人审）
  → 剧本路由（选处理路径与目标运行时）→ 澄清/计划（Plan）
  → 开单（Ticket + Mandate）→ launch() 派工 → Worker 执行
  → 回写事件状态与结论（Issue 评论 / webhook 回调 / 飞书卡片）
```

![两条流程：被动交互 vs 主动处理](@./docs/design/figures/fig-tracks.png)

### 1.3 事件管线全景

![事件管线全景](@./docs/design/figures/fig-pipe.png)

从订阅到回写一共七段：订阅 → 归一 → 判定 → 路由 → 澄清/计划 → 开单执行 → 回写。其中「归一 / 判定 / 开单执行 / 回写」复用现有能力，新增的是「订阅、路由、澄清计划」三段。

### 1.4 两条轨的关系

| 维度 | 轨道 A（channel） | 轨道 B（事件管线） |
| --- | --- | --- |
| 触发方 | 用户 | 外部系统 |
| Root Agent 姿态 | 被动接收指令 | 主动接收信息、自动处理 |
| 有无对话 | 有（可澄清、可追问） | 无（只能自动澄清或转人工） |
| 优先级 | 即时（当前就是同步串行处理） | P0–P4，排队 + 窗口 |
| 产物 | 群内回复 + 工单 | 事件结论 + 工单 + 回写来源 |
| 执行 | 同一个 Worker 体系 | 同一个 Worker 体系 |

**汇合点只有一个：派工。** 事件管线最终也变成一张 Ticket（带 Mandate 授权范围、repo、branch），走现有 `Engine.decide()` → `launch()`，因此 Worker、worktree、回报、PR 跟踪、清理全部复用，不需要为事件再造一套执行链路。

### 1.5 事件没有聊天上下文，这是必须先解决的前置问题

现有模型里每条消息都带 `chatId` / `threadId` / `actorId`，回复靠它回到来源。事件没有这些，所以事件管线必须自带三件事：

1. **虚拟线程**：事件落库时生成一个合成会话（如 `chatId = event:github:blankPen/router-agent`），这样现有的线程、订阅扇出、附件、输入投递机制都能直接用。
2. **发起人**：事件没有自然人发起人，用「系统」+ 来源标识（`actorType = system`），日志里可区分「用户消息」与「系统事件」。
3. **回写通道**：结论必须回到来源，否则人不知道发生了什么。订阅器要声明 `reply` 能力（Issue 评论 / webhook 回调 / 飞书群通知 / 只落库不回写）。

---

## 2. 事件订阅系统

### 2.1 插件体系（对齐 runtime 插件机制）

沿用 `packages/runtime/src/plugins` 的做法：插件包声明 `meta`，宿主加载后拿到的不是「一份配置」，而是「一段可渲染的选项 schema」，面板据此生成表单。

```text
packages/event-source          事件源插件包（宿主只依赖接口）
  src/plugins/types.ts         EventSourcePlugin / EventSource / EventSourceContext
  src/plugins/loader.ts        按配置加载插件、注册订阅器、失败不阻塞其它插件
packages/event-source-github   内置：github 订阅器
packages/event-source-http     内置：http 订阅器
packages/event-source-feishu   内置：feishu 订阅器（本期空壳占位）
```

插件接口（草案）：

```ts
export interface EventSourcePlugin {
  kind: 'event-source'
  meta?: {
    id: string
    name: string
    hint: string
    /** 面板据此渲染配置表单；没有就退化成通用键值表单。 */
    options?: EventSourceOptionSpec[]
    default?: boolean
  }
  create(ctx: EventSourceContext): EventSource | null
}

export interface EventSource {
  readonly id: string
  readonly mode: 'push' | 'pull' | 'schedule'
  /** push：外部把原始事件交给宿主；pull：宿主定时调它拉；schedule：宿主按时钟调它。 */
  start?(sink: (raw: unknown) => void): void
  stop?(): void
  poll?(cursor: string | null): PollResult
  /** 把外部原始载荷归一化成统一事件信封；不认识就返回 null。 */
  normalize(raw: unknown): EventEnvelope | null
  /** 结论怎么回写来源：issue-comment / webhook-callback / feishu-card / none。 */
  readonly reply: string
}
```

配置形态（与 `runtime.plugins` 同构）：

```yaml
event:
  plugins:
    github: '@router-agent/event-source-github'
    http: '@router-agent/event-source-http'
    feishu: '@router-agent/event-source-feishu'
  sources:
    github:
      enabled: true
      mode: poll            # poll | subscribe
      repos: [blankPen/router-agent]
      intervalSeconds: 300
      events: [issues, issue_comment, pull_request, workflow_run]
      labels: [bug, needs-triage]
    http:
      enabled: true
      path: /api/events
      secretRef: RA_EVENT_SECRET
      rateLimitPerMinute: 60
```

### 2.2 三个内置订阅器

**① github**
- 两种接法：**轮询**（`gh api` / REST 拉取，带 `updated_at` 游标）与**订阅**（GitHub App webhook 推到 HTTP 接口）。轮询实现成本低、先上；订阅留给二期。
- 监听对象：issue 新建/评论、PR 状态、workflow_run（CI）结果。
- 归一化：标题 + 正文（截断到 2000 字）+ labels + 作者 + 仓库 + 链接。
- 去重：同一 Issue 的多次评论合并为一条事件，后续评论作为工单输入投递（不重复开单）。

**② feishu（本期空壳占位）**
- 插件在、界面在、能配置，但不订阅任何内容。本期只留接口与状态位，避免二期再动插件契约。

**③ http（对外注入）**
- 宿主 API 挂 `POST /api/events`，供外部系统注入事件。

接口契约草案：

| 项 | 约定 |
| --- | --- |
| 鉴权 | `X-RA-Signature: HMAC-SHA256(body, secret)` + `X-RA-Timestamp`（防重放窗口 5 分钟） |
| 幂等 | 请求头 `X-Event-Id` 优先；没有则用 body 的 SHA-256；重复直接返回 200 且不重复入队 |
| 限流 | 按来源 IP + secret 双维度，超限返回 429 |
| 体积 | body ≤ 256KB；正文超长在归一化时截断 |
| 字段 | `{ type, title, body, labels, url, repo, actor, occurredAt, priorityHint, context }` |
| 拒绝 | 验签失败 / 超限 / 字段缺失 → 4xx 且**不入队**，记 `event:rejected` |

### 2.3 Web 界面：订阅卡片 + 设置弹窗 + 添加自定义插件

![Web 界面：订阅卡片与事件队列](@./docs/design/figures/fig-ui.png)

- **订阅页**：每个订阅器一张卡片，显示名称、启用状态、关键配置摘要（仓库数、轮询间隔、监听事件、限流），右上角一个「设置」按钮。
- **设置弹窗**：表单由插件的 `options` schema 生成（沿用 runtime 的 `optionSpecs` 机制），插件自己定义字段与校验；宿主不假设任何插件的配置形状。
- **添加自定义插件**：输入 npm 包名 → 宿主安装并加载 → 读取插件 `meta` → 生成卡片与配置表单；加载失败只标记该插件不可用，不影响其它订阅器（与 runtime 插件的失败策略一致）。
- **操作**：启用/暂停、立即拉取一次（poll 模式便于验证）、查看最近事件与错误。

---

## 3. 事件队列

### 3.1 四类业务状态 + 三个执行态

![事件队列状态](@./docs/design/figures/fig-queue.png)

| 你的分类 | 含义 | 进入条件 | 出口 |
| --- | --- | --- | --- |
| **无效事件** | 噪声、与项目无关、重复 | 规则判定 或 Jev 判定为不重要 | 归档保留（可回溯为什么没处理），不再出现 |
| **待处理** | 判定该做，等待执行 | 判定通过且有对应剧本 | 出队 → 澄清/计划 → 派工 → 已处理完成 |
| **待审核** | 需人介入 | 信息不足 / 命中风险清单 / 人工驳回 | 批准 → 回到待处理；驳回 → 无效事件 |
| **已处理完成** | Worker 已执行并回报 | Worker 回报 | 回写来源 + 关联工单/PR + 成本记账 |

补充的三个**执行态**（都挂在「待处理」下面，不改变你的四分类）：
- **延后**：窗口外或预算超限，记住 `notBefore`，到点自动继续。
- **重试中**：处理异常（模型失败、派工失败），指数退避，超过上限转「待审核」而不是丢弃。
- **失败**：连续失败且已转人工，等人处理。

### 3.2 优先级 P0–P4：四象限 + 噪声

![优先级四象限](@./docs/design/figures/fig-priority.png)

| 级别 | 象限 | 含义 | 执行策略 |
| --- | --- | --- | --- |
| **P0** | 重要且紧急 | 生产阻塞、线上告警、用户明确催办 | 立刻执行，可插队，全天窗口，不受预算限制 |
| **P1** | 重要不紧急 | 明确要做但不急（feature、常规 bug） | 排期执行，低峰批量处理，必须做 |
| **P2** | 紧急不重要 | 快速但价值低（格式、重复小修） | 低优运行时 + 合并执行，低峰跑 |
| **P3** | 不重要不紧急 | 可做可不做（信息同步、归档） | 只记录，不自动执行，面板可见 |
| **P4** | 明确无效 / 噪声 | 灌水、与项目无关、重复投递 | 直接忽略，仅留审计记录 |

为什么多 P4：四象限能表达「要不要做」，但表达不了「明确是噪声」。把噪声单列一档后，P3 与 P4 都不占执行预算，面板与日志仍能回答「为什么这条没被处理」。

**优先级怎么定**：Jev 一次判定输出四象限（重要 / 紧急各 0~1），再按象限映射到 P0–P4；但**规则能定案的不调模型**（见第 5 章）。

### 3.3 出队顺序与并发

- 排序：`priority ASC → notBefore ASC → enqueuedAt ASC`。
- P0 插队：直接置顶，不与其它事件竞争。
- 同一来源同类型事件可合并成一批（一次判定、多条执行），是省 token 的主要手段之一。
- 并发：按优先级限制并发数（P0 不限，P1/P2 各自上限），避免事件把机器打满。

---

## 4. 重点：事件进来之后，Router 怎么分派

### 4.1 先回答你提的两个方案

你的两个想法是：

- **A. 每类事件一套固定 worker 流程**（点对点定制）
- **B. 所有事件都先需求分析 / 澄清，产出明确执行方案，再交给一个统一 worker 执行**

我的结论是：**B 是骨架，A 是特例**。两者不冲突，但要有明确的落地方式，否则会变成两套代码。

| 维度 | 方案 A：每类事件一套固定流程 | 方案 B：所有事件统一澄清再执行 |
| --- | --- | --- |
| 优点 | SOP 固定、可预测、省 token、不做无用澄清 | 通用，任何事件都能兜住；执行前一定有方案 |
| 缺点 | 事件类型不可穷举，新类型就要新写一套；维护成本随类型线性增长 | 对简单事件是浪费（Issue 已说清还要再澄清一轮）；多花 token 与时延 |
| 适合 | 已注册的高频类型（issue bug、CI 失败、定时巡检） | 未注册的未知事件、低频长尾事件 |
| 我的取舍 | 作为**可注册的配置**，不写死在代码里 | 作为**默认兜底**，任何事件都先落到它 |

关键设计：**A 不做成「新的 Worker 类型」，而做成 B 的一个具名剧本（Playbook）**。剧本只是「这类事件该怎么处理」的一份声明式配置——判定问题、澄清策略、计划模板、目标运行时、工具范围、审核门、预算。执行仍然交给现有 Worker（Orca / Codex / Claude Code）。

这样只有一个澄清/计划/执行的代码路径，特例通过配置走快路径，不会两套逻辑漂移；新增一种事件类型也不用发版，写一份剧本配置即可。

### 4.2 分派链路

![分派设计：事件分给谁、依据什么、怎么收口](@./docs/design/figures/fig-dispatch.png)

七步，回答三个问题：

| 问题 | 答案 | 对应步骤 |
| --- | --- | --- |
| **依据什么分？** | 事件类型 + 标签 + 来源 + 仓库 + 剧本匹配打分 | ① 匹配剧本 |
| **分给谁？** | 剧本声明的能力标签 → 现有运行时；再由剧本定工具范围与授权 | ③ 选目标 Worker |
| **怎么收口？** | 生成任务包 → 开单（Ticket + Mandate）→ 复用 `launch()` 派工 → 回报回写事件 | ④⑤ |

### 4.3 剧本 Playbook：声明式定义

![剧本定义](@./docs/design/figures/fig-playbook.png)

```yaml
# ~/.router-agent/playbooks/github-bug-triage.yaml
id: github-bug-triage
match:
  sourceType: github-issue
  labels: [bug]
  repos: ['*']          # 支持通配
clarify: skip            # skip | auto | human
plan:
  template: bug-triage
  required: [repro, rootCause, fixPlan, verify]
runtime:
  capability: [code-read, code-write]
  fallback: codex
toolScope: repo-write    # 复用 packages/core/src/tool-scope.ts 的边界
review:
  when: 'labels ∋ security'
  notify: [admin-card]
budget:
  maxTokens: 60000
  window: offPeak        # highPeak | offPeak | any
notify:
  reply: issue-comment
```

剧本字段一览：

| 字段 | 含义 | 例子 |
| --- | --- | --- |
| `match` | 命中条件：来源类型 / 事件类型 / 标签 / 仓库 | `sourceType=github-issue ∧ labels∋bug` |
| `clarify` | 澄清策略：`skip` / `auto` / `human` | 特化剧本 `skip`；通用剧本 `auto→human` |
| `plan` | 计划产物模板与必填项 | 「复现路径 / 根因 / 修复步骤 / 验证方式」 |
| `runtime` | 目标运行时或能力标签 | `capability: code-read, code-write` |
| `toolScope` | 工具与权限边界 | 只读 / 可写代码仓 / 禁生产操作 |
| `review` | 审核门：强制 / 条件触发 / 不需要 | `when: labels∋security` |
| `budget` | 单事件 token / 时长上限与窗口 | `maxTokens: 60k, window: offPeak` |
| `notify` | 回写方式与通知对象 | `reply: issue-comment` |

### 4.4 剧本匹配算法

按顺序匹配，命中即用（先具体后通用，避免特化剧本被通用剧本抢走）：

```text
1. 精确匹配：sourceType + eventType 全等          → 特化剧本
2. 标签匹配：labels 命中剧本声明的标签集合          → 特化剧本
3. 来源默认：sourceType 自带的默认剧本              → 特化剧本
4. 兜底：generic-intake（通用剧本）                 → 任何事件都有出路
5. 兜底的兜底：human-gate（缺关键信息 / 高风险）     → 直接进待审核
```

补充规则：

- 剧本可以声明 `priorityCap`：例如「运营群来源最高只能到 P1」，防止模型把一条闲聊抬成 P0。
- 剧本优先级：显式配置 > 内置默认 > 通用兜底；同层级按配置顺序。
- 匹配结果要落库（`event.playbook`），面板上能看到「这条为什么走了这个剧本」。

### 4.5 无交互场景下的「澄清」怎么做

事件没有对话，不能像 channel 那样多轮追问。这里用**三档澄清**，而不是「一直挂着等人」：

| 档 | 条件 | 做法 | 产出 |
| --- | --- | --- | --- |
| **自动澄清** | 事件上下文足够（标题、正文、标签、仓库、作者、链接） | 从上下文直接补齐项目、分支、复现信息、影响范围 | 完整 Plan，直接执行 |
| **带假设执行** | 信息不全但可假设（只有仓库没有分支等） | Plan 里写明假设与影响范围，回报中同时给出假设，便于复核 | 带假设的 Plan，执行并标注 |
| **转人工** | 缺关键项（定位不到项目）或命中风险清单（安全 / 生产 / 付费 / 对外发布） | 不执行，进待审核队列 + 飞书卡片通知 admin | 待审核项，等人拍板 |

关键区别：**转人工是「排队等人」，不是「阻塞等人对话」**。事件不会因为没人回复就卡死，它在待审核列表里可见、可批量处理、可以被 admin 一次批准多。

### 4.6 目标 Worker 怎么选

不新增 Worker 类型。剧本声明**能力标签**，宿主按标签从现有运行时里选：

| 能力标签 | 需要的工具 | 典型运行时 |
| --- | --- | --- |
| `code-read` | 只读代码、日志 | 轻量运行时（Claude Code / Codex 只读模式） |
| `code-write` | 改代码、跑测试 | Codex / Claude Code（可写 worktree） |
| `repo-ops` | git 分支、PR | Orca（worktree + PR） |
| `ops-read` | 只读线上状态、监控 | 轻量运行时 + 只读工具 |

选择顺序：**剧本指定 → 事件上下文能推导（如事件来自某仓库，就用该仓库绑定的运行时）→ 默认运行时**。

仍然复用现有派工机制：`Engine.decide()` 生成 Ticket + Mandate（授权范围写在 mandate.scope 里），`launch()` 按 runtimeId 起 worktree、注入任务简报。事件与 channel 的差别只在于**任务包的来源**：channel 传的是用户原话，事件传的是**剧本 + Plan**。

### 4.7 任务包（分派协议）

派给 Worker 的东西要能自解释，尤其是没有对话上下文时：

```json
{
  "eventId": "evt_01H...",
  "eventType": "github-issue",
  "source": { "type": "github", "repo": "blankPen/router-agent", "url": "https://github.com/.../issues/318" },
  "playbook": { "id": "github-bug-triage", "version": 1 },
  "plan": {
    "summary": "登录态偶发丢失，需定位并修复",
    "assumptions": ["复现路径基于用户描述，未本地验证"],
    "steps": ["定位会话失效点", "补回归用例", "提交 PR"],
    "verify": "跑 e2e 登录用例"
  },
  "scope": "定位并修复登录态偶发丢失问题；不改其它模块，不触碰生产配置",
  "repo": "blankPen/router-agent",
  "branch": "main",
  "replyTo": "issue-comment"
}
```

约束：

- `scope` 就是 Mandate 的授权范围，沿用现有「授权范围用研判结论而不是标题」的口径。
- `plan.assumptions` 必须存在（哪怕为空数组），让 Worker 知道哪些是推断。
- 任务包与 Worker 简报（`buildWorkerBrief`）结构对齐，避免两套模板。

### 4.8 回写与审计

事件与工单双向关联，回写内容固定：

```text
事件 evt_x
 ├─ 判定：优先级 P1 / 剧本 github-bug-triage / 依据「labels∋bug」
 ├─ 计划：自动澄清（置信度 0.82）
 ├─ 工单：tk-91（stage=running，runtime=codex）
 ├─ 产出：PR #318 / 结论摘要
 └─ 回写：issue-comment（已在 Issue 下留言）
```

面板与日志都能用 `eventId` 还原全链路；工单页也能反向看到「这张单是从哪个事件来的」。

---

## 5. 判定层：规则先判，Jev 兜底

事件量大、重复多，**不能每个事件都调模型**。

| 层 | 做什么 | 例子 | 是否花 token |
| --- | --- | --- | --- |
| 规则层（确定性） | 形态与身份判断、直接定案 | 重复投递合并、机器人/噪声丢弃、label → 优先级基线、来源配额、已有在办工单 → 转工单输入 | 否 |
| Jev 决策模型（一次判定） | 只回答四件事 | 重要度、紧急度（→ 四象限 → P0–P4）、事件类型、是否需要人审 | 是，但只调一次 |

Jev 的输出契约：

```ts
export interface EventVerdict {
  eventId: string
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4'
  important: number      // 0~1
  urgent: number         // 0~1
  type: string           // bug / feature / question / chore / info
  needsHuman: boolean
  reason: string
  confidence: number
  degraded: boolean      // 模型失败走降级
}
```

降级策略（模型超时/失败）：保守降级为 P3 + 进待审核，**不丢事件**，并记 `event:degraded`（warn）。

---

## 6. 成本控制与时间窗口

![成本与时间窗口](@./docs/design/figures/fig-cost.png)

- **窗口**：高峰 09:00–20:00 只执行 P0/P1；P2 只判定不执行；P3/P4 不跑。低峰 20:00–09:00 批量跑 P2/P3，同类事件合并成一次判定。
- **三档预算**：单事件上限（防长 Issue 烧光额度）、来源日配额（防 webhook 风暴 / issue 洪水）、全局日配额（总兜底）。超限一律**延后**，不丢弃。
- **剧本级预算**：`budget.maxTokens` 与 `budget.window` 让「某类事件只在低峰跑」成为配置而不是硬编码。
- **省 token 的大头**：规则先判、模型兜底；通用剧本用小模型 + 短 prompt；特化剧本的问题模板固定且短。

---

## 7. 数据模型（草案）

```sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,      -- github-issue / http / schedule / feishu
  source_id TEXT NOT NULL,        -- 哪个订阅器实例
  event_type TEXT NOT NULL,       -- issues.opened / ci.failed / custom
  external_id TEXT NOT NULL,      -- 来源侧 ID，幂等
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  context TEXT,                   -- 仓库、链接、作者等
  priority TEXT NOT NULL,         -- P0..P4
  priority_reason TEXT NOT NULL,
  verdict TEXT,                   -- Jev 判定 JSON
  playbook_id TEXT,               -- 命中的剧本
  classify TEXT NOT NULL,         -- invalid / pending / review / done
  exec_state TEXT,                -- 延后 / 重试 / 失败（待处理的子状态）
  plan TEXT,                      -- Plan JSON
  assumptions TEXT,
  ticket_id TEXT,
  review_id TEXT,
  reply_mode TEXT,                -- issue-comment / webhook-callback / none
  estimated_tokens INTEGER,
  actual_tokens INTEGER,
  received_at TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  evaluated_at TEXT,
  not_before TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  trace TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_queue ON events (classify, priority, not_before, enqueued_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe ON events (dedupe_key);

CREATE TABLE IF NOT EXISTS event_reviews (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggestion TEXT,
  status TEXT NOT NULL,           -- open / approved / rejected
  notified_at TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_cursors (
  source_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

剧本本身不入库，放配置文件（`~/.router-agent/playbooks/*.yaml`），与 runtime 插件的配置思路一致：改剧本不用迁移数据。

---

## 8. 日志与可观测

新增事件（同步进 `docs/OPERATIONS.md`）：

| 事件 | 级别 | 关键字段 | 含义 |
| --- | --- | --- | --- |
| `event:ingested` | info | `eventId` `sourceType` `priority` `trace` | 事件入队 |
| `event:duplicate` | info | `eventId` `dedupeKey` | 重复投递被合并 |
| `event:verdict` | info | `eventId` `priority` `type` `needsHuman` | Jev 判定完成 |
| `event:routed` | info | `eventId` `playbookId` `runtime` | 剧本匹配完成（分派结论） |
| `event:deferred` | info | `eventId` `notBefore` `reason` | 窗口外 / 预算超限 |
| `event:dispatched` | action | `eventId` `ticketId` | 已开单派工 |
| `event:review-queued` | action | `eventId` `reviewId` | 进入待审核 |
| `event:notified` | action | `eventId` `channel` | 通知已发出 |
| `event:done` | action | `eventId` `ticketId` `actualTokens` | 事件处理完成 |
| `event:degraded` | warn | `eventId` `reason` | 判定降级 |
| `event:source-error` | warn | `sourceType` `message` | 订阅器故障（拉取失败、验签失败） |
| `event:rejected` | warn | `sourceType` `reason` | 外部注入被拒（不入队） |

每个事件至少带 `eventId` + `trace`；派发类带 `ticketId`；审核类带 `reviewId`；订阅器故障带 `sourceType`。

---

## 9. 落地路线

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| **一期：事件骨架** | `packages/event-source` 插件机制 + github(poll) / http 订阅器 + 事件表 + 判定（规则 + Jev 一次）+ 队列面板只读 | GitHub Issue 能入队并在面板看到判定结论；http 接口能注入一条事件并完成一次派工 |
| **二期：分派与剧本** | 剧本注册表与匹配、通用剧本（澄清三档）、特化剧本示例、任务包、事件回写 | 不同事件类型自动走不同剧本；带假设执行有标注；结论能回写到 Issue |
| **三期：审核与界面** | 待审核列表 + 飞书卡片通知 + 面板可操作、订阅卡片与设置弹窗、自定义插件安装 | admin 能从卡片或面板完成批准/驳回；能安装一个第三方事件源 npm 包 |
| **四期：成本与窗口** | 时间窗口、三档预算、降级阶梯、成本统计、批量判定 | 高峰只跑 P0/P1；预算超限自动延后且不丢事件；面板能看到今日成本 |

每期都遵循「先红绿测试再实现」。测试重点：订阅器归一化与幂等、剧本匹配顺序、澄清三档分支、P0 插队、预算超限延后、审核动作回写、任务包字段完整性。

---

## 10. 风险与取舍

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **无交互澄清质量不够** | 事件带着错误假设去改代码 | 澄清三档 + 假设必须标注 + 关键项缺失一律转人工；特化剧本用固定 SOP 补足 |
| **剧本写歪了** | 事件走错处理方式 | 剧本是配置不是代码，改配置即生效；匹配结果落库可回溯；面板显示命中依据 |
| **事件洪水**（webhook 风暴 / issue 批量） | 队列膨胀、token 超支 | 来源配额 + 合并去重 + 全局预算 + 延后 + 剧本级限流 |
| **外部内容注入** | Issue 正文里的指令被执行 | 外部正文只当数据传入；工具范围与 `toolScope` 是硬边界；模型只能定级不能定动作 |
| **与 channel 流程重复处理** | 同件事被做两遍 | 事件与 channel 走不同来源类型与队列；同一 `dedupeKey` 全局唯一 |
| **事件没有回写通道** | 做完没人知道 | 订阅器必须声明 `reply` 能力；无回写能力的事件只落库并在面板可见（不假装做完） |
| **HTTP 接口暴露** | 被灌事件 | 验签 + 防重放 + 限流 + 体积上限；失败一律不入队并记日志 |

**取舍说明**：本方案刻意**不**引入 Kafka / Redis / 工作流引擎。单机部署、事件量在百级/天，SQLite 队列 + 定时器足够；引入外部中间件会把部署门槛从「一个命令」拉高到「一套运维」。

---

## 附录：可视化与仓库文件

- 可视化 HTML（单文件，双击即开，无外部依赖）：`docs/design/event-flow.html`
- 样式：`docs/design/event-flow.css`
- 本设计稿 Markdown：`docs/design/event-flow-v2.md`
- 配图（本文插图由上面的 HTML 渲染导出）：`docs/design/figures/*.png`
- 分支：`ra/tk-87-设计多来源事件总线方案并输出飞书文档-2`（仓库 `blankPen/router-agent`）
- 上一版（v1，含更细的队列/面板/成本论证）：https://poizon.feishu.cn/docx/DYkJdcKGQoyK2JxJJxecutqIn3f
