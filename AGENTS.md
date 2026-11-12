# AGENTS.md · router-agent 开发规范

本文件是本仓库 agent 规范的**唯一来源**；`CLAUDE.md` 只做指向，不重复内容。
适用范围：整个仓库，含 `packages/*` 与 `src/`。

## 开工前先拿到的两份上下文

- **架构与边界** → `docs/MONOREPO.md`（包划分、依赖方向、新增 runtime/channel 的步骤）
- **日志事件表** → `docs/OPERATIONS.md`（已有事件名、来源、关键字段，新增事件必须同步）

## 技能：按触发读，不要一次全读

技能文件在 `.claude/skills/<name>/SKILL.md`（若本地还装了 `.agents/skills/`，同一份内容以它为准）。

| 触发场景 | 读这个 |
|-|-|
| 写代码、改 bug、重构 | `.claude/skills/ponytail/SKILL.md`（最小完整改动） |
| 实现新行为、修 bug | `.claude/skills/tdd/SKILL.md`（红 → 绿；细则见同目录 `tests.md`、`mocking.md`） |
| 写或改测试 | `.claude/skills/vitest/SKILL.md`（API / mock / 配置）+ `.claude/skills/writing-unit-tests/SKILL.md`（测试写法） |
| 做界面、样式、交互 | `.claude/skills/design-taste-frontend/SKILL.md` |
| 调整模块边界、抽职责 | `.claude/skills/improve-codebase-architecture/SKILL.md` |

## 1. 架构：monorepo 与可插拔 runtime / channel

```text
packages/core       领域内核：model / stage / policy / events + 中立配置视图
packages/infra      基础设施：logger / process / chat / vision
packages/runtime    WorkerRuntime 端口、RuntimeRegistry、orca / claude-code / codex / acp / herdr adapter
packages/channel    ChannelAdapter 端口、ChannelRegistry、飞书 adapter、入站管线
src/                宿主应用：Engine / Store、Router、API / Web、CLI、配置与装配
```

依赖单向向下：

```text
core  ←  infra  ←  runtime / channel  ←  src/
```

硬约束：

1. `packages/*` 不得 import `src/`；`runtime` 与 `channel` 互不依赖——由 `tests/architecture/packages.test.ts` 兜底，改边界时同步改这个测试。
2. 跨包只用别名 `#core/*`、`#infra/*`、`#runtime/*`、`#channel/*`；`tsconfig.json` 的 `paths`、根 `package.json` 的 `imports`、`vitest.config.ts` 的 alias、`scripts/build-web.mjs` 的 tsconfig **四处必须一致**。
3. 适配器需要的配置形状放 `packages/core/src/config.ts`（`RuntimeConfigView` / `ChannelConfigView`），不得反向依赖宿主 `AppConfig`。
4. 根 `package.json` 的 `imports` 指向 `dist/`，所以**改了 `packages/*/src` 之后必须 `pnpm build`**，否则 CLI 用的还是旧产物。
5. 新增 runtime / channel 的完整步骤见 `docs/MONOREPO.md`，照着它做，不要另起一套装配方式。

## 2. 开发流程：TDD 红 → 绿

- **先写会失败的测试**，再写刚好让它通过的实现；一个垂直切片（一个 seam、一个测试、一个最小实现）一个循环。
- **不预判未来测试**，不写投机性实现；重构不在红绿循环里做，留到交付前。
- **先确认 seam**：测的是哪个公开边界、这层测试能兜住什么、兜不住什么；没确认的边界不写测试。
- 修 bug 同样走红绿：先写一个复现失败路径的测试，再改实现。
- 提交前 `pnpm check`（`pnpm typecheck` + `pnpm test`）必须绿。

## 3. 代码风格：ponytail（最小完整改动）

- 动手前先列全这次改动要触达的地方：调用方、测试、fixture、配置、导出、文档。半成品不算完成。
- 选方案按顺序取第一个能完整解决问题的：**不需要存在 > 仓库里已有 > 标准库/平台能力 > 已安装依赖 > 一行能读懂**。不为没人要的功能加抽象、配置项、开关或「以后会用」的代码。
- **删除优于新增**，保持仓库现有的分层、接口与写法。
- 修 bug 先 grep 所有调用方，在公共代码里修一次根因，不要在每个调用点各修一遍。
- 注释只写代码本身看不出来的 why，一行以内。
- 新增的非平凡逻辑（分支、循环、解析、脚本）至少留一个小测试或自检；纯文案改动不需要。

## 4. 测试规范

- **只测公开契约**：重构内部实现不应让测试变红；红了说明测的是实现。
- **一个测试一个行为**，名字直接写结论（`subject_scenario_outcome` 形式，如 `expired_token_is_rejected_with_401`），不要用 `test_xxx_1`。
- **期望值来自独立来源**：写死的手算字面量或规格值，不复制生产逻辑重算一遍。
- **确定性**：不睡 `sleep`，不用真实时间 / 真实随机 / 真实网络 / 真实文件系统；注入时钟与随机源，mock 掉边界。
- **只 mock 边界**（网络、时钟、文件、第三方服务）；不 mock 自己的代码去断言 mock 本身。
- **失败路径是一等公民**：断言结果值，不断言「没抛异常」；新增的 `warn` / `error` 日志至少有一条测试断言事件名与关键字段。
- **只写有功能价值的测试**：没有行为主张的用例（只验证调用发生、只验证不报错、只验证常量等于自己）不要写。
- 位置：包内测试放 `packages/<pkg>/tests/`，其余放 `tests/`；命令 `pnpm test`，单文件用 `pnpm vitest run tests/xxx.test.ts`。

## 5. 界面与前端

