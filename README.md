# router-agent（`ra`）

> 飞书消息 → 常驻 Router 研判 → 派发到 Orca worktree 内的 Claude Code 执行 → PR 跟踪闭环。
> 绿色重写，**不依赖** dsh-superagent 的 tmux / DSE profile。

## 它做什么

1. **听**：常驻消费飞书群 / 私聊消息，按名单与 `@` 规则做确定性准入。
2. **判**：未被直接指派的候选交给 LLM 研判（可批量），输出 `accept / stop / ignore / unavailable` 四类决定。
3. **派**：接单后创建工单与授权（Mandate），先确认「项目 + 起始分支」，再通过 `orca worktree create --repo ... --base-branch ...` 开一个独立 worktree + Claude Code 终端。缺项目或分支时不开单，先在会话里追问（群配置里可固定项目和分支，免问答）。
4. **跟**：Worker 用 `ra report` 上报（失败自动落盘 `state.json`），Router 刷新工单阶段；PR 合并 / 关闭后闭环并通知发起人。

设计蓝本见飞书文档《router-agent（ra）技术设计方案》。

## 架构

```text
Sources（飞书 / GitHub）
        │ Trigger
        ▼
Router（AgentLoop + 工具 + HTTP API + Web）
        │ Engine（唯一状态写入口）
        ▼
领域内核（TS 零依赖：Ticket / Mandate / Assignment / Stage / Policy）
        │ Assignment
        ▼
WorkerBackend 端口 ── OrcaAdapter（默认）── 未来：Codex / Headless Claude
```

关键约束：

- **Engine 是唯一状态写入口**：Router、Worker、面板都不直接写 SQLite。
- **WorkerBackend 是唯一扩展点**：换后端只加一个 adapter，内核与 Router 一行不改。
- **所有对外通知走 Outbox**：幂等 key + 2s 起步的指数退避（上限 60s）。
- **不解析终端屏幕文本**：只读 Orca 的结构化字段（`connected` / `orphaned` / `lastOutputAt`）。

## 快速开始

```bash
pnpm install --registry=https://registry.npmjs.org/
pnpm build

ra init                 # 交互式引导：仓库 → 机器人 → 群 → 授权成员，一条命令装完
ra start                # 后台常驻
ra status
ra web                  # 打开面板
```

`ra init` 只问必填项，其余参数写成默认值，后续用 `ra config set <key> <value>` 调整：

```bash
ra config set policy.acceptMode observe   # 先观察，不开工
ra config set policy.maxWorkers 2
ra config set workerSpec.mode agent
ra config --edit                          # 直接编辑整份配置
```

`ra` 是 `pnpm link --global` 后可用，也可以直接 `node bin/ra.js <command>`。

## 配置

`~/.router-agent/config.yaml`（`ra config` 可查看）：

```yaml
feishu:
  larkHome: ""         # 专属机器人的独立 lark-cli 配置目录；空=复用当前 profile
  appId: ""            # 专属机器人 App ID（App Secret 只存 lark-cli 加密存储）
  reaction: "Typing"   # 收到消息立即回的确认表情（飞书 emoji_type；空字符串关闭）
  # 监控的群：一条配置同时决定「收什么消息 + 派工绑定 + 是否补拉历史」
  chats:
    - chat: oc_xxx     # 群 chat_id
      mode: all        # all=全部消息；mention=只收 @机器人
      repo: router-agent   # 可选：群绑定项目（项目名或仓库选择器）
      branch: main         # 可选：群绑定起始分支
      sync: false          # 可选：启动时补拉该群历史
      allowed: [ou_xxx]    # 可选：本群只允许这些人操作（空=沿用全局 allowed）
  directMessages: true
  allowed: []          # 允许发起工作的 open_id
  bots: []             # 允许产生推断候选的机器人
  botOpenIds: []       # 机器人自己的 open_id / app_id
  botNames: []         # 机器人显示名

policy:
  acceptMode: auto     # off / observe / auto
  maxWorkers: 4

workerSpec:
  mode: prompt         # prompt | agent

backend:
  default: orca

# 项目清单：开单前必须确认「哪个项目 + 哪个起始分支」
projects: []
#  - name: router-agent            # 用户/模型引用的项目名
#    repo: name:dsh/router-agent   # 交给 Orca 的仓库选择器
#    defaultBranch: main           # 未指定分支时使用；留空则每次开工前追问
#    branches: [main, release]     # 可选：允许的起始分支白名单

server:
  port: 3083
```

