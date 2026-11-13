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
      scope: mention   # admins=仅接受管理员消息；mention=接受普通用户 @ 消息；all=接受所有消息
      repo: router-agent   # 可选：群绑定项目（只能是当前后端项目清单里的项目名）
      branch: main         # 由项目默认分支自动决定，面板不可单独编辑
      allowed: [ou_xxx]    # 可选：本群管理员扩充（在默认管理员之外再加这些人）；支持邮箱（推荐）或 ou_xxx
      members:         # 可选：本群普通成员消息的处理细节（Web 面板里点群配置里的「普通成员设置」按钮编辑）
        maxQuestions: 10  # 最多主动追问几轮；达到上限按现有信息收口
        codeAccess: true   # 分析子 Agent 是否只读本群绑定项目的本地代码
        approvers: []      # 终审管理员；支持邮箱（推荐）或 ou_xxx；空 = 回退到默认管理员名单
  directMessages: true
  allowed: []          # 默认管理员：所有群的基线名单（邮箱，推荐；兼容 ou_xxx）
  bots: []             # 允许产生推断候选的机器人
  botOpenIds: []       # 机器人自己的 open_id（留空=按 appId 自动识别群成员里的机器人；填了就不自动识别）
  botNames: []         # 机器人显示名
  images:              # 图片消息：原图落盘并透传给 Worker，同时转文本进入研判
    enabled: true
    maxChars: 2000     # 单张图片转写结果的最大字符数
    timeoutMs: 60000   # 单张图片识别超时（毫秒）

policy:
  acceptMode: auto     # off / observe / auto
  maxWorkers: 4
  # worker 被服务重启打断后的恢复策略（只影响 codex-app / acp-* 这类
  # worker 进程随 Router 一起死的运行时）：
  #   auto   = 发中断提示后自动补一条输入，让 worker 从中断处接着做
  #   notify = 只发中断提示，等用户回复「继续」才恢复
  #   off    = 不处理
  interruptedRecovery: auto
  maxAutoRecover: 1    # 同一工单最多自动恢复几次，超出后降级为 notify

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

# 闲置工单治理：先提醒，宽限期后自动关闭（只停 worker，workspace 交给定时任务回收）
retention:
  enabled: true
  idleHours: 24        # 多久没有新进展就发关单提醒
  closeGraceHours: 6   # 提醒后多久没回复就自动关闭
  zombieHours: 6       # 执行中但多久没上报/输出算僵尸
  sweepMinutes: 5      # 扫描间隔（分钟）

# 关单后的工作区回收：关单只停 worker，目录保留一段时间后由定时任务回收
workspace:
  enabled: true
  keepHours: 24        # 关单后保留多久；0 = 下个扫描周期就回收
  sweepMinutes: 30     # 扫描间隔（分钟）

# Worker 工具策略：安全基线，runtime.options 不允许覆盖这些字段
worker:
  tools:
    fileAccess: read-write   # read-only = 只给 Read / Glob / Grep
    shell: allowlist         # deny=不给 shell | allowlist=只放行 shellAllow | allow=任意 shell
    shellAllow: [ra report, ra doc, git, gh, pnpm, npm, npx, node, yarn, bun,
                 python, python3, pytest, cargo, go, make, mvn, gradle]
    allowNetwork: false      # 预留字段：当前只解析，未用于收窄网络
  # UI 证据门禁：UI 工单报 ready 时检查 PR / MR 描述里的 Before / After 对比
  evidence:
    ui: warn               # off=关闭 | warn=只记日志 | enforce=拦截 ready（保存后需重启）

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
  #       repo: /Users/me/router-agent   # 所有 runtime 统一是本地仓库绝对路径
  # 自定义运行时插件：npm 包名或本地路径；id 取自插件包声明的 meta.id
  # （用 ra runtime add <包名|路径> / ra runtime install <id>，或面板「安装并添加」）
  # plugins:
  #   demo: '@acme/runtime-demo'
  #   local-runtime: ./local-runtime

# orca 项目清单：开单前必须确认「哪个项目 + 哪个起始分支」
projects: []
#  - name: router-agent            # 用户/模型引用的项目名
#    repo: /Users/me/router-agent   # 本地仓库绝对路径；派工时自动登记成 Orca 项目
#    defaultBranch: main           # 未指定分支时使用；留空则每次开工前追问

