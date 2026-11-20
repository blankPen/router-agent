# 术语表

本文解释 router-agent 里那些**同一个东西有好几个叫法**的词。
代码位置见 [CODE-MAP.md](CODE-MAP.md)，架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

> **为什么有这份文档**：项目里「研判 / 决策 / 判定 / 准入」描述的是同一条链上的不同阶段，
> 但名字放在一起看不出区别。本文的目的是让第一次读代码的人**不用猜**。

---

## 1. 消息链路上的阶段

一条消息从进群到变成工单，会依次经过下面这些阶段。
**顺序就是它们在代码里的执行顺序**。

| 词 | 英文 / 代码名 | 在哪一步 | 回答什么问题 |
|-|-|-|-|
| **接入** | ingress | 消息到达通道 | 收到什么？原样存成 `Trigger` |
| **准入（Gate）** | `gate()` | 接入之后 | 「这个人有资格让 Router 处理这条消息吗」 |
| **准入（Admission）** | `admissionOf()` | Gate 之后 | 「这条消息命中了什么规则，要不要走模型」 |
| **分流** | — | 准入之后 | 管理员直进 Router；普通成员先进决策层 |
| **决策** | `DecisionAgent` | 普通成员路径 | 「这条消息值不值得跟进、属于哪一类」 |
| **研判** | `assess()` / `DecisionEngine` | 管理员路径 | 「这条消息要做什么」→ 决定开单 / 追问 / 回话 |
| **初筛** | `ScreenedKind` | 需求会话第一步 | 「这是闲聊、提问还是问题」 |
| **澄清** | clarify | 需求会话第二步 | 「需求还不清楚，追问补齐」 |
| **终审** | approve | 需求会话第三步 | 管理员确认需求单 → 才变成工单 |
| **派工** | `launch()` | 工单产生后 | 「交给哪个 runtime、在哪个目录跑」 |
| **上报** | `Report` | worker 执行中 | worker 交回进展 / 阻塞 / 完成 |
| **通知** | `outbox` | 有结果时 | 把结果送回群里 |
| **关单** | `closeTicket()` | 结束 | 工单结束，workspace 随后回收 |

### 两个「准入」的区别

| | `gate()`（`core/policy.ts`） | `admissionOf()`（`core/admission.ts`） |
|-|-|-|
| 层次 | 路由层 | 规则层 |
| 问什么 | 人有没有资格 | 这条消息要不要处理 |
| 依据 | 管理员名单、群 scope、是否 @ 机器人 | 事件类型、是否机器人、是否口令、是否有在途工单 |
| 结果 | `explicit` / `infer` / `reply-only` / `ignore` | 命中规则名，或「需要走模型」 |

**改准入规则要同时看这两层**——这是最容易漏的地方。

---

## 2. 决策层的四类消息

普通成员的消息由决策层分类（`MemberMessageKind`，`packages/core/src/decision.ts`）：

| 词 | 含义 |
|-|-|
| **chitchat** | 闲聊，没有工作请求 |
| **grumble** | 吐槽 / 抱怨 |
| **consult** | 咨询、问问题 |
| **feedback** | 反馈 / 意见 |

---

## 3. 需求会话的三种类型

初筛模型产出的类型（`ScreenedKind`，`packages/core/src/model.ts`）：

| 词 | 含义 |
|-|-|
| **chat** | 闲聊 |
| **question** | 提问 |
| **issue** | 要解决的问题 |

`IntakeKind` 比它多一个 **`request`**：管理员自己提的需求不经过初筛模型，直接进澄清。

---

## 4. 工单生命周期

| 词 | 代码 | 含义 |
|-|-|-|
| **阶段** | `Stage` | `todo` → `running` → `review` → `blocked` → `done` |
| **工单** | `Ticket` | 一张要做完的卡 |
| **授权范围** | `Mandate` | 这张单**允许做什么 / 不允许做什么**。派工时给 worker 的边界 |
| **派工** | `Assignment` | 一次「哪张单 → 哪个 runtime → 哪个 handle」的绑定 |
| **轮次** | `turn` | worker 的一次执行。`Report.turn` 是轮次号 |
| **输入** | `Input` | 投给 worker 的一条用户消息。有 `seq`（同一张单内递增） |
| **上报** | `Report` | worker 交回的一次结果 |
| **待办问题** | `Question` | 需要人回答的选择题（回写卡片） |
| **关注点** | `attention` | 工单上挂着的「当前在等你确认什么」 |
| **订阅** | `Subscription` | 关注某条线程的新工单 |

---

## 5. 运行时与工作区