### 专属机器人（推荐）

`ra init` 的「飞书机器人」一步提供两种专属机器人方式，都不需要手动敲 `lark-cli`：

`ra init` 用交互式选择器引导（方向键选择、空格多选、密码输入不回显）：

| 选项 | 行为 |
|-|-|
| 2) 已有 App ID / App Secret | 输入后 `ra init` 内部执行 `lark-cli config init --app-id ... --app-secret-stdin`，写进 `feishu.larkHome` 指定的独立目录；Secret 走 stdin，不落 argv、不写 config.yaml |
| 3) 现在新建应用 | `ra init` 内部执行 `lark-cli config init --new`，浏览器完成创建后自动回读 appId |

之后如果需要用户身份（按名字搜索群/成员），`ra init` 会检测并询问是否立刻执行 `lark-cli auth login`。

命令与选项均由 `commander` 解析：`ra --help`、`ra init --help`、`ra tickets --help` 可查用法。

机器人凭据由 lark-cli 的加密存储管理，`router-agent` 只保存 `larkHome` 与 `appId`。
运行期所有 lark-cli 子进程（事件消费、发消息、补拉、群名刷新）都会带上 `HOME=<larkHome>`，
与其它 agent 的 lark-cli profile 完全隔离。

### 项目与仓库选择

每个 `projects[].repo` 决定该工单 `orca worktree create --repo` 的目标。先看 Orca 里注册了哪些：

```bash
orca repo list --json | jq -r '.result.repos[] | "\(.displayName)\t\(.path)\t\(.kind)"'
```

三种写法都支持：

| 写法 | 例子 | 说明 |
|-|-|-|
| displayName | `teamwork-repos` | 默认按 `name:` 匹配，最常用 |
| `name:` | `name:teamwork-repos` | 显式按名称 |
| `id:` | `id:3ee11f05-...` | 名称重名时按 id 精确匹配 |
| `path:` | `path:/Users/admin/du/teamwork-repos` | 按绝对路径 |

注意：只有 `kind: git` 的仓库能创建 worktree；`kind: folder`（纯文件夹项目）会在 `orca worktree create` 阶段失败。

### 多项目与多分支派工

开单需要三个要素：**任务、项目（repo）、起始分支（branch）**。三者都明确，Router 才会建单；缺项目或分支时它**不会开单**，而是在会话里追问：

```
用户：@bot 把登录超时改成 30 秒
Router：要改哪个项目、从哪个分支开始？可选项目：router-agent、super-agent
用户：router-agent，从 release 开始
Router：好的，我帮你创建了工单「调整登录超时」…
```

- 追问期间请求会记成**派工草稿**（按群 + 同一个人，30 分钟内有效），用户补齐后直接开单，不用复述任务。
- 项目/分支的取值优先级：**本条消息明确说的 > 群配置里的绑定 > 上次草稿 > 唯一项目的 `defaultBranch`**。
- 起始分支会传给 `orca worktree create --base-branch <ref>`；worker 的 worktree 就从该分支切出。
- 用户说的项目不在 `projects` 清单里、或分支不在 `branches` 白名单里，Router 会带着可选值再问一次，不会猜。

**群绑定（免问答）**：群配置本身同时承担「监控」和「派工绑定」，一条就够：

```bash
# 命令行
ra config set project.router-agent "name:dsh/router-agent@main"
ra config set chatBinding.oc_xxx "router-agent@main"   # 绑定同时意味着监控该群
ra config set chatMode.oc_xxx mention                  # 可选：只收 @ 消息
ra config set chatSync.oc_xxx true                     # 可选：启动时补拉历史
```

对应的 YAML：

```yaml
feishu:
  chats:
    - chat: oc_xxx
      mode: all
      repo: router-agent
      branch: main
```