server:
  port: 3083
```

日常调整不需要编辑整份文件：

```bash
ra config set policy.acceptMode observe   # 先观察，不开工
ra config set policy.maxWorkers 2
ra config edit                            # 用 $EDITOR 编辑整份配置（不是 --edit）
```

## 逐项修改（`ra config set`）

`ra config set <点路径> <值>` 覆盖常用标量配置；路径未知或值非法会直接报「未知配置项或非法值」：

| 点路径 | 取值 |
|-|-|
| `policy.acceptMode` | `off` / `observe` / `auto` |
| `policy.maxWorkers` | 1–64 |
| `policy.interruptedRecovery` | `auto` / `notify` / `off` |
| `policy.maxAutoRecover` | 0–100 |
| `router.timeoutMs` / `router.tokenBudget` / `router.agentDir` | 毫秒（1s–600s） / token（0=不限） / Pi 配置目录 |
| `progress.syncMs` / `probeMs` / `silenceMs` / `repeatMs` | 毫秒；前两项 0 = 关闭 |
| `feishu.chats[].scope` | `admins` / `mention` / `all`；见「准入规则」 |
| `feishu.chats[].members.maxQuestions` / `codeAccess` / `approvers` | 见「处理普通成员消息」 |
| `retention.enabled` / `idleHours` / `closeGraceHours` / `zombieHours` / `sweepMinutes` | 见「闲置工单治理」 |
| `workspace.enabled` / `keepHours` / `sweepMinutes` | 见「关单后的工作区回收」 |
| `worker.evidence.ui` | `off` / `warn` / `enforce`；UI 证据门禁档位（保存后需重启） |
| `runtime.default` | `orca` / `claude-code` / `acp` / `acp-*` / `runtime.plugins` 里声明的插件 id |
| `runtime.options.<运行时>.<键>` | 运行时自己的选项；键由该运行时声明，见「运行时选项」 |
| `runtime.plugins.<runtime id>` | npm 包名、`./path`，或 `{ package / path / plugin, entry?, enabled? }`；id 取自插件包声明的 `meta.id`，见 [RUNTIME.md](RUNTIME.md) |
| `server.port` | 1–65535 |
| `feishu.appId` / `reaction` / `directMessages` / `allowed` / `bots` / `botOpenIds` / `botNames` | 字符串、布尔或逗号分隔列表 |
| `feishu.chats` | 逗号分隔 chat_id；已有条目的消息范围 / 绑定 / sync 保留，新条目默认 `mention` |
| `llm.baseUrl` / `llm.model` / `llm.apiKey` | 模型连接信息 |
| `decision.enabled` | `true` / `false`；开启普通成员消息的决策层 |
| `decision.provider` | `jev` / `llm`；决策模型来源 |
| `decision.jev.model` / `decision.jev.apiKey` / `decision.jev.baseUrl` | Jev 连接信息（密钥只写不回显） |
| `event.enabled` | `true` / `false`；事件总线总开关 |
| `event.budget.dailyTokens` / `event.budget.dailyEvents` | 每日 token / 事件数上限；`0` = 不限制（默认） |
| `event.maxQueueDepth` | 队列深度上限；超出后丢弃最低分事件 |
| `event.approvers` | 逗号分隔审核人（open_id / 邮箱） |
| `event.notifyChat` | 审核与进展通知群 |
| `event.windows` | JSON 数组整体替换时间窗，如 `[{"id":"night","from":"22:00","to":"06:00","allow":["t0","t1"]}]` |
| `event.sources` | JSON 数组整体替换事件来源，如 `[{"id":"gh","type":"github","mode":"poll","repos":["a/b"],"state":"open","intervalMs":600000}]` |

群与项目这类复合结构用专用写法，一次完成「登记 + 绑定」：

| 写法 | 例子 | 说明 |
|-|-|-|
| `project.<名>` | `ra config set project.router-agent "/Users/me/router-agent@main"` | `@` 后可带默认起始分支；`repo` 必须是本地仓库绝对路径 |
| `chatBinding.<chatId>` | `ra config set chatBinding.oc_xxx "router-agent@main"` | 绑定群的项目与起始分支 |
| `chatScope.<chatId>` | `ra config set chatScope.oc_xxx mention` | `admins` / `mention` / `all` |
| `chatSync.<chatId>` | `ra config set chatSync.oc_xxx true` | 启动时补拉该群历史 |
| `chatAllow.<chatId>` | `ra config set chatAllow.oc_xxx ou_a,ou_b` | 群管理员扩充；空值 = 只用默认 `feishu.allowed` |
| `runtime.options.<运行时>.<键>` | `ra config set runtime.options.orca.agent codex` | 运行时专属选项；按该运行时的声明校验 |
| `runtime.plugins.<runtime id>` | `ra runtime add '@acme/runtime-demo'` | 装好包并读出它声明的 id 后写入配置 |

`router.session.*`、`router.persona.*`、`feishu.images.*` 不在 `config set` 的白名单里，用 `ra config edit` 或 Web 面板改；`worker.tools.*` 面板不提供，只能 `ra config edit` 直接改文件。

## 运行时选项

每个运行时可以声明自己的可配置项，落在通用的 `runtime.options.<运行时 id>.<键>` 下：

- **面板**：声明过的选项出现在对应运行时卡片的「设置」弹窗里，不写死任何运行时；
- **命令行**：`ra config set runtime.options.orca.agent codex`；
- **校验**：后端按该运行时的声明校验取值，声明之外的键一律拒绝。

目前只有 Orca 声明了一个选项：`agent` —— 决定 Orca 在工单 worktree 里启动哪个 Agent。默认 `claude`；填 `codex` / `claude` / `opencode` 等则显式指定。改了要重启服务才生效，只影响新工单。

默认值写在选项声明里（`RuntimeOptionField.default`），后端、面板、文档都从同一处取值。如果某个运行时的选项没有「可省略」的形态（例如 Orca 的 `--prompt` 必须配 `--agent`），就用声明默认值兜底，而不是让调用方猜。

新增运行时只要声明自己的选项即可，内核与面板都不用改；选项声明见 `packages/runtime/src/runtimes/options.ts` 与各运行时的 `options.ts`。

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

**从本地配置导入**：Web 初始化页「LLM Provider」卡片右上角的「从本地配置导入」会打开选择弹窗，只读检查以下位置，把 Base URL / 模型 / 密钥齐全的 Provider 列出来；选中一份后点「导入所选」直接写回 `config.yaml`（密钥在服务端读取，不会回显到页面）：

| 来源 | 路径 | 说明 |
|-|-|-|
| Claude Code | `~/.claude/settings.json` 的 `env` | 识别 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`（含 `ANTHROPIC_DEFAULT_*_MODEL`） |
| CCSwitch | `~/.cc-switch/cc-switch.db`（SQLite `providers` 表）与旧版 `~/.cc-switch/config.json` | 支持 claude（Anthropic 兼容）以及 opencode / openclaw / pi 这类 `baseUrl + apiKey + models` 结构 |
| Pi | `~/.pi/agent/models.json` | 读取 `providers` 下的模型清单，`apiKey` 支持 `$ENV` 引用 |
| OpenCode | `~/.config/opencode/opencode.json` | 读取 `provider.<id>.options.baseURL / apiKey` 与 `models`，`apiKey` 支持 `{ "env": "VAR" }` |
| Magpie | `~/.config/magpie/providers.json` | 读取 `providers[]` 的 `chat` / `anthropic` / `baseAPI` / `models`；`model[1M]` 标记会转换成模型名 + 上下文窗口 |

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

