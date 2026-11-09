# router-agent vs dsh-superagent-prototype 差距分析

> 日期：2026-11-06
> 对象：`/Users/admin/pz/dsh/router-agent`（ra，src ≈ 6.7k 行，248 测试）vs `/Users/admin/pz/dsh/dsh-superagent-prototype`（src ≈ 12.7k 行，≈811 测试，9 篇设计文档 ≈ 2k 行）
>
> 说明：原型是「研究代码」，很多设计讲的是方向而非实现；本报告只提炼**可迁移的机制**，不要求照抄领域模型。凡是原型自己也没有的能力（多仓库、成本预算、长期记忆、离线评测、自动回滚），单列为「共同缺口」，不算 ra 落后。

---

## 0. 一句话结论

ra 的**主干是通的**：Source → Gate → LLM 研判 → 工单/Mandate → Orca worker → `ra report` → Outbox → PR 闭环，每一环都有测试与真实环境验证，工程密度（6.7k 行 / 248 测试）在同类项目里不低。

差距不在「少了哪个大功能」，而在三层：

1. **正确性层面有 6 个真 bug**（补拉取错消息、并发口径漏算、策略热更新不生效、LLM 无超时、stop 决策空转、决策日志无法查看）——这些不修，功能越多越危险；
2. **运营闭环缺一个面**：ra 写了很多状态（decisions / triggers / attention），但只有 tickets 一个可读出口，导致 observe 模式、失败排查、研判复盘实际上没法运营；
3. **执行与交付的语义偏浅**：订阅=无脑转发、工单关了不能续、progress 也发消息、worker 没有「交回路由」的通道。

---

## 1. 分层对照

| 层 | ra 现状 | prototype | 判断 |
|-|-|-|-|
| 来源 | 飞书事件流（lark-cli 子进程）；GitHub 只查 PR 三态 | 飞书事件流 + 每群游标补拉 + 线程轮询双通道；GitHub Issue/PR/评论/review/CI 全覆盖；图片附件链路；Source 插件契约 | **差距大** |
| 准入 | 3×2 准入表 + acceptMode + bot 名单（`core/policy.ts`） | 同为 3 格表，但按 Source 维度、默认更保守、Mandate 恢复前重校验 | **接近，默认值偏松** |
| 研判 | 单条 LLM + 5 个工具 + 3 轮 | 批量候选 + 强 schema（每条规则必须给结论）+ 方向四字段 + deadline/重排 | **差距中** |
| 执行 | Orca worktree + 终端 + 上报协议；无 resume/暂停/handback | 持久 session + 槽位调度（人工 +1 槽）+ pause/retry/stop + handback | **差距中** |
| 交付 | 卡片/富文本降级 + 分块 + Outbox 幂等退避 | 四种 purpose 的回复 + 严格降噪 + 去重 + 失败升级为系统问题 | **差距中** |
| 面板 | 3 Tab / 278 行，以只读为主 | 6 Tab + 2 详情 + 5 设置组 + 草稿三方合并 + 全局搜索 | **差距大** |
| 配置 | YAML + `ra config set`，无版本无审计 | block 级 revision 乐观锁 + 30 版 diff + 影响在途工单 | **差距中** |
| 文档 | README + VERIFICATION | 9 篇分层文档（含部署排障、新增 Source cookbook） | **差距大** |
| 测试 | 248 用例，功能覆盖扎实 | ≈811 用例，额外有文档/类注释/模型可见面/双语的**契约测试** | **差距中** |

---

## 2. P0：先修的 6 个正确性问题（外加 1 个恢复期漏洞）

> 修复进度：A1、B1（见第 3 节）、A4 已于 2026-11-06 修复并验证；A2、A3、A5–A7 仍待做。

### A1 启动补拉取到的是「最老的 50 条消息」（该功能已于 2026-11-08 移除）

