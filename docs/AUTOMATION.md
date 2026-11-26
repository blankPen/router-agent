# 自动化：任务、调度与内置工具

自动化是 router-agent 的「订阅什么 + 触发后做什么」的能力：任务定义在 `config.yaml`，调度器跑在服务进程内，执行统一走 Worker runtime。

一条任务有两种触发方式：

| 触发方式 | `trigger.kind` | 触发时机 |
|-|-|-|
| 定时 | `schedule` | 到点跑（`hourly` / `daily` / `weekly` / `cron`） |
| 事件 | `event` | 订阅的事件命中后跑 |

事件触发任务的订阅关系写在任务里（`trigger.source` / `types` / `params` / `filter` / `mode`），事件源插件只声明**有什么可订阅**。原来的「决策规则」模块已整体删除。

## 数据模型

一条任务定义在 `automation.tasks`（与 `events` 同级）：

```yaml
automation:
  enabled: true
  timeoutMs: 600000      # 单次执行硬超时（毫秒）
  maxRetries: 1          # 失败后的重试次数
  tasks:
    - id: auto_weekly_deps
      name: 每周检查依赖更新
      description: 周一把过期的依赖列出来
      type: ai             # ai | script
      prompt: 检查 package.json 里有没有新版本依赖，有就建一张工单
      trigger:
        kind: schedule
        schedule:
          kind: weekly
          weekday: 1         # 0=周日 … 6=周六
          time: 09:00
      runtimeId: ''        # 留空跟随默认 runtime
      project: demo
      repo: /Users/me/code/demo
      branch: main
      enabled: true
      createdBy: ''
      createdAt: 2026-11-18T00:00:00.000Z
      updatedAt: 2026-11-18T00:00:00.000Z
```

- `trigger.kind: event`：事件触发。`source` 是事件目录 id，`types` 是订阅的事件类型，`params` 是这一条订阅自己的连接参数（如仓库），`filter` 是过滤条件（`keywords` 确定性过滤 + `semantic` 语义条件），`mode` 是命中后的处理方式（`auto` 直接开单 / `review` 进收件箱等人批 / `notify` 只记录并提醒）。`skill` 是处理方式（`EVENT_SKILLS` 闭集内的 id），`project` 是归属项目。
- `type: ai`：只需要自然语言提示词。
- `type: script`：`prompt` 是脚本要达成的目标；`script` 是脚本正文，可在面板查看与人工编辑。脚本由面板的「生成脚本」按钮显式生成（`POST /api/automations/script`），生成后写回任务定义并固定下来；定时执行跑的就是这份脚本，不会每次重新生成。**没有脚本就不会执行**——执行前必须先生成并确认。
- `runtimeId`、`project`、`schedule.kind` 都是注册 / 配置驱动：runtime 从运行时注册表按 id 取，项目从 `projects`（或按运行时隔离的项目清单）取，计划从计划注册表取。代码里没有针对单一 runtime、项目或渠道的特例分支。

存储落点：

| 数据 | 位置 | 理由 |
|-|-|-|
| 任务定义 | `config.yaml` 的 `automation.tasks` | 与 `events` 同级；`LIST_PATHS` / `HOT_CONFIG_PREFIXES` 已登记，Web 保存补丁能正确收集并立即生效 |
| 调度状态 | `state.db` 的 `automation_states` | 下次触发 / 上次结果由机器写，不污染用户配置文件 |
| 执行记录 | `state.db` 的 `automation_runs` | 每次执行一条，面板「执行记录」直接读；与现有状态库同实例，不新建数据库 |
| 会话 | `state.db` 的 `automation_conversations` | 自然语言建任务的会话；任务与它一一绑定（`conversationId`），点「恢复会话」能找回原会话 |
| 脚本文件 | `<home>/automations/<任务 id>/automation.sh` | 不写进用户仓库；执行时复制到 runtime 在该项目上创建的 worktree |

## 调度语义

- 调度器内嵌在 router-agent 服务进程内，随服务起停；默认每 30 秒扫一轮。
- `hourly` / `daily` / `weekly` / `cron` 四种计划都在 `packages/core/src/automation-schedule.ts` 注册；cron 只接受五段（分 时 日 月 周），支持列表、范围和步长。
- 服务重启后**不补跑**过期任务：超过到期时间 5 分钟的任务记为 `missed`，落一条执行记录，然后重新计算下一次触发时间。
- 手动触发复用同一条执行管线，记录里 `manual: true`。

## 执行管线

`src/automation/executor.ts` 是执行器注册表，`ai` 与 `script` 共用一条管线：

1. 按任务 `runtimeId` 取 runtime（留空取默认），不存在则记 `automation:executor-missing` / 失败。
2. AI 自动化把任务契约投给 runtime；脚本自动化读取持久化脚本，落盘后把「执行 automation.sh」的契约投给 runtime。
3. runtime 在被选项目上创建 worktree；自动化不自己指定任意工作目录，`ctx.workdir` 传空串。
4. 轮询 `status()`，直到 agent 报出完成信号、runtime 结束、`blocked` 或超时；结束后 `stop()`，避免常驻 worker 占用并发额度。
5. 执行期间新建的工单 / 事件按 `source = automation:<任务 id>` 收集进执行记录。

