# 自动化：任务、调度与内置工具

自动化是 router-agent 的定时执行能力：任务定义在 `config.yaml`，调度器跑在服务进程内，执行统一走 Worker runtime。它不替换现有事件判定 / 建单 / 通知链路，npm 包扩展的事件来源仍然可用。

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

- `type: ai`：只需要自然语言提示词。
- `type: script`：`prompt` 是脚本要达成的目标；`script` 是 AI 生成并持久化的脚本正文，可在面板查看与人工编辑。面板留空时首次执行生成一次，之后一直执行这份落盘脚本，不会每次重新生成。
- `runtimeId`、`project`、`schedule.kind` 都是注册 / 配置驱动：runtime 从运行时注册表按 id 取，项目从 `projects`（或按运行时隔离的项目清单）取，计划从计划注册表取。代码里没有针对单一 runtime、项目或渠道的特例分支。

存储落点：

| 数据 | 位置 | 理由 |
|-|-|-|
| 任务定义 | `config.yaml` 的 `automation.tasks` | 与 `events` 同级；`LIST_PATHS` / `HOT_CONFIG_PREFIXES` 已登记，Web 保存补丁能正确收集并立即生效 |
| 调度状态 | `state.db` 的 `automation_states` | 下次触发 / 上次结果由机器写，不污染用户配置文件 |
| 执行记录 | `state.db` 的 `automation_runs` | 每次执行一条，面板「执行记录」直接读；与现有状态库同实例，不新建数据库 |
| 待确认草稿 | `state.db` 的 `automation_drafts` | 飞书自然语言整理出的草稿在面板确认前不写正式任务 |
| 脚本文件 | `<home>/automations/<任务 id>/automation.sh` | 不写进用户仓库；执行时复制到 runtime 在该项目上创建的 worktree |

## 调度语义

- 调度器内嵌在 router-agent 服务进程内，随服务起停；默认每 30 秒扫一轮。
- `hourly` / `daily` / `weekly` / `cron` 四种计划都在 `packages/core/src/automation-schedule.ts` 注册；cron 只接受五段（分 时 日 月 周），支持列表、范围和步长。
- 服务重启后**不补跑**过期任务：超过到期时间 5 分钟的任务记为 `missed`，落一条执行记录，然后重新计算下一次触发时间。
- 手动触发复用同一条执行管线，记录里 `manual: true`。

## 执行管线

`src/automation/executor.ts` 是执行器注册表，`ai` 与 `script` 共用一条管线：

1. 按任务 `runtimeId` 取 runtime（留空取默认），不存在则记 `automation:executor-missing` / 失败。
2. AI 自动化把任务契约投给 runtime；脚本自动化先生成 / 读取持久化脚本，落盘后把「执行 automation.sh」的契约投给 runtime。
3. runtime 在被选项目上创建 worktree；自动化不自己指定任意工作目录，`ctx.workdir` 传空串。
4. 轮询 `status()` 直到结束、`blocked` 或超时；结束后 `stop()`，避免常驻 worker 占用并发额度。
5. 执行期间新建的工单 / 事件按 `source = automation:<任务 id>` 收集进执行记录。

超时是硬上限（默认 10 分钟），失败按 `maxRetries` 重试；脚本与 AI 自动化使用同一套超时、重试与执行记录。

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

鉴权与限流：

- 工具只按任务绑定的项目范围操作；`project` / `repo` 来自任务定义，不由调用方传入。
- 同一任务每分钟最多 30 次工具调用，超限返回 `rate:limited`。
- 凭据不进入任务定义、契约或脚本正文；需要凭据的动作由 handler 内部复用现有配置。
- HTTP 入口 `POST /api/automations/tools` 与 CLI 走同一层服务校验，未知任务 / 工具返回 404，工具拒绝返回 400。

## Web 面板与对话式创建

- 左侧菜单：初始化 → 收件箱 → **自动化** → 工单 → 配置 → 来源 → 日志。自动化紧跟收件箱，因为两者都是「外部输入 → Router 处理」；同时保持在工单上方。
- 页面两个 Tab：「自动化任务」（新建 / 编辑 / 启停 / 删除 / 手动执行一次）与「执行记录」（状态、耗时、结果、产出）。
- 「新建自动化」弹窗沿用「添加决策规则」的分段与间距，字段顺序：名称 → 类型 → 提示词 / 脚本描述 → runtime → 项目 → 执行时间。
- 飞书里描述「我想监听 / 定期处理 X」时，先用确定性词表预筛，再让模型整理为草稿。草稿落到 `automation_drafts` 并在面板「待确认草稿」显示；用户在面板检查、编辑并保存后才写进 `automation.tasks`。模型识别不确定（例如没说项目、计划不合法）时只回问，不落库。

## 扩展位

- 新自动化类型：实现 `AutomationExecutor` 并注册到 `createAutomationExecutors`，核心调度流程不变。
- 新触发计划：实现 `AutomationScheduleSpec` 并调用 `registerSchedule`。
- 新工具：在 `buildTools` 里加一条定义；AI 与脚本自动化自动同时获得。

## 日志

新增事件见 [OPERATIONS.md](OPERATIONS.md) 的自动化事件段。执行链路的关键事件：`automation:scheduler-started` / `execute-start` / `runtime-started` / `script-staged` / `run-finished` / `runtime-failed` / `missed`。
