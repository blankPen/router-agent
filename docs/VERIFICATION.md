# 验证记录

验证日期：2026-11-06
环境：macOS (Darwin 24.6.0)、Node v22.18.0、Orca 1.4.240、gh 已登录、lark-cli 1.0.97

## 1. 自动化测试

```
pnpm check   # tsc --noEmit + vitest
Test Files  27 passed (27)
Tests       291 passed | 4 skipped
```

| 测试文件 | 覆盖 |
|-|-|
| `tests/core/stage.test.ts` | 阶段推导与迁移合法性（15） |
| `tests/core/policy.test.ts` | 准入表三列、accept mode、群级白名单、Mandate 重新校验（23） |
| `tests/core/engine.test.ts` | 接单 / 副工 / 上报 / 扇出 / 输入重绑 / 结束约束 / 交付物落库（15） |
| `tests/core/effects.test.ts` | Outbox 幂等、退避、单条失败隔离（7） |
| `tests/store/store.test.ts` | SQLite 读写、去重、订阅、队列、游标、mediaOnly、派工草稿、工单 repo/branch（15） |
| `tests/worker/orca.test.ts` | 命令构造、返回解析、start/deliver/stop/inspect、工单级 repo/branch 与 `--base-branch`（16） |
| `tests/worker/report-poller.test.ts` | state.json 增量读取、交付物解析、坏文件容错、idle 判定（17） |
| `tests/sources/feishu.test.ts` | 事件归一化、@ / 私聊、系统消息与卡片丢弃、附件标记、飞书文档创建、互动卡片与降级、幂等 key 长度（24） |
| `tests/sources/feishu-backfill.test.ts` | 历史补拉的命令与解析、`--start` 时间窗、首跑基线、游标增量与失败保号（8） |
| `tests/sources/feishu-directory.test.ts` | 群名目录刷新与持久化（3） |
| `tests/sources/github.test.ts` | PR 状态归一化、仓库选择器转 gh owner/name（6） |
| `tests/router/agent-loop.test.ts` | 显式研判、礼貌回复、附件不开单、ack+话题、工具调用、批处理、扇出、多项目派工追问、会话绑定上下文、群白名单（27） |
| `tests/router/dispatch.test.ts` | 多项目/多分支解析：项目匹配、群绑定、草稿继承、白名单校验（11） |
| `tests/router/api.test.ts` | HTTP API 全端点、`POST /api/reports` 上报入口与旧字段兼容（12） |
| `tests/service.test.ts` | 派工、并发上限、PR 闭环、停止、重启对账、回复投递、长回复分块、旧上报去重、会话丢失转人工（16） |
| `tests/service-runtime.test.ts` | 未 ack 重投、idle 唤醒、stale、Orca linkedPR、补拉（8） |
| `tests/cli.test.ts` | commander 命令解析：init / tickets / ticket / status / config / help（11） |
| `tests/cli-init.test.ts` | inquirer 交互初始化：select/checkbox/password、App Secret 走 stdin、新建应用、授权引导（6） |
| `tests/infra/process.test.ts` | 命令执行器：stdin 传递、错误码透出（3） |
| `tests/sources/lark.test.ts` | larkHome 隔离、群/成员/身份/事件预检解析（7） |
| `tests/config.test.ts` | 配置读写、统一群配置解析、群级白名单、旧格式迁移与 `config set` 点路径（14） |
| `tests/sources/feishu-consumer.test.ts` | 消费者 stdin 常驻、NDJSON、stderr 分级、断线重连（9） |
| `tests/cli-doctor.test.ts` | 启动前自检的 10 项检查（5） |
| `tests/cli-simulate.test.ts` | 本地模拟研判：显式/推断/observe/dry-run（7） |
| `tests/verify-live.test.ts` | 真实环境验证（`RA_VERIFY=1` 时运行） |

## 2. 真实环境验证（已通过）

`RA_VERIFY=1 npx vitest run tests/verify-live.test.ts` → 4 passed。

1. **真实 LLM 研判**：用 `.trove/config.json` 的 DeepSeek 配置跑通 `AgentLoop`，推断候选得到可解析决定，未落 `unavailable`。
2. **真实 HTTP + Web**：`/api/status` 返回 `backend=orca`；`/` 返回 React 面板 HTML；`/app.js` 可加载。
3. **真实 Orca CLI**：`terminal list` 解析正常（不存在的 handle 返回 null 不抛错）；`worktree list` 可读。
4. **真实飞书**：`event consume ... --dry-run` 预检通过；历史补拉真实群返回 6 条并正确过滤机器人自己的消息。