## 决策层（普通成员消息）

普通成员消息默认不值得处理：决策层先过**确定性准入门槛**（去重 / 纯媒体 / 口令 / 噪声），再交**决策模型**判断「要不要跟进、属于哪一类、是否与本群项目相关」，通过才进入路由与需求分析。**默认关闭**，关闭时普通成员消息保持原有的初筛行为。

在 Web 面板「配置 → 决策层」里配（也可以写 `config.yaml` 或用 `ra config set`）：

```yaml
decision:
  enabled: true
  provider: jev        # jev | llm（llm 用同一份决策契约模拟，Jev 不可用时兜底）
  jev:
    apiKey: sk-xxx
    model: jev-latest
    baseUrl: ""        # 留空 = 默认地址
```

密钥也可以放环境变量，优先级高于 `config.yaml`：

| 变量 | 作用 |
|-|-|
| `TYPESAFE_API_KEY` | Jev 密钥 |
| `TYPESAFE_MODEL` | Jev 模型名 |
| `TYPESAFE_BASE_URL` | Jev 接口地址（走代理时才需要） |

> `apiKey` 与 `model` **两项都要有**才会真的走 Jev：只给密钥不给模型名时，决策层会退化成 LLM 兜底路径，并在日志里记 `decision:provider-missing`。