- 证据：`src/sources/feishu-backfill.ts:5-9` —— `['im','+chat-messages-list','--chat-id',chatId,'--as','bot','--page-size','50','--order','asc',...]`，调用处 `src/cli/index.ts:669` 没有传 `startTime`。
- 已实测确认（2026-11-06，本机 bot 身份，只读）：同一群 `--order asc --page-size 3` 返回建群系统消息（2026-11-02 16:24），`--order desc` 返回最新消息（2026-11-03 21:14）。即 `asc` 且无 `--start-time`、无 `--page-all` 拿到的是**该群最早的一页**。
- 后果：一旦配了 `feishu.syncChat`，每次重启都会把群里的上古消息当新消息送进 Gate 与研判，可能开出一串历史工单；且这些消息 `receivedAt` 很旧，不受 8s 批窗口保护，会立刻进入研判。
- 建议：改成 `--order desc --page-size 50` 拿最近 50 条后倒序处理；或引入持久化游标（`KV.chat(chatId)`）+ `--start-time` 增量补拉。后者与 B2 是同一件事。

**已修复（2026-11-06）**：补拉改为「每群游标 + 首跑基线」。首次见到某个群只取最新一条记基线、不补历史；之后从游标回退 5s 用 `--start`（ISO 8601）增量拉取并推进游标；单群失败不动游标。顺带修掉了第二个错误：原代码用的是 `--start-time`，而 lark-cli 只认 `--start`，带时间窗时命令会直接失败。真实群只读验证：首跑 0 条、回拨 3 天拉到 2 条且不含机器人自发消息。

### A2 并发上限会漏算「还占着终端的工单」

- 证据：`src/service.ts:229-231` 只统计 `stage === 'assigned' || 'running'`；而 `src/core/stage.ts:17-22` 里，一旦 `hasAttention` 就变 `person`、`latestReport.state === 'ready'` 就变 `review`。
- 后果：worker 活着但在等人（`person`）或等评审（`review`）时不计入并发，`launchPending` 会继续派工，实际 Orca 终端数可超过 `maxWorkers`（当前配置 4）。
- 建议：计数口径改为「`assignment.status !== 'ended'` 的工单数」，与终端真实占用对齐；如需区分「忙/闲」，单独加 `paused` 概念。

### A3 面板改策略，Router 的提示词不跟着变

- 证据：`src/router/agent-loop.ts:78` 有 `setPolicy()`，但全仓无生产调用点；`src/cli/index.ts:682-684` 的 `onPolicyChange` 只打了一行日志。
- 后果：Gate 用的是 `engine.policy()`（实时值，行为正确），但喂给模型的 system prompt 里「当前策略」段仍是进程启动时的 acceptMode 与准入表。模型会按旧策略措辞判断，`observe` 切 `auto` 后行为与解释不一致。
- 建议：`onPolicyChange` 里同时 `service.loop.setPolicy(engine.policy())`。

### A4 LLM 调用没有超时，一次挂起会停掉半个服务

- 证据：`src/router/llm.ts:136` 的 `fetch` 没有 `signal`/超时；`src/service.ts:137-153` 的 `runCycle` 串行执行「研判 → 上报轮询 → Effects → 派工 → 投递」，并用 `ticking` 互斥。
- 后果：模型端慢请求（无上限）会让后续所有 `runOnce` 直接 return，研判、`state.json` 兜底轮询、Outbox 投递、派工全部停摆（PR 跟踪与 idle 检查因独立 timer 仍会跑，掩盖了故障）。
- 对照：prototype 的 Eval 有 30–600s deadline，超时重排，连续两次后记 `unavailable`。
- 建议：`AbortSignal.timeout(60_000)`；超时按 `unavailable` 落库并记录 attempt，避免无限重试。

**已修复（2026-11-06）**：研判层切换为 Pi 单引擎后，按 `router.timeoutMs`（默认 60s）做硬超时，并用 `router.tokenBudget`（默认 32000）限制单次研判；超时/超预算统一落 `unavailable`，不再阻塞 `runCycle`。测试：`tests/router/pi-decision-engine.test.ts`。

### A5 `stop` 决策是空转