绑定后该群开工不再追问项目/分支；没写 `repo`/`branch` 的群仍会按上面的规则追问。

**群级白名单**：`allowed` 非空时，这个群**只有名单内的人能触发**——名单外的人 @ 机器人也会被静默忽略（不进研判、不回复、不开单），并且覆盖全局 `feishu.allowed`。

```bash
ra config set chatAllow.oc_xxx "ou_alice,ou_bob"
ra config set chatAllow.oc_xxx ""          # 清空，回到全局 allowed
```

> 注意：全局 `feishu.allowed` 只区分「显式 / 推断」，名单外的人 @ 机器人默认仍可能被研判接单；要严格限制某群人，请用群级 `allowed`。

**注意**：旧版的全局 `repo` 配置已移除（`ra` 不再读取它）。已有配置文件请改成 `projects`，`ra doctor` 会在没有任何项目时直接报错并给出命令。

**模型配置**会自动复用 `~/.trove/config.json` 里的 `llm` 段（`baseUrl` / `model` / `apiKey`）；
也可以在本文件写 `llm:` 段，或用 `RA_LLM_BASE_URL` / `RA_LLM_API_KEY` / `RA_LLM_MODEL` 覆盖。
优先级：环境变量 > `config.yaml` > `.trove`。

## 启动与验证

```bash
ra doctor                      # 1. 自检：全绿再往下
ra start                       # 2. 后台启动
ra status                      # 3. 确认 pid 与工单概览
ra logs | tail -20             # 4. 看到 api:listening / feishu:ready

ra simulate --infer --text "把 README 的端口从 3000 改成 3083"   # 5. 不依赖飞书，验证研判
ra tickets                     # 6. 模拟产生的工单应出现在这里
```

真实验收：

1. 在群里 @机器人 提一个小需求；
2. `ra logs | grep trigger:ingested` 确认消息进来了；
3. `ra tickets` 出现工单，`ra ticket <id>` 看授权范围与强度；
4. `orca worktree list --json` 出现 `ra-t<编号>`，分支名为 `ra/<编号>-<语义slug>`，Orca 里出现 Claude Code 终端；
5. worker 执行 `ra report` 后，`ra ticket <id>` 的阶段在 `running → review/person` 之间变化；
6. 合并或关闭 PR 后，工单变 `closed`，飞书收到一次闭环通知。

### 闲聊与回复

Router 不做对话，只在必要时说话：

| 场景 | 行为 |
|-|-|
| **任意被监听的消息** | 收到后**立即**加一个确认表情（默认 `Typing` ⌨️），回复发出后自动取消 |
| 群里 @机器人，但只是寒暄/试探 | **LLM 生成**一句礼貌回复，作为**普通消息**发出；不建单 |
| 群里 @机器人，是真需求 | 普通消息回 ack「我帮你创建了工单「标题」」+ 用**话题**开场：「后续进展会在这个话题里更新」 |
| 未 @ 的群消息 | 走 LLM 研判；判为闲聊则**完全静默**（不刷屏） |
| 私聊 | 走 LLM 研判；判为闲聊时用 LLM 礼貌回复（普通消息） |
| 只发了图片 / 文件（没有文字） | **不开单**：@ 或私聊时回一句「看不到附件内容，请用文字说明」，不烧模型调用 |
| 系统消息（建群 / 拉人 / 改群名） | 直接丢弃，不进领域 |
| 互动卡片消息 | 直接丢弃（`content` 是原始卡片 JSON，不能当需求读） |
| 研判没完成（unavailable） | 若在跟它说话，用 LLM 追问一句 |
| `acceptMode: off` 的推断候选 | 固定说明「暂不自动开工」 |
| worker 卡住 / 有结果 / PR 合并关闭 | 一律作为**话题回复**同步到原消息下 |
| worker 交付结论 | 以**飞书卡片**渲染 `--reply` 的 Markdown 回话题；有文档/PR 链接一并展示 |

- 显式请求也会过一次研判（`conversation.md` / `admission.md` 提示词），不是命中名单就无脑开工；
- 明显寒暄走规则短路，不再额外调用模型；
- 确认表情是 best-effort：失败只记 `feishu:reaction-failed`，不影响研判；
  只对首次入库、且是在跟它说话（@ / 私聊）的消息加；补拉与重放不会重复加；
