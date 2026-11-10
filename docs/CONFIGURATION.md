# 配置参考

配置文件是 `~/.router-agent/config.yaml`（`ra config` 可查看）。本文是完整字段说明；快速开始只需要 Web 初始化页或 `ra init` 配好 LLM、运行时、项目、机器人、群绑定五项。

## 完整示例

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
  default: orca            # orca | claude-code | acp | acp-*（非 orca 运行时的项目必须是本地路径，见 RUNTIME.md）
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

## 逐项修改（`ra config set`）

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
| `runtime.default` | `orca` / `claude-code` / `acp` / `acp-*` |
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

`router.session.*`、`router.persona.*`、`feishu.images.*` 不在 `config set` 的白名单里，用 `ra config edit` 或 Web 面板改；`worker.tools.*` 与 `runtime.options.*` 面板不提供，只能 `ra config edit` 直接改文件。

## 环境变量

| 变量 | 作用 |
|-|-|
| `RA_HOME` | 状态目录，等价于全局选项 `--home`；默认 `~/.router-agent` |
| `RA_PORT` | `ra report` 的上报端口，覆盖 `server.port` |
| `RA_LLM_BASE_URL` / `RA_LLM_API_KEY` / `RA_LLM_MODEL` | 覆盖研判模型连接信息（优先级最高） |
| `RA_LLM_IMAGE_BASE_URL` / `RA_LLM_IMAGE_API_KEY` / `RA_LLM_IMAGE_MODEL` | 覆盖图片转写模型 |

优先级：**环境变量 > `config.yaml`**。

## 模型配置

模型配置是**必填项**：必须在 `~/.router-agent/config.yaml` 的 `llm` 段（或 Web 面板的「LLM Provider」）配置 `baseUrl` / `model` / `apiKey`，三项缺一不可，否则服务启动直接报错。密钥只写不回显。也可以用 `RA_LLM_BASE_URL` / `RA_LLM_API_KEY` / `RA_LLM_MODEL` 覆盖。

默认走 OpenAI 兼容协议（`/chat/completions`）。如果网关是 Anthropic 兼容（Claude Code / CCSwitch 里常见的 `ANTHROPIC_BASE_URL`），加两项：

```yaml
llm:
  baseUrl: https://gateway.example.com
  model: claude-sonnet-demo
  apiKey: sk-xxx
  api: anthropic-messages   # 默认 openai-completions
  authHeader: true          # 密钥用 Authorization: Bearer 发送（ANTHROPIC_AUTH_TOKEN）
```

`authHeader` 只在 `api: anthropic-messages` 时生效：用 `ANTHROPIC_AUTH_TOKEN` 的网关开启，用 `ANTHROPIC_API_KEY`（x-api-key）的网关保持关闭。Web 初始化页 / 配置页的「接口协议」「密钥用 Bearer 发送」对应这两项。

**从本地配置导入**：Web 初始化页「LLM Provider」下方的「扫描本地配置」会只读检查以下位置，把 Base URL / 模型 / 密钥齐全的 Provider 列出来，点「导入」直接写回 `config.yaml`（密钥在服务端读取，不会回显到页面）：

| 来源 | 路径 | 说明 |
|-|-|-|
| Claude Code | `~/.claude/settings.json` 的 `env` | 识别 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`（含 `ANTHROPIC_DEFAULT_*_MODEL`） |
| CCSwitch | `~/.cc-switch/cc-switch.db`（SQLite `providers` 表）与旧版 `~/.cc-switch/config.json` | 支持 claude（Anthropic 兼容）以及 opencode / openclaw / pi 这类 `baseUrl + apiKey + models` 结构 |
| Pi | `~/.pi/agent/models.json` | 读取 `providers` 下的模型清单，`apiKey` 支持 `$ENV` 引用 |

导入只新增或覆盖 `llm` 段的连接信息，不改动本地原配置；导入后需要重启服务生效。

> 服务未启动时 Web 面板打不开，首次配置可以直接写 `config.yaml`，或用 `ra config set llm.baseUrl ...` / `ra config set llm.model ...` / `ra config set llm.apiKey ...` 先落盘，再 `ra start`。会话自动压缩依赖 `llm.contextWindow`（默认 128000），换模型时记得同步改。

图片消息转文本默认复用同一个模型；如果主模型不支持多模态，单独指定视觉模型即可（只覆盖图片链路，不影响研判）：

```yaml
llm:
  imageModel: qwen3-vl-plus
  imageBaseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1
  imageApiKey: sk-xxx