- 证据：`src/core/model.ts:4` 定义了 `'stop'`；`src/router/agent-loop.ts:238-250` 的 `applyDecision` 把「非 accept」一律映射成 `ignore`；`src/core/engine.ts:133-144` 收到 `stop` 只写一条 decision，不停工单。
- 后果：用户在原话题里说「先停一下」，只会被当作普通跟帖转发给 worker（见 D2），工单继续跑；模型即使想停也没有效果。
- 建议：二选一——(a) 让 `stop` 真正走 `engine.stopTicket()` 并校验强度为 `explicit`；(b) 暂时从 `ROUTER_TOOLS` 的枚举里删掉，避免给模型一个假开关。

### A6 决策日志只写不读，observe 模式没有运营出口

- 证据：`src/store/db.ts:344` 写入 `decisions`，`src/store/db.ts:350` 只有按 id 取单条；无 `listDecisions`，无 API，无 CLI，面板也没有。
- 后果：`acceptMode: observe` 的设计意图是「先观察，看它本该接哪些单」，`wouldAccept` 字段也写了——但没有任何地方能看。同理，`trigger:dropped` 只能靠 `ra logs` 抓几十行。
- 建议：`GET /api/decisions?since=&decision=&wouldAccept=`，面板加「决策」Tab（含「本该接单」筛选），`ra decisions` 命令。这是**投入产出比最高的一项**。

### A7（补充）重启恢复不校验授权是否已失效

- 证据：`src/core/policy.ts:94` 的 `revalidateMandate()` 只在 `tests/core/policy.test.ts` 出现；`src/service.ts:430-464` 的 `recover()` 直接复用终端或重派。
- 后果：把人移出 `allowed`、或把 acceptMode 从 `auto` 改回 `observe` 之后，重启会让旧工单继续跑。
- 对照：prototype「恢复前必校验，失败即撤权并把消息退回 Eval」。
- 建议：`recover()` 里先 `revalidateMandate`，失败则 `stopTicket` + 通知人。

---

## 3. P1：运营闭环缺的那一块

### B1 非文本消息被误当需求（原判断有误，已纠正）

- **更正**：lark-cli 的 Process hook 已经把 `text / post / image / file / audio` 等类型的 `.content` **预渲染成人类可读文本**（见 `lark-cli skills read lark-event/references/lark-event-im.md`），所以截图不会变成 `{"image_key":...}` 乱文本。仓库里原本就有用例「非文本消息用预渲染 content」记录这一点——我上一版报告在这条上判断错了。
- 真实缺陷只剩三条：
  1. `interactive` 卡片是唯一不预渲染的类型，原始卡片 JSON 会原样进入领域；
  2. `system` 消息（建群 / 拉人 / 改群名）会进入领域；
  3. 纯附件消息（只有图/文件、没有文字）如果 @ 了机器人，会开出一张内容为「[图片]」的空工单。
- 对照：prototype 会把图片下载成模型可见附件，并先校验模型是否支持 image——那是另一档能力（需要多模态），本次不做。
- **已修复（2026-11-06）**：`system` / `interactive` 在归一化阶段直接丢弃（带 `system-message` / `card-message` 原因）；附件类消息保留预渲染文本并打 `mediaOnly` 标记（持久化到 `triggers.media_only`），Router 遇到纯附件不开单、不调模型，@ 或私聊时回一句「看不到附件内容，请用文字说明」，群里的未 @ 附件完全静默。

### B2 没有周期性补拉，断线期间的消息永久丢（补拉功能已于 2026-11-08 移除）

- 证据：`src/service.ts:159-167` 只在 `start()` 时做一次 backfill；`FeishuConsumer` 断线重连（`feishu.ts:186-196`）不补消息。
- 后果：事件总线抖动、`another event bus is already connected`、机器休眠恢复——这些窗口里的消息不会进来。README 里也承认「同一机器人只能有一个事件总线」。
- 对照：prototype 是双通道：事件流负责实时，每群游标 + 线程轮询负责兜底，重叠窗口 5s + 稳定 ID 去重。
- 建议：每 60s 按 `--start-time=lastCursor-5s` 增量拉一次监听中的群；游标进 SQLite（`KV` 表或新表），与 A1 一起做。