超时是硬上限（默认 10 分钟），失败按 `maxRetries` 重试；脚本与 AI 自动化使用同一套超时、重试与执行记录。

### 完成信号：`.automation-result` 文件

agent 干完活**不会自己退出**（runtime 会话是常驻的），所以执行必须有一个「干完了」的判据，
否则每次执行都只能干等到超时才收尾。判据是**工作目录下的 `.automation-result` 文件**：

```bash
echo "这次做了什么、发现了什么、有没有产出" > .automation-result
```

- 文件存在 = 执行完成，内容就是这次执行的结果摘要。
- 每轮开始前 runner 会先删掉上一轮的遗留文件，避免上一轮的信号被当成本轮的完成。
- 文件信号与 runtime 版本无关：agent 跑的是用户机器上装的 `ra`，版本未必有对应命令，文件永远在。
- agent 不写这个文件时，本次执行只能等到超时（记 `timeout`）。

执行过程中会持续上报**阶段**（`phase`），写进同一条执行记录：

| 阶段 | 含义 |
|-|-|
| `preparing` | 准备执行环境 |
| `generating-script` | 生成脚本（只在「生成脚本」入口里出现） |
| `starting-runtime` | 启动 runtime 会话 |
| `running` | runtime 正在跑 |
| `collecting` | 收集工单 / 事件产出 |

面板据此显示「跑到哪一步了」，不用猜是卡住了还是已经结束。

服务重启时，上一轮挂在「执行中」的记录会被收尾成 `failed`（`error: interrupted`）：
进程都没了，那一轮不可能还在跑。记录留在执行列表里可见，不会永远挂在「执行中」。

### 脚本自动化的生命周期

```text
新建任务（写「脚本要达成的目标」）
  → 面板点「生成脚本」→ 模型生成脚本正文 → 写回任务定义
  → 人工在「编辑」里看一遍、改一改（可选）→ 保存
  → 到点执行：runtime 在被选项目的 worktree 里跑这份脚本
  → agent 顺手修了跑不起来的脚本 → 改后的正文写回任务定义（下一轮跑修好的那份）
  → 脚本里的产出通过内置工具回到工单 / 收件箱
```

脚本生成与执行是两步：生成是**人机协作**的一步（模型出稿，人确认），执行是**无人值守**的一步（跑固定脚本）。
执行路径里没有「顺手生成一份」——否则定时任务跑的是谁也没确认过的脚本。

脚本生成走独立的一次模型调用，参数与普通对话不同：

- `maxTokens: 8000`：脚本比一句话长得多，默认 2000 不够写。
- `thinkingBudgetTokens: 1024`：推理模型（`group/never-stuck` 等）会先把输出额度花在思考上，不设预算就可能一个字都吐不出来（表现为 `chat:empty-response`）。
- `timeoutMs: 180000`：推理模型写脚本常常要一分多钟，默认 60s 会超时。
- 结果去掉 markdown 代码围栏；空正文视为生成失败并写日志 `automation:script-generate-failed`。

## 内置工具协议

工具在 `src/automation/tools.ts` 一次性定义，AI 与脚本两条管线共用同一个注册表。每个工具都有：

```ts
interface AutomationTool {
  name: string
  description: string
  parameters: Record<string, unknown>   // JSON Schema 子集
  mutates: boolean
  handler(args, scope): Promise<unknown> | unknown
}
```

`scope` 是任务所属项目（`automationId` / `project` / `repo` / `branch`），handler 必须据此限定可访问的数据。越界返回 `scope:denied`。

| 工具 | 作用 | 写操作 |
|-|-|-|
| `automation_list_tickets` | 查询本项目范围内的工单，可按阶段 / 关键字过滤 | 否 |
| `automation_get_ticket` | 按工单 ID 读详情与最近进展；范围外拒绝 | 否 |
| `automation_create_ticket` | 在本项目下创建工单，走现有 Engine 链路 | 是 |
| `automation_list_events` | 查询项目范围内的收件箱事件 | 否 |
| `automation_create_event` | 往收件箱写事件，交给现有判定链路 | 是 |

调用方式（runtime 里的 agent 在工作目录里执行）：

```bash
ra automation tool --id <任务 id> --name <工具名> --args '<JSON 入参>'
```

契约里除了工具名与说明，还会带上每个工具的**入参 schema**（参数名、类型、是否必填）。
没有它，模型只能靠猜参数名，猜错的代价是一次 `missing-<参数>` 拒绝——
表现就是同一个工具反复调、却始终拿不到结果。

鉴权与限流：

- 工具只按任务绑定的项目范围操作；`project` / `repo` 来自任务定义，不由调用方传入。
- 同一任务每分钟最多 30 次工具调用，超限返回 `rate:limited`。
- 凭据不进入任务定义、契约或脚本正文；需要凭据的动作由 handler 内部复用现有配置。
- HTTP 入口 `POST /api/automations/tools` 与 CLI 走同一层服务校验，未知任务 / 工具返回 404，工具拒绝返回 400。