### 真实 Orca worktree 冒烟（已清理）

用临时 git 仓库注册到 Orca，调用**项目内的 `OrcaAdapter.start()`** 走完整链路：

- 成功创建 worktree：`/Users/admin/orca/workspaces/ra-orca-smoke/ra-tk_smoke`
- 解析出 `handle=term_...` 与 `workdir`
- 终端状态 `running`，`terminal read` 能看到完整的 worker 手册（约 2.2KB prompt 被 Claude Code 正常接收）→ **P0-1 prompt 长度可行**
- worktree 内 Claude Code 的 cwd 为 worktree 路径 → **P0-2 可行**
- 验证后已 `terminal close` + `worktree rm` + `project setup-delete`，临时目录已删除。

### `ra report` → 飞书文档 → 卡片（真实环境，已验证）

```
ra report --ticket tk_c2ff... --state ready --summary "..." \
  --deliverable-kind doc --deliverable-title "..." --deliverable-content @answer.md
```

- `POST /api/reports` 返回 201，turn 由 Router 自增（无需 worker 维护）
- 命中 `deliver-result` effect → `lark-cli docs +create` 成功创建文档并回写 URL
- 出站消息经 `threads-messages-list` 确认 `msg_type=interactive`（卡片），未走降级
- 服务重启后同一上报不会重复发送（effect id 与 outbox key 均幂等）

### 真实 CLI / 服务端到端

```
ra init → 配置 port 3099 → ra start → curl /api/status → curl / → ra status → ra tickets → ra stop → 端口关闭
```

全部符合预期，后台 daemon 的 pid 管理、日志、停止均正常。

## 3. 实测发现并修正的偏差

| 偏差 | 实测行为 | 修正 |
|-|-|-|
| `lastOutputAt` 类型 | Orca 返回**毫秒数字**而非 ISO 字符串 | `toIsoTime()` 归一化，兼容数字 / ISO / 秒级 |
| `orphaned` 语义 | **CLI 创建的终端可能 `orphaned=true` 但仍 connected+writable** | 只有 `connected=false` 判死；`orphaned && !writable` 才算孤儿 |
| 命令运行器 | 原先或带或不带二进制名，真实环境报 `ENOENT` | `CommandRunner` 统一绑定二进制，argv 不含命令名 |
| 飞书幂等 key 超长 | 拼接 turn + updatedAt 后超过 50 字符，飞书直接拒绝发送 | `fitIdempotencyKey()` 截断 + 稳定哈希 |
| `.trove` 定位 | 传入临时 `--home` 时把 `.trove` 也指到临时目录 | 状态目录与真实用户主目录分离 |
| worker 会话被删 | 每秒重试 `terminal send`，工单一直挂着 running | 检测到终端不存在后结束派工、转 person、取消订阅并只通知一次 |
| lark-cli 机器人隔离 | 原先只能复用默认 profile | 新增 `feishu.larkHome`，所有 lark-cli 子进程注入独立 HOME |
| init 依赖手工配置 | 原先要手动跑 lark-cli 并填 4 个 id | 交互式引导 + 内部调用 `lark-cli config init` / `auth login` |
| CLI 解析手写 | 手写 argv 解析、无补全/帮助 | 换 `commander`：子命令、选项、`--help`、退出码 |
| 交互原始 | readline 裸提问，密钥回显 | 换 `@inquirer/prompts`：select / checkbox / password |
| 事件消费 0 秒退出 | `lark-cli` 把 stdin EOF 当退出信号，`stdio: 'ignore'` 导致消费者秒退 | stdin 改为保持打开的 pipe |
| 事件总线冲突 | 同一机器人只允许一个总线，失败时无提示 | 结构化识别冲突并给出修复建议，指数退避自动重连 |
| 收消息无即时反馈 | 用户不知道消息是否被读到 | 入库后立即加确认表情（默认 Typing ⌨️），回复发出后自动撤销 |
| 同一条消息重复开工 | tick 每秒触发，研判 2–13s，重叠的 tick 重复领取同一条 pending → 多张同题工单、多个 worktree | Store 原子领取（`pending→evaluating`）+ `runOnce` 串行化 + 启动重置 evaluating
| `router_reply` 发不出去 | 模型把内部 id `feishu_om_…` 当 message_id，且与自动 ack 重复 | `normalizeMessageId` 归一化；提示词明确「回复由系统自动发送，不要调用 router_reply」
| 脏 Outbox 永久重试 | 旧记录带非法 thread_id，每 60s 失败一次 | 启动时 `repairOutbox()` 标记为已处理 |
| worker 会话不可控 | Orca 默认开成 chat 会话（handle `structured-agent-session-…`），不在 terminal list 里，send/close/inspect 都失效，重启必判死并重开 | `worktree create` 固定 `--surface terminal` |
| 模型二次回复 | `router_reply` 与系统自动 ack 重复，且常传内部 id 导致发送失败 | 该工具改为 no-op；回复统一由系统发送 |
| 同线程排队期消息 | 会重复开第二张工单 | 派工前也可投递，派工时重新绑定 Assignment |
| `ra init` 的 worker 规范 | 写在状态目录下，Orca 启动的 claude 读不到 | 默认写入全局 `~/.claude/agents/`（可用 `--agents-dir` 覆盖） |

