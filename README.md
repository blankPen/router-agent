<div align="center">

<img src="docs/assets/router-agent-logo.svg" width="112" alt="router-agent logo">

# router-agent

### 在飞书说一句，在 Orca 里干完，在 PR 里闭环。

**飞书消息 → 常驻 Router 研判 → 派发到 Orca worktree 里的 Claude Code → PR 跟踪回群。**<br>
准入、开单、派工、追问、进展同步、闭环全自动，<br>
每张工单都有自己的分支、终端和上下文。

[![Stars](https://img.shields.io/github/stars/blankPen/router-agent?style=flat&color=111111)](https://github.com/blankPen/router-agent/stargazers)
![Node](https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)

[快速开始](#快速开始) &nbsp;·&nbsp; [它怎么工作](#它怎么工作) &nbsp;·&nbsp; [配置](#配置) &nbsp;·&nbsp; [命令](#命令) &nbsp;·&nbsp; [Worker 协议](#worker-上报协议) &nbsp;·&nbsp; [文档](#文档)

**简体中文** · [English](README.en.md)

</div>

<br>

## 它适合你吗？

如果你每天要在多个仓库之间来回切：在群里丢一句需求，等人开分支、开终端、跑起来，再回来汇报结果——这段流程本来就该由机器接管。

router-agent（`ra`）是一个常驻的双层 Agent 系统：**Router 只做研判与调度，Worker 只在独立 worktree 里干活**。它不替你写代码，它负责把「谁、在哪个项目、从哪个分支、做什么」变成一张有边界、有上下文、可追踪的工单，然后交给 Orca 里独立 worktree 的 Claude Code 执行。

- **多个仓库、多个群**：项目、分支、群绑定集中在一份配置里，开工前先确认清楚再派工。
- **需求边界要留痕**：每条消息都过确定性 Gate，再交 Pi 研判；接单、忽略、追问、不可用都有结论可查。
- **不想盯终端**：Worker 用 `ra report` 上报，Router 把进展合并后同步回原话题，PR 合并或关闭自动闭环。
- **每个工单互不打扰**：一个工单一个 worktree、一条分支、一个 Claude Code 终端，做完即隔离。

它面向的是「消息进来、代码出去」的日常研发协作。如果你只是偶尔让 AI 改一个文件，直接打开 Claude Code 会更快。

它是对 dsh-superagent 的**绿色重写**，不依赖原型的 tmux / DSE profile。

## 快速开始

**前置条件**

| 依赖 | 说明 |
|-|-|
| Node.js | `>= 22.19.0`（使用内置 `node:sqlite`；项目根目录 `.node-version` 已固定 22.19.0） |
| pnpm | 安装依赖与构建 |
| Orca | 提供 `orca` CLI，负责创建 worktree 与终端 |
| lark-cli | 飞书事件消费、发消息；需要一个飞书自建应用 |
| Claude Code | Worker 的实际执行者，由 Orca 在 worktree 内拉起 |

**1 · 安装并构建**

```bash
pnpm install --registry=https://registry.npmjs.org/
pnpm build
```

`ra` 是 `pnpm link --global` 后可用，也可以直接 `node bin/ra.js <command>`。

**2 · 初始化**

```bash
ra init                 # 交互式引导：仓库 → 机器人 → 群 → 授权成员，一条命令装完
```

`ra init` 只问必填项，其余参数写成默认值。飞书 App ID / App Secret、群绑定、白名单都可以在引导里一次配好，也可以稍后在 Web 配置页补填。

**3 · 启动**

```bash
ra start                # 后台常驻，就绪后自动打开 Web 初始化页
ra status
ra web                  # 之后想再打开面板
```

`ra start` 等服务就绪后会用默认浏览器打开面板的「初始化」页，把启动必需项一次配完：Worker 运行时（含 ACP 扩展一键安装）、项目、飞书机器人（App ID / App Secret 与授权）、监控群与绑定。保存后按页面提示重启服务即可。远程机器或没有图形界面时用 `ra start --no-open`，只打印面板地址。

**4 · 自检与模拟**

```bash
ra doctor                                              # 配置 / Orca / 飞书 / 模型 / 端口，全绿再往下
ra simulate --infer --text "把 README 的端口从 3000 改成 3083" --dry-run
ra simulate --text "你好，在吗" --dry-run               # 验证回复通道也走 Pi
ra tickets                                             # 模拟产生的工单会出现在这里
```

真实验收时，在群里 @机器人 提一个小需求，然后依次确认：

1. `ra logs | grep trigger:ingested` 能看到消息进入；
2. `ra tickets` 出现工单，`ra ticket <id>` 能看到授权范围与强度；
3. `orca worktree list --json` 出现 `ra-tk-<编号>-<语义slug>`，分支名为 `ra/tk-<编号>-<语义slug>`（目录名与分支名一一对应，只把 `/` 换成 `-`），Orca 里出现 Claude Code 终端；
4. Worker 执行 `ra report` 后，`ra ticket <id>` 的阶段在 `running → review/blocked` 之间变化；
5. 合并或关闭 PR 后，工单变 `closed`，飞书收到一次闭环通知。

## 它怎么工作

```text
Sources（飞书 / GitHub）
        │ Trigger
        ▼
Router（AgentLoop + DecisionEngine(Pi) + HTTP API + Web）
        │ Engine（唯一状态写入口）
        ▼
领域内核（TS 零依赖：Ticket / Mandate / Assignment / Stage / Policy）
        │ Assignment
        ▼
WorkerRuntime 端口 ── OrcaRuntime（默认）/ ClaudeCodeRuntime / AcpRuntime ── 未来：Codex
```

一条消息会依次经过四步：

1. **听**：常驻消费飞书群 / 私聊消息，按名单与 `@` 规则做确定性准入。
2. **判**：未被直接指派的候选交给 Pi 研判（可批量），输出 `accept / stop / ignore / unavailable` 四类决定。
3. **派**：接单后创建工单与授权（Mandate），先确认「项目 + 起始分支」，再按 `runtime.default` 选择运行时：Orca 用 `orca worktree create --repo ... --base-branch ...` 开 worktree + Claude Code 终端；Claude Code 用 `git worktree` + `claude --bg` 后台会话。缺项目或分支时不开单，先在会话里追问（群配置里可固定项目和分支，免问答）。
4. **跟**：Worker 用 `ra report` 上报（失败自动落盘 `state.json`），Router 刷新工单阶段；PR 合并 / 关闭后闭环并通知发起人。

关键约束：

- **Engine 是唯一状态写入口**：Router、Worker、面板都不直接写 SQLite。
- **WorkerRuntime 是唯一扩展点**：换运行时只加一个 adapter，内核与 Router 一行不改。
- **所有对外通知走 Outbox**：幂等 key + 2s 起步的指数退避（上限 60s）。
- **状态判定不解析终端屏幕文本**：`checkIdle` 只读中立 `AgentStatus`（Orca 映射自 `connected / orphaned / lastOutputAt`，Claude 映射自 `claude agents --json`）；主动巡检优先读 Agent 自己的会话记录（结构化 JSONL），只有读不到时才退回终端输出并做保守清洗。巡检消息是语义摘要：只保留助手文本与一行动作概要，工具调用回显与状态行会被过滤或折叠。
- **研判层是 DecisionEngine 端口**：Pi 是唯一实现，研判与礼貌回复都走同一条 Pi 通道；研判工具只产出提案，写库仍由 Engine 统一完成。

## 它能做什么

### 听：只接该接的消息

- 群消息默认按配置工作：`mode: all` 收全部消息且不 @ 也回复，`mode: mention` 只收 @机器人。
- 私聊单独开关；机器人、系统消息、互动卡片不会进入领域。
- 群级 `allowed` 非空时，这个群只有名单内的人能触发；名单外的人 @ 机器人也会被静默忽略。
- 图片消息会下载 `image_key`，原图落盘到 `/tmp/ra-images/<trigger id>/` 并把本地路径透传给 Worker（worker 手册里直接给出路径，可打开原图）；同时用多模态模型转成文字进入研判，识别失败也不丢原图。引用消息里的图片、富文本里的图片同样处理。文件 / 语音等其它附件不下载、不做多模态识别。

### 判：Gate 在前，Pi 在后

显式请求也会过一次研判（`conversation.md` / `admission.md` 提示词），不是命中名单就无脑开工；明显寒暄走规则短路，不再额外调用模型。

研判层是 `DecisionEngine` 端口，**Pi 是唯一实现**。AgentLoop 只负责 Gate、应用提案、写库与回复，不再持有工具循环。

| 通道 | 说明 |
|-|-|
| 研判 | Pi `createAgentSession`，in-memory session，只注入 Router system prompt；工具白名单 `router_read / router_ticket / router_ticket_list / router_ticket_progress / router_ticket_close / router_workspace_remove / router_decide` |
| 回复 | 同一个 Pi 引擎，零工具，生成寒暄 / 追问的一句礼貌回复；失败时退回固定话术 |

五条约束：

1. **Gate 在 Pi 之前**：Pi 只处理已过确定性准入的候选，准入永远不交给模型。
2. **工具白名单**：不给 shell / 文件 / MCP / 通用 skill。
3. **写操作有界**：查询工具只读；清理工具只经 `Engine` 关单、把 workspace 回收排进 `Effects`（仍由服务层统一停终端 / 删 worktree），且只对准入名单内、明确 @ 或私聊的用户开放。`router_decide` 只产出 `DecisionProposal`，`Engine.decide()` 由 AgentLoop 统一调用。
4. **超时与预算**：单次 60s、32k token，超时 / 超预算落 `unavailable`，不会拖住 `runCycle`。
5. **审计与回放**：`~/.router-agent/logs/decisions.jsonl` 记录 prompt、工具序列、proposal、耗时与 token。

Pi 侧完全隔离：AuthStorage / SettingsManager / SessionManager 全为 in-memory，关闭 extensions / skills / prompts / themes / AGENTS.md，不读写用户 `~/.pi`。

### 记：一个会话一个 session

Router 不再「逐条失忆」：同一个群里的每个人各有一个落盘的 Pi session，所有对话持续累积，直到本人发送 `/new`。

- **按人隔离**：`chat:<chatId>:user:<actorId>`；张三和李四在同一个群互不可见，`/new` 只清自己的上下文；
- **@ 准入**：`mode: mention` 的群只把 @机器人 / 私聊的消息放进 session；`mode: all` 的群全量进入；名单外成员不进；
- **落盘与恢复**：session 写在 `~/.router-agent/sessions/`，Router 重启后按映射自动 `SessionManager.open` 恢复；
- **空闲回收**：30 分钟无消息只释放内存，文件保留，下一条消息重新打开；
- **自动压缩**：用 Pi 原生 compaction，`contextTokens > contextWindow - reserveTokens` 时保留最近约 20k tokens，把更早的消息总结成结构化摘要；
- **`/new`**：整条消息精确匹配，只重置发送者自己的 session；旧文件保留 7 天后由清理任务删除；
- **人格**：`router.persona.soulFile` 可配置 soul；只改语气，不改工具白名单和权限判定。

确定性回复（寒暄短路、附件提示、关闭话题提示等）也会写进 session，保证下一轮模型知道「刚才发生过什么」。

### 派：每个工单一个 worktree

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
ra config set project.router-agent "name:dsh/router-agent@main"
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

### 跟：进展合并，追问不断线

Worker **不手写状态文件**，统一用 `ra report` 上报。CLI 会 POST 给本地 Router（`POST /api/reports`）；服务不可达时自动落盘到 `~/.router-agent/workers/<ticketId>/state.json`，由 poller 在 1 秒内捡起。

- `--reply` 是**用户真正看到的完整内容**（Markdown），支持字面量、`@文件`、`-`（stdin）。
- `--summary` 只放一句话；只给 summary 会被提示「回复不完整」。
- Router **只发送 `--reply` 原文**，不判断形态、不改写：里面有 PR 链接就是 PR，有文档链接就是文档。
- 需要长文档时，Worker 自己执行 `ra doc --title "…" --content @answer.md`，拿到链接后写进 `--reply`。
- 追问以 `【Router 输入 in_xxx】` 前缀投递；Worker 用 `--ack in_xxx` 确认，否则会被反复重投。
- `--state progress` 的 `--reply` / `--summary` 默认不即时发送：Router 按 `progress.syncMs` 定时合并后同步到话题，同一内容只发一次；带 `--ack` 的追问回答，以及 ready / blocked / failed 等终态仍即时发送。
- **不依赖 worker 上报**：worker 超过 `progress.silenceMs` 没有新上报 / 新输入时，Router 按 `progress.probeMs` 主动取进展——优先读 Agent 自己的结构化会话记录（Claude Code 的 `~/.claude/projects/.../*.jsonl`），读不到再退回 `orca terminal read --screen` 的渲染屏幕；把进展整理成语义摘要（助手文本 + 一行动作概要，工具调用噪音不逐条回放）同步到话题，同一静默期按 `progress.repeatMs` 限流。`review` 之后又收到新输入的工单也会被巡检。
- Router 每轮按文件变化增量读取（`state.json` 兜底通道），成功后调 `Engine.report()`。
- 终端长时间无输出 → 主动发 `status?`；仍无响应 → 标记 stale 并通知人。
- 审计事件追加到同目录 `events.log`。

两种规范注入模式（`workerSpec.mode`）：`prompt` 把手册拼进启动 prompt；`agent` 只发工单，由全局 `~/.claude/agents/router-agent-worker.md` 提供规范（`ra init` 会生成）。两种模式都不改项目 `CLAUDE.md`。

### 看：回复、面板与审计

Router 不做对话，只在必要时说话：

| 场景 | 行为 |
|-|-|
| **任意被监听的消息** | 收到后**立即**加一个确认表情（默认 `Typing` ⌨️），回复发出后自动取消 |
| 群里 @机器人，但只是寒暄 / 试探 | **Pi 生成**一句礼貌回复，作为**普通消息**发出；不建单 |
| 群里 @机器人，是真需求 | 只发一条**话题**消息：「工单「标题」（id）已开始执行。后续进展会在这个话题里更新。」，不再额外回「我帮你创建了工单」之类的普通消息 ack |
| 未 @ 的群消息 | 走 Pi 研判；判为闲聊则**完全静默**（不刷屏） |
| 私聊 | 走 Pi 研判；判为闲聊时用 Pi 礼貌回复（普通消息） |
| 只发了图片 | 下载原图落盘并透传给 Worker，同时转成文字走研判；识别失败也保留原图，不再回「看不到附件内容」 |
| 只发了文件 / 语音等其它附件 | **不开单**：@ 或私聊时回一句「看不到附件内容，请用文字说明」 |
| 系统消息（建群 / 拉人 / 改群名） | 直接丢弃，不进领域 |
| 互动卡片消息 | 直接丢弃（`content` 是原始卡片 JSON，不能当需求读） |
| 研判没完成（unavailable） | 若在跟它说话，用 Pi 追问一句 |
| `acceptMode: off` 的推断候选 | 固定说明「暂不自动开工」 |
| worker 卡住 / 有结果 / PR 合并关闭 | 一律作为**话题回复**同步到原消息下 |
| worker 交付结论 | 简单单行回复走**纯文本**；带 Markdown 的以**飞书卡片**渲染（卡片内 Markdown 先归一化）回话题；有文档 / PR 链接一并展示 |
| worker 进展（`--state progress` 或 Router 主动巡检） | 上报的进展**不逐条发送**：按 `progress.syncMs` 合并成一条话题消息（追问的回答除外）；worker 静默时 Router 按 `progress.probeMs` 主动取进展（优先会话记录，其次终端屏幕），整理成语义摘要（助手文本 + 一行动作概要，过滤工具调用噪音）发到话题，同一静默期按 `progress.repeatMs` 限流 |

- 确认表情是 best-effort：失败只记 `feishu:reaction-failed`，不影响研判；只对首次入库、且是在跟它说话（@ / 私聊）的消息加；重放不会重复加；回复发出后自动撤销（`feishu:unreact-failed` 是撤销失败的日志）。`ra config set feishu.reaction ""` 可关闭。
- 全部 emoji_type 见飞书文档「表情文案」，注意**大小写敏感**（`Typing` 不是 `TYPING`）。
- 出站按内容分流：**单行、≤200 字、不含 Markdown 语法**的回复直接用 `text` 消息；其余用飞书**互动卡片**渲染 Markdown，卡片失败自动降级为 post 富文本。分流规则：`threadId` 为空 = 普通消息，有值 = 话题回复。
- 卡片内的 Markdown 会先归一化（`normalizeCardMarkdown`），把 Card 1.0 不支持的语法降级掉：`#` 标题 → 加粗行、`>` 引用 → `▍`、表格 → 加粗表头 + 列表行、`- [x]` → ☑ / ☐、`<br>` → 换行、`![图片](http...)` → 可点击链接；代码块内原样保留。

**日志能追到哪一步**：所有关键节点都是结构化 JSON，一行一个事件（`at` / `level` / `message` + 业务字段）：

| 事件 | 来源 | 关键字段 | 说明 |
|-|-|-|-|
| `feishu:ready` | 事件消费者 | — | 事件流已连上 |
| `trigger:ingested` | Source | `id` `chat` `addressed` | 用户消息进入系统 |
| `trigger:dropped` | Source | `reason` `chat` `actor` | 收到但被过滤 |
| `router:decision` | Engine | `triggerId` `decision` `strength` `reason` `ticketId` `title` `scope` | Router 的研判结论 |
| `launch` | Service | `ticketId` `handle` `workdir` | 派工到 Orca worktree |
| `input:queued` | Engine | `ticketId` `seq` `text` | Router 准备发给 worker 的内容 |
| `input:delivered` | Service | `ticketId` `count` `text` | 实际投递进 worker 终端 |
| `report` | Service | `ticketId` `state` `turn` `summary` `reply` `humanAction` `pr` | worker 的 `ra report` 上报 |
| `progress:synced` / `progress:dedup` | Service | `ticketId` `count` / `skipped` | 进展定时合并同步，或内容重复被跳过 |
| `progress:probed` | Service | `ticketId` `minutes` `count` `unchanged` | 主动巡检读会话记录 / 终端并把语义摘要同步到话题 |
| `outbox:sent` / `outbox:failed` | Outbox | `key` `text` / `error` | 对外通知结果 |
| `api:input` / `api:stop` / `api:policy` / `api:config` | HTTP API | — | 面板 / CLI 的操作 |
| `idle:nudge` / `idle:stale` | Service | — | 空闲唤醒与失联标记 |
| `pr:linked` / `pr:state` | Service | — | PR 跟踪 |
| `recover:*` | Service | — | 重启对账 |

worker 终端里的原始输出**不进日志**（避免把 TUI 文本当状态）；主动巡检优先读 Claude 会话记录，其次才把终端里的语义摘要（助手文本 + 动作概要）发到话题，不逐条回放工具调用。要看它做了什么，读 `report` 的 `summary` 与 `~/.router-agent/workers/<ticketId>/events.log`。

> **同一机器人只能有一个事件总线在跑。** 如果 `ra logs` 出现 `another event bus is already connected`，先停掉其它占用该应用的消费者；建议给 router-agent 使用独立的自建应用，避免与其它 agent 抢同一个机器人。

#### Web 面板

`ra start` 自动打开、`ra web` 也可随时打开的面板分五块：

- **初始化**：只放启动必需项——LLM Provider、运行时、项目、飞书机器人、群与绑定，顶部有完成度清单；LLM Provider 放在第一位，Base URL / 模型 / API Key 三项必填（密钥只写入 `config.yaml`，保存后不回显），未配置时服务无法启动。飞书机器人固定使用 `~/.router-agent-lark` profile：App ID / App Secret 直接在本页填写（Secret 只写入 lark-cli 加密存储），并可检查授权状态、发起 Device Flow 授权。运行时用卡片平铺展示（带对应品牌 Logo），每张卡会检测 CLI / 版本 / ACP 依赖 / 登录状态。安装拆成两个按钮：**安装 CLI** 跳转该 Agent 的官方安装文档，**安装 ACP 扩展** 由 ra 把 npm 适配包装到 `~/.router-agent/runtimes`（没有可安装扩展时不显示）；另有真实握手试启动。配好后保存并按提示重启服务即可。
- **工单**：按阶段分组 + 计数、关键字搜索（标题 / 工单号 / 仓库 / PR）、自动刷新开关与手动刷新；详情页有阶段、派工、PR、授权范围、上报时间线（含完整回复与 `humanAction`）、投递记录，可直接投递 follow-up 或停止工单。
- **日志**：直接看 `~/.router-agent/logs/router-agent.log`，默认 2 秒增量拉取（只读游标之后的新字节，不重复读整个文件），可开「实时刷新」；按 INFO / WARN / ERROR 过滤、按消息或字段搜索、复制当前结果；停在底部时自动跟随新日志，往上翻后不再打断，点「最新」回到底部。文件不存在或还没写入时给出空状态提示。
- **配置**：按「LLM Provider / 准入策略 / 研判与人格 / 会话复用 / 进展同步 / 闲置治理 / 飞书消息 / 派工与服务 / 项目与群绑定」分组；飞书分组的顶部是「飞书机器人」区块，可直接写入 App Secret、刷新授权状态并引导完成飞书授权。每个字段带说明与默认值提示，改动逐项标脏，保存前做前端 + 后端双重校验，保存后写回 `config.yaml`。「派工与服务」里的 Worker 运行时是与初始化页相同的卡片平铺组件（`orca` / `claude-code` / `acp` / `acp-*`），可检测安装状态、分别跳转官方文档安装 CLI 或由 ra 安装 ACP 扩展，并做 ACP 握手试启动；项目清单按后端隔离，切换后端后「项目与群绑定」里的项目清单会切换到该后端自己的一套（Orca 用仓库选择器，Claude Code 必须是本地仓库绝对路径）；「添加本地项目」支持系统目录选择并自动识别 Git / 分支，「添加 Git 项目」支持填写 ssh / http(s) 地址后自动 clone 并登记。群绑定的项目只能从当前清单里选，分支自动跟随项目的默认分支，不能单独自定义。
- **来源**：服务状态、监控群、接收范围概览。

配置项会标注生效范围：**策略**（`acceptMode` / `maxWorkers` / `admission`）保存后立即生效；其余配置在服务启动时读入，保存后点侧栏或配置页的「重启服务」即可热重启 daemon（浏览器页面不会刷新），也可以手动 `ra stop && ra start`。面板可以在「初始化 · LLM Provider」或「配置 · LLM Provider」里填写 `llm.apiKey`，密钥只写入 `config.yaml`，保存后不会再回显（`publicConfig` 只返回 `apiKeySet`）；也可以用 CLI / 环境变量配置。保存会重写 `config.yaml`，原文件的注释会丢失。

### PR 闭环

- 派工成功后 Router 跟踪该分支的 PR 状态（`pr:linked` / `pr:state`）。
- PR 仍处于 open 时禁止结束工单。
- PR 合并或关闭后，工单变 `closed`，飞书收到一次闭环通知。
- 不做自动合并：合并与否由人决定。

## 配置

`~/.router-agent/config.yaml`（`ra config` 可查看）：

```yaml
feishu:
  appId: ""            # 专属机器人 App ID；App Secret 只存 lark-cli 加密存储，lark-cli profile 固定为 ~/.router-agent-lark
  reaction: "Typing"   # 收到消息立即回的确认表情（飞书 emoji_type；空字符串关闭）
  # 监控的群：一条配置同时决定「收什么消息 + 派工绑定」
  chats:
    - chat: oc_xxx     # 群 chat_id
      mode: all        # all=全部消息且不 @ 也回复；mention=只收 @机器人
      repo: router-agent   # 可选：群绑定项目（只能是当前后端项目清单里的项目名）
      branch: main         # 由项目默认分支自动决定，面板不可单独编辑
      allowed: [ou_xxx]    # 可选：本群只允许这些人操作（空=沿用全局 allowed）
  directMessages: true
  allowed: []          # 允许发起工作的 open_id
  bots: []             # 允许产生推断候选的机器人
  botOpenIds: []       # 机器人自己的 open_id / app_id
  botNames: []         # 机器人显示名
  images:              # 图片消息：原图落盘并透传给 Worker，同时转文本进入研判
    enabled: true
    maxChars: 2000     # 单张图片转写结果的最大字符数
    timeoutMs: 60000   # 单张图片识别超时（毫秒）

policy:
  acceptMode: auto     # off / observe / auto
  maxWorkers: 4
  # 准入表：按「名单内外 × 是否 @」逐格配置，默认值如下（含义见「准入规则」）
  admission:
    listedNotAddressed: inferred    # 名单内、未 @：inferred | ignore
    unlistedAddressed: inferred     # 名单外、@bot：explicit | inferred | ignore
    unlistedNotAddressed: ignore    # 名单外、未 @：inferred | ignore

# 研判层：Pi 单引擎；超时、token 预算与独立配置目录
router:
  timeoutMs: 60000         # 单次研判硬超时，超时按 unavailable 落库
  tokenBudget: 32000       # 单次研判 token 预算；0 表示不限制
  agentDir: ""             # Pi 独立配置目录；空=~/.router-agent/pi

  # 会话复用：一个飞书会话按人一个 session，落盘、可恢复、自动压缩
  session:
    enabled: true          # false = 回到每次新建 in-memory session
    keyScope: user         # user=群+人；thread=群+话题+人
    dir: ""                # 空=~/.router-agent/sessions
    idleTtlMs: 1800000     # 30 分钟无消息回收内存（文件保留）
    maxActive: 50          # 同时驻留内存的 session 上限
    retentionDays: 7       # /new 之后旧 session 文件保留天数；0=不清理
    cleanupIntervalHours: 24
    turnTimeoutMs: 180000  # 带会话的一轮硬超时（含压缩）
    tokenBudget: 0         # 会话 token 预算；0=不限制，交给压缩
    compaction:            # Pi 原生自动压缩
      enabled: true
      reserveTokens: 16384
      keepRecentTokens: 20000

  # 人格：只影响语气与表达，不影响工具权限
  persona:
    name: "阿罗"
    soulFile: ""           # 空=内置 prompts/soul.md
    style: friendly        # friendly | concise | professional
    language: zh-CN

progress:
  # 工单进展定时轮询：把这段时间内的 progress 上报合并成一条消息同步到话题
  syncMs: 60000        # 毫秒；0 = 关闭（progress 上报不再同步到话题）
  # 主动巡检：worker 静默时直接读 Orca 终端，不依赖 worker 上报
  probeMs: 120000      # 巡检间隔（毫秒）；0 = 关闭主动巡检
  silenceMs: 600000    # 多久没有新上报 / 新输入才算静默
  repeatMs: 900000     # 同一静默期内重复提醒的最小间隔

# 闲置工单治理：先提醒，宽限期后自动关闭并回收 workspace
retention:
  enabled: true
  idleHours: 24        # 多久没有新进展就发关单提醒
  closeGraceHours: 6   # 提醒后多久没回复就自动关闭
  zombieHours: 6       # 执行中但多久没上报/输出算僵尸
  sweepMinutes: 5      # 扫描间隔（分钟）

workerSpec:
  mode: prompt         # prompt | agent

# Worker 工具策略：安全基线，runtime.options 不允许覆盖这些字段
worker:
  tools:
    fileAccess: read-write   # read-only = 只给 Read / Glob / Grep
    shell: allowlist         # deny=不给 shell | allowlist=只放行 shellAllow | allow=任意 shell
    shellAllow: [ra report, ra doc, git, gh, pnpm, npm, npx, node, yarn, bun,
                 python, python3, pytest, cargo, go, make, mvn, gradle]
    allowNetwork: false      # 预留字段：当前只解析，未用于收窄网络

runtime:
  default: orca            # orca | claude-code | acp（claude-code 对 projects 的本地路径有要求，见「已知限制」）
  # 运行时专属的非安全参数：目前有 claude-code.model（兼容旧键 claude-cli.model）与 acp.command/args/env。
  # 写 allowedTools / permissionMode / sandbox / shellAllow / allowNetwork / fileAccess 会直接启动失败。
  # options:
  #   claude-code:
  #     model: claude-sonnet-5-5
  #   acp:
  #     command: opencode     # Agent 可执行文件
  #     args: [acp]           # 传给 Agent 的参数
  #     env: {}               # 额外环境变量
  # 非 orca 运行时使用独立项目清单，和顶层 projects 互不影响
  # projects:
  #   claude-code:
  #     - name: router-agent
  #       repo: /Users/me/router-agent   # Claude Code 需要本地仓库绝对路径

# orca 项目清单：开单前必须确认「哪个项目 + 哪个起始分支」
projects: []
#  - name: router-agent            # 用户/模型引用的项目名
#    repo: name:dsh/router-agent   # 交给 Orca 的仓库选择器
#    defaultBranch: main           # 未指定分支时使用；留空则每次开工前追问

server:
  port: 3083
```

日常调整不需要编辑整份文件：

```bash
ra config set policy.acceptMode observe   # 先观察，不开工
ra config set policy.maxWorkers 2
ra config set workerSpec.mode agent
ra config edit                            # 用 $EDITOR 编辑整份配置（不是 --edit）
```

### 逐项修改（`ra config set`）

`ra config set <点路径> <值>` 覆盖常用标量配置；路径未知或值非法会直接报「未知配置项或非法值」：

| 点路径 | 取值 |
|-|-|
| `policy.acceptMode` | `off` / `observe` / `auto` |
| `policy.maxWorkers` | 1–64 |
| `policy.admission.listedNotAddressed` / `unlistedAddressed` / `unlistedNotAddressed` | 见「准入规则」 |
| `router.timeoutMs` / `router.tokenBudget` / `router.agentDir` | 毫秒（1s–600s） / token（0=不限） / Pi 配置目录 |
| `progress.syncMs` / `probeMs` / `silenceMs` / `repeatMs` | 毫秒；前两项 0 = 关闭 |
| `retention.enabled` / `idleHours` / `closeGraceHours` / `zombieHours` / `sweepMinutes` | 见「闲置工单治理」 |
| `workerSpec.mode` | `prompt` / `agent` |
| `backend.default` | `orca` / `claude-cli` |
| `server.port` | 1–65535 |
| `feishu.appId` / `reaction` / `directMessages` / `allowed` / `bots` / `botOpenIds` / `botNames` | 字符串、布尔或逗号分隔列表 |
| `feishu.chats` | 逗号分隔 chat_id；已有条目的 mode / 绑定 / sync 保留，新条目默认 `all` |
| `llm.baseUrl` / `llm.model` / `llm.apiKey` | 模型连接信息 |

群与项目这类复合结构用专用写法，一次完成「登记 + 绑定」：

| 写法 | 例子 | 说明 |
|-|-|-|
| `project.<名>` | `ra config set project.router-agent "name:dsh/router-agent@main"` | `@` 后可带默认起始分支 |
| `chatBinding.<chatId>` | `ra config set chatBinding.oc_xxx "router-agent@main"` | 绑定群的项目与起始分支 |
| `chatMode.<chatId>` | `ra config set chatMode.oc_xxx mention` | `all` / `mention` |
| `chatSync.<chatId>` | `ra config set chatSync.oc_xxx true` | 启动时补拉该群历史 |
| `chatAllow.<chatId>` | `ra config set chatAllow.oc_xxx ou_a,ou_b` | 空值 = 沿用全局 `feishu.allowed` |

`router.session.*`、`router.persona.*`、`feishu.images.*` 不在 `config set` 的白名单里，用 `ra config edit` 或 Web 面板改；`worker.tools.*` 与 `backend.options.*` 面板不提供，只能 `ra config edit` 直接改文件。

### 环境变量

| 变量 | 作用 |
|-|-|
| `RA_HOME` | 状态目录，等价于全局选项 `--home`；默认 `~/.router-agent` |
| `RA_PORT` | `ra report` 的上报端口，覆盖 `server.port` |
| `RA_LLM_BASE_URL` / `RA_LLM_API_KEY` / `RA_LLM_MODEL` | 覆盖研判模型连接信息（优先级最高） |
| `RA_LLM_IMAGE_BASE_URL` / `RA_LLM_IMAGE_API_KEY` / `RA_LLM_IMAGE_MODEL` | 覆盖图片转写模型 |

### 飞书机器人（专属 profile）

router-agent 固定使用 `~/.router-agent-lark` 作为 lark-cli profile，**不复用**你终端里其它 lark-cli 的登录态，也不能通过配置修改这个目录。凭据与授权有两个入口：

| 入口 | 行为 |
|-|-|
| Web 配置页 | 「飞书机器人」区块填写 App ID / App Secret；Secret 走 `lark-cli config init --app-secret-stdin` 写入 lark-cli 加密存储，不落 argv / config.yaml。同页可检查 bot / user 状态，并发起 Device Flow 授权。 |
| `ra init` | 交互式选择「已有 App ID / App Secret」或「现在新建应用」；也可以选择跳过，稍后在 Web 配置页补填。 |

之后如果需要用户身份（按名字搜索群 / 成员、创建文档），在 Web 配置页点「开始授权」完成授权，或由 `ra init` 询问后执行 `lark-cli auth login`。授权只申请 **IM（消息 / 群 / 成员）、云文档、云空间、通讯录** 四个业务域，不再请求日历、邮箱、审批等无关权限。

命令与选项均由 `commander` 解析：`ra --help`、`ra init --help`、`ra tickets --help` 可查用法。

机器人凭据由 lark-cli 的加密存储管理，`router-agent` 只在 `config.yaml` 保存 `appId`。运行期所有 lark-cli 子进程（事件消费、发消息、群名刷新、凭据与授权）都会带上 `HOME=~/.router-agent-lark`，与其它 agent 的 lark-cli profile 完全隔离。

### 项目与仓库选择

每个 `projects[].repo` 决定该工单 `orca worktree create --repo` 的目标。先看 Orca 里注册了哪些：

```bash
orca repo list --json | jq -r '.result.repos[] | "\(.displayName)\t\(.path)\t\(.kind)"'
```

Web 面板的「登记项目」提供两种添加方式：

| 入口 | 行为 |
|-|-|
| 添加本地项目 | 弹出系统目录选择框；选中后自动识别 Git 根目录、当前分支与 origin。不是 Git 仓库时直接提示，不能用于创建 worktree |
| 添加 Git 项目 | 填写 ssh / http(s) 地址，自动 clone 到 `<RA_HOME>/repos/<项目名>`（默认 `~/.router-agent/repos`）；Orca 运行时再执行 `orca repo add --path ... --kind git` 登记，配置里写 `path:<绝对路径>` |

三种写法都支持：

| 写法 | 例子 | 说明 |
|-|-|-|
| displayName | `teamwork-repos` | 默认按 `name:` 匹配，最常用 |
| `name:` | `name:teamwork-repos` | 显式按名称 |
| `id:` | `id:3ee11f05-...` | 名称重名时按 id 精确匹配 |
| `path:` | `path:/Users/admin/du/teamwork-repos` | 按绝对路径 |

注意：只有 `kind: git` 的仓库能创建 worktree；`kind: folder`（纯文件夹项目）会在 `orca worktree create` 阶段失败。

另外，旧版的全局 `repo` 配置已移除（`ra` 不再读取它）。已有配置文件请改成 `projects`，`ra doctor` 会在没有任何项目时直接报错并给出命令。

### 模型配置

模型配置是**必填项**：必须在 `~/.router-agent/config.yaml` 的 `llm` 段（或 Web 面板的「LLM Provider」）配置 `baseUrl` / `model` / `apiKey`，三项缺一不可，否则服务启动直接报错。密钥只写不回显。也可以用 `RA_LLM_BASE_URL` / `RA_LLM_API_KEY` / `RA_LLM_MODEL` 覆盖。

> 服务未启动时 Web 面板打不开，首次配置可以直接写 `config.yaml`，或用 `ra config set llm.baseUrl ...` / `ra config set llm.model ...` / `ra config set llm.apiKey ...` 先落盘，再 `ra start`。会话自动压缩依赖 `llm.contextWindow`（默认 128000），换模型时记得同步改。

优先级：**环境变量 > `config.yaml`**。

图片消息转文本默认复用同一个模型；如果主模型不支持多模态，单独指定视觉模型即可（只覆盖图片链路，不影响研判）：

```yaml
llm:
  imageModel: qwen3-vl-plus
  imageBaseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1
  imageApiKey: sk-xxx
```

也可以用 `RA_LLM_IMAGE_MODEL` / `RA_LLM_IMAGE_BASE_URL` / `RA_LLM_IMAGE_API_KEY` 覆盖。`feishu.images.enabled: false` 可关闭图片转文本（回到「只回一句请补充文字」的行为）。

`llm.temperature` 只影响图片转写（默认 `0.1`），不参与研判。

### Worker 工具策略

`worker.tools` 是派给 worker 的工具基线（默认读写 + 白名单 shell）：

| 字段 | 取值 | 说明 |
|-|-|-|
| `fileAccess` | `read-only` / `read-write` | 只读时只给 `Read` / `Glob` / `Grep`，读写再加 `Write` / `Edit` |
| `shell` | `deny` / `allowlist` / `allow` | `allowlist` 时按 `shellAllow` 的命令前缀放行（如 `git` 放行 `git ...`） |
| `shellAllow` | 命令前缀数组 | 仅在 `shell: allowlist` 时生效 |
| `allowNetwork` | `true` / `false` | 预留字段：当前只解析，未用于收窄网络 |

它只对 `backend.default: claude-cli` 生效（映射成 Claude 的 `allowedTools`）；`orca` 后端里 worker 的权限由 Orca 启动的 Claude Code 自身决定。安全字段只能由这里和 adapter 内置基线决定，`backend.options` 写了同名键会直接启动失败。

### Worker 规范注入

`workerSpec.mode` 有两种：

- `prompt`：把 Worker 手册拼进启动 prompt（默认，已验证可行）。
- `agent`：只发工单，由全局 `~/.claude/agents/router-agent-worker.md` 提供规范（`ra init` 会生成）。

两种模式都不改项目自己的 `CLAUDE.md`。

### ACP Runtime（可选）

任何实现了 [Agent Client Protocol](https://agentclientprotocol.com) 的 Agent，都可以用同一套 `AcpRuntime` 接入，不需要为每家写适配器。ra 启动后会自动探测本机可用的 ACP Agent，Web 面板「配置 → 派工与服务 → Worker 运行时」里可以直接选择；未安装 / 版本不兼容 / 未登录的项会置灰并显示原因。

内置的 ACP 运行时 id：

| runtime id | Agent | 启动方式 | 可在线安装 | 说明 |
|-|-|-|-|-|
| `acp-claude` | Claude Code | `claude-agent-acp` | ✅ | 需先登录 Claude Code；支持 `session/load` |
| `acp-codex` | Codex | `codex-acp` | ✅ | 需本机 `codex` CLI；`codex-acp login`；不支持断线恢复 |
| `acp-opencode` | OpenCode | `opencode acp` | ❌ | 本机安装后自动识别 |
| `acp-gemini` | Gemini CLI | `gemini --acp` | ❌ | |
| `acp-copilot` | GitHub Copilot CLI | `copilot --acp --stdio` | ❌ | |
| `acp-cursor` | Cursor CLI | `cursor-agent acp` | ❌ | 旧版本可能没有 `acp` 子命令 |
| `acp-goose` | Goose | `goose acp` | ❌ | |

按需安装、探测与检查：

```bash
ra runtime list                    # 本机 ACP Agent 状态、版本、来源
ra runtime install acp-claude      # 装到 ~/.router-agent/runtimes/claude
ra runtime install acp-codex
ra runtime check acp-claude        # 完整 initialize + session/new 握手
ra runtime login acp-codex         # 交互式登录
ra runtime uninstall acp-codex
```

选好之后写进配置（也可以在 Web 面板直接选）：

```yaml
runtime:
  default: acp-codex
  # 可选：覆盖单个 Agent 的命令/参数/环境变量
  # options:
  #   acp-codex:
  #     command: /Users/me/.router-agent/runtimes/codex/node_modules/.bin/codex-acp
  #     args: ["--message-streaming"]
  #     env: {}
  projects:
    acp-codex:
      - name: router-agent
        repo: /Users/me/router-agent   # 非 orca runtime 必须是本地仓库绝对路径
        defaultBranch: main
```

旧的 `runtime.default: acp` + `runtime.options.acp.command` 仍然可用，作为「自定义命令」入口保留。

`AcpRuntime` 负责：spawn Agent 子进程 → `initialize` → `session/new` → `session/prompt`；从 `session/update` 读取助手文本与工具调用；把 Agent 的 `session/request_permission` 按 `worker.tools` 策略自动放行或拒绝；进程退出后，若 Agent 声明 `loadSession`，追问时会用 `session/load` 恢复会话。

当前不做客户端侧的 `fs/*` 与 `terminal/*` 代理：`initialize` 里声明不支持，Agent 需使用自己的文件/命令工具。Agent 必须预先完成登录（ACP 的 `auth_required` 会以启动失败上报）。`codex-acp` 需要加上 `--message-streaming` 才能在活动面板看到文本输出（目录里已默认带上）。

## 命令

| 命令 | 说明 |
|-|-|
| `ra init` | 交互式初始化（`--yes` 跳过提问） |
| `ra doctor` | 启动前自检：配置 / Orca / 飞书 / 模型 / 端口（`--json` 机器可读） |
| `ra simulate` | 本地模拟一条消息，验证 Gate + Pi 研判，不派工（`--infer` 走 Pi 研判，`--dry-run` 不落库） |
| `ra start [--foreground]` | 启动常驻服务（默认后台），就绪后自动打开 Web 初始化页；`--no-open` 只打印地址 |
| `ra stop` | 停止服务 |
| `ra status` | 服务状态 + 工单概览 |
| `ra web` | 重新打开 Web 面板 |
| `ra tickets [--stage]` | 列出工单 |
| `ra ticket <id>` | 工单详情（状态 / 派工 / 上报 / 输入） |
| `ra logs` | 最近 50 行日志 |
| `ra runtime [list]` | 探测本机 ACP Agent：状态、版本、来源；`--json` 机器可读 |
| `ra runtime install <id>` | 按需安装 ACP 适配器到 `~/.router-agent/runtimes/<agent>` |
| `ra runtime uninstall <id>` | 卸载 ra 托管的 ACP 适配器 |
| `ra runtime check <id>` | 完整 ACP 握手（`initialize` + `session/new`） |
| `ra runtime login <id>` | 交互式登录（目前是 `codex-acp login`） |
| `ra config` | 查看配置；`config set <key> <value>` 改单项（含 `project.<名>` / `chatBinding.<群>` / `chatMode.<群>` / `chatSync.<群>` / `chatAllow.<群>` / `progress.syncMs` / `progress.probeMs`）；`config edit` 编辑全文 |

全局选项 `--home <dir>` 可切换状态目录（测试与多实例用）。

## 准入规则

| 场景 | off | observe | auto |
|-|-|-|-|
| 名单内、@bot / 私聊 | 显式接单 | 显式接单 | 显式接单 |
| 名单内、未 @ | 只回复说明 | 研判但不开工 | 研判通过开单 |
| 名单外、@bot | 只回复说明 | 研判但不开工 | 研判通过开单 |
| 名单外、未 @ | 忽略 | 忽略 | 忽略 |

准入表在 `config.yaml` 的 `policy.admission` 里逐格调整：

| 配置项 | 对应场景 | 可取值 | 默认 |
|-|-|-|-|
| `policy.admission.listedNotAddressed` | 名单内、未 @ | `inferred` / `ignore` | `inferred` |
| `policy.admission.unlistedAddressed` | 名单外、@bot | `explicit` / `inferred` / `ignore` | `inferred` |
| `policy.admission.unlistedNotAddressed` | 名单外、未 @ | `inferred` / `ignore` | `ignore` |

`inferred` 进入研判（再由 `acceptMode` 决定 observe 时是否真的开工），`explicit` 直接按显式请求开单，`ignore` 直接丢弃。这三项属于 `policy.*`：Web 面板保存后立即生效；`ra config set` 写的是文件，重启服务后生效。

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
旧版本八阶段（`draft/accepted/assigned/running/review/person/idle/closed`）的历史数据迁移见 [docs/TICKET-STAGE-MIGRATION.md](docs/TICKET-STAGE-MIGRATION.md)。

## 闲置工单治理

长时间没有新进展的工单会被自动收口，避免工单和 Orca workspace 越积越多：

- **24 小时没有任何新进展**（worker 上报 / 用户输入 / 派工启动）→ 在话题里发一次关单提醒；
- **提醒后 6 小时仍无回复** → 自动关闭工单，并关闭终端、删除对应的 worktree；脏工作区不强删，会通知人工；
- **PR 仍开着** → 只催办一次，不自动关闭；
- **执行中但 6 小时无上报且终端无输出** → 转人工，不自动关闭；
- **已关闭话题再次被回复** → 固定回复「工单已关闭」；回复「重新开工」会基于原工单的仓库 / 起点分支创建新工单，并带上之前描述的需求。

```bash
ra config set retention.enabled false        # 关闭
ra config set retention.idleHours 48         # 多久无进展提醒
ra config set retention.closeGraceHours 12   # 提醒后多久自动关闭
ra config set retention.zombieHours 6        # 僵尸判定
ra config set retention.sweepMinutes 5       # 扫描间隔
```

`ra status` 会显示当前治理阈值；阈值改动需要重启服务后生效。

## Worker 上报协议

Worker **不手写状态文件**，统一用 `ra report` 上报。CLI 会 POST 给本地 Router（`POST /api/reports`）；服务不可达时自动落盘到 `~/.router-agent/workers/<ticketId>/state.json`，由 poller 在 1 秒内捡起。

```bash
ra report \
  --ticket tk-12 \
  --state progress|waiting|ready|blocked|failed|dropped \
  --summary "一句话摘要" \
  --reply @answer.md \
  --pr-number 12 --pr-url "https://github.com/o/r/pull/12" \
  --human-action "blocked 时要人做的事" \
  --ack in_xxx
```

| 参数 | 说明 |
|-|-|
| `--summary` | 一句话摘要，只给日志和列表用 |
| `--reply` | 用户真正看到的完整内容（Markdown），支持字面量、`@文件`、`-`（stdin） |
| `--pr-number` / `--pr-url` | 代码类交付时附 PR 编号与链接 |
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

## HTTP API

| 方法 | 路径 | 说明 |
|-|-|-|
| GET | `/api/status` | 服务与工单概览 |
| GET | `/api/tickets?stage=&limit=` | 工单列表 |
| GET | `/api/tickets/:id` | 工单详情 |
| POST | `/api/tickets/:id/input` | 投递 follow-up |
| POST | `/api/tickets/:id/stop` | 停止工单 |
| POST | `/api/tickets/:id/assignment` | 手工绑定 Assignment |
| POST | `/api/reports` | Worker 上报状态与回复（`ra report` 的入口） |
| GET / PUT | `/api/policy` | 读写策略（保存后落盘） |
| GET / PUT | `/api/config` | 配置面板：读安全快照 / 按点路径提交补丁（白名单校验 + 落盘） |
| POST | `/api/restart` | 热重启 daemon：先返回 202，再释放端口并拉起新进程（页面不刷新） |
| GET | `/api/sources/feishu/chats` | 飞书来源配置 |
| GET | `/api/logs?cursor=&limit=` | 面板日志页：不带 `cursor` 回看尾部若干行，带上后只返回新增行 |
| POST | `/api/projects/pick-directory` | 打开系统目录选择框（添加本地项目） |
| POST | `/api/projects/inspect` | 识别目录是否为 Git 仓库、当前分支与 origin |
| POST | `/api/projects/register` | 本地项目登记（Orca 运行时执行 `orca repo add`） |
| POST | `/api/projects/clone` | Git 项目：clone 到 `<RA_HOME>/repos` 并按需登记 Orca |

## 开发

```bash
pnpm test        # 466 个测试通过（5 个默认跳过，其中包含真实 Pi 验证）
pnpm typecheck
pnpm build       # tsc + esbuild（Web 面板与 Markdown 资产）
pnpm check       # typecheck + test
RA_PI_VERIFY=1 npx vitest run tests/verify-pi-live.test.ts   # 真实 Pi + 真实模型（默认跳过）
```

发布 npm 包由 GitHub Actions 自动完成：合并到 `main` 后若 `package.json` 版本尚未发布则自动发布
（也支持推送 `v*` tag 或手动触发），配置与发版流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

代码结构：

```text
src/core/     领域内核（model / stage / policy / engine / effects）
src/store/    SQLite（node:sqlite）
src/worker/   WorkerRuntime 端口、RuntimeRegistry、OrcaRuntime、ClaudeCodeRuntime、AcpRuntime、state.json 轮询、worker 手册
src/sources/  飞书事件、GitHub PR 跟踪
src/router/   AgentLoop、工具契约、提示词、HTTP API
src/web/      React 面板
src/cli/      ra 命令
```

## 已知限制

- 第一版只支持 macOS（Linux 上裸 `orca` 会撞 GNOME 屏幕阅读器，需要 `orca-ide`）。
- 不做自动合并 PR，只跟踪与通知。
- GitHub Source 只用于 PR 状态跟踪，不消费 Issue / 评论。
- 上报走 `ra report`，`state.json` 只作为服务不可达时的兜底通道。
- 图片会下载并落盘到 `/tmp/ra-images/`，原图路径透传给 Worker（可直接查看）；同时用多模态模型转成文字供研判。文件 / 语音等其它附件只识别到「这是一条附件消息」，需要内容时请用文字描述。
- 图片转文本依赖模型支持 image 输入；主模型不支持时请在 `llm.imageModel` 单独配置视觉模型。单张转写失败时原图仍会落盘并透传，研判只能看到占位说明；`feishu.images.enabled: false` 则整条图片链路关闭。
- 实测 Orca 的 `lastOutputAt` 是毫秒数字、且 CLI 创建的终端可能 `orphaned=true` 但依然可用；适配层已分别做归一化与「只有 `connected=false` 才判死」的处理。
- `workerSpec.mode: agent` 依赖 Orca 启动的 claude 是否加载全局 `~/.claude/agents/`；该前提尚未实测，默认使用已验证可行的 `prompt` 模式。
- Claude Code 运行时用 `git worktree`，项目清单与 Orca 隔离（`runtime.projects.claude-code`），`repo` 必须是本地仓库绝对路径（`path:/abs` 或 `/abs`）；`ra init` 在 `runtime.default: claude-code` 时会直接问路径。切换运行时后，没有对应清单项目的工单会先追问，不会把 Orca 选择器当路径用。
- Claude Code 运行时启动时带 `--dangerously-skip-permissions`，正常情况下不会因权限确认阻塞；若仍进入 `blocked`（例如等待人工输入），只转人工，不自动 resume。追问在当前轮结束后生效（与 TUI 输入排队一致）；需要轮内实时插话时要改用 `stream-json` 或 SDK/ACP。
- Claude Code 依赖 `claude agents --json --all` 的字段（本仓库实测 `2.1.318`）；升级后字段变化时状态会退化为 `null`，需要按版本适配。
- 派工草稿按「群 + 同一个人」保存，30 分钟有效；同一个群里的多个未补齐请求会互相覆盖（后一次追问覆盖前一次）。
- Pi SDK 仍在演进，本仓库锁定 `@earendil-works/pi-coding-agent@1.5.0`，升级前先跑 `RA_PI_VERIFY=1` 的真实环境验证。
- Pi 是唯一研判引擎，没有回退到旧实现的开关；Pi 不可用时候选会按 `unavailable` 落库，不会静默重试。

## 文档

| 文档 | 内容 |
|-|-|
| [docs/COMPARISON.md](docs/COMPARISON.md) | 与 dsh-superagent 原型的差距分析与可迁移机制 |
| [docs/AGENT-ADAPTER-DESIGN.md](docs/AGENT-ADAPTER-DESIGN.md) | Agent 工具适配器接口设计：Orca / Claude Code / Codex 的契约与迁移方案 |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | 真实环境验证记录与需要人工执行的剩余步骤 |
| [docs/show-me-router-flow.html](docs/show-me-router-flow.html) | 消息 → 研判 → 派工 → 上报 → 闭环的可视化流程 |
| [README.en.md](README.en.md) | English version |

设计蓝本见飞书文档《router-agent（ra）技术设计方案》。

---

问题、建议或想接入新的 WorkerRuntime，欢迎提 Issue。