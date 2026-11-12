# 回复、面板、日志与已知限制

本文说明 Router 什么时候说话、怎么说话，Web 面板各页做什么，以及日志能追到哪一步。架构与派工流程见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 回复策略

Router 不做对话，只在必要时说话：

| 场景 | 行为 |
|-|-|
| **会被处理的已寻址消息**（@ / 私聊 / 全量接收群） | 收到后**立即**加一个确认表情（默认 `Typing` ⌨️），回复发出后自动取消；被准入拦截的消息不加 |
| **未 @ 但话题已绑定在办工单的消息**（名单内成员，tk-59） | 照样加确认表情，并在话题里回一句「收到，已转给工单…（id）的 worker」；**每张工单只回一次**，同单话题里的后续追问不再重复回执；消息直接投给该工单的 worker，不新开工单 |
| 群里 @机器人，但只是寒暄 / 试探 | **Pi 生成**一句礼貌回复，作为**普通消息**发出；不建单 |
| 群里 @机器人，是真需求 | 只发一条**话题**消息：「工单「标题」（id）已开始执行。后续进展会在这个话题里更新。」，不再额外回「我帮你创建了工单」之类的普通消息 ack |
| 未 @ 的群消息 | 走 Pi 研判；判为闲聊则**完全静默**（不刷屏） |
| 需求识别开启的群里，普通成员反馈问题（可不 @） | 先轻量初筛：`chat` 静默；`question` / `issue` 由分析子 Agent 追问或直接答疑，信息收敛后 @管理员终审，确认后才派单 |
| 分析子 Agent 追问 / 需求单整理完成 | 回复挂在该话题：追问直接发；需求单完成后先告知发起人「已提交管理员确认」，再 @管理员给出结构化需求单与操作口令 |
| 管理员终审 | 回复「确认派单」生成正式工单；「驳回」结束；直接补充要求则重新分析一版 |
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

- 确认表情是 best-effort：失败只记 `feishu:reaction-failed`，不影响研判；只对首次入库、且是在跟它说话（@ / 私聊 / 全量接收群 / 未 @ 但话题已绑定在办工单）的消息加；被准入拦截（群白名单外、`admission: ignore`）的消息不加，避免「有表情、永远没回复」；重放不会重复加；回复发出后自动撤销（`feishu:unreact-failed` 是撤销失败的日志）。`ra config set feishu.reaction ""` 可关闭。
- 全部 emoji_type 见飞书文档「表情文案」，注意**大小写敏感**（`Typing` 不是 `TYPING`）。
- 出站按内容分流：**单行、≤200 字、不含 Markdown 语法**的回复直接用 `text` 消息；其余用飞书**互动卡片**渲染 Markdown，卡片失败自动降级为 post 富文本。分流规则：`threadId` 为空 = 普通消息，有值 = 话题回复。
- 卡片内的 Markdown 会先归一化（`normalizeCardMarkdown`），把 Card 1.0 不支持的语法降级掉：`#` 标题 → 加粗行、`>` 引用 → `▍`、表格 → 加粗表头 + 列表行、`- [x]` → ☑ / ☐、`<br>` → 换行、`![图片](http...)` → 可点击链接；代码块内原样保留。

## Web 面板

`ra start` 自动打开、`ra web` 也可随时打开的面板分五块：