**怎么确认决策层真的生效**（三项都对才算生效）：

1. `ra doctor` 里有「决策层」一行：`已启用，Provider jev（jev-latest）` 才算装好；写「缺模型名 / 缺 API Key」就是还差东西。
2. 启动日志里有 `decision:enabled`：`provider` 是 `jev` 或 `llm`（`llm` 说明在走兜底）。
3. 普通成员在群里发一条消息后，日志里有 `decision:verdict`（带 `action` / `msgType` / `confidence`）；被确定性准入挡掉的是 `intake:decision-dropped`，判定不跟进的是 `intake:decision-ignore`，进了分析会话的是 `intake:opened`。

```bash
ra logs --follow | grep '"message":"decision:'
```

> 决策层只处理**普通成员**的消息（@没 @ 都一样），且该群要同时满足「处理普通成员消息已开启」与「已绑定项目」；管理员（授权名单内）的消息永远不进决策层，直接进 Router。

面板改造前后的截图见 [assets/decision-config/README.md](assets/decision-config/README.md)。

## 飞书机器人（专属 profile）

router-agent 固定使用 `~/.router-agent-lark` 作为 lark-cli profile，**不复用**你终端里其它 lark-cli 的登录态，也不能通过配置修改这个目录。凭据与授权有两个入口：

| 入口 | 行为 |
|-|-|
| Web 配置页 | 「渠道配置 → 飞书 → 机器人与授权」区块填写 App ID / App Secret；Secret 走 `lark-cli config init --app-secret-stdin` 写入 lark-cli 加密存储，不落 argv / config.yaml。同页可检查 bot / user 状态，并发起 Device Flow 授权。初始化页的「渠道配置」一步是同一套表单。 |
| `ra init` | 交互式选择「已有 App ID / App Secret」或「现在新建应用」；也可以选择跳过，稍后在 Web 配置页补填。 |

之后如果需要用户身份（按名字搜索群 / 成员、创建文档），在 Web 配置页点「开始授权」完成授权，或由 `ra init` 询问后执行 `lark-cli auth login`。授权只申请 **IM（消息 / 群 / 成员）、云文档、云空间、通讯录** 四个业务域，不再请求日历、邮箱、审批等无关权限。

四个业务域之外还会**显式追加一个 scope：`contact:user.id:readonly`**。原因是 lark-cli 的 `contact` 域只映射到 `contact:user.basic_profile:readonly` 与 `contact:user:search`，不含这一条；而 router-agent 要用 `contact/v3/users/batch_get_id` 把允许名单里的**邮箱解析成 open_id**（`src/sources/feishu-identity.ts`），这个接口依赖的正是 `contact:user.id:readonly`。域映射不覆盖 → 用户授权页看不到这一项 → 授权 100% 成功、token 里却没有该权限，表现成「用户已经授权好飞书，却没有这个权限」。`lark-cli` 的 `--scope` 与 `--domain` 是叠加关系，所以 router-agent 在授权参数里显式带上它（`src/sources/feishu-bot-admin.ts` 的 `FEISHU_AUTH_SCOPES`）。

> 应用侧（机器人身份 / tenant_access_token）同样需要这一条权限。若 `batch_get_id` 报 `99991672 app_scope_not_applied`，说明应用后台尚未开通，按报错里的 `console_url`（开放平台 scope-apply 链接）补开通即可；用户身份是否授权与它无关。

