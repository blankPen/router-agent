# 架构与工单生命周期

本文说明 router-agent 的分层、一条消息的完整链路，以及工单、会话、分支与上报协议的实现细节。只想快速跑起来，看 [README](../README.md) 的「快速开始」即可。

## 分层

```text
Sources（飞书 / GitHub / GitLab）
        │ Trigger
        ▼
Router（AgentLoop + DecisionEngine(Pi) + HTTP API + Web）
        │ Engine（唯一状态写入口）
        ▼
领域内核（TS 零依赖：Ticket / Mandate / Assignment / Stage / Policy）
        │ Assignment
        ▼
WorkerRuntime 端口 ── OrcaRuntime（默认）/ ClaudeCodeRuntime / AcpRuntime（acp 与 7 个 acp-*）
```

仓库是 pnpm workspace：领域内核、基础设施、Worker 运行时与消息通道分别在
`packages/core`、`packages/infra`、`packages/runtime`、`packages/channel`，宿主应用仍在 `src/`。
依赖单向向下（`core ← infra ← runtime / channel ← src`），跨包用 `#core/*` / `#infra/*` /
`#runtime/*` / `#channel/*` 别名。包划分、依赖约束与新增适配器的步骤见 [MONOREPO.md](MONOREPO.md)。

运行时的差异与选型见 [RUNTIME.md](RUNTIME.md)。

某个群开启「需求分析助手」（`feishu.chats[].intake.enabled`）后，Router 与 Worker 之间多一条**并行**的能力链：

```text
群消息（普通成员，可不 @）
        │
        ▼
IntakeCoordinator ── 初筛（轻量 LM）── chat / question / issue
        │                                   │
        │ question / issue                  │ chat → 静默忽略
        ▼
PiIntakeEngine（只读项目代码：code_ls / code_read / code_grep）
        │ 多轮追问，补齐场景 / 环境 / 复现步骤 / 影响 / 预期
        ▼
结构化需求单 ──@管理员终审── 确认派单 → 原有 Engine.decide() → WorkerRuntime
                              └─ 驳回 / 补要求 → 结束 / 重新分析
```