### B3 缺少「研判没完成」的可见性与处置

- 证据：`src/router/agent-loop.ts:227-229` 异常直接 `markUnavailable`；`unavailable` 是终态，对未寻址消息完全静默（`applyAssess` 只在 `addressed !== 'none'` 时说话）。
- 后果：模型挂一次、返回非法 JSON、工具轮次耗尽——用户拿不到任何反馈，运营也看不到。
- 对照：prototype 把「近 1 小时未解决的 unavailable」做成 overview 的一条系统问题，可重排、可 dismiss。
- 建议：决策列表里单独标 `unavailable` 并有「重新研判」按钮（与 A6 同一个面）。

### B4 「凭什么接这单」无法回答

- 证据：`src/router/tools.ts:37` 的 `rules` 是模型自由填的字符串数组，没有规则定义、没有校验、没有「必须命中至少一条」的约束。
- 后果：`Mandate.rules` 记录的是模型的自述，无法审计，也无法做「这类活以后都别接」。
- 对照：prototype 的 Policy 里是一组可增删改启停的规则，**推断接单的前提是至少命中一条启用规则**，且每条规则必须给出 matched/reason，Mandate 持久化规则名，策略变更后给在途工单投递「规则已变」Input。
- 建议：先落最小版——`config.yaml` 加 `policy.rules: [{name, text, enabled}]`，拼进 system prompt，`router_decide` 的 `rules` 只允许从这组名字里选，服务端校验；未命中任何启用规则时拒绝 inferred accept。

### B5 上下文没有预算，长线程会失控

- 证据：`src/router/agent-loop.ts:289-313` 把最近 10 条消息 + 工单直接 `JSON.stringify`，无字数上限、无省略标记。
- 对照：prototype 用「首 5 条 + 触发点前后各 5 条」窗口，逐条按 4000/1200/400/50 字截断，并显式告诉模型 `omitted_before/after`。
- 建议：给 `contextPrompt` 加字符预算与省略计数——成本可控，模型也知道自己缺信息。

### B6 订阅 = 无脑转发，worker 没有「交回路由」的通道

- 证据：`src/core/engine.ts:279-296` 的 `fanOut` 把该线程每条新消息都变成 `followup` 投给 worker；`src/router/tools.ts` 没有任何「handback」能力。
- 后果：话题里聊到别的需求，也会塞给当前 worker；worker 只能 `blocked`（把整张工单卡住）或硬着头皮做。
- 对照：prototype 的消息有「归属」——归属于某工单的消息由它的 Executor 决定，超出范围可 handback，全部交回后才重新进 Eval；上下文订阅（context-only）不授予任何权限。
- 建议：`ra report` 增加 `--handback` 语义（把某条 input 退回路由），Router 收到后把它当新 Trigger 走 Gate；`context_only` 订阅在 ra 里已建模但未使用，顺手接上。

### B7 工单结束即终结，无法续做

- 证据：`hasLiveSubscription`（`agent-loop.ts:282-287`）只认 `stage !== 'closed'`；`handleLostWorker`（`service.ts:483-496`）的措辞也是「请重新开一张工单」。
- 对照：prototype 的 ended ticket 保留 Mandate，本人在原线程的追问可以直接唤醒同一张工单，不走 Eval。
- 建议：给 Ticket 加 `ended_reason`，区分「人工停/失败/完成」；未人工停的工单允许 `reopen` 复用同一 Mandate 与 worktree。

### B8 通知不降噪

- 证据：`src/service.ts:357-366`——只要 report 带 `reply` 就发，**不区分 state**；summary/reply 相同也照发（幂等 key 含 `updatedAt`，每次上报都不同）。
- 后果：worker 每轮 progress 都带 `--reply` 时，话题里会刷屏；prototype 明确「progress 不唤醒、不发 IM」。
- 建议：progress 默认不发（或合并成每 N 分钟最多一条）；同 ticket 相同 reply 做内容去重。
- **已修复（2026-11-06）**：progress 上报不再逐条发送；`RouterService.syncProgress()` 按 `progress.syncMs`（默认 60 秒）
  定时轮询未同步的进展，合并成一条消息发到工单话题，内容相同的进展只发一次。ready / blocked 等终态与带 `--ack` 的追问回答
  仍即时发送，并在发送前补发未同步的进展，保证话题内「进展 → 完成」的顺序。