机器人凭据由 lark-cli 的加密存储管理，`router-agent` 只在 `config.yaml` 保存 `appId`。运行期所有 lark-cli 子进程（事件消费、发消息、群名刷新、凭据与授权）都会带上 `HOME=~/.router-agent-lark`，与其它 agent 的 lark-cli profile 完全隔离。

## 项目与仓库选择

每个 `projects[].repo` 决定该工单的仓库，**所有运行时统一填本地仓库绝对路径**（`/Users/admin/du/teamwork-repos`）：

| 运行时 | 怎么用这个路径 |
|-|-|
| Orca | 翻译成 Orca 的 `path:` 选择器交给 `orca worktree create --repo`，并在派工前自动 `orca repo add --path … --kind git` 登记成 Orca 项目 |
| claude-code / codex-app / t3code / herdr / acp | 直接作为 `git worktree` 的仓库目录 |

项目清单仍按运行时隔离：Orca 用顶层 `projects`，其它运行时用 `runtime.projects.<runtime id>`，见 [RUNTIME.md](RUNTIME.md)。

Web 面板的「项目配置」提供三种添加方式：

| 入口 | 行为 |
|-|-|
| 扫描本地项目 | 读本机 Claude Code（`~/.claude/projects`）、Codex（`~/.codex/sessions`）、OpenCode（`~/.local/share/opencode`）的历史会话日志，从里面还原用过的目录，按最近活跃时间倒序列出候选；默认勾选最近活跃的 5 个 Git 项目，其余不勾。导入时逐个走本地项目登记流程（Orca 运行时同时 `orca repo add`），路径重复的自动跳过，项目名撞了加序号 |
| 添加本地项目 | 弹出系统目录选择框；选中后自动识别 Git 根目录、当前分支与 origin。不是 Git 仓库时直接提示，不能用于创建 worktree |
| 添加 Git 项目 | 填写 ssh / http(s) 地址，自动 clone 到 `<RA_HOME>/repos/<项目名>`（默认 `~/.router-agent/repos`） |

扫描只读会话日志，不写任何文件。候选会收敛成「能直接当项目用的目录」：

- **worktree 归并到主仓库**：`.git` 是文件说明这是 git worktree，扫描时归并到它所属的主仓库（活跃时间照算），worktree 自己不会出现在候选里；
- **临时目录丢掉**：`/tmp`、`/var/folders` 等系统临时区里的目录直接剔除；
- **只留 Git 仓库**：面板只能加 Git 目录（worktree 需要它），非 Git 目录不进候选；
- 目录已不存在的会话记录会被跳过。

登记到 Orca 是自动的：Orca 运行时新增项目时立刻 `orca repo add`，派工时再兜底登记一次，所以清单里只写路径就够了。想看 Orca 侧已登记的仓库：

```bash
orca repo list --json | jq -r '.result.repos[] | "\(.displayName)\t\(.path)\t\(.kind)"'
```

注意：只有 `kind: git` 的仓库能创建 worktree；`kind: folder`（纯文件夹项目）会在 `orca worktree create` 阶段失败。

**历史写法**：Orca 的 `name:` / `id:` 选择器（如 `name:teamwork-repos`）不再接受——旧配置仍能读，但保存时会被校验拒绝，请改成上面表格里的绝对路径。

另外，旧版的全局 `repo` 配置已移除（`ra` 不再读取它）。已有配置文件请改成 `projects`，`ra doctor` 会在没有任何项目时直接报错并给出命令。

## 准入规则（群级消息范围）

准入不再由全局开关逐格配置，而是**按群配一个消息范围**。全局只保留「默认管理员是谁」，每个群再按自己的范围决定接不接普通成员的消息。

| 消息范围（`feishu.chats[].scope`） | 管理员的消息 | 普通成员的消息 |
|-|-|-|
| `admins`（仅接受管理员消息） | 都处理 | 一律忽略 |
| `mention`（接受普通用户 @ 消息） | 都处理 | 必须 @ 机器人 |
| `all`（接受所有消息） | 都处理 | 都处理（由决策层判断要不要跟进） |