这条链**不改原有架构**：Router 仍只调度与收尾，读代码与业务判断全部落在子 Agent；派单仍只经 `Engine.decide()`；权限、项目隔离、五阶段工单、Outbox 与 PR 闭环一行不改。详见 [CONFIGURATION.md](CONFIGURATION.md#需求分析助手群级-intake)。

## 一条消息的四个步骤

1. **听**：常驻消费飞书群 / 私聊消息，按名单与 `@` 规则做确定性准入。
2. **判**：未被直接指派的候选交给 Pi 研判（可批量），输出 `accept / stop / ignore / unavailable` 四类决定。
3. **派**：接单后创建工单与授权（Mandate），先确认「项目 + 起始分支」，再按 `runtime.default` 选择运行时：Orca 用 `orca worktree create --repo ... --base-branch ...` 开 worktree + Agent 终端（默认 Claude Code，可用 `runtime.options.orca.agent` 指定）；Claude Code 用 `git worktree` + `claude --bg` 后台会话；ACP 用 `AcpRuntime` 拉起对应的 ACP Agent。缺项目或分支时不开单，先在会话里追问（群配置里可固定项目和分支，免问答）。
4. **跟**：Worker 用 `ra report` 上报（失败自动落盘 `state.json`），Router 刷新工单阶段；PR 合并 / 关闭后闭环并通知发起人。

## 关键约束

- **Engine 是唯一状态写入口**：Router、Worker、面板都不直接写 SQLite。
- **WorkerRuntime 是唯一扩展点**：换运行时只加一个 adapter，内核与 Router 一行不改。
- **所有对外通知走 Outbox**：幂等 key + 2s 起步的指数退避（上限 60s）。
- **状态判定不解析终端屏幕文本**：`checkIdle` 只读中立 `AgentStatus`（Orca 映射自 `connected / orphaned / lastOutputAt`，Claude 映射自 `claude agents --json`）；主动巡检优先读 Agent 自己的会话记录（结构化 JSONL），只有读不到时才退回终端输出并做保守清洗。巡检消息是语义摘要：只保留助手文本与一行动作概要，工具调用回显与状态行会被过滤或折叠。
- **研判层是 DecisionEngine 端口**：Pi 是唯一实现，研判与礼貌回复都走同一条 Pi 通道；研判工具只产出提案，写库仍由 Engine 统一完成。

## 听：只接该接的消息

- 群消息默认按配置工作：`mode: all` 收全部消息且不 @ 也回复，`mode: mention` 只收 @机器人。
- 私聊单独开关；机器人、系统消息、互动卡片不会进入领域。
- 群级 `allowed` 非空时，这个群只有名单内的人能触发；名单外的人 @ 机器人也会被静默忽略。
- 图片消息会下载 `image_key`，原图落盘到 `/tmp/ra-images/<trigger id>/` 并把本地路径透传给 Worker（worker 手册里直接给出路径，可打开原图）；同时用多模态模型转成文字进入研判，识别失败也不丢原图。引用消息里的图片、富文本里的图片同样处理。文件 / 语音等其它附件不下载、不做多模态识别。

准入矩阵与 `policy.admission` 的逐格配置见 [CONFIGURATION.md](CONFIGURATION.md#准入规则)。

## 判：Gate 在前，Pi 在后

显式请求也会过一次研判（`conversation.md` / `admission.md` 提示词），不是命中名单就无脑开工；明显寒暄走规则短路，不再额外调用模型。

研判层是 `DecisionEngine` 端口，**Pi 是唯一实现**。AgentLoop 只负责 Gate、应用提案、写库与回复，不再持有工具循环。

| 通道 | 说明 |
|-|-|
| 研判 | Pi `createAgentSession`，in-memory session，只注入 Router system prompt；工具白名单 `router_read / router_ticket / router_ticket_list / router_ticket_progress / router_ticket_close / router_workspace_remove / router_update / router_decide`（`router_update` 仅在服务进程内、且用户明确要求更新时可用） |
| 回复 | 同一个 Pi 引擎，零工具，生成寒暄 / 追问的一句礼貌回复；失败时按真实原因回话（没额度就说没额度，超时就说超时），不用统一话术掩盖故障 |

五条约束：

1. **Gate 在 Pi 之前**：Pi 只处理已过确定性准入的候选，准入永远不交给模型。
2. **工具白名单**：不给 shell / 文件 / MCP / 通用 skill。
3. **写操作有界**：查询工具只读；清理工具只经 `Engine` 关单、把 workspace 回收排进 `Effects`（仍由服务层统一停终端 / 删 worktree），且只对准入名单内、明确 @ 或私聊的用户开放。`router_decide` 只产出 `DecisionProposal`，`Engine.decide()` 由 AgentLoop 统一调用。
4. **超时与预算**：单次 60s、32k token，超时 / 超预算落 `unavailable`，不会拖住 `runCycle`。
5. **审计与回放**：`~/.router-agent/logs/decisions.jsonl` 记录 prompt、工具序列、proposal、耗时与 token。

Pi 侧完全隔离：AuthStorage / SettingsManager / SessionManager 全为 in-memory，关闭 extensions / skills / prompts / themes / AGENTS.md，不读写用户 `~/.pi`。

## 记：一个会话一个 session

Router 不再「逐条失忆」：同一个群里的每个人各有一个落盘的 Pi session，所有对话持续累积，直到本人发送 `/new`。

- **按人隔离**：`chat:<chatId>:user:<actorId>`；张三和李四在同一个群互不可见，`/new` 只清自己的上下文；
- **@ 准入**：`mode: mention` 的群只把 @机器人 / 私聊的消息放进 session；`mode: all` 的群全量进入；名单外成员不进；
- **落盘与恢复**：session 写在 `~/.router-agent/sessions/`，Router 重启后按映射自动 `SessionManager.open` 恢复；
- **空闲回收**：30 分钟无消息只释放内存，文件保留，下一条消息重新打开；
- **自动压缩**：用 Pi 原生 compaction，`contextTokens > contextWindow - reserveTokens` 时保留最近约 20k tokens，把更早的消息总结成结构化摘要；
- **`/new`**：整条消息精确匹配，只重置发送者自己的 session；旧文件保留 7 天后由清理任务删除；
- **人格与规范**：Router 的 soul、执行规范与 Worker 规范统一存放在 `~/.router-agent/specs/`，可在 Web 面板「配置 → 规范文件」直接查看、编辑、保存或恢复默认；人格只改语气，不改工具白名单和权限判定。

确定性回复（寒暄短路、附件提示、关闭话题提示等）也会写进 session，保证下一轮模型知道「刚才发生过什么」。

## 派：每个工单一个 worktree

开单需要三个要素：**任务、项目（repo）、起始分支（branch）**。三者都明确，Router 才会建单；缺项目或分支时它**不会开单**，而是在会话里追问：

```text
用户：@bot 把登录超时改成 30 秒
Router：要改哪个项目、从哪个分支开始？可选项目：router-agent、super-agent
用户：router-agent，从 release 开始
Router：工单「调整登录超时」（tk_1）已开始执行。后续进展会在这个话题里更新。
```

- 追问期间请求会记成**派工草稿**（按群 + 同一个人，30 分钟内有效），用户补齐后直接开单，不用复述任务。
- 项目 / 分支的取值优先级：**本条消息明确说的 > 群配置里的绑定 > 上次草稿 > 唯一项目的 `defaultBranch`**。
- 起始分支会传给 `orca worktree create --base-branch <ref>`；worker 的 worktree 就从该分支切出。
- 用户说的项目不在 `projects` 清单里时，Router 会带着可选项目再问一次，不会猜；分支不做白名单限制，用户指定什么就用什么。

**群绑定（免问答）**：群配置本身同时承担「监控」和「派工绑定」，一条就够：

```bash
# 命令行
ra config set project.router-agent "/Users/me/router-agent@main"
ra config set chatBinding.oc_xxx "router-agent@main"   # 绑定同时意味着监控该群
ra config set chatMode.oc_xxx mention                  # 可选：只收 @ 消息
```

对应的 YAML：

```yaml
feishu:
  chats:
    - chat: oc_xxx
      mode: all
      repo: router-agent   # 只能是当前后端项目清单里的项目名
      branch: main         # 自动跟随项目默认分支，不单独维护
```

绑定后该群开工不再追问项目；项目配了默认分支时也不再追问分支。没写 `repo` 的群仍会按规则追问。

**群级白名单**：`allowed` 非空时，这个群**只有名单内的人能触发**——名单外的人 @ 机器人也会被静默忽略（不进研判、不回复、不开单），并且覆盖全局 `feishu.allowed`。

```bash
ra config set chatAllow.oc_xxx "ou_alice,ou_bob"
ra config set chatAllow.oc_xxx ""          # 清空，回到全局 allowed
```

> 注意：全局 `feishu.allowed` 只区分「显式 / 推断」，名单外的人 @ 机器人默认仍可能被研判接单；要严格限制某群人，请用群级 `allowed`。

项目清单与仓库选择见 [CONFIGURATION.md](CONFIGURATION.md#项目与仓库选择)。

## 跟：进展合并，追问不断线

Worker **不手写状态文件**，统一用 `ra report` 上报。CLI 会 POST 给本地 Router（`POST /api/reports`）；服务不可达时自动落盘到 `~/.router-agent/workers/<ticketId>/state.json`，由 poller 在 1 秒内捡起。

- `--reply` 是**用户真正看到的完整内容**（Markdown），支持字面量、`@文件`、`-`（stdin）。
- `--summary` 只放一句话；只给 summary 会被提示「回复不完整」。
- Router **只发送 `--reply` 原文**，不判断形态、不改写：里面有 PR 链接就是 PR，有文档链接就是文档。
- 需要长文档时，Worker 自己执行 `ra doc --title "…" --content @answer.md`，拿到链接后写进 `--reply`。
- 追问以 `【Router 输入 in_xxx】` 前缀投递；Worker 用 `--ack in_xxx` 确认，否则会被反复重投。
- `--state progress` 的 `--reply` / `--summary` 默认不即时发送：Router 按 `progress.syncMs` 定时合并后同步到话题，同一内容只发一次；带 `--ack` 的追问回答，以及 ready / blocked / failed 等终态仍即时发送。
- **不依赖 worker 上报**：worker 超过 `progress.silenceMs` 没有新上报 / 新输入时，Router 按 `progress.probeMs` 主动取进展——优先读 Agent 自己的结构化会话记录（Claude Code 的 `~/.claude/projects/.../*.jsonl`；Codex 的 `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl`），读不到再退回 `orca terminal read --screen` 的渲染屏幕；把进展整理成语义摘要（助手文本 + 一行动作概要，工具调用噪音不逐条回放）同步到话题，同一静默期按 `progress.repeatMs` 限流。`review` 之后又收到新输入的工单也会被巡检。
- Router 每轮按文件变化增量读取（`state.json` 兜底通道），成功后调 `Engine.report()`。
- 终端长时间无输出 → 主动发 `status?`；仍无响应 → 标记 stale 并通知人。
- 审计事件追加到同目录 `events.log`。

Worker 手册会拼进启动 prompt；非 Orca 运行时使用运行时中立的契约文件。两者都不改项目 `AGENTS.md`。详见 [RUNTIME.md](RUNTIME.md#worker-规范注入)。

### 上报协议

```bash
ra report \
  --ticket tk-12 \
  --state progress|waiting|ready|blocked|failed|dropped \
  --summary "一句话摘要" \
  --reply @answer.md \
  --pr-number 12 --pr-url "https://github.com/o/r/pull/12" \
  --ui-change [true|false] \
  --human-action "blocked 时要人做的事" \
  --ack in_xxx
```

| 参数 | 说明 |
|-|-|
| `--summary` | 一句话摘要，只给日志和列表用 |
| `--reply` | 用户真正看到的完整内容（Markdown），支持字面量、`@文件`、`-`（stdin） |
| `--pr-number` / `--pr-url` | 代码类交付时附 PR 编号与链接 |
| `--ui-change` | 显式声明是否改了 UI；不声明时 Router 按改动文件推断。`worker.evidence.ui: enforce` 下，UI 工单缺 Before / After 证据的 `ready` 会返回 422 |
| `--human-action` | `blocked` 时需要人做的事 |
| `--ack` | 确认已读某条追问（`in_xxx`），否则会被反复重投 |

上报状态：

| 状态 | 含义 |
|-|-|
| `progress` | 中途进展；Router 按 `progress.syncMs` 合并后同步，不逐条转发 |
| `waiting` | 等待外部条件 |
| `ready` | 这一轮交付完成（结论 / PR / 文档） |
| `blocked` | 被阻塞，需要人处理；配合 `--human-action` |
| `failed` | 执行失败 |
| `dropped` | 主动放弃 |

## 工单编号与分支命名

- 工单号是全局自增的短编号：`tk-1`、`tk-2`……，重启后从上次的值继续，旧库里的 `tk_<uuid>` 仍可正常查询。
- Orca worktree 名：`ra-tk-<编号>-<语义 slug>`，与工作分支一一对应，只把 `/` 换成 `-`，目录和分支一眼能对上。
- 工作分支：`ra/tk-<编号>-<语义 slug>`，由工单标题生成；标题里有足够英文时优先用英文，纯中文标题保留中文本身（git 支持 UTF-8 分支名）：
  - `ra/tk-12-fix-login-timeout`
  - `ra/tk-13-调整登录超时`
- 工单上的 `branch` 表示**起始分支**；工作分支通过 `orca worktree create --branch` 单独指定，不再叠加 Orca 的用户前缀与 UUID。

## 工单阶段

工单只有五种阶段：

| 阶段 | 含义 |
| --- | --- |
| `todo` 待办 | 已接单，尚未派工 |
| `running` 进行中 | 已派工，worker 正在执行 |
| `review` 审核中 | worker 已交付，等待发起人验收 |
| `blocked` 已阻塞 | 等待人工回答、worker 失败/退出，或需要人工推动 |
| `done` 已完成 | 工单闭环（PR 合并/关闭或人工结束） |

`done` 是终态；其余四种阶段之间可以互相流转。PR 仍处于 open 时禁止结束工单。
旧版本八阶段（`draft/accepted/assigned/running/review/person/idle/closed`）的历史数据迁移见 [TICKET-STAGE-MIGRATION.md](TICKET-STAGE-MIGRATION.md)。

## PR / MR 闭环

- 派工成功后 Router 跟踪该分支的 PR / MR 状态（`pr:linked` / `pr:state`）。
- 平台按 worktree 的 `git remote` 自动识别：`github.com` 走 `gh`，其它主机按 GitLab 走 `glab`（需本机安装并完成登录）；GitLab MR 不会交给 `gh`。
- PR / MR 仍处于 open 时禁止结束工单。
- PR / MR 合并或关闭后，工单变 `closed`，飞书收到一次闭环通知。
- 不做自动合并：合并与否由人决定。