- 动面板 / Web 界面（页面、组件、样式、交互、布局）前先读 `design-taste-frontend`，按它的house style 和截图自检流程走。
- 复用现有组件与设计 token，不新建第二套样式体系；文案与交互与现有语义保持一致。
- 交付要求里含 UI 改动时，必须给同一场景、同一视口、同一主题的 **Before / After** 真实截图，拿不到就不报完成。

## 6. 日志规范（必须遵守）

日志是排查「消息没反应 / 配置没生效 / 服务报错」的第一入口，目标是**只看日志就能还原一次用户操作的完整轨迹**。新增或修改功能时，先想清楚这条链路失败时用户能不能从日志里查到原因，再写代码。

### 格式

- 服务日志一行一个 JSON：`at`（ISO 时间）/ `level` / `message` + 业务字段，由 `src/cli/index.ts` 的 `createLogger` 统一写入 `<RA_HOME>/logs/router-agent.log`。
- `message` 用 `域:动作` 的 kebab-case，例如 `trigger:ingested`、`config:parse-failed`。常用域：`feishu` / `chats` / `trigger` / `loop` / `decision` / `chat` / `session` / `config` / `api` / `ticket` / `outbox` / `effect` / `worker` / `launch` / `input` / `report` / `progress` / `pr` / `retention` / `recover`。
- `message` 只放事件名，错误详情、stderr 摘要等文本一律用 `detail` 字段；`createLogger` 会把业务字段里的 `message` 自动改写成 `detail`，事件名不会被冲掉。
- 业务字段**平铺**在同一层，不要塞 `payload` / `data` 嵌套对象；长文本用 `preview()`（`packages/core/src/events.ts`）截断。
- 每个事件至少带一个可定位字段：`triggerId` / `ticketId` / `inputId` / `key` / `chat` / `path` / `handle`。同一条链路上的事件用同一个 ID 串起来，串不起来就是漏了字段。

### 级别

| 级别 | 用途 | 例子 |
|-|-|-|
| `info` | 正常关键节点与状态变化，能串起完整链路 | 消息入库、派工、投递、上报、配置更新 |
| `warn` | 已降级的异常，流程还能继续 | 模型回复失败走了兜底、卡片降级为富文本、缓存损坏 |
| `error` | 影响主流程、需要人介入的失败 | 派工失败、API 请求异常、安全参数被覆盖 |

### 硬性要求

1. **禁止空 catch**：每个 `catch` 要么重新抛出，要么写 `warn` / `error`，并且必须带上错误原因（统一用 `errorMessage(error)`，来自 `packages/infra/src/logger.ts`）。如果失败被有意忽略，注释里要写清为什么。
2. **不遗漏错误与警告**：任何失败、降级、重试、超时都要留日志；不能因为「偶发」就不记。能定位到具体 `error` / `warn` 事件的日志，才算把问题兜住了。
3. **关键链路必须留痕**：
   - 消息：接入、过滤（`trigger:dropped`）、去重（`trigger:duplicate`）、研判结论、回复生成与投递（`outbox:sent` / `outbox:failed`）；
   - 通信：飞书事件消费与重连、lark-cli 调用失败、卡片降级、群名目录刷新；
   - 配置：加载（创建 / 解析失败 / 旧配置迁移）、面板保存（校验 / 落盘）、策略版本变化；
   - 异常：API 请求级失败、worker 状态查询失败、PR 跟踪失败、会话读写失败、effect 执行失败。
4. **可还原用户轨迹**：一次用户操作从入口到终点要有连续的 `info` 事件（接入 → 判断 → 执行 → 投递），中间任何一跳失败都要有对应 `warn` / `error`，且带上能回链的 ID；不允许出现「功能没生效但日志里什么都没发生」的情况。
5. **不要记录敏感信息**：API Key、token、App Secret、完整 prompt、完整用户消息、完整文件内容都不能进日志；用户消息用 `preview(text, 120~160)`，错误里的 stderr 截断到 200~300 字。
6. **不打印堆栈**：日志只写一行可读原因；调试堆栈留在终端或测试里。
7. **高频路径降噪**：轮询、重复状态、同一错误的连续重试不要每条都打；在状态变化或首次失败时打一次。同类事件用稳定字段做去重。
8. **日志失败不能影响主流程**：写日志本身要吞掉 IO 异常（`createLogger` 已处理）；`appendEventLog` 等辅助写盘也要 try/catch。
9. **模块只依赖 `Logger` 接口**：通过构造参数注入 `packages/infra/src/logger.ts` 的 `Logger`，缺省用 `noopLogger`；不要在业务模块里直接 `console.log`、直接写文件或自己拼时间戳。
10. **新增事件同步文档**：在 `docs/OPERATIONS.md` 的日志事件表里补上事件名、来源、关键字段与含义（`README.md` / `README.en.md` 只保留入口链接）。
11. **失败路径要测试**：新增的 warn / error 日志，至少补一条测试断言事件名与关键字段（参考 `tests/config.test.ts`、`tests/router/agent-loop.test.ts`、`tests/router/api.test.ts`）。

### 查看与排查

```bash
ra logs                                  # 最近 50 行
ra logs --follow                         # 实时跟随
grep '"message":"trigger:' ~/.router-agent/logs/router-agent.log
```

面板「日志」页支持按 INFO / WARN / ERROR 过滤与关键字搜索；读文件实现见 `src/router/log-tail.ts`。

## 7. 代码、提交与交付

- 代码注释、提交信息、文档统一使用中文。
- 提交前至少通过 `pnpm typecheck` 与 `pnpm test`；交付前跑 `pnpm build`。
- 不直接连数据库做写操作；状态写入一律走 `src/core/engine.ts`。
- 交付说明写清「做了什么 / 怎么验证的 / 风险」，PR 链接或文档链接要能打开。
