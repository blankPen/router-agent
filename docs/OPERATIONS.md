# 回复、面板、日志与已知限制

本文说明 Router 什么时候说话、怎么说话，Web 面板各页做什么，以及日志能追到哪一步。架构与派工流程见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 回复策略

Router 不做对话，只在必要时说话：

| 场景 | 行为 |
|-|-|
| **会被处理的已寻址消息**（@ / 私聊 / 全量接收群） | 收到后**立即**加一个确认表情（默认 `Typing` ⌨️），回复发出后自动取消；被准入拦截的消息不加 |
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

- 确认表情是 best-effort：失败只记 `feishu:reaction-failed`，不影响研判；只对首次入库、且是在跟它说话（@ / 私聊 / 全量接收群）的消息加；被准入拦截（群白名单外、`admission: ignore`）的消息不加，避免「有表情、永远没回复」；重放不会重复加；回复发出后自动撤销（`feishu:unreact-failed` 是撤销失败的日志）。`ra config set feishu.reaction ""` 可关闭。
- 全部 emoji_type 见飞书文档「表情文案」，注意**大小写敏感**（`Typing` 不是 `TYPING`）。
- 出站按内容分流：**单行、≤200 字、不含 Markdown 语法**的回复直接用 `text` 消息；其余用飞书**互动卡片**渲染 Markdown，卡片失败自动降级为 post 富文本。分流规则：`threadId` 为空 = 普通消息，有值 = 话题回复。
- 卡片内的 Markdown 会先归一化（`normalizeCardMarkdown`），把 Card 1.0 不支持的语法降级掉：`#` 标题 → 加粗行、`>` 引用 → `▍`、表格 → 加粗表头 + 列表行、`- [x]` → ☑ / ☐、`<br>` → 换行、`![图片](http...)` → 可点击链接；代码块内原样保留。

## Web 面板

`ra start` 自动打开、`ra web` 也可随时打开的面板分五块：