- **初始化**：只放启动必需的五件事——LLM Provider、运行时、项目、飞书机器人、群与绑定，顶部有完成度清单；LLM Provider 的 Base URL / 模型 / API Key 三项必填（密钥只写入 `config.yaml`，保存后不回显），可选 OpenAI / Anthropic 两种接口协议，并支持从 Claude Code、CCSwitch、Pi、OpenCode、Magpie 的本地 Provider 配置一键导入；飞书 App ID / App Secret 与授权也直接在本页完成（固定 `~/.router-agent-lark` profile）。逐项说明见 [README · 快速开始](../README.md#快速开始)；运行时的卡片检测与安装引导见 [RUNTIME.md](RUNTIME.md)。
- **工单**：按阶段分组 + 计数、关键字搜索（标题 / 工单号 / 仓库 / PR）、自动刷新开关与手动刷新；详情页有阶段、派工、PR、授权范围、上报时间线（含完整回复与 `humanAction`）、投递记录，可直接投递 follow-up 或停止工单。**人工停止工单会立即回收对应的 workspace**（先停 worker，再删 worktree）；而闲置超时、PR 合并等**自动关单只停 worker，workspace 会保留一段时间（默认 24 小时）后由定时任务回收**，也可以随时在「清理工作区」里手动回收。页头还有「清理工作区」入口：按 Worker 运行时分组列出仍在磁盘上的工单工作区，可勾选多个工单批量清理。清理动作按工单各自的运行时执行——Orca 关闭 worktree 并删除目录，Claude Code 删除 `claude agents` 视图与 worktree 目录，ACP 直接删除 worktree 目录；在办工单与有未提交改动的目录会被跳过，并在结果里说明原因。
- **日志**：直接看 `~/.router-agent/logs/router-agent.log`，默认 2 秒增量拉取（只读游标之后的新字节，不重复读整个文件），可开「实时刷新」；按 INFO / WARN / ERROR 过滤、按消息或字段搜索、复制当前结果；停在底部时自动跟随新日志，往上翻后不再打断，点「最新」回到底部。文件不存在或还没写入时给出空状态提示。
- **配置**：按「LLM Provider / 准入策略 / 研判与人格 / 会话复用 / 进展同步 / 闲置治理 / 工作区回收 / 飞书消息 / 派工与服务 / 项目与群绑定」分组；飞书分组的顶部是「飞书机器人」区块，可直接写入 App Secret、刷新授权状态并引导完成飞书授权。每个字段带说明与默认值提示，改动逐项标脏，保存前做前端 + 后端双重校验，保存后写回 `config.yaml`。「派工与服务」里的 Worker 运行时是与初始化页相同的卡片平铺组件（`orca` / `claude-code` / `codex-app` / `acp` / `acp-*`），卡片标题是首字母大写的运行时名（`Orca` / `Claude Code` / `Codex App`），可检测安装状态、分别跳转官方文档安装 CLI 或由 ra 安装 ACP 扩展，并做 ACP 握手试启动；已有原生运行时替代品的 `acp-claude` / `acp-codex` 不再出现在可选列表里（当前正选中的仍保留，老配置继续可用）；项目清单按运行时隔离，切换运行时后「项目与群绑定」里的项目清单会切换到该运行时自己的一套（Orca 用仓库选择器，Claude Code / ACP 必须是本地仓库绝对路径）；「添加本地项目」支持系统目录选择并自动识别 Git / 分支，「添加 Git 项目」支持填写 ssh / http(s) 地址后自动 clone 并登记。群绑定的项目只能从当前清单里选，分支自动跟随项目的默认分支，不能单独自定义。
- **来源**：服务状态、监控群、接收范围概览。

侧栏品牌行末尾有全局主题切换图标：**跟随系统 / 亮色 / 暗色** 三态循环，默认跟随系统；选择只存在浏览器本地，不写入 `config.yaml`，所有页签即时生效。

发现 npm 上有新版本时，侧栏「服务运行中」状态条上方会出现更新提示：点「更新并重启」会执行 `npm install -g router-agent@latest` 并在安装成功后自动重启 daemon，页面无需刷新；点 × 只忽略当前版本，出现更高版本时会再次提示。窄屏侧栏收起后退化为右下角悬浮按钮。也可以直接在飞书里让 Router 更新版本——它会调用 `router_update` 工具安装最新版，并在回复发出后自动重启整个服务。

配置项会标注生效范围：**策略**（`acceptMode` / `maxWorkers` / `admission`）保存后立即生效；其余配置在服务启动时读入，保存后点侧栏或配置页的「重启服务」即可热重启 daemon（浏览器页面不会刷新），也可以手动 `ra stop && ra start`。面板可以在「初始化 · LLM Provider」或「配置 · LLM Provider」里填写 `llm.apiKey`，密钥只写入 `config.yaml`，保存后不会再回显（`publicConfig` 只返回 `apiKeySet`）；也可以用 CLI / 环境变量配置。保存会重写 `config.yaml`，原文件的注释会丢失。

## 日志

所有关键节点都是结构化 JSON，一行一个事件（`at` / `level` / `message` + 业务字段），写入 `~/.router-agent/logs/router-agent.log`。`message` 固定是事件名（`域:动作`），错误详情等文本一律用 `detail` 字段，不要占用 `message`：

| 事件 | 来源 | 关键字段 | 说明 |
|-|-|-|-|
| `feishu:ready` | 事件消费者 | — | 事件流已连上 |
| `trigger:ingested` | Source | `id` `chat` `addressed` `admitted` `threadKeys` `topic` | 用户消息进入系统；`topic=true` 表示事件带了话题 ID（omt_）；`admitted=true` 表示没 @ 但因话题已绑定在办工单被放行（tk-59） |
| `trigger:dropped` | Source | `reason` `chat` `actor` | 收到但被过滤 |
| `trigger:admitted-unaddressed` | CLI | `chat` `actor` `keys` | 已绑定工单的话题里，名单内成员没 @ 机器人也放行处理（tk-59） |
| `intake:screen` | AgentLoop | `triggerId` `chat` `kind` `reason` | 需求识别初筛结论：chat / question / issue（`reason` 已截断到 120 字） |
| `intake:screen-failed` / `intake:screen-invalid` | AgentLoop | `triggerId` `detail` / `triggerId` | 初筛模型失败或输出不合法；消息按原准入规则继续处理 |
| `intake:opened` | AgentLoop | `intakeId` `chat` `actor` `kind` `project` | 为一条疑似问题创建需求识别会话 |
| `intake:clarify` | AgentLoop | `intakeId` `questions` | 分析 Agent 发起追问 |
| `intake:answered` | AgentLoop | `intakeId` `chat` | 分析 Agent 直接给出结论，会话结束，不产出需求单 |
| `intake:ready` | AgentLoop | `intakeId` `chat` `title` `approvers` | 需求单整理完成，已 @管理员终审 |
| `intake:approved` | AgentLoop | `intakeId` `ticketId` `actor` `reused` | 管理员确认派单，已生成正式工单；`reused=true` 表示复用了上次已建的工单 |
| `intake:rejected` | AgentLoop | `intakeId` `actor` | 管理员驳回需求单 |
| `intake:expired` | AgentLoop | `intakeId` | 需求识别会话超过 72 小时无消息，自动放弃 |
| `intake:analysis-failed` / `intake:analysis-invalid` | AgentLoop | `intakeId` `detail` / `intakeId` `triggerId` | 分析模型失败或输出不合法；已给用户兜底回复 |
| `intake:approve-failed` | AgentLoop | `intakeId` `detail` | 终审通过后开单失败；需求单仍可再次终审 |
| `intake:requester-not-allowed` | AgentLoop | `triggerId` `chat` `actor` | 发起人不在该群白名单里，不再继续澄清（群名单是硬边界） |
| `intake:project-unbound` | AgentLoop | `chat` `triggerId` | 群没绑定项目，intake 不接管，按原准入规则处理 |
| `intake:decision-failed` | AgentLoop | `triggerId` `detail` | 落决策失败（例如同一轮已落过决定） |
| `intake:abort-failed` / `intake:dispose-failed` | IntakeEngine | `stage` `detail` | 分析会话超时中断或释放失败；已拿到的结果不受影响 |
| `intake:tool-failed` | IntakeEngine | `stage` `detail` | 只读代码工具读写失败（code_read / code_ls / code_grep）；读不到不等于没有匹配 |
| `thread:created` | Engine | `threadId` `source` `chat` | 首次见到某条线程，登记规范 ID |
| `thread:resolved` | Engine | `threadId` `rawThreadId` `triggerId` `source` | 消息自带线程标识没对上，靠别名收敛到了已有线程（排查「消息没进工单」先看这条） |
| `thread:backfilled` / `thread:backfill-failed` | CLI | `filled` `failed` / `batch` `code` `detail` | `ra migrate threads --apply` 的回填结果 |
| `router:decision` | Engine | `triggerId` `decision` `strength` `reason` `ticketId` `title` `scope` | Router 的研判结论 |
| `launch` | Service | `ticketId` `handle` `workdir` | 派工到 Orca worktree |
| `input:queued` | Engine | `ticketId` `seq` `text` | Router 准备发给 worker 的内容 |
| `input:deduped` | Engine | `ticketId` `inputId` `seq` `kind` `sourceKey` | 同一条来源消息重复到达（飞书重投 / 面板再点一次），复用已有输入，没有重复投给 worker |
| `input:delivered` | Service | `ticketId` `count` `text` | 实际投递进 worker 终端 |
| `worker:lost` | Service | `ticketId` `handle` `reason` `lastSeq` `expired` | 执行会话已不存在；已投递未 ack 的输入标为 `expired`，不再参与重投 |
| `input:relaunch` | Service | `ticketId` `pending` | 因新消息重建 worker；同一批积压输入只触发一次 |
| `input:adopted-handle` | Service | `ticketId` `from` `to` `sessionId` | 运行时投递时接管了新会话（Claude resume fork），Assignment 已切换到新 handle |
| `worker:stop-stale` | Service | `ticketId` `handle` | 终端句柄已失效（`terminal_handle_stale`），停止动作不再重试 |
| `report` | Service | `ticketId` `state` `turn` `summary` `reply` `humanAction` `pr` | worker 的 `ra report` 上报 |
| `report:evidence-missing` | Service | `ticketId` `mode` `action` `source` `reason` `missing` | UI 工单缺 Before / After 证据；`enforce` 时 action=reject，`warn` 时只记录 |
| `report:evidence-unverified` | Service | `ticketId` `mode` `unverified` `source` | 无法判断是否有证据（workdir 丢失、git / PR 查询失败），降级放行 |
| `report:ingest-failed` | Service | `ticketId` `message` | 兜底通道处理上报时的非门禁异常 |
| `progress:synced` / `progress:dedup` | Service | `ticketId` `count` / `skipped` | 进展定时合并同步，或内容重复被跳过 |
| `progress:probed` | Service | `ticketId` `minutes` `count` `unchanged` | 主动巡检读会话记录 / 终端并把语义摘要同步到话题 |
| `outbox:sent` / `outbox:failed` | Outbox | `key` `text` / `error` | 对外通知结果 |
| `api:input` / `api:stop` / `api:policy` / `api:config` | HTTP API | — | 面板 / CLI 的操作 |
| `idle:nudge` / `idle:stale` | Service | — | 空闲唤醒与失联标记 |
| `retention:baseline` | Service | `baselineAt` `openTickets` | 服务启动时重置闲置治理计时基线：启动前就已无进展的工单不补发提醒 |
| `pr:linked` / `pr:state` | Service | — | PR / MR 跟踪 |
| `pr:track-failed` | Service | `ticketId` `prNumber` `repo` `detail` | PR / MR 状态查询无结果；同一工单 + PR 只记一次 |
| `recover:*` | Service | — | 重启对账 |
| `recover:interrupted` | Service | `ticketId` `turnId` `mode` `autoRecovered` | 发现 worker 上一轮被服务重启打断，按 `policy.interruptedRecovery` 处置 |
| `recover:auto-resume` | Service | `ticketId` `turnId` | 自动补了一条 `kind=retry` 的输入，worker 从中断处接着做 |
| `recover:auto-resume-failed` | Service | `ticketId` `turnId` `message` | 自动恢复投递失败；已提示用户回复「继续」手动接着做 |

消息、配置与异常三类关键链路的补充事件（都遵循同一套 `at` / `level` / `message` + 业务字段格式）：

| 事件 | 来源 | 关键字段 | 说明 |
|-|-|-|-|
| `trigger:duplicate` | Source | `id` `chat` | 重复投递的消息被入库去重，不是消息丢失 |
| `channel:not-registered` | Channel Router | `channel` `target` `key` | Outbox 里的通道没有注册，跳过发送（历史脏数据不会卡死队列） |
| `channel:duplicate-id` | Channel Registry | `channel` `kind` | 同一通道实例被重复注册，保留最后一次 |
| `channel:ack-failed` | Channel Ingress | `channel` `messageId` `detail` | 回执表情添加失败，不影响消息入库与回复 |
| `plugin:loaded` | Runtime / Channel loader | `kind` `id` | 插件创建成功并注册了实例；`kind=runtime` 时 `id` 是运行时 id，`kind=channel` 时是通道实例 id |
| `plugin:load-failed` | Plugin loader | `kind` `id` `package` `detail` | 插件包无法解析或导入（路径错、缺依赖、未安装）；服务继续启动，面板与 `/api/config` 会显示失败原因 |
| `plugin:create-failed` | Runtime / Channel loader | `kind` `id` `detail` | 插件入口已导入，但 `create()` / `createAll()` 抛错；该实例不注册，其它插件不受影响 |
| `plugin:id-mismatch` | Runtime / Channel loader | `kind` `id` `declared` `detail` | 配置里的插件 id 与插件声明的 `meta.id` 不一致；面板按配置 id 回链，提示用户统一命名 |
| `channel:consumer-started` / `channel:consumer-start-failed` | CLI | `channel` / `channel` `detail` | 已加载通道的入站消费启动结果；自定义通道启动失败不会阻塞其它通道 |
| `channel:feishu-missing` | CLI | `detail` | 配置里没有可用的飞书通道；服务继续启动，但飞书消息不会入站 |
| `channel:unreact-failed` | CLI | `channel` `messageId` `detail` | 回复发送后撤销回执失败；不影响已发出的回复 |
| `session:migrated` | CLI | `sessions` `resets` | 人工执行 `ra migrate sessions --apply` 完成 |
| `session:migration-required` | CLI | `pending` | 存在未迁移的历史 sessionKey，服务拒绝启动 |
| `session:migration-incomplete` / `session:migration-verify-failed` / `session:migration-failed` | CLI | 计数与异常数 / `detail` | 迁移执行失败（已回滚）或迁移后校验未通过 |
| `feishu:reconnecting` | Source | `attempt` `delayMs` | 事件消费者断开，已安排退避重连 |
| `feishu:spawn-failed` | Source | `detail` | lark-cli 无法拉起（未安装 / 无权限），会继续重试 |
| `feishu:card-fallback` | Sender | `target` `key` `code` `detail` | 互动卡片发送失败，已自动降级为富文本 |
| `feishu:quote-fetch-failed` / `feishu:quote-parse-failed` | Source | `messageId` `detail` | 引用消息回查失败，按原消息继续 |
| `chats:refresh-failed` / `chats:parse-failed` / `chats:cache-invalid` | Source | `code` / `detail` / `path` | 群名目录刷新失败或缓存损坏，旧值继续可用 |
| `identity:resolved` | Identity | `entry`(掩码) `actor` `name` | 允许名单条目（邮箱 / open_id）解析成 open_id 与显示名 |
| `identity:resolve-failed` | Identity | `entry`(掩码) `detail` | 条目确认解析不出来（格式不对 / 查无此人 / open_id 跨应用），该条目被丢弃 |
| `identity:resolve-deferred` | Identity | `entry`(掩码) `detail` | 暂时查不了（权限缺失 / lark-cli 不可用 / 超时），条目**保留**待重试，不清空名单 |
| `identity:cache-failed` | Identity | `kind` `detail` | 身份解析缓存读写失败，本次降级为直接查通讯录 |
| `identity:refresh-failed` | HTTP API | `detail` | 面板保存后重新解析允许名单失败；保存照样成功，名单先按上一次的结果继续用 |
| `identity:retry-resolved` | CLI | `round` `pending` | 启动时的后台重试解析成功，名单已恢复并重建策略 |
| `identity:retry-deferred` | CLI | `round` `pending` `bot` | 后台重试后仍有待重试条目或机器人未识别，继续退避 |
| `identity:retry-failed` | CLI | `round` `detail` | 后台重试本身失败（接口 / 网络），下一轮再试 |
| `identity:retry-exhausted` | CLI | `attempts` | 后台重试次数用完仍没解析全，需要重启或重新保存来触发 |
| `config:identity-invalid` | Identity | `count` `detail` | 允许名单里有条目解析不到人（或暂时查不了待重试），名单已生效但可见性问题已告警 |
| `feishu:allowlist-empty` | Identity | `count` `detail` | 全局允许名单一个都没解析出来（`detail` 区分「待重试」与「查无此人」），等于暂时谁都不许 |
| `config:identity-resolve-failed` | CLI | `detail` | 启动时的身份装配整体失败，已降级为按原始配置启动 |
| `feishu:bot-identity-resolved` | Identity | `bot` `name` | 机器人身份自动识别成功（按 `app_id` 匹配群成员），或使用了手动填写的身份 |
| `feishu:bot-identity-failed` | Identity | `detail` | 机器人身份识别失败，`mode: mention` 的群会丢消息，需人工确认 |
| `feishu:chat-allowlist-empty` | Identity | `chat` `name` `count` | 群级允许名单配了却一个都解析不出来，该群按「拒绝所有人」处理 |
| `feishu:intake-approver-empty` | Identity | `chat` `name` `count` | 需求分析助手的终审管理员配了却一个都解析不出来，该群没有人能终审（不会退回全局名单） |
| `loop:trigger-failed` | Agent Loop | `triggerId` `chat` `detail` | 单条消息处理异常，同批其它消息不受影响 |
| `loop:admitted-replied` | Agent Loop | `triggerId` `chat` `ticketId` `tickets` | 未 @ 放行的消息已投给工单 worker，Router 在话题里回了一句「已转给工单」 |
| `loop:admitted-suppressed` | Agent Loop | `triggerId` `chat` `ticketId` | 这张工单已经回过执，本次追问不再重复发「已转给工单」（消息照样投给了 worker） |
| `decision:engine-failed` | Agent Loop | `triggerId` `detail` | 研判引擎调用失败，按 unavailable 处理并留下原因 |
| `chat:reply-failed` | Agent Loop | `triggerId` `chat` `reason` `detail` | 回复模型失败，已退回固定话术 |
| `session:transcript-failed` / `session:reset-failed` | Agent Loop | `key` `detail` | 会话转录 / `/new` 重置失败，不影响当轮回复 |
| `config:created` | Config | `path` | 首次启动写入了默认 `config.yaml` |
| `config:parse-failed` | Config | `path` `detail` | YAML 解析失败，已降级为默认配置启动 |
| `config:legacy-backend` | Config | `path` | 旧版 `backend` 段已兼容映射到 `runtime` |
| `config:intake-migrated` | Config | `chats` `enabled` `maxQuestions` | 旧版全局 `intake:` 段已迁移到群级配置（`chats` 是被迁移的群） |
| `config:invalid-security-override` | Config | `runtime` `keys` | `runtime.options` 试图覆盖安全参数，启动被拒绝 |
| `config:patch-rejected` / `config:write-failed` | HTTP API | `errors` / `detail` | 面板保存的配置校验失败或落盘失败 |
| `api:config` | HTTP API | `changed` `policyChanged` `restartRequired` `identityEffective` | 配置保存成功、是否需要重启、允许名单是否已即时生效 |
| `api:request-failed` | HTTP API | `method` `path` `detail` | 请求级未预期异常（客户端会收到 500） |
| `logs:assistant-answered` | Log Assistant | `question` `evidence` `source` `tools` | 日志页排查助手给出结论；`source` 为 `llm`（模型总结）或 `rules`（规则降级），`tools` 是这次用到的工具名 |
| `logs:assistant-model-failed` | Log Assistant | `question` `detail` | 模型总结失败，已退回规则式排查，结论里会写明降级原因 |
| `api:log-assistant-failed` | HTTP API | `question` `detail` | 排查请求本身失败（客户端会收到 500） |
| `issue:created` | Issue Reporter | `repo` `number` `title` | 排查结论已上报成 GitHub issue |
| `issue:create-failed` | Issue Reporter | `repo` `code` `detail` | issue 创建失败（`gh` 未登录、仓库不存在等），面板上会提示失败原因 |
| `api:issue` | HTTP API | `number` `url` | 面板触发的一键上报成功 |
| `api:issue-create-failed` | HTTP API | `detail` | 一键上报失败（客户端会收到 500） |
| `ticket:resume-failed` | HTTP API | `ticketId` `detail` | 工单详情里的恢复命令生成失败，详情页仍可打开 |
| `effect:done` / `effect:failed` | Effects | `kind` `key` / `error` | 派工、停止、清理等内部动作的执行结果 |
| `worker:stop-queued` | Service | `ticketId` `source` | 自动关单（`idle` / `pr:merged` / `pr:closed`）后排队停 worker，workspace 保留给定时任务回收；同 key 已存在时不重复记录 |
| `cleanup:queued` | Service | `ticketId` `source` | 排队回收 workspace：人工停止（`stop`）与派工半成功（`launch-failed`）；同 key 已存在时不重复记录 |
| `workspace:sweep` / `workspace:sweep-failed` | Service | `due` `removed` `skipped` `keepHours` / `message` | 定时任务回收已关闭工单残留工作区的汇总；扫描失败只记一次，不影响主流程 |
| `cleanup:worktree-removed` / `cleanup:worktree-skipped` / `cleanup:no-remove-capability` | Service | `ticketId` `workdir` / `reason` `attempts` | 自动回收 workspace 的结果；脏目录或不可重试的失败只记录一次并通知发起人 |
| `workspace:bulk-removed` / `workspace:bulk-skip` / `workspace:bulk-cleanup` | Service | `ticketId` `workdir` / `reason` / `requested` `removed` `skipped` | 面板「清理工作区」逐项回收结果与汇总 |
| `outbox:sent` / `outbox:failed` | Outbox | `key` `channel` `text` / `error` | 对外消息的最终投递结果 |
| `worker:status-failed` | Service | `ticketId` `handle` `runtime` `detail` | 运行时活性查询失败，按未知状态处理 |
| `worker:event-log-failed` | Service | `ticketId` `kind` `detail` | 工单 `events.log` 写入失败，不影响主流程 |
| `pr:inspect-failed` / `pr:repo-slug-failed` | Service | `ticketId` `handle` `detail` | PR 线索获取失败，等待 gh 兜底 |
| `cursor:invalid` | Service | `key` `detail` | 游标 JSON 损坏，按无游标处理 |
| `llm:model-config-failed` | CLI | `detail` | 启动时模型配置缺失或不可解析 |
| `llm:import-applied` | HTTP API | `source` `name` `api` `baseUrl` `changed` | 从本地 Claude Code / CCSwitch / Pi / OpenCode / Magpie 配置导入 Provider，已写回 `config.yaml` |
| `api:llm-import` | HTTP API | `source` `model` `changed` | 面板触发的本地 Provider 导入成功（不记录密钥） |
| `llm:import-missing` / `llm:import-rejected` / `llm:import-scan-failed` / `llm:import-write-failed` | HTTP API / Import | `id` / `errors` / `detail` | 候选已失效、校验失败、扫描失败或落盘失败（不记录密钥） |
| `update:checked` | Update | `current` `latest` `hasUpdate` | 每 6 小时的版本检查结果 |
| `update:check-failed` / `update:skipped` | Update | `detail` / `reason` `root` | registry 不可达，或源码运行时跳过全局安装 |
| `update:upgrade-started` / `update:upgraded` / `update:upgrade-failed` | Update | `from` `to` `durationMs` / `code` `detail` | npm 全局安装的开始、成功与失败 |
| `update:service-restarted` / `update:service-stop-failed` / `update:restart-failed` | CLI | `pid` / `pid` `reason` `detail` | `ra update` 自动重启的结果 |
| `update:restart-scheduled` | Router Tool | `delayMs` | 飞书里让 Router 更新版本后，安排在回复发出后重启服务 |
| `api:update` | HTTP API | `phase` `from` `to` `reason` | 面板触发的更新结果 |
| `codex:binary-resolved` | Codex runtime | `ticketId` `source` `path` `version` | 实际使用的 Codex 可执行文件（App 内置 / 环境变量 / PATH） |
| `codex:codex-home` | Codex runtime | `ticketId` `codexHome` | 子进程使用的 `CODEX_HOME`；与桌面端不一致时桌面端看不到 thread |
| `codex:full-access` | Codex runtime | `ticketId` `approvalPolicy` `sandboxMode` | Worker 以 full access 运行；没有人工审批闸门 |
| `codex:thread-started` | Codex runtime | `ticketId` `threadId` `cwd` `sandboxMode` `approvalPolicy` | `thread/start` 成功，threadId 写入 Assignment |
| `codex:thread-name-failed` | Codex runtime | `ticketId` `threadId` `reason` | `thread/name/set` 失败；不影响工单，只是桌面端标题退回默认摘要 |
| `codex:turn-started` | Codex runtime | `ticketId` `threadId` `turnId` `inputIds` `preview` | 新 turn 开始；追问也会走这里 |
| `codex:turn-completed` | Codex runtime | `ticketId` `threadId` `turnId` `status` `durationMs` | turn 正常结束 |
| `codex:turn-failed` | Codex runtime | `ticketId` `threadId` `turnId` `reason` | turn 失败，转人工 |
| `codex:turn-steered` / `codex:steer-failed` | Codex runtime | `ticketId` `threadId` `turnId` `inputId` / `reason` | 执行中追加输入成功或失败（失败会排队） |
| `codex:approval` | Codex runtime | `ticketId` `threadId` `kind` `decision` `command` | 审批请求的处理结果（full + never 下通常不出现） |
| `codex:resumed` / `codex:resume-failed` | Codex runtime | `ticketId` `threadId` / `reason` | 重启后 `thread/resume` 接回成功或失败 |
| `codex:process-exit` | Codex runtime | `ticketId` `threadId` `code` `signal` `reason` | app-server 子进程退出 |
| `codex:interrupted-turn-check-failed` | Codex runtime | `ticketId` `threadId` `reason` | `thread/turns/list` 读不回轮次状态；判定不了有没有被中断，不触发恢复动作 |
| `codex:error` | Codex runtime | `ticketId` `threadId` `reason` | Codex 返回的警告/错误事件 |
| `codex:launch-failed` | Codex runtime | `workdir` `branch` `reason` | 派工启动失败 |

worker 终端里的原始输出**不进日志**（避免把 TUI 文本当状态）；主动巡检优先读 Agent 自己的会话记录（Claude / Codex，见 [RUNTIME.md](RUNTIME.md#运行时选项各运行时自己声明)），其次才把终端里的语义摘要（助手文本 + 动作概要）发到话题，不逐条回放工具调用。要看它做了什么，读 `report` 的 `summary` 与 `~/.router-agent/workers/<ticketId>/events.log`。

> 话题内直接发言时，飞书会把 `reply_to` 自动填成话题根消息。Source 只在 `reply_to` 与 `root_id` 不同时才当作用户引用，否则记 `raw.quoteIgnored` 并跳过回查，避免每条话题回复都拼上根消息正文（tk-51）。

### 查看与排查

```bash
ra logs                                  # 最近 50 行
ra logs --follow                         # 实时跟随
grep '"message":"trigger:' ~/.router-agent/logs/router-agent.log
```

面板「日志」页支持按 INFO / WARN / ERROR 过滤与关键字搜索。

### 智能问题排查助手

面板右下角常驻一个**智能排查助手悬浮按钮**，不用切到「日志」页也能用：

1. 服务日志里出现 `error` 时，按钮变成红色并带上错误条数，同时弹一条「检测到 N 条新的错误日志」的提示；没有错误时是普通状态。
2. 鼠标移到按钮上会展开快捷菜单：**智能分析异常**（直接分析最近的错误）、**上报 GitHub issue**（打开面板并分析，看完结论再决定要不要报）、**打开排查面板**。
3. 点开后是弹窗：描述问题（也可以点常见问题快捷入口）→ 给出结论、可能原因、建议的下一步、证据日志；结论属于配置类时给「去配置页修改」的入口，属于缺陷 / 体验类时给「一键上报 GitHub issue」的按钮。

- 有配置模型时由模型总结，结论里会标注「模型总结」；没配模型或模型调用失败时自动退回**规则式排查**（内置「事件名 → 症状」知识库），结论标注「规则排查」，降级原因写在结论下方。
- 助手与日志页共用同一套筛选：用户看到的日志范围就是排查范围，结论里引用的事件一定能在证据列表里看到。
- 证据按分诊顺序排列：错误 → 警告 → 普通信息，同级里越新越靠前。
- 助手只读日志，不改配置、不动工单；所有动作仍要走面板或 CLI。
- 发给模型前，日志里的正文类字段（`text` / `reply` / `summary` / `content` 等）会被替换成「（内容已省略）」：排查用不到用户消息正文，没必要把它送到外部模型。面板上看到的证据仍是完整内容。

#### 模型能看本机代码与配置

配了模型时，助手是一个带工具的 Agent，可以调用四个**只读**工具核实判断：

| 工具 | 作用 |
|-|-|
| `read_config` | 读取当前生效的配置（密钥已脱敏）与配置文件路径 |
| `list_code` | 列出 router-agent 安装目录下的文件与子目录 |
| `read_code` | 读取安装目录内的文本文件（可指定行号区间） |
| `search_code` | 在安装目录里搜关键字，返回 `文件:行号:内容` |

安全边界（硬约束，不要为了方便放宽）：**只读**（没有写、删、执行命令的能力）、**路径封闭**（所有路径必须在安装目录内，`..` 越界一律拒绝）、**限量**（单次读文件 400 行 / 20000 字符，搜索最多 30 条命中）。结论里会列出这次用到的工具，用户知道判断依据是什么。

#### 一键上报 GitHub issue

判定为缺陷 / 体验问题时，点「一键上报 GitHub issue」会把**问题描述 + 排查结论 + 可能原因 + 建议 + 证据日志**拼成一条 issue 发到 `blankPen/router-agent`（仓库可用环境变量 `RA_ISSUE_REPO` 覆盖）。走 `gh` CLI，与 PR 跟踪共用同一套登录态，用户不用额外配置。issue 正文里的日志就是面板上看到的那批证据。

上报入口有两处，任意一处都会真的建出 issue：

- **悬浮菜单的「上报 GitHub issue」**：打开面板并分析，**不会自动提交**——分析完、用户看过结论后，弹窗底部才出现「一键上报 GitHub issue」，由用户点一下才发出。结论若是「配置没生效」，用户可以不上报。
- **弹窗底部的「一键上报 GitHub issue」**：结论里命中缺陷 / 体验类问题时出现。配置类与缺陷类同时命中时，**两个入口都给出**——只给「去配置页修改」的话，缺陷就报不上去。

issue 正文分四段：**问题描述**、**排查结论**（可能原因 + 建议的下一步）、**错误日志**、**证据日志**。其中「错误日志」段把 `error` 级的条目单独提到最前面——用户上报 issue 就是冲着错误来的，混在几十条 `info` 里等于没有。助手回看日志的窗口也比面板大（5000 行 / 4MB），避免服务一忙、错误被后来的 `info` 挤出窗口。

> 排查助手判断「配置类 / 缺陷类」时，只有真正的失败事件才算症状。消息进线（`trigger:ingested`）、建单（`thread:created`）、研判（`router:decision`）、派工（`launch`）、保存配置（`api:config`）这些**正常事件不算命中**，否则服务正常运行时也会被判成问题、进而挡住上报入口。

#### 上报失败会看到什么

`gh` 没装、没登录、没权限时，面板会显示具体原因和下一步动作（不是裸的英文报错）：

| 情况 | 面板提示 |
|-|-|
| 没装 `gh` | 未找到 gh 命令，请先安装 GitHub CLI（brew install gh）后重试 |
| 没登录 | gh 未登录，请先执行 gh auth login 登录 GitHub |
| 凭据失效 | GitHub 凭据无效，请重新执行 gh auth login 登录 |
| 对仓库无权限 | 当前账号没有该仓库的创建权限，请换用有权限的账号或改 `RA_ISSUE_REPO` |
| 仓库不存在 | 仓库不存在或无权访问，请检查 `RA_ISSUE_REPO` 配置 |

失败同时会记到服务日志：`issue:create-failed`（带 `code` 与 `detail`）与 `api:issue-create-failed`。

> **同一机器人只能有一个事件总线在跑。** 如果 `ra logs` 出现 `another event bus is already connected`，先停掉其它占用该应用的消费者；建议给 router-agent 使用独立的自建应用，避免与其它 agent 抢同一个机器人。

## 数据迁移

历史 sessionKey 从 `chat:<chatId>:...` 迁移到 `channel:feishu:chat:<chatId>:...`，**只由人手动执行**，启动时不会自动写库：

```bash
ra stop

# 备份（WAL 先 checkpoint，生成一致性快照）
sqlite3 ~/.router-agent/state.db "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 ~/.router-agent/state.db \
  "VACUUM INTO '$HOME/.router-agent/state.db.bak-$(date +%Y%m%d%H%M%S)';"

ra migrate sessions --dry-run    # 只读：待迁移数 / 异常 key / 映射样例
ra migrate sessions --apply      # 交互确认后执行，事务内完成，幂等
ra migrate sessions --verify     # 总数、格式、审计表、异常检查

ra start
```

- 迁移只改 `chat_sessions` 与 `chat_session_resets` 的 `session_key`、`id`，会话文件与内容不动。
- 异常 key（既不是 `chat:` 也不是 `channel:`）不会被修改，`--dry-run` 会列出来，需要人工确认后单独处理。
- 非交互环境执行 `--apply` 必须显式加 `--yes`；不提供 `--force`。
- 迁移失败时事务整体回滚；回滚版本请恢复上一步的备份文件。
- 手工 SQL 兜底：`scripts/migrations/2026-11-session-key-channel.sql`（同样由人确认后执行）。

## 线程别名回填（话题 ID）

飞书在老线程上只给根消息 ID（`om_`），但「在话题面板里直接发言」时事件只带话题 ID（`omt_`）。
Router 靠 `thread_aliases` 把两者收敛到同一条线程，见 `Store.resolveThread`。

存量线程需要一次性补上话题 ID，否则这类消息仍然匹配不上已有工单：

```bash
ra stop
ra migrate threads --dry-run    # 只读：线程总数 / 待回填数 / 样例
ra migrate threads --apply      # 回查话题 ID 并登记别名，幂等
ra migrate threads --verify     # 仍缺少话题 ID 的线程数
ra start
```

- 规范线程 ID 的尾段始终是可回复的消息 ID（`om_`）——`+messages-reply --message-id` 只接受 `om_`。
- 同一消息带多个标识时，按「话题 ID > 根消息 ID > 消息自身 ID」的顺序解析，与登记时间无关。
- 查询失败的线程（消息已删除 / 无权限）如实报告，仍需按根消息 ID 归并；`--apply` 退出码为 1。

## 已知限制

- 第一版只支持 macOS（Orca 运行时在 Linux 上裸 `orca` 会撞 GNOME 屏幕阅读器，需要 `orca-ide`）。
- 不做自动合并 PR / MR，只跟踪与通知。
- GitHub / GitLab Source 只用于 PR / MR 状态跟踪，不消费 Issue / 评论。
- 上报走 `ra report`，`state.json` 只作为服务不可达时的兜底通道。
- 图片会下载并落盘到 `/tmp/ra-images/`，原图路径透传给 Worker（可直接查看）；同时用多模态模型转成文字供研判。文件 / 语音等其它附件只识别到「这是一条附件消息」，需要内容时请用文字描述。
- 图片转文本依赖模型支持 image 输入；主模型不支持时请在 `llm.imageModel` 单独配置视觉模型。单张转写失败时原图仍会落盘并透传，研判只能看到占位说明；`feishu.images.enabled: false` 则整条图片链路关闭。
- 实测 Orca 的 `lastOutputAt` 是毫秒数字、且 CLI 创建的终端可能 `orphaned=true` 但依然可用；适配层已分别做归一化与「只有 `connected=false` 才判死」的处理。
- Claude Code 运行时用 `git worktree`，项目清单与 Orca 隔离（`runtime.projects.claude-code`），`repo` 必须是本地仓库绝对路径（`path:/abs` 或 `/abs`）；`ra init` 在 `runtime.default: claude-code` 时会直接问路径。切换运行时后，没有对应清单项目的工单会先追问，不会把 Orca 选择器当路径用。
- Claude Code 运行时启动时带 `--dangerously-skip-permissions`，正常情况下不会因权限确认阻塞；若仍进入 `blocked`（例如等待人工输入），只转人工，不自动 resume。追问在当前轮结束后生效（与 TUI 输入排队一致）；需要轮内实时插话时要改用 `stream-json` 或 SDK/ACP。
- Claude Code 的追问遵循「一个话题 = 一个会话」：本轮还在跑（`state=working`）时通过 `claude attach <id>` 把输入插进当前轮，agent 会像 TUI 里那样在处理中途收到这句话；本轮已结束（`done/stopped`）则先 `claude stop <id>`（会话与对话都保留），再用 `--bg --resume <完整 sessionId>` 原地续跑同一会话。**必须传 `claude agents --json` 里打印的完整 session id**（传 short id 会被 CLI 判成另开一个会话），也不能带新 flag。
- Claude Code 轮内插话走的是 TUI 输入框（attach），不是官方接口：注入后必须用会话记录里的 `input-<id>` 标记校验，没落盘就退回排队、等本轮结束再 resume；同一条输入按 meta 水位线幂等，不会因为 Router 重投而重复插话。`blocked`（等权限/人工）不插话，只转人工。
- Claude Code 的后台 worker 在本轮结束后仍然存活，此时直接 `--bg --resume` 会被 CLI 判成「already running in the background」并复制出一个副本——这才是 fork 的真正来源（不是 `--` 分隔符）。适配器已经先 stop 再 resume；万一仍出现副本，会 `claude stop` 掉副本、保留原会话不变，并把本轮输入退避重投回原会话（`claude:resume-forked`），5 次后转人工。
- Claude Code 副本路径刻意不用 `claude rm`：部分版本会连带删掉工单的 worktree。
- 输入按「来源标识」幂等：飞书消息用 trigger 的外部 id 做 `source_key`；跨来源重复（飞书 + 面板各插一条同文本）按 120 秒窗口去重。已 ack / expired 的输入不参与去重，用户可以再发一遍同样的话。
- 回收检出时 `git worktree remove` 会带上源仓库作为 cwd（拿不到就退回检出目录自己），否则进程 cwd 不在仓库里会报 `fatal: not a git repository`，检出与分支会残留在磁盘上。
- 自动升级的 npm 安装默认超时 300 秒；超时会被 SIGKILL，日志记 `update:upgrade-failed` 且带 `timedOut` / `signal` / `timeoutMs`，不再退化成看不出原因的「npm 退出码 1」。
- Claude Code 依赖 `claude agents --json --all` 的字段（本仓库实测 `2.1.318`）；升级后字段变化时状态会退化为 `null`，需要按版本适配。
- 派工草稿按「群 + 同一个人」保存，30 分钟有效；同一个群里的多个未补齐请求会互相覆盖（后一次追问覆盖前一次）。
- Pi SDK 仍在演进，本仓库锁定 `@earendil-works/pi-coding-agent@1.5.0`，升级前先跑 `RA_PI_VERIFY=1` 的真实环境验证。
- Pi 是唯一研判引擎，没有回退到旧实现的开关；Pi 不可用时候选会按 `unavailable` 落库，不会静默重试。