### B9 outbox 失败不会升级

- 证据：`src/store/db.ts:598-600` 失败只写 `last_error` 并指数退避；无次数上限、无告警。
- 对照：prototype 连续 3 次失败把消息升级为「系统问题」放上 overview。
- 建议：`attempts >= 3` 时写一条 attention，并在 `ra status` 里露出。

---

## 4. P2：能力与体验的外延

| 编号 | 差距 | ra 证据 | 建议 |
|-|-|-|-|
| C1 | GitHub 只跟 PR 三态 | `src/sources/github.ts:1-70` 只有 `pr view` 的 open/merged/closed | 接 `review comments` + `check-runs`，把 review 意见当 followup 投给 worker——这是「PR 跟踪闭环」真正的价值点 |
| C2 | Source 硬编码两值 | `src/core/model.ts:16` `SourceKind = 'feishu' \| 'github'` | 需要时再抽 registry；现在抽是过度设计 |
| C3 | 无暂停 | 只有 `stop`（不可逆） | Ticket 加 `paused` 阶段，`pause` 不停 worker、只停止派新活 |
| C4 | 无「人工插队槽」 | `launchPending` 纯 FIFO | 人的追问投递优先于新派工（当前同队列，worker 满了追问也排队） |
| C5 | 无 turn 墙钟上限 | 只有 idle nudge + stale（软提醒） | 加 `maxTurnMs`，超时记 `blocked` 转人工 |
| C6 | 卡片只是 Markdown 壳 | `src/sources/feishu.ts:378-384` 只有一个 markdown 元素（含 Markdown 归一化） | 加状态字段 + 「打开面板 / 停止」按钮（需要 card callback 通道，成本较高，可延后） |
| C7 | 配置无版本无审计 | `config.yaml` 直改 | 保存时留 revision + diff，面板能回看；不必做自动回滚 |
| C8 | prompt 打包进 dist | `src/worker/spec/index.ts:1-50` 读文件 | 允许 `~/.router-agent/prompts/` 覆盖，免 rebuild |
| C9 | 面板只读为主 | `src/web/client/app.tsx` 3 Tab | 至少补：决策/日志/健康三个只读视图（和 A6/B3 一起做） |
| C10 | 无鉴权加固 | `api.ts:208-214` 只 bind 127.0.0.1 | 加 Host 校验（防 DNS rebinding）——prototype 的 `sameOrigin` 是现成做法 |
| C11 | 日志无轮转 | `~/.router-agent/logs/router-agent.log` 只追加 | 按大小切分，保留 N 份 |
| C12 | `apiKey` 明文落盘 | `~/.router-agent/config.yaml` 的 `llm.apiKey` | 支持从 env/钥匙串读取，配置里只留引用 |

---

## 5. 工程化与文档

| 项 | ra | prototype | 建议 |
|-|-|-|-|
| 测试 | 26 文件 / 248 用例，功能覆盖扎实 | 59 spec / ≈811 用例 | 数量不是重点，补**契约测试**：文档链接可解析、每个导出函数有注释、prompt 体积预算 |
| 文档 | README（部分过时：写 221 个测试、HTTP 表漏 `POST /api/reports`）+ VERIFICATION | 9 篇分层文档，含部署排障与「新增 Source」cookbook | 补两篇：`docs/DEPLOYMENT.md`（排障、升级、日志怎么看）、`docs/EXTENDING.md`（加 Source / 加状态的步骤） |
| 死代码 | `revalidateMandate`（仅测试）、`AgentLoop.setPolicy`（无调用）、`titleFrom`、`relaunchAgent`、`removeWorktree` | — | 要么接线（A3/A7），要么删 |
| 阶段 `draft` | `model.ts:10` 定义但从不产生 | — | 删或实现 |
| CI | 无 | 无 | 都没有，本地 `pnpm check` 已够；若要加，先加 GitHub Actions 跑 check |
| 版本控制 | **`/Users/admin/pz/dsh/router-agent` 不是 git 仓库** | 有 `.git` | 先 `git init` ——这是所有改动的安全网 |