管理员 = 默认管理员（`feishu.allowed`）+ 群内扩充（`feishu.chats[].allowed`）。群名单只扩充、不覆盖：默认管理员在任何一个群里都还是管理员。

```bash
ra config set chatScope.oc_xxx admins|mention|all   # 群消息范围
ra config set chatAllow.oc_xxx a@b.com,ou_xxx        # 群管理员扩充
```

| 场景 | off | observe | auto |
|-|-|-|-|
| 管理员、@bot / 私聊 | 显式接单 | 显式接单 | 显式接单 |
| 管理员、未 @ | 只回复说明 | 研判但不开工 | 研判通过开单 |
| 普通成员、@bot（范围含普通成员时） | 只回复说明 | 研判但不开工 | 研判通过开单 |
| 普通成员、未 @（只有 `all` 范围会走到） | 只回复说明 | 研判但不开工 | 研判通过开单 |

范围之外的组合一律忽略。`inferred` 进入研判（再由 `acceptMode` 决定 observe 时是否真的开工），`explicit` 直接按显式请求开单。Web 面板保存后立即生效；`ra config set` 写的是文件，重启服务后生效。

旧配置（`policy.admission` 三格准入表 + 群级 `mode: all/mention`）会在启动时折算成新的群级范围：旧「名单外 @bot 一律忽略」→ `admins`；旧「普通消息也处理」→ `all`；其余 → `mention`。

## 处理普通成员消息（群级 scope + members）

每个群单独配消息范围（`scope`），默认 `mention`（只接普通成员的 @ 消息）。范围决定 Router 要不要处理本群非授权用户的消息；`members` 只管处理细节（追问几轮、能不能读代码、谁终审）。

范围是 `admins` 时（本组消息的路由方式）：

| 发送人 | 处理方式 |
|-|-|
| 管理员（默认管理员 + 群内扩充） | 直进 Router：闲聊回复、简单需求直接开单、复杂需求先讨论几轮再开单 |
| 普通成员 | 不处理，消息被忽略 |

范围是 `mention` / `all` 时，普通成员的消息先过**决策层**（Jev / LLM 分类），由决策层决定要不要跟进：

1. **决策**：确定性准入先挡掉机器人、纯附件、口令、已在会话里的消息；其余交给决策模型分类成「不跟进 / 观察 / 咨询 / 需求反馈」；
2. **不跟进**：闲聊、吐槽直接忽略，不打扰用户；
3. **咨询**：建咨询会话，分析子 Agent 只读本群绑定项目的代码，直接给结论；
4. **需求**：建需求会话，分析子 Agent 主动追问补齐信息，整理成结构化需求单 @终审管理员；
5. **终审与派单**：管理员回复「确认派单」才走原有 `Engine.decide()` 生成工单；回复「驳回」结束这条需求。

配置入口在 Web 面板：**「配置 → 渠道配置 → 飞书 → 群与绑定」**里每一行都有一个消息范围下拉框和一个「普通成员设置」按钮，点开弹窗就能填终审管理员、调轮次、决定是否读代码；也可以直接改 `config.yaml`：

```bash
feishu:
  chats:
    - chat: oc_dev
      scope: all
      repo: router-agent
      members:
        maxQuestions: 10          # 最多追问 10 轮（默认 10，0 = 不追问）
        codeAccess: true          # false = 分析 Agent 不读代码，只基于对话判断
        approvers: [lead@example.com]   # 终审管理员：邮箱（推荐）或 ou_xxx；空 = 回退到默认管理员名单
```

| 字段 | 含义 |
|-|-|
| `scope` | 消息范围：`admins` / `mention` / `all`；要不要处理普通成员的消息由它决定 |
| `maxQuestions` | 最多主动追问几轮，默认 **10**，上限 50；到顶后按现有信息收口成需求单 |
| `codeAccess` | 分析子 Agent 是否只读本群绑定项目的代码；关闭后只依据对话与通用业务知识判断 |
| `approvers` | 终审管理员：支持**邮箱**（推荐）或 `ou_xxx`；启动时把邮箱解析成 open_id，解析不到就没人能终审（不会退回全局名单） |