- 回复发出后自动撤销该表情（`feishu:unreact-failed` 是撤销失败的日志）；`ra config set feishu.reaction ""` 可关闭。
- 全部 emoji_type 见飞书文档「表情文案」，注意**大小写敏感**（`Typing` 不是 `TYPING`）。
- 出站统一用飞书**互动卡片**渲染 Markdown；卡片失败自动降级为 post 富文本。分流规则：`threadId` 为空 = 普通消息，有值 = 话题回复。

### 日志能追到哪一步

所有关键节点都是结构化 JSON，一行一个事件（`at` / `level` / `message` + 业务字段）：

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
| `outbox:sent` / `outbox:failed` | Outbox | `key` `text` / `error` | 对外通知结果 |
| `api:input` / `api:stop` / `api:policy` | HTTP API | — | 面板/CLI 的操作 |
| `idle:nudge` / `idle:stale` | Service | — | 空闲唤醒与失联标记 |
| `pr:linked` / `pr:state` | Service | — | PR 跟踪 |
| `recover:*` | Service | — | 重启对账 |

worker 终端里的原始输出**不进日志**（避免解析 TUI 文本）；要看它做了什么，读 `report` 的 `summary` 与
`~/.router-agent/workers/<ticketId>/events.log`。

**同一机器人只能有一个事件总线在跑。** 如果 `ra logs` 出现
`another event bus is already connected`，先停掉其它占用该应用的消费者，
或用 `ra init` 的「专属机器人」选项给 router-agent 单独配一个。

## 命令

| 命令 | 说明 |
|-|-|
| `ra init` | 交互式初始化（`--yes` 跳过提问） |
| `ra doctor` | 启动前自检：配置 / Orca / 飞书 / 模型 / 端口（`--json` 机器可读） |
| `ra simulate` | 本地模拟一条消息，验证 Gate + 研判，不派工（`--infer` 走 LLM，`--dry-run` 不落库） |
| `ra start [--foreground]` | 启动常驻服务（默认后台） |
| `ra stop` | 停止服务 |
| `ra status` | 服务状态 + 工单概览 |
| `ra web` | 打开 Web 面板 |
| `ra tickets [--stage]` | 列出工单 |
| `ra ticket <id>` | 工单详情（状态 / 派工 / 上报 / 输入） |
| `ra logs` | 最近 50 行日志 |
| `ra config` | 查看配置；`config set <key> <value>` 改单项（含 `project.<名>` / `chatBinding.<群>`）；`config --edit` 编辑全文 |

全局选项 `--home <dir>` 可切换状态目录（测试与多实例用）。

## 准入规则

| 场景 | off | observe | auto |
|-|-|-|-|
| 名单内、@bot / 私聊 | 显式接单 | 显式接单 | 显式接单 |
| 名单内、未 @ | 只回复说明 | 研判但不开工 | 研判通过开单 |
| 名单外、@bot | 只回复说明 | 研判但不开工 | 研判通过开单 |
| 名单外、未 @ | 忽略 | 忽略 | 忽略 |

准入表可在 `config.yaml` 的 `policy.admission` 里逐格调整。

## 工单编号与分支命名

- 工单号是全局自增的短编号：`T1`、`T2`……，重启后从上次的值继续，旧库里的 `tk_<uuid>` 仍可正常查询。
- 创建工单的确认消息、话题开场以及后续状态通知都会带上这个短编号，例如「工单 T12 已完成」。
- Orca worktree 名：`ra-t<编号>`，目录短且纯 ASCII。
- 工作分支：`ra/<编号>-<语义 slug>`，由工单标题提炼任务语义；标题里有足够英文时优先用英文，纯中文标题保留中文本身（git 支持 UTF-8 分支名）：
  - `ra/T12-fix-login-timeout`
  - `ra/T13-调整登录超时`
- 工单上的 `branch` 表示**起始分支**；工作分支通过 `orca worktree create --branch` 单独指定，不再叠加 Orca 的用户前缀与 UUID。