---

## 6. ra 做得更好、值得保留的地方

对比不是单向的，以下设计原型反而没有：

1. **`ra` CLI 本身就是运营面**：`init` 向导（App Secret 走 stdin）、`doctor` 10 项自检、`simulate` 离线研判、`report`、`doc`、`logs`。原型把这一切交给 SETUP.md 让 agent 现学。
2. **`ra report` + `state.json` 兜底双通道**：服务不可达时 worker 仍能落盘，poller 之后捡起；这是很实际的容错设计。
3. **确认表情 + 自动撤销**（`feishu.ts:341-354`）：收到消息立刻 `Typing`，回复后撤销。零成本告诉用户「我看到了」，比打字更省注意力。
4. **幂等 key 长度适配**（`feishu.ts:292-299`）：飞书 50 字符上限 + 稳定哈希，细节处见功力。
5. **不解析终端文本**：只用 Orca 的结构化字段（`connected`/`orphaned`/`lastOutputAt`），并且实机修正了「`orphaned` 不等于死」的误判——这条经验应写进文档而不是只留在代码注释里。
6. **交付形态完全由 worker 决定**：Router 不做长度判断、不自动转文档。这个回调是对的，原型虽然也有 delivery requirements，但它的形态判定挂在 prompt 层，ra 的「Router 只发 `--reply` 原文」更简单可预测。

---

## 7. 建议路线图

**第 1 步（正确性，1–2 天）**：✅ A1 补拉方向与游标（已完成）/ A2 并发口径 / A3 策略热更新 / A4 LLM 超时 / A7 恢复前重校验 / git init。剩下五项都是小改动，且都能补一条回归测试。

**第 2 步（运营面，3–5 天）**：A6+B3 合成一个「决策」面——`listDecisions` + `GET /api/decisions` + 面板 Tab + `ra decisions`；A5 给 `stop` 定义清楚语义；C9 顺手补日志/健康两个只读视图。做完这一步，observe 模式才算真的能用。

**第 3 步（执行语义，1 周）**：B7 resume、B6 handback、B8 降噪、B4 最小规则模型、B5 上下文预算。这一步动的是领域模型，需要先补设计说明（可以照着 prototype 的 `002-authorization.md`/`003-execution.md` 写 ra 自己的版本）。

**第 4 步（来源与交付外延）**：B1 附件消息（✅ 已做「识别 + 不开空单」，多模态识图仍待评估）、B2 周期性游标补拉、C1 review/CI 回灌、C7 配置版本。

---

## 附：本次核查的关键证据索引

```text
src/service.ts:229-231                  并发口径只算 assigned/running
src/core/stage.ts:17-22                 person/review 不消耗槽位
src/router/agent-loop.ts:78             setPolicy 无生产调用点
src/cli/index.ts:682-684                onPolicyChange 只打日志
src/router/llm.ts:136                   fetch 无超时
src/service.ts:137-153                  runCycle 串行 + ticking 互斥
src/core/model.ts:4 / agent-loop.ts:238-250   stop 决策空转
src/store/db.ts:344,350                 decisions 只写不读
src/core/policy.ts:94                   revalidateMandate 仅测试引用
src/sources/feishu.ts                   message_type 分支（system / card 丢弃，mediaOnly 标记）
src/router/agent-loop.ts                mediaOnly 不开单分支
src/core/engine.ts:279-296              fanOut 无归属
src/service.ts:357-366                  任意 report 带 reply 即发
src/store/db.ts:598-600                 outbox 失败无升级
src/sources/github.ts:1-70              PR 三态
src/web/client/app.tsx                  3 Tab
```