## 4. 需要你执行的剩余验证

以下三项依赖真实的飞书群配置或需要人确认，未在本次自动验证中执行：

### 4.1 模式二（B1/P0-3）：Orca 启动的 claude 是否加载 `~/.claude/agents/`

```bash
ra init                       # 生成 ~/.claude/agents/router-agent-worker.md
# 在 Orca 里新建一个 worktree（任意仓库），打开后问：
#   "你当前可用哪些自定义 agent？是否包含 router-agent-worker？"
```

若加载不到，把 `workerSpec.mode` 保持为 `prompt`（默认，已验证可行）。

### 4.2 真实飞书消息端到端

1. 在 `~/.router-agent/config.yaml` 填入真实群与自己的 open_id：
   ```yaml
   feishu:
     chats: ["oc_xxx"]
     allowed: ["ou_xxx"]
     botOpenIds: ["ou_xxx"]   # 机器人自己的 open_id
   repo: "<你的仓库名>"
   ```
2. `ra start`，在群里 @机器人 提一个可执行的小需求。
3. 观察 `ra tickets` 是否出现 `accepted → assigned`，Orca 是否打开新终端。
4. worker 写完 `state.json` 后观察 `ra ticket <id>` 是否进入 `running / review`。

这一步会真实创建 worktree 并启动 Claude Code，因此没有自动执行。

### 4.3 真实 PR 闭环

worker 开 PR 后：

```bash
ra ticket <id>          # 看 pr_number / pr_url
# 合并或关闭 PR 后
ra status               # 工单应变为 closed
```

验证点：Orca `linkedPR` 优先读取、`gh` 兜底、合并/关闭只通知一次。

### 4.4 多项目 / 多分支派工（本轮新增）

```bash
ra config set project.router-agent "name:dsh/router-agent@main"
ra config set project.super-agent  "name:dsh/super-agent@release"
ra config set chatBinding.oc_xxx   "router-agent@main"   # 绑定即监控
ra stop && ra start
```

1. **未绑定的群**：@bot 说「把登录超时改成 30 秒」→ Router 应**追问**「要改哪个项目、从哪个分支开始」（列出 router-agent / super-agent），`ra tickets` 里**没有新工单**。
2. 接着回「router-agent，从 release 开始」→ 开出工单，`ra ticket <id>` 的「派工」一行显示 `name:dsh/router-agent @ release`；`ra logs` 里 `launch` 记录 worktree 带 `--base-branch release`。
3. **绑定的群**（`oc_xxx`）：直接 @bot 派活 → 不追问，直接开单并派工到 `router-agent @ main`。
4. 反例：@bot 说「用 feature/x 分支改一下」且项目配了 `branches: [main, release]` → 应回复「该分支不在允许范围」，不开单。

## 5. Pi 研判层（2026-11-06 切换为单引擎）

### 5.1 实现

研判层保留 `DecisionEngine` 端口，**Pi 是唯一实现**：

- `assess()`：Pi session + 三个只读/提案工具（`router_read / router_ticket / router_decide`）；
- `reply()`：同一个 Pi 引擎、零工具，生成寒暄 / 追问的礼貌回复；
- 删除自研 `CustomDecisionEngine`、`OpenAiCompatClient`、影子模式、`decision_shadows` 表与 `/api/decisions/shadow`；
- `router_decide` 只产出 proposal，`Engine.decide()` 仍由 AgentLoop 统一调用；
- 两个通道共用 60s 硬超时 + 32k token 预算，超时/超预算落 `unavailable` 或退回固定话术。