| 词 | 代码 | 含义 |
|-|-|-|
| **运行时** | `WorkerRuntime` | 执行工单的引擎（Orca / Claude Code / Codex / ACP Agent …） |
| **ACP** | — | Agent Client Protocol，一套让外部 agent 接入的协议 |
| **workspace** | — | 一张工单的工作目录。工单关了之后按保留期回收 |
| **workdir** | `WorkerContext.workdir` | 本次运行的工作目录 |
| **workspaceRef** | `WorkerContext.workspaceRef` | workspace 的稳定引用（跨进程可还原） |
| **worktree** | `WorkerContext.worktree` | git worktree 形态的工作区 |
| **handle** | `Assignment.handle` | 运行时侧的会话句柄（Orca 终端 id、Claude 会话 id …） |
| **规范注入** | `packages/runtime/src/spec/` | 派工时写进 worker 的规范文件（`contract.md` 等） |
| **persona** | `src/specs/` | Router 的人格与口吻配置 |

---

## 6. 留存治理（`retention`）

「用户不吭声了怎么办」这一整套机制。

| 词 | 含义 |
|-|-|
| **闲置** | 一段时间没有新进展 |
| **静默期** | 当前这段没有进展的时间窗 |
| **水位** | `cursors` 表里的进度标记。「已经处理到哪了」 |
| **巡检** | 定时读 worker 的会话记录 / 终端，判断它还在不在动 |
| **巡检探针** | 巡检时读的那份 worker 状态快照 |
| **僵尸** | worker 长时间不上报且终端无响应。**只转人工，不自动关闭** |
| **催办** | PR 还开着时的提醒。只催一次，不关单 |
| **提醒 / 自动关闭** | 闲置到期先提醒，宽限期过后自动关单 |
| **未 ack** | 输入已投给 worker，但一直没被确认接收 |

三类留存水位（`retention:*`）的 key 与 value 格式见
[OPERATIONS.md](OPERATIONS.md#游标表cursors)。

---

## 7. 投递与幂等

| 词 | 含义 |
|-|-|
| **outbox** | 待投递的通知队列。**投递成功前不删**，进程重启会重投 |
| **幂等键** | outbox / effect 的 `key`。同键只生效一次，重复投递不会打扰用户 |
| **effect** | 需要幂等执行的副作用（状态变更、通知） |
| **扇出** | 一条消息投给该线程的**所有订阅者**（不是一个工单，是多个） |
| **ack** | worker 确认收到了某条输入 |

---

## 8. 会话

| 词 | 含义 |
|-|-|
| **会话** | 一个用户在一个群里的连续对话上下文 |
| **会话粒度** | `user` = 群 + 人；`thread` = 群 + 话题 + 人 |
| **`/new`** | 重置当前会话的口令。即使话题里有活跃工单也生效 |
| **终审口令** | 管理员在群里回「通过」/「驳回」/「放弃」完成终审 |
| **重开** | 在已关闭工单的话题里说「重新开工」，会基于原单建**新**单 |
| **记忆口令** | `/记忆 保存 / 列表 / 删除 …`，管理自己的回复偏好（回复语言、回复详略）。跨群偏好只能在私聊里管 |

---

## 9. 模型与外部依赖

| 词 | 含义 |
|-|-|
| **Pi** | `@earendil-works/pi-coding-agent`。**Router 全部模型调用都走它** |
| **Jev** | TypeSafe 的决策模型接口。一次请求带若干问题，返回 0~1 判定或档位分数 |
| **LLM 兜底** | Jev 不可用时，退回通用大模型做同样的判断 |
| **spec** | 决策层的规格说明（`USER_MSG_DECISION_SPEC`），Jev 的问题与档位从它生成 |

---

## 10. 日志

| 词 | 含义 |
|-|-|
| **事件名** | `域:动作` 的 kebab-case，如 `trigger:ingested` |
| **trace** | 链路 ID。同一条链路的连续事件串起来 |
| **类别** | `category`：`message`（用户消息）/ `action`（对外动作）/ `event`（内部状态） |
| **降级** | 出错后走次优路径继续（如模型失败退回规则式排查） |

完整事件表见 [OPERATIONS.md](OPERATIONS.md#日志)。

---

## 11. 容易混的两组

### `Input.kind` vs 决策层的 `msgType` vs 初筛的 `kind`

| | 取值 | 作用 |
|-|-|-|
| `Input.kind` | `followup` / `ci` / `policy` / `retry` | 投给 worker 的这条输入**是什么性质**（追加 / CI 反馈 / 策略变更 / 重试） |
| 决策层 `msgType` | `chitchat` / `grumble` / `consult` / `feedback` | 用户这条消息**属于哪一类** |
| 初筛 `kind` | `chat` / `question` / `issue`（+ `request`） | 需求会话里**这是哪种需求** |

三个都叫「kind / 类型」，但管的是不同维度。

### `src/sources/` 不是消息来源

`src/sources/` 里是 **PR / MR 追踪器**（GitHub / GitLab / Forge），
只跟踪 PR 状态，不消费 Issue 与评论。消息来源是 `packages/channel/`。

---

## 12. 待澄清的词

以下词在代码里出现，但含义依赖上下文，改动前先问一句：

| 词 | 现状 |
|-|-|
| 「闸门」 | 文档里几乎不出现；代码里是 `gate()` |
| 「意图」 | 研判的产物；`DecisionProposal` |
| 「档位」 | 决策层 `msgType` 的 0~3 分档（`msgTypeFromScore`） |