- **初始化**：只放启动必需的五件事——LLM Provider、运行时、项目、飞书机器人、群与绑定，顶部有完成度清单；LLM Provider 的 Base URL / 模型 / API Key 三项必填（密钥只写入 `config.yaml`，保存后不回显），可选 OpenAI / Anthropic 两种接口协议，并支持从 Claude Code、CCSwitch、Pi、OpenCode、Magpie 的本地 Provider 配置一键导入；飞书 App ID / App Secret 与授权也直接在本页完成（固定 `~/.router-agent-lark` profile）。逐项说明见 [README · 快速开始](../README.md#快速开始)；运行时的卡片检测与安装引导见 [RUNTIME.md](RUNTIME.md)。
- **工单**：按阶段分组 + 计数、关键字搜索（标题 / 工单号 / 仓库 / PR）、自动刷新开关与手动刷新；详情页有阶段、派工、PR、授权范围、上报时间线（含完整回复与 `humanAction`）、投递记录，可直接投递 follow-up 或停止工单。页头还有「清理工作区」入口：按 Worker 运行时分组列出仍在磁盘上的工单工作区，可勾选多个工单批量清理。清理动作按工单各自的运行时执行——Orca 关闭 worktree 并删除目录，Claude Code 删除 `claude agents` 视图与 worktree 目录，ACP 直接删除 worktree 目录；在办工单与有未提交改动的目录会被跳过，并在结果里说明原因。
- **日志**：直接看 `~/.router-agent/logs/router-agent.log`，默认 2 秒增量拉取（只读游标之后的新字节，不重复读整个文件），可开「实时刷新」；按 INFO / WARN / ERROR 过滤、按消息或字段搜索、复制当前结果；停在底部时自动跟随新日志，往上翻后不再打断，点「最新」回到底部。文件不存在或还没写入时给出空状态提示。
- **配置**：按「LLM Provider / 准入策略 / 研判与人格 / 会话复用 / 进展同步 / 闲置治理 / 飞书消息 / 派工与服务 / 项目与群绑定」分组；飞书分组的顶部是「飞书机器人」区块，可直接写入 App Secret、刷新授权状态并引导完成飞书授权。每个字段带说明与默认值提示，改动逐项标脏，保存前做前端 + 后端双重校验，保存后写回 `config.yaml`。「派工与服务」里的 Worker 运行时是与初始化页相同的卡片平铺组件（`orca` / `claude-code` / `acp` / `acp-*`），可检测安装状态、分别跳转官方文档安装 CLI 或由 ra 安装 ACP 扩展，并做 ACP 握手试启动；项目清单按运行时隔离，切换运行时后「项目与群绑定」里的项目清单会切换到该运行时自己的一套（Orca 用仓库选择器，Claude Code / ACP 必须是本地仓库绝对路径）；「添加本地项目」支持系统目录选择并自动识别 Git / 分支，「添加 Git 项目」支持填写 ssh / http(s) 地址后自动 clone 并登记。群绑定的项目只能从当前清单里选，分支自动跟随项目的默认分支，不能单独自定义。
- **来源**：服务状态、监控群、接收范围概览。

侧栏品牌行末尾有全局主题切换图标：**跟随系统 / 亮色 / 暗色** 三态循环，默认跟随系统；选择只存在浏览器本地，不写入 `config.yaml`，所有页签即时生效。

发现 npm 上有新版本时，侧栏「服务运行中」状态条上方会出现更新提示：点「更新并重启」会执行 `npm install -g router-agent@latest` 并在安装成功后自动重启 daemon，页面无需刷新；点 × 只忽略当前版本，出现更高版本时会再次提示。窄屏侧栏收起后退化为右下角悬浮按钮。也可以直接在飞书里让 Router 更新版本——它会调用 `router_update` 工具安装最新版，并在回复发出后自动重启整个服务。

配置项会标注生效范围：**策略**（`acceptMode` / `maxWorkers` / `admission`）保存后立即生效；其余配置在服务启动时读入，保存后点侧栏或配置页的「重启服务」即可热重启 daemon（浏览器页面不会刷新），也可以手动 `ra stop && ra start`。面板可以在「初始化 · LLM Provider」或「配置 · LLM Provider」里填写 `llm.apiKey`，密钥只写入 `config.yaml`，保存后不会再回显（`publicConfig` 只返回 `apiKeySet`）；也可以用 CLI / 环境变量配置。保存会重写 `config.yaml`，原文件的注释会丢失。

## 日志

所有关键节点都是结构化 JSON，一行一个事件（`at` / `level` / `message` + 业务字段），写入 `~/.router-agent/logs/router-agent.log`：

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
| `report:evidence-missing` | Service | `ticketId` `mode` `action` `source` `reason` `missing` | UI 工单缺 Before / After 证据；`enforce` 时 action=reject，`warn` 时只记录 |
| `report:evidence-unverified` | Service | `ticketId` `mode` `unverified` `source` | 无法判断是否有证据（workdir 丢失、git / PR 查询失败），降级放行 |
| `report:ingest-failed` | Service | `ticketId` `message` | 兜底通道处理上报时的非门禁异常 |
| `progress:synced` / `progress:dedup` | Service | `ticketId` `count` / `skipped` | 进展定时合并同步，或内容重复被跳过 |
| `progress:probed` | Service | `ticketId` `minutes` `count` `unchanged` | 主动巡检读会话记录 / 终端并把语义摘要同步到话题 |
| `outbox:sent` / `outbox:failed` | Outbox | `key` `text` / `error` | 对外通知结果 |
| `api:input` / `api:stop` / `api:policy` / `api:config` | HTTP API | — | 面板 / CLI 的操作 |
| `idle:nudge` / `idle:stale` | Service | — | 空闲唤醒与失联标记 |
| `pr:linked` / `pr:state` | Service | — | PR / MR 跟踪 |
| `pr:track-failed` | Service | `ticketId` `prNumber` `repo` `message` | PR / MR 状态查询无结果；同一工单 + PR 只记一次 |
| `recover:*` | Service | — | 重启对账 |

消息、配置与异常三类关键链路的补充事件（都遵循同一套 `at` / `level` / `message` + 业务字段格式）：

| 事件 | 来源 | 关键字段 | 说明 |
|-|-|-|-|
| `trigger:duplicate` | Source | `id` `chat` | 重复投递的消息被入库去重，不是消息丢失 |
| `channel:not-registered` | Channel Router | `channel` `target` `key` | Outbox 里的通道没有注册，跳过发送（历史脏数据不会卡死队列） |
| `channel:duplicate-id` | Channel Registry | `channel` `kind` | 同一通道实例被重复注册，保留最后一次 |
| `channel:ack-failed` | Channel Ingress | `channel` `messageId` `message` | 回执表情添加失败，不影响消息入库与回复 |
| `session:migrated` | CLI | `sessions` `resets` | 人工执行 `ra migrate sessions --apply` 完成 |
| `session:migration-required` | CLI | `pending` | 存在未迁移的历史 sessionKey，服务拒绝启动 |
| `session:migration-incomplete` / `session:migration-verify-failed` / `session:migration-failed` | CLI | 计数与异常数 / `message` | 迁移执行失败（已回滚）或迁移后校验未通过 |
| `feishu:consumer-start-failed` | CLI | `message` | 飞书通道启动失败 |
| `feishu:reconnecting` | Source | `attempt` `delayMs` | 事件消费者断开，已安排退避重连 |
| `feishu:spawn-failed` | Source | `message` | lark-cli 无法拉起（未安装 / 无权限），会继续重试 |
| `feishu:card-fallback` | Sender | `target` `key` `code` `message` | 互动卡片发送失败，已自动降级为富文本 |
| `feishu:quote-fetch-failed` / `feishu:quote-parse-failed` | Source | `messageId` `message` | 引用消息回查失败，按原消息继续 |
| `chats:refresh-failed` / `chats:parse-failed` / `chats:cache-invalid` | Source | `code` / `message` / `path` | 群名目录刷新失败或缓存损坏，旧值继续可用 |
| `loop:trigger-failed` | Agent Loop | `triggerId` `chat` `message` | 单条消息处理异常，同批其它消息不受影响 |
| `decision:engine-failed` | Agent Loop | `triggerId` `message` | 研判引擎调用失败，按 unavailable 处理并留下原因 |
| `chat:reply-failed` | Agent Loop | `triggerId` `chat` `reason` `message` | 回复模型失败，已退回固定话术 |
| `session:transcript-failed` / `session:reset-failed` | Agent Loop | `key` `message` | 会话转录 / `/new` 重置失败，不影响当轮回复 |
| `config:created` | Config | `path` | 首次启动写入了默认 `config.yaml` |
| `config:parse-failed` | Config | `path` `message` | YAML 解析失败，已降级为默认配置启动 |
| `config:legacy-backend` | Config | `path` | 旧版 `backend` 段已兼容映射到 `runtime` |
| `config:invalid-security-override` | Config | `runtime` `keys` | `runtime.options` 试图覆盖安全参数，启动被拒绝 |
| `config:patch-rejected` / `config:write-failed` | HTTP API | `errors` / `message` | 面板保存的配置校验失败或落盘失败 |
| `api:config` | HTTP API | `changed` `policyChanged` `restartRequired` | 配置保存成功及是否需要重启 |
| `api:request-failed` | HTTP API | `method` `path` `message` | 请求级未预期异常（客户端会收到 500） |
| `ticket:resume-failed` | HTTP API | `ticketId` `message` | 工单详情里的恢复命令生成失败，详情页仍可打开 |
| `effect:done` / `effect:failed` | Effects | `kind` `key` / `error` | 派工、停止、清理等内部动作的执行结果 |
| `outbox:sent` / `outbox:failed` | Outbox | `key` `channel` `text` / `error` | 对外消息的最终投递结果 |
| `worker:status-failed` | Service | `ticketId` `handle` `runtime` `message` | 运行时活性查询失败，按未知状态处理 |
| `worker:event-log-failed` | Service | `ticketId` `kind` `message` | 工单 `events.log` 写入失败，不影响主流程 |
| `pr:inspect-failed` / `pr:repo-slug-failed` | Service | `ticketId` `handle` `message` | PR 线索获取失败，等待 gh 兜底 |
| `cursor:invalid` | Service | `key` `message` | 游标 JSON 损坏，按无游标处理 |
| `llm:model-config-failed` | CLI | `message` | 启动时模型配置缺失或不可解析 |
| `llm:import-applied` | HTTP API | `source` `name` `api` `baseUrl` `changed` | 从本地 Claude Code / CCSwitch / Pi / OpenCode / Magpie 配置导入 Provider，已写回 `config.yaml` |
| `api:llm-import` | HTTP API | `source` `model` `changed` | 面板触发的本地 Provider 导入成功（不记录密钥） |
| `llm:import-missing` / `llm:import-rejected` / `llm:import-scan-failed` / `llm:import-write-failed` | HTTP API / Import | `id` / `errors` / `message` | 候选已失效、校验失败、扫描失败或落盘失败（不记录密钥） |
| `update:checked` | Update | `current` `latest` `hasUpdate` | 每 6 小时的版本检查结果 |
| `update:check-failed` / `update:skipped` | Update | `message` / `reason` `root` | registry 不可达，或源码运行时跳过全局安装 |
| `update:upgrade-started` / `update:upgraded` / `update:upgrade-failed` | Update | `from` `to` `durationMs` / `code` `message` | npm 全局安装的开始、成功与失败 |
| `update:service-restarted` / `update:service-stop-failed` / `update:restart-failed` | CLI | `pid` / `pid` `reason` `message` | `ra update` 自动重启的结果 |
| `update:restart-scheduled` | Router Tool | `delayMs` | 飞书里让 Router 更新版本后，安排在回复发出后重启服务 |
| `api:update` | HTTP API | `phase` `from` `to` `reason` | 面板触发的更新结果 |

worker 终端里的原始输出**不进日志**（避免把 TUI 文本当状态）；主动巡检优先读 Claude 会话记录，其次才把终端里的语义摘要（助手文本 + 动作概要）发到话题，不逐条回放工具调用。要看它做了什么，读 `report` 的 `summary` 与 `~/.router-agent/workers/<ticketId>/events.log`。

### 查看与排查

```bash
ra logs                                  # 最近 50 行
ra logs --follow                         # 实时跟随
grep '"message":"trigger:' ~/.router-agent/logs/router-agent.log
```

面板「日志」页支持按 INFO / WARN / ERROR 过滤与关键字搜索。

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
- Claude Code 依赖 `claude agents --json --all` 的字段（本仓库实测 `2.1.318`）；升级后字段变化时状态会退化为 `null`，需要按版本适配。
- 派工草稿按「群 + 同一个人」保存，30 分钟有效；同一个群里的多个未补齐请求会互相覆盖（后一次追问覆盖前一次）。
- Pi SDK 仍在演进，本仓库锁定 `@earendil-works/pi-coding-agent@1.5.0`，升级前先跑 `RA_PI_VERIFY=1` 的真实环境验证。
- Pi 是唯一研判引擎，没有回退到旧实现的开关；Pi 不可用时候选会按 `unavailable` 落库，不会静默重试。