## 会话建任务（自然语言）

新建自动化**不再有填表弹窗** —— 只有一个入口：用一句话说清要订阅什么、命中后做什么。

会话状态机：

```text
idle → parsing → clarifying（缺项回问，一次一项） → previewing（出参数预览卡） → confirmed（落库）
```

- **闭集校验**：来源、事件类型、项目、处理方式都必须落在目录 / 清单里，选不中就回问，绝不编造。目录里没有的事件类型会被**明确拒掉**并列出目录里实际有什么。
- **一次只问一项**：缺什么问什么，不一口气列一堆必填。
- **参数齐了才出预览卡**：卡片摊开触发方式、连接参数、过滤条件、处理方式、归属项目、运行时；**没点「确认创建」就不落库**。
- **参数探活**：格式对但资源不存在（如「订阅不存在的仓库 xxx/yyy」）会被拦下，不建任务。
- **同会话可迭代**：建完后说「关键词加上退款」「改成只提醒我」，改的是**同一条任务**，不新建。任务卡的「恢复会话」回到原会话，历史完整。

**流式**：助手逐字吐字（SSE），不是等几秒蹦一整段。断线后按 `seq` 补齐遗漏的增量。

会话相关事件：`automation:session-created` / `session-step` / `session-rejected` / `task-created` / `task-updated`。

## 从决策规则迁移

旧的「决策规则」模块已删除，旧配置里的 `events.rules` 会被忽略。迁移用独立命令：

```bash
ra migrate event-rules --dry-run     # 只读报告：能迁几条、哪些要人工处理
ra migrate event-rules --apply --yes # 真正写入 automation.tasks
ra migrate event-rules --verify      # 核对迁移结果
```

- 默认只读；`--apply` 必须配 `--yes`。
- 写入前自动备份 `config.yaml.bak.<ts>`；**旧规则段原样保留**，方便回滚。
- 重复执行幂等：不会重复建任务。
- 迁不了的（来源前缀不认识、`*` 通配、项目多候选）列进人工清单，不硬迁。

## Web 面板

- 左侧菜单：初始化 → 收件箱 → **自动化** → 工单 → 配置 → 来源 → 日志。自动化紧跟收件箱，因为两者都是「外部输入 → Router 处理」；同时保持在工单上方。
- 页面两个 Tab：「自动化任务」（会话新建 / 停用 / 删除 / 生成脚本 / 手动执行一次 / 恢复会话）与「执行记录」（状态、阶段、耗时、结果、产出、日志入口）。
- 任务卡展示处理模式标签、订阅的事件类型、过滤条件，并带「恢复会话」入口。
- 手动触发是**异步**的：接口立即返回一条 `running` 记录，面板按 3 秒轮询（有任务在跑时）刷新阶段；执行记录每行带「查看日志」深链，跳到日志页并按任务 id 过滤。
- 事件源**目录**在「配置 → 事件总线」里只读展示：列出每个来源可订阅的事件类型与可用性标注，并显示「被 N 个任务订阅」；**没有「勾选事件类型」的多选框**。

## 排查：脚本生成失败

面板点「生成脚本」失败时，报错里带的就是真实原因，不用猜：

| 报错 | 含义 | 怎么办 |
|-|-|-|
| `chat:empty-response:max_tokens` | 推理模型把输出额度全花在思考上，正文一个字没吐出来 | 已在 `src/automation/service.ts` 用 `maxTokens: 8000` + 思考预算 `1024` 兜住；若仍出现，多半是模型网关忽略了思考参数，换 `llm.model` |
| `chat:timeout(180000ms)` | 写脚本比默认 60s 慢 | 已放宽到 180s；仍超时说明网关侧卡住，先用面板「日志」页看同一时间段的 `chat:*` 事件 |
| `chat:http-4xx` / `chat:http-5xx` | 模型地址、密钥或额度有问题 | 按状态码查 `llm.baseUrl` / `llm.apiKey` / 网关额度 |
| `模型只返回了思考，没有脚本正文` | 模型返回了空正文 | 换模型，或把任务描述写具体一点 |

执行链路上的日志都带 `runId`：用 `ra logs` 过滤 `automationId`，再用 `runId` 就能把一次执行的
`execute-start` → `run-phase` → `runtime-finished` / `runtime-failed` → `run-finished` 串成一条线。

## 扩展位

- 新自动化类型：实现 `AutomationExecutor` 并注册到 `createAutomationExecutors`，核心调度流程不变。
- 新触发计划：实现 `AutomationScheduleSpec` 并调用 `registerSchedule`。
- 新工具：在 `buildTools` 里加一条定义；AI 与脚本自动化自动同时获得。

## 日志

新增事件见 [OPERATIONS.md](OPERATIONS.md) 的自动化事件段。执行链路的关键事件：`automation:scheduler-started` / `execute-start` / `runtime-started` / `script-staged` / `run-finished` / `runtime-failed` / `missed`。