### 5.2 自动化验证

```
pnpm check
Test Files  30 passed | 1 skipped (31)
Tests       307 passed | 5 skipped (312)
```

| 测试文件 | 覆盖 |
|-|-|
| `tests/router/pi-decision-engine.test.ts` | 工具白名单、proposal-only、prompt 注入、超时 abort、token 预算、JSON 兜底、reply 零工具、dispose（8） |
| `tests/router/decision-engine.test.ts` | proposal 解析与非法决定（3） |
| `tests/router/tool-spec.test.ts` | 只有三个 Pi 工具、TypeBox schema 校验（3） |
| `tests/router/agent-loop.test.ts` | Gate / 派工 / 追问 / 扇出 / 回复 / 并发去重（25） |
| `tests/config.test.ts` | `router.*` 默认值、读取、`config set`、写回（18） |
| `tests/cli-simulate.test.ts` | 模拟研判 / observe / 寒暄回复 / dry-run（7） |
| `tests/service*.test.ts` | 派工、上报、PR 闭环、重启对账（24） |

### 5.3 方案第 7 节 Spike 验收对照

| 验收项 | 结果 | 证据 |
|-|-|-|
| Pi 在不写库的前提下产出合法 `DecisionProposal` | ✅ | 单元测试断言 `store.listTickets()` 为空；真实运行由 AgentLoop 统一开单 |
| 工具调用序列可审计 | ✅ | `audit.toolCalls` + `~/.router-agent/logs/decisions.jsonl` |
| 超时与异常降级为 `unavailable`，不拖垮服务 | ✅ | `pi:timeout` / `pi:token-budget` / `pi:error` / `pi:no-decision` |
| 研判与回复都只有一条模型通道 | ✅ | `reply()` 复用同一个 Pi 引擎，零工具 |
| 不直接替换生产 | — | 按用户要求，本轮直接切为 Pi 单引擎 |

### 5.4 真实环境验证

```
RA_PI_VERIFY=1 npx vitest run tests/verify-pi-live.test.ts  → 1 passed
```

用 worktree 内构建产物 + 独立临时 home 跑 `ra simulate`（真实 `deepseek-v4-flash`）：

| 场景 | 结果 |
|-|-|
| 真实需求（`--infer`） | accept；4085ms；5445 tokens；1 次工具调用；开出工单 |
| 寒暄（`你好，在吗`） | Pi 生成回复：「在的。想把明确的需求告诉我，比如要改哪个项目、改哪里、期望的结果…」 |
| 隔离服务 | `ra start` → `/api/status` 正常；`/api/decisions/shadow` 已随影子模式删除，返回 404；`ra stop` 后端口关闭 |

切换前曾用本机最近 20 条真实消息对比旧实现与 Pi：0 次 unavailable，决定一致 19/20（95%），唯一分歧为边界样本；该对比仅作切换依据，旧实现代码已删除。

### 5.5 五个约束的落地位置

| 约束 | 实现 |
|-|-|
| Gate 在 Pi 之前 | `AgentLoop.handle()` 先 `gate()`，只有通过准入才调用 `assess()` |
| 工具白名单 | `PiDecisionEngine` 只注册三个 router_* 工具，关闭 Pi 内置工具；回复通道零工具 |
| 工具不写库 | `RouterToolbox` 只有 read / ticket / propose |
| 超时 + 预算 | `router.timeoutMs` / `router.tokenBudget` |
| 审计与回放 | `DecisionAudit` 统一结构；CLI 写 JSONL |

## 6. 结论

- 领域内核、Router、WorkerBackend、上报协议、飞书 / GitHub Source、HTTP API、Web 面板、CLI 均已实现并有测试覆盖。
- 研判层已切换为 Pi 单引擎：`assess` 与 `reply` 都走 Pi，工具白名单、proposal-only、超时预算与审计均已落地并有测试。
- 多项目 / 多分支：开单前强制明确「任务 + 项目 + 起始分支」，缺信息先在会话里追问并落草稿；群级 `chatBindings` 可免问答。
- 真实 LLM、Orca、lark-cli、HTTP 服务与 CLI 常驻链路均已跑通。
- 剩余风险集中在「真实飞书群 + 真实 worktree 开工」的外部集成，已在上节给出可直接执行的步骤。