| 约束 | 实现 |
|-|-|
| Router 不读代码、不做业务分析 | 读代码与判断只发生在 `IntakeEngine`；主链路只做调度、落库与出站 |
| 权限分层 | 授权用户拿全套工单工具（查单、关单、回收 workspace）；普通成员只有只读上下文工具，没有任何工单权限 |
| 项目隔离 | 分析工具（`code_ls` / `code_read` / `code_grep`）只接受项目目录内的相对路径，越界直接拒绝 |
| 名单只管权限，不管说话 | 授权名单决定谁能当管理员、谁能派单；普通成员照样能提需求，只是要走管理员终审 |
| 名单只扩充不覆盖 | 群 `allowed` 只往默认管理员名单上加人；默认管理员在群里仍是管理员 |
| 不干扰存量派单流程 | 同一话题里管理员 @机器人 的新指令仍走原研判，不会被待审需求单截走 |
| 旧配置自动迁移 | 旧的群级 `intake:` 段与旧版全局 `intake:` 段（`enabled` / `chats` / `maxQuestions` / `codeAccess` / `approvers`）在启动时迁移到 `members:`；写回配置后旧段消失 |

需求会话在 `~/.router-agent/state.db` 的 `intakes` 表里持久化；72 小时没有新消息自动放弃，不会挡住后续新问题。分析 Agent 的追问 / 收口规范在 Web 面板「配置 → 规范文件」里可查看和修改（`需求初筛规范` / `需求分析规范`）。

> 注意：处理普通成员消息依赖群已绑定项目（`chatBinding` / `feishu.chats[].repo`）。没有绑定项目的群里，它不会接管消息，仍按原准入规则处理——因为拿不到项目就无法生成可派单的需求单。

## 事件总线（多来源事件）

所有来源（用户消息、运营群、GitHub Issue、webhook、定时任务）先归一化成**事件**，进同一个队列池，由判定层决定直派工单、进待审核、归档还是丢弃。**来源只提供幂等键、优先级基线、成本档位与泳道，不决定处理方式。**

整体方案见 [EVENT-BUS-DESIGN.md](EVENT-BUS-DESIGN.md)。

```yaml
event:
  enabled: true                  # 总开关；关掉时所有来源都不接
  sources:                       # 来源清单，可多个
    - id: github-issues          # 来源 id，唯一；幂等键与面板筛选都按它
      type: github               # github | webhook | cron
      mode: poll                 # poll（轮询）| webhook（推送）| schedule（定时）
      repos: [blankPen/router-agent]   # 仓库白名单（github）
      labels: [bug]              # 标签筛选（github）
      state: open                # issue 状态筛选（github）
      intervalMs: 900000         # 轮询间隔
      cron: "0 3 * * *"          # 定时表达式（cron / schedule）
      path: /api/events/in/ops   # webhook 路径
      secretRef: RA_EVENT_OPS_TOKEN   # 密钥的环境变量名；密钥本身不写进配置
      notifyChat: oc_xxx         # 事件派工后的进展通知群
      project: router-agent      # 归属项目；决定派工目标
      priorityHint: 70           # 基线优先级 0–100（只影响排序，不决定是否直派）
      costClass: cheap           # free | cheap | llm | heavy
      lane: repo:blankPen/router-agent   # 归属泳道；同 lane 串行处理
    - id: nightly-audit
      type: cron
      mode: schedule
      cron: "0 3 * * *"
      task: check-dependency-drift
      project: router-agent
      priorityHint: 40
  windows:                       # 时间窗；**留空 = 一直放行**
    - id: peak
      from: '09:00'
      to: '20:00'
      allow: [t0, t1]            # 该窗口放行的档位：t0 直派 / t1 待审 / t2 归档 / t3 丢弃
      batch: false
  budget:
    dailyTokens: 0               # 每日 token 上限；0 = 不限制
    dailyEvents: 0               # 每日事件数上限；0 = 不限制
  maxQueueDepth: 500
  approvers: []                  # 审核人（open_id / 邮箱）；面板写操作按它校验
  notifyChat: ''                 # 待审核事件的推送群；留空则只在面板可见
```

要点：