```

也可以用 `RA_LLM_IMAGE_MODEL` / `RA_LLM_IMAGE_BASE_URL` / `RA_LLM_IMAGE_API_KEY` 覆盖。`feishu.images.enabled: false` 可关闭图片转文本（回到「只回一句请补充文字」的行为）。

> 图片转写目前只走 OpenAI 兼容的 `/chat/completions`。如果主模型是 `anthropic-messages` 且没有单独配置 `imageBaseUrl` / `imageApiKey`，请同时配置一个 OpenAI 兼容的视觉模型，或关闭 `feishu.images.enabled`。

`llm.temperature` 只影响图片转写（默认 `0.1`），不参与研判。

## 飞书机器人（专属 profile）

router-agent 固定使用 `~/.router-agent-lark` 作为 lark-cli profile，**不复用**你终端里其它 lark-cli 的登录态，也不能通过配置修改这个目录。凭据与授权有两个入口：

| 入口 | 行为 |
|-|-|
| Web 配置页 | 「飞书机器人」区块填写 App ID / App Secret；Secret 走 `lark-cli config init --app-secret-stdin` 写入 lark-cli 加密存储，不落 argv / config.yaml。同页可检查 bot / user 状态，并发起 Device Flow 授权。 |
| `ra init` | 交互式选择「已有 App ID / App Secret」或「现在新建应用」；也可以选择跳过，稍后在 Web 配置页补填。 |

之后如果需要用户身份（按名字搜索群 / 成员、创建文档），在 Web 配置页点「开始授权」完成授权，或由 `ra init` 询问后执行 `lark-cli auth login`。授权只申请 **IM（消息 / 群 / 成员）、云文档、云空间、通讯录** 四个业务域，不再请求日历、邮箱、审批等无关权限。

机器人凭据由 lark-cli 的加密存储管理，`router-agent` 只在 `config.yaml` 保存 `appId`。运行期所有 lark-cli 子进程（事件消费、发消息、群名刷新、凭据与授权）都会带上 `HOME=~/.router-agent-lark`，与其它 agent 的 lark-cli profile 完全隔离。

## 项目与仓库选择

每个 `projects[].repo` 决定该工单的仓库：Orca 运行时交给 `orca worktree create --repo`；其它运行时作为 `git worktree` 的本地仓库绝对路径。先看 Orca 里注册了哪些：

```bash
orca repo list --json | jq -r '.result.repos[] | "\(.displayName)\t\(.path)\t\(.kind)"'
```

Web 面板的「登记项目」提供两种添加方式：

| 入口 | 行为 |
|-|-|
| 添加本地项目 | 弹出系统目录选择框；选中后自动识别 Git 根目录、当前分支与 origin。不是 Git 仓库时直接提示，不能用于创建 worktree |
| 添加 Git 项目 | 填写 ssh / http(s) 地址，自动 clone 到 `<RA_HOME>/repos/<项目名>`（默认 `~/.router-agent/repos`）；Orca 运行时再执行 `orca repo add --path ... --kind git` 登记，配置里写 `path:<绝对路径>` |

四种写法都支持：

| 写法 | 例子 | 说明 |
|-|-|-|
| displayName | `teamwork-repos` | 默认按 `name:` 匹配，最常用 |
| `name:` | `name:teamwork-repos` | 显式按名称 |
| `id:` | `id:3ee11f05-...` | 名称重名时按 id 精确匹配 |
| `path:` | `path:/Users/admin/du/teamwork-repos` | 按绝对路径 |

注意：只有 `kind: git` 的仓库能创建 worktree；`kind: folder`（纯文件夹项目）会在 `orca worktree create` 阶段失败。

非 Orca 运行时（`claude-code` / `acp-*`）不使用仓库选择器，`repo` 直接填本地仓库绝对路径，项目清单写在 `runtime.projects.<runtime id>` 下，见 [RUNTIME.md](RUNTIME.md)。

另外，旧版的全局 `repo` 配置已移除（`ra` 不再读取它）。已有配置文件请改成 `projects`，`ra doctor` 会在没有任何项目时直接报错并给出命令。

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