## 工单阶段

`draft → accepted → assigned → running → review → closed`，可在 `person`（等人）与 `idle`（空闲）之间来回。
PR 仍处于 open 时禁止结束工单。

## Worker 上报协议

Worker **不手写状态文件**，统一用 `ra report` 上报。CLI 会 POST 给本地 Router（`POST /api/reports`）；
服务不可达时自动落盘到 `~/.router-agent/workers/<ticketId>/state.json`，由 poller 在 1 秒内捡起。

```bash
ra report \
  --ticket T12 \
  --state progress|waiting|ready|blocked|failed|dropped \
  --summary "一句话摘要" \
  --reply @answer.md \
  --pr-number 12 --pr-url "https://github.com/o/r/pull/12" \
  --human-action "blocked 时要人做的事" \
  --ack in_xxx
```

- `--reply` 是**用户真正看到的完整内容**（Markdown），支持字面量、`@文件`、`-`（stdin）。
- `--summary` 只放一句话；只给 summary 会被提示「回复不完整」。
- Router **只发送 `--reply` 原文**，不判断形态、不改写：里面有 PR 链接就是 PR，有文档链接就是文档。
- 需要长文档时，worker 自己执行 `ra doc --title "…" --content @answer.md`，拿到链接后写进 `--reply`。
- 追问以 `【Router 输入 in_xxx】` 前缀投递；worker 用 `--ack in_xxx` 确认，否则会被反复重投。
- Router 每轮按文件变化增量读取（`state.json` 兜底通道），成功后调 `Engine.report()`。
- 终端长时间无输出 → 主动发 `status?`；仍无响应 → 标记 stale 并通知人。
- 审计事件追加到同目录 `events.log`。

两种规范注入模式（`workerSpec.mode`）：`prompt` 把手册拼进启动 prompt；`agent` 只发工单，由全局
`~/.claude/agents/router-agent-worker.md` 提供规范（`ra init` 会生成）。两种模式都不改项目 `CLAUDE.md`。

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
| GET / PUT | `/api/policy` | 读写策略 |
| GET | `/api/sources/feishu/chats` | 飞书来源配置 |

## 开发

```bash
pnpm test        # 258 个测试（TDD 写成）
pnpm typecheck
pnpm build       # tsc + esbuild（Web 面板与 Markdown 资产）
pnpm check       # typecheck + test
```

代码结构：

```text
src/core/     领域内核（model / stage / policy / engine / effects）
src/store/    SQLite（node:sqlite）
src/worker/   WorkerBackend 端口、OrcaAdapter、state.json 轮询（CLI 兜底通道）、worker 手册
src/sources/  飞书事件、历史补拉、GitHub PR 跟踪
src/router/   AgentLoop、工具契约、提示词、HTTP API
src/web/      React 面板
src/cli/      ra 命令
```

## 已知限制

- 第一版只支持 macOS（Linux 上裸 `orca` 会撞 GNOME 屏幕阅读器，需要 `orca-ide`）。
- 不做自动合并 PR，只跟踪与通知。
- GitHub Source 只用于 PR 状态跟踪，不消费 Issue / 评论。
- 上报走 `ra report`，`state.json` 只作为服务不可达时的兜底通道。
- 图片 / 文件只识别到「这是一条附件消息」，不下载、不做多模态识别；需要内容时请用文字描述。
- 历史补拉按群游标增量进行：首次见到某个群只记基线（最新一条消息时间），不会把历史消息当新需求。
- 实测 Orca 的 `lastOutputAt` 是毫秒数字、且 CLI 创建的终端可能 `orphaned=true` 但依然可用；
  适配层已分别做归一化与「只有 `connected=false` 才判死」的处理。
- `workerSpec.mode: agent` 依赖 Orca 启动的 claude 是否加载全局 `~/.claude/agents/`；
  该前提尚未实测，默认使用已验证可行的 `prompt` 模式。
- 派工草稿按「群 + 同一个人」保存，30 分钟有效；同一个群里的多个未补齐请求会互相覆盖（后一次追问覆盖前一次）。

验证细节与需要人工执行的剩余步骤见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。