- **时间窗先留空**：不预置高低峰模板，需要时再配；窗口不放行的事件会延后到窗口开始。
- **预算默认不限制**：`dailyTokens` / `dailyEvents` 都是 `0` 时不拦任何事件；显式配置才生效。T0 事件超预算仍会执行（保响应），只记一条 `event:budget-exceeded` 告警。
- **密钥只从环境变量读**：`secretRef` 里写的是环境变量名；GitHub webhook 用 `X-Hub-Signature-256` 验签，通用 webhook 用 `Bearer` 令牌。
- **轮询与 webhook 可平滑切换**：同一个来源把 `mode` 从 `poll` 改成 `webhook` 即可，产出的是同一种事件。
- 判定层复用决策层的 Jev 连接信息（`decision.jev.*`）；没配 Jev 时事件只走规则层，判定一律转人工审核，不会自动开单。
- 面板「事件」页可以直接改时间窗与预算，保存后立即生效；来源清单在 `config.yaml` 里改，或用 `ra config set event.sources '<JSON>'` 整体替换。
- 命令行等价写法：`ra config set event.enabled true`、`ra config set event.budget.dailyTokens 50000`、`ra config set event.windows '[{"id":"night","from":"22:00","to":"06:00","allow":["t0","t1"]}]'`；`event.windows` 与 `event.sources` 是 JSON 整体替换，条目不合法时整体拒绝，不写半份配置。

## 闲置工单治理

长时间没有新进展的工单会被自动收口，避免工单和 Orca workspace 越积越多：

- **24 小时没有任何新进展**（worker 上报 / 用户输入 / 派工启动）→ 在话题里发一次关单提醒；
- **提醒后 6 小时仍无回复** → 自动关闭工单，只停终端；对应的 workspace 保留到定时任务回收（见「关单后的工作区回收」），脏工作区不强删，会通知人工；
- **PR 仍开着** → 只催办一次，不自动关闭；
- **执行中但 6 小时无上报且终端无输出** → 转人工，不自动关闭；
- **PR 合并 / 关闭** → 不关单，只通知一次进展；工单保持开放，用户在话题里追问会再次派给 worker；
- **已关闭话题再次被回复** → 固定回复「工单已关闭」；若该工单的 workspace 已被回收，会额外提示「需要的话，我可以帮你新开工单进行处理。」；回复「重新开工」会基于原工单的仓库 / 起点分支创建新工单，并带上之前描述的需求。

**服务启动时不补发闲置通知**：闲置计时以服务启动时刻为基线重新开始。启动前就已经没有进展的工单，不会因为服务重启而被一次性补发提醒、催办或关单通知；它们会在启动后满 `idleHours` 时照常提醒，再满 `closeGraceHours` 后自动关闭。启动前已经提醒过、但还没到关单时间的工单同样不重复提醒，只把关单时间按新基线顺延。

```bash
ra config set retention.enabled false        # 关闭
ra config set retention.idleHours 48         # 多久无进展提醒
ra config set retention.closeGraceHours 12   # 提醒后多久自动关闭
ra config set retention.zombieHours 6        # 僵尸判定
ra config set retention.sweepMinutes 5       # 扫描间隔
```

`ra status` 会显示当前治理阈值；阈值改动需要重启服务后生效。

## 关单后的工作区回收

关单和回收 workspace 是两件事：**关单只停 worker，不删目录**。目录只会在下面两个时机被回收：

- **定时任务**：关单后保留满 `keepHours`（默认 24 小时）后，由扫描任务回收；
- **用户手动回收**：面板「清理工作区」里勾选清理，或在飞书里让 Router 调用 `router_workspace_remove`。

闲置超时自动关单走的是「保留后回收」。PR 合并 / 关闭不会关单，工单保持开放、可继续追问；会话只在巡查判定长期无进展或用户主动关闭时才结束。**人工停止工单**（面板「停止」/ `ra ticket --stop`）是用户明确表示不要这个目录，仍然立即回收。

```bash
ra config set workspace.enabled false       # 关掉定时回收，只能手动回收
ra config set workspace.keepHours 48        # 关单后保留多久；0 = 下个扫描周期就回收
ra config set workspace.sweepMinutes 15    # 扫描间隔（分钟）
```

`ra status` 会显示当前回收策略；`workspace.*` 改动需要重启服务后生效。
