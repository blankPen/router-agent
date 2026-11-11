# 飞书身份配置改造（邮箱优先）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让允许名单支持「邮箱（推荐）/ open_id（兼容）」两种写法，机器人身份自动识别，Web 保存后名单立即生效，解析失败可见且不静默丢消息。

**Architecture:** 新增 `IdentityResolver`（`src/sources/feishu-identity.ts`）在**服务启动与配置变更时**把名单条目解析成 open_id，解析结果进 `state.db` 缓存（键带 appId，换应用自然失效）。`Policy` 增补 `allowedOpenIds` / `allowedByChatOpenIds`，运行时所有名单判定改用解析结果；`open_id` 仍是唯一主键，邮箱只在配置层出现一次。机器人身份按 `feishu.appId` 与群成员自动匹配，失败时启动即报 error。

**Tech Stack:** TypeScript (ESM, Node 22+)、vitest、已有 `lark-cli`（`/Users/pz/.local/bin/lark-cli`，固定 profile `~/.router-agent-lark`）、SQLite（`state.db`）、React 面板（Vite 构建）。不新增 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-11-11-feishu-identity-design.md`（本计划实现它；执行者两个都要读）

## Global Constraints

- **日志规范**（`CLAUDE.md`）：一行一个 JSON；`message` 用 `域:动作` kebab-case；错误详情一律进 `detail`；业务字段平铺；禁止空 catch（要么重抛要么写 warn/error 且带 `errorMessage(error)`）；不打印堆栈；**邮箱必须掩码后入日志**（形如 `p***@dewu.com`）；新增事件必须同步 `docs/OPERATIONS.md` 的日志事件表。
- **语言**：代码注释、提交信息、文档一律中文。
- **提交前**：`pnpm typecheck` 与 `pnpm test` 全绿；交付前 `pnpm build` 通过。
- **不直接写数据库**：状态写入一律走 `src/core/engine.ts`；新增的表只由 Store 的方法写入。
- **不新增 npm 依赖**：通讯录解析用已有的 `lark-cli`。
- **解析时机**：身份解析只发生在服务启动与配置变更；**消息入站链路不得发起通讯录请求**。
- **测试文件后缀**：vitest 只收集 `tests/**/*.test.ts`（不含 `.tsx`）；前端可测逻辑必须抽到独立 `.ts` 文件里再测。
- **旧数据兼容**：`state.db` 里已有的 `policy` 行没有 `allowedOpenIds` 字段；读取时必须回退到 `allowed`（把原始条目当 open_id 用），不能因此让旧工单全部失效。

## Review Focus

以下五类输入/故障是最容易咬人的，每条都已在对应任务里指定了钉住它的测试：

1. **跨应用 open_id**（就是 `ou_82fb106b096ac2a7563f9a2a6077a44d` 那次）——能保存，但面板与日志必须显示「解析不到」，且该用户不算允许名单内 → Task 1 / Task 6。
2. **通讯录权限缺失 / lark-cli 不可用 / 超时**——名单**不能被清空**，条目保留待重试，机器人按上一份有效名单继续工作 → Task 1。
3. **群级 allowed 全部解析失败**——该群**拒绝所有人**并标红，**不得退回全局名单** → Task 3。
4. **名单改成邮箱后，在途工单恢复**——`revalidateMandate()` 不得把工单判成 `sender:not-allowed` → Task 3。
5. **换 `feishu.appId`**——旧缓存必须失效重解析，不能继续用旧应用的 open_id → Task 2。

---

### Task 1: 身份条目解析器

**Files:**
- Create: `src/sources/feishu-identity.ts`
- Test: `tests/sources/feishu-identity.test.ts`

**Interfaces:**
- Consumes: `CommandRunner`（`src/infra/process.ts`）、`Logger` / `noopLogger` / `errorMessage`（`src/infra/logger.ts`）
- Produces:
  ```ts
  export type IdentityKind = 'email' | 'open_id' | 'invalid'
  export type IdentityStatus = 'resolved' | 'invalid' | 'pending'
  export interface IdentityEntry {
    entry: string      // 用户原样填写的条目
    kind: IdentityKind
    openId: string     // 解析出的 open_id；未解析出来为空
    name: string       // 通讯录显示名；取不到为空
    status: IdentityStatus
    detail: string     // 失败原因（邮箱已掩码）
  }
  export interface IdentityResolution {
    entries: IdentityEntry[]
    openIds: string[]          // 解析成功的 open_id，去重
    names: Map<string, string> // open_id → 显示名
    invalid: IdentityEntry[]
    pending: IdentityEntry[]
  }
  export interface IdentityCache {
    get(appId: string, kind: 'email' | 'open_id', value: string): { openId: string; name: string } | null
    set(appId: string, kind: 'email' | 'open_id', value: string, openId: string, name: string): void
  }
  export function classifyEntry(raw: string): { kind: IdentityKind; value: string }
  export function parseBatchGetId(stdout: string): Map<string, string>   // email → open_id
  export function parseContactUser(stdout: string): { openId: string; userId: string; name: string; email: string } | null
  export function maskEmail(email: string): string
  export class IdentityResolver {
    constructor(opts: { lark: CommandRunner; appId?: string; cache?: IdentityCache; logger?: Logger })
    async resolveEntries(entries: readonly string[]): Promise<IdentityResolution>
  }
  ```

- [ ] **Step 1: 写失败测试 `tests/sources/feishu-identity.test.ts`**

覆盖以下行为（用假 runner，断言 `run` 被调用的 argv）：

```ts
const runner = (results: Record<string, { code: number; stdout: string; stderr: string }>): CommandRunner & { calls: string[][] }
```

- `classifyEntry('a@b.com')` → `{ kind: 'email', value: 'a@b.com' }`；`' ou_x '` → `{ kind: 'open_id', value: 'ou_x' }`；`'张三'` → `{ kind: 'invalid', value: '张三' }`。
- 邮箱条目：`resolveEntries(['pengzhen02@dewu.com'])` 调用
  `['api','POST','/open-apis/contact/v3/users/batch_get_id','--params',JSON.stringify({ user_id_type: 'open_id' }),'--data',JSON.stringify({ emails: ['pengzhen02@dewu.com'] }),'--as','bot','--format','json']`，
  返回 `ok:true` 且 `data.user_list[0].user_id='ou_aa94092a6fd14dd0672a7f327a00fd61'` 时，`openIds` 含该 id。
- 邮箱查无此人：`ok:true` 但该条**没有** `user_id` 字段 → 该条目 `status='invalid'`、`detail` 含「查无此人」，且**不在** `openIds` 里。
- 跨应用 open_id：`contact +get-user` 返回 `ok:false` 且 `error.code=99992361` → `status='invalid'`、detail 含「跨应用」。
- 查无此人的 open_id：`error.code=99992351` → `status='invalid'`。
- 权限/网络类失败：runner 返回 `code=1` 或抛异常 → `status='pending'`（**不是** invalid），条目**保留**，并断言 `invalid` 数组里没有它。
- 名字回填：`contact +get-user` 返回 `name='阿振(Pz)'` → `names.get('ou_aa94...')==='阿振(Pz)'`。
- 缓存：`cache.get` 命中时**不再调用** runner（断言 `calls.length===0`）；`cache.set` 被调用且键为 `(appId,'email','pengzhen02@dewu.com')`。
- `maskEmail('pengzhen02@dewu.com')` → `'p***@dewu.com'`；`invalid[0].detail` 里不出现完整邮箱。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/sources/feishu-identity.test.ts`
Expected: FAIL —— `Cannot find module '../../src/sources/feishu-identity.js'`

- [ ] **Step 3: 实现 `src/sources/feishu-identity.ts`**

要点：
- `classifyEntry`：先 `trim()`；含 `@` → `email`（value 保持原样，比较时再小写）；`/^ou_/` → `open_id`；否则 `invalid`。
- 邮箱解析走 `batch_get_id`（一次可批量，先把所有邮箱条目一次性发出去，再逐条对号入座）。返回值里**缺 `user_id` 字段**才算查无此人（已实测：邮箱查无此人时 `ok` 仍为 true）。
- `open_id` 条目查名字走 `contact +get-user --user-id <id> --as bot --format json`。
- 错误分类：`ok:false` 且 `error.code` ∈ {`99992351`, `99992361`} → `invalid`；其余 `ok:false`、runner 非零退出、抛异常 → `pending`。
- `pending` 的条目**必须保留**（`invalid` 才丢弃），下次解析会重试。
- 缓存键：`${appId}|${kind}|${value}`；`appId` 为空时用 `''`，不写缓存（避免跨应用污染）。
- 日志：`logger.info('identity:resolved', { entry: maskEmail(...), actor: openId, name })`；`logger.warn('identity:resolve-failed', { entry, detail })`（invalid）；`logger.warn('identity:resolve-deferred', { entry, detail })`（pending）。**entry 字段必须掩码**。
- `catch` 里必须写 `errorMessage(error)` 并落到 `pending`，不得静默。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/sources/feishu-identity.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sources/feishu-identity.ts tests/sources/feishu-identity.test.ts
git commit -m "feat(feishu): 新增身份条目解析器，支持邮箱与 open_id"
```

---

### Task 2: 解析结果缓存（state.db）

**Files:**
- Modify: `src/store/db.ts`（`SCHEMA` 常量 + `Store` 方法）
- Test: `tests/store/store.test.ts`

**Interfaces:**
- Consumes: `IdentityCache`（Task 1）
- Produces: `Store` 新增
  ```ts
  getIdentityAlias(appId: string, kind: 'email' | 'open_id', value: string): { openId: string; name: string } | null
  setIdentityAlias(appId: string, kind: 'email' | 'open_id', value: string, openId: string, name: string): void
  ```

- [ ] **Step 1: 写失败测试**

在 `tests/store/store.test.ts` 追加：

- `setIdentityAlias('cli_a','email','a@b.com','ou_x','阿振')` 后 `getIdentityAlias('cli_a','email','a@b.com')` 返回 `{ openId:'ou_x', name:'阿振' }`。
- **换 appId 后缓存失效**：`getIdentityAlias('cli_b','email','a@b.com')` 返回 `null`（Review Focus 第 5 条）。
- 同 appId 不同 kind 不串：`getIdentityAlias('cli_a','open_id','a@b.com')` 返回 `null`。
- 重开数据库（重新 `new Store(path)`）后仍能读到（缓存落盘，不在内存）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/store/store.test.ts`
Expected: FAIL —— `store.getIdentityAlias is not a function`

- [ ] **Step 3: 实现表与 Store 方法**

在 `src/store/db.ts` 的 `SCHEMA` 常量里追加（`CREATE TABLE IF NOT EXISTS`，幂等，无需迁移）：

```sql
CREATE TABLE IF NOT EXISTS identity_aliases (
  app_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  open_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, kind, value)
);
```

`Store.getIdentityAlias` 读一行；`setIdentityAlias` 用 `INSERT OR REPLACE`。`updated_at` 用 `new Date().toISOString()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/store/store.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/store/db.ts tests/store/store.test.ts
git commit -m "feat(store): 新增身份别名缓存表，键带 app_id 以便换应用失效"
```

---

### Task 3: 运行时按解析结果匹配名单

**Files:**
- Modify: `src/core/policy.ts`（`Policy` 类型、`gate()`、`revalidateMandate()`）
- Modify: `src/config.ts`（`policyOf()`）
- Modify: `src/router/agent-loop.ts`（`canMutate()`、`isAllowed()`、`contextPrompt()`）
- Test: `tests/core/policy.test.ts`、`tests/router/agent-loop.test.ts`

**Interfaces:**
- Consumes: 无新外部依赖（`IdentityResolution` 在 Task 4 才接进来）
- Produces:
  ```ts
  // src/core/policy.ts
  export interface Policy {
    ...
    allowed: string[]                                   // 原始条目（邮箱或 ou_）
    allowedOpenIds?: string[]                          // 解析结果；缺省回退到 allowed
    allowedByChatOpenIds?: Record<string, string[]>    // 群级解析结果
    allowedByChat?: Record<string, string[]>           // 原始群级条目
  }
  export function policyOf(config: AppConfig, resolved?: {
    allowedOpenIds?: string[]
    allowedByChatOpenIds?: Record<string, string[]>
  }): Policy
  export function effectiveAllowed(policy: Policy): string[]              // allowedOpenIds ?? allowed
  export function effectiveAllowedByChat(policy: Policy, chatId: string): string[] | null
  ```

- [ ] **Step 1: 写失败测试**

`tests/core/policy.test.ts` 追加：

- `policy.allowed = ['a@b.com']`、`policy.allowedOpenIds = ['ou_alice']` 时，`gate(trigger{actorId:'ou_alice', addressed:'mention'})` → `action='explicit'`；`actorId:'ou_bob'` → 不是 explicit。
- **旧库兼容**：`policy` 里**没有** `allowedOpenIds`（旧 `state.db` 读出来的形态）且 `allowed=['ou_alice']` 时，`actorId:'ou_alice'` 仍然算名单内。
- **群级名单全空 → 拒绝所有人**（Review Focus 第 3 条）：`allowedByChat = { oc_1: ['a@b.com'] }`、`allowedByChatOpenIds = { oc_1: [] }` 时，该群的消息即使来自全局名单内的人，`gate()` 也不得判 explicit；并且要有一条 `ignore`，reason 说明是群级名单为空。
- `revalidateMandate()`：`allowed=['a@b.com']`、`allowedOpenIds=['ou_alice']`，`mandate.actorId='ou_alice'` → 仍然 `valid: true`（Review Focus 第 4 条）；`actorId='ou_bob'` → `valid:false, reason:'sender:not-allowed'`。

`tests/router/agent-loop.test.ts` 追加：

- `canMutate`：名单解析后为 `ou_alice` 的发送人 → 允许写操作；`ou_bob` → 不允许。
- `isAllowed`（会话复用）：同一人在两次消息间用解析后的 open_id 命中名单 → 复用会话。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/core/policy.test.ts tests/router/agent-loop.test.ts`
Expected: FAIL —— 邮箱条目无法命中 / 群级空名单退回全局

- [ ] **Step 3: 实现**

- `Policy` 加 `allowedOpenIds?`、`allowedByChatOpenIds?` 两个**可选**字段（可选是为了旧 `policy` 行能读）。
- `effectiveAllowed(policy)` = `policy.allowedOpenIds ?? policy.allowed`。
- `effectiveAllowedByChat(policy, chatId)`：`scoped = policy.allowedByChat?.[chatId]`；`scoped` 非空数组时，
  取 `policy.allowedByChatOpenIds?.[chatId] ?? scoped`；**返回空数组表示"配了但一个都没解析出来"**，调用方必须按"拒绝所有人"处理，不能退回全局。
  区分两种"没有配置"：`scoped === undefined` → 未配置该群名单（沿用全局）；`scoped.length > 0` 但解析结果为空 → 拒绝所有人。
- `gate()`：按上面两个函数取名单；群级存在但解析为空 → `{ action: 'ignore', reason: 'admission:chat-allowlist-empty' }`。
- `revalidateMandate()`、`canMutate()`、`isAllowed()` 全部改用 `effectiveAllowed` / `effectiveAllowedByChat`。
- `contextPrompt()`：展示名单时用解析出的名字（`policy.names` 可选字段，Task 4 注入）；**不把邮箱喂给模型**。为免耦合，这里只在有 `names` 时显示 `名字(ou_xxx)`，否则退回原样。
- `policyOf(config, resolved?)`：把 `resolved?.allowedOpenIds` / `resolved?.allowedByChatOpenIds` 写进 Policy；**`policy.version` 的指纹仍只由原始配置计算**（解析结果抖动不得触发 policy 变更）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/core/policy.test.ts tests/router/agent-loop.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/policy.ts src/config.ts src/router/agent-loop.ts tests/core/policy.test.ts tests/router/agent-loop.test.ts
git commit -m "feat(policy): 允许名单支持邮箱解析结果，保留旧库兼容回退"
```

---

### Task 4: 机器人身份自动识别与启动装配

**Files:**
- Modify: `src/sources/feishu-identity.ts`（追加 `resolveBotIdentity` 与 `resolveRuntimeIdentity`）
- Modify: `src/sources/feishu.ts`（`FeishuConfig` 增加 `actorNames`，`actorName` 填充）
- Modify: `src/cli/index.ts`（启动时解析并注入）
- Test: `tests/sources/feishu-identity.test.ts`（追加）、`tests/sources/feishu.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `IdentityResolver`、Task 2 的 `Store.getIdentityAlias/setIdentityAlias`（实现 `IdentityCache`）、Task 3 的 `policyOf(config, resolved)`
- Produces:
  ```ts
  // src/sources/feishu-identity.ts
  export interface BotIdentity {
    botOpenIds: string[]
    botNames: string[]
    resolved: boolean
    detail: string
  }
  export interface RuntimeIdentity {
    allowedOpenIds: string[]
    allowedByChatOpenIds: Record<string, string[]>
    names: Map<string, string>
    bot: BotIdentity
    status: IdentityStatusView
  }
  export interface IdentityStatusView {
    entries: IdentityEntry[]        // 全局名单 + 群级名单的条目状态
    bot: BotIdentity
    invalidCount: number
    pendingCount: number
  }
  export async function resolveRuntimeIdentity(opts: {
    config: AppConfig
    lark: CommandRunner
    cache?: IdentityCache
    logger?: Logger
  }): Promise<RuntimeIdentity>

  // src/sources/feishu.ts
  export interface FeishuConfig {
    ...
    /** 发送人 open_id → 显示名；由 IdentityResolver 原地维护，入站只读。 */
    actorNames?: Map<string, string>
  }
  ```

- [ ] **Step 1: 写失败测试**

`tests/sources/feishu-identity.test.ts` 追加：

- `resolveBotIdentity({ appId: 'cli_a', chatIds: ['oc_1'] })`：群成员返回 `bots:[{ member_id:'ou_bot', name:'Pz小助手', app_id:'cli_a' }]` → `botOpenIds` 含 `'ou_bot'`、`botNames` 含 `'Pz小助手'`、`resolved===true`。
- 群成员里**没有**匹配 appId 的机器人 → `resolved===false`，`detail` 说明「群 oc_1 里没找到 appId=cli_a 的机器人」。
- 群成员调用失败（runner 抛错）→ `resolved===false`，`detail` 含 `errorMessage(error)`。
- `resolveRuntimeIdentity`：全局 `allowed=['pengzhen02@dewu.com']` → `allowedOpenIds` 含 `ou_aa94...`；`names` 含该 id → `阿振(Pz)`。

`tests/sources/feishu.test.ts` 追加：

- `normalizeFeishuEventDetailed` 在 `cfg.actorNames = new Map([['ou_alice','阿振(Pz)']])` 时，返回的 `trigger.actorName === '阿振(Pz)'`。
- `actorNames` 为空或没有该人时，`actorName === ''`（不报错）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/sources/feishu-identity.test.ts tests/sources/feishu.test.ts`
Expected: FAIL —— `resolveBotIdentity` 不存在 / `actorName` 仍为空

- [ ] **Step 3: 实现**

- `resolveBotIdentity`：对 `chatIds` 逐个跑
  `['im','+chat-members-list','--chat-id',chatId,'--as','bot','--format','json']`，
  用 `parseLarkMembers`（`src/sources/lark.ts`，已有）取 `type==='bot'` 且 `appId===opts.appId` 的成员；
  合并所有群的匹配结果；一个都没匹配上 → `resolved:false`。
  日志：`logger.info('feishu:bot-identity-resolved', { bot: openId, name })` 或
  `logger.error('feishu:bot-identity-failed', { detail })`。
- `resolveRuntimeIdentity`：
  1. 全局名单 `config.feishu.allowed` → `resolveEntries`；
  2. 每个 `config.feishu.chats[].allowed` → 逐群 `resolveEntries`；
  3. `resolveBotIdentity({ appId: config.feishu.appId, chatIds: 只取 mode==='mention' 的群 })`；
  4. 汇总 `names`（open_id → 名字）、`allowedOpenIds`、`allowedByChatOpenIds`；
  5. 群级名单**配了但解析为空**时写 `logger.error('feishu:chat-allowlist-empty', { chat, name })`；
  6. 有 invalid/pending 时写 `logger.warn('config:identity-invalid', { count, detail })`。
- `src/sources/feishu.ts`：`FeishuConfig` 增加 `actorNames?: Map<string, string>`；
  `normalizeFeishuEventDetailed` 里 `actorName: cfg.actorNames?.get(senderId) ?? ''`（**不要**动 `mentions` 等既有逻辑）。
- `src/cli/index.ts`（serve 装配处，约 1193 行 `createFeishuChannel` 之前）：
  ```ts
  const cache: IdentityCache = {
    get: (appId, kind, value) => {
      const row = store.getIdentityAlias(appId, kind, value)
      return row ? { openId: row.openId, name: row.name } : null
    },
    set: (appId, kind, value, openId, name) => store.setIdentityAlias(appId, kind, value, openId, name),
  }
  const identity = await resolveRuntimeIdentity({ config, lark: larkRunner, cache, logger })
  const feishuConfig = { ...config.feishu, botOpenIds: identity.bot.botOpenIds, botNames: identity.bot.botNames, actorNames: identity.names }
  ```
  并把 `identity.allowedOpenIds` / `identity.allowedByChatOpenIds` 传给
  `new Engine({ store, policy: policyOf(config, identity), ... })`。
  **注意**：`createFeishuChannel({ config: feishuConfig, ... })` 必须用 `feishuConfig`，否则 mention 判定仍用旧的空 `botOpenIds`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/sources/feishu-identity.test.ts tests/sources/feishu.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sources/feishu-identity.ts src/sources/feishu.ts src/cli/index.ts tests/sources/feishu-identity.test.ts tests/sources/feishu.test.ts
git commit -m "feat(feishu): 启动时自动识别机器人身份并解析允许名单"
```

---

### Task 5: Web 保存后立即生效

**Files:**
- Modify: `src/router/api.ts`（`ApiServerOptions` 增加 `identity` 端口；`configPayload` 附带状态；配置保存后刷新）
- Modify: `src/cli/index.ts`（装配 `identity` 端口）
- Test: `tests/router/api.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `IdentityStatusView`、`resolveRuntimeIdentity`
- Produces:
  ```ts
  // src/router/api.ts
  export interface IdentityPort {
    /** 重新解析名单并刷新内存快照。 */
    refresh(): Promise<IdentityStatusView>
    /** 最近一次解析结果快照。 */
    snapshot(): IdentityStatusView
    /** 解析出的 open_id 集合，供重建 Policy 用；缺省时沿用配置里的原始条目。 */
    policyIds?(): { allowedOpenIds: string[]; allowedByChatOpenIds: Record<string, string[]> }
  }
  // ApiServerOptions 新增：identity?: IdentityPort
  // GET /api/config 与 PUT /api/config 的响应新增：identity: IdentityStatusView
  ```

- [ ] **Step 1: 写失败测试**

`tests/router/api.test.ts` 追加：

- `GET /api/config` 响应含 `identity` 字段，且 `identity.entries` 里有每个名单条目的 `status`。
- `PUT /api/config` 保存 `feishu.allowed` 后：响应 `policyChanged===true`；`identity` 端口的 `refresh` 被调用；**不需要重启**（`restartRequired` 仍按既有 `requiresRestart` 语义，不影响本次断言）。
- 保存**解析失败**的邮箱：响应 **200**（不阻断保存），`identity.invalidCount > 0`。
- 刷新失败（`refresh()` 抛错）→ 保存仍然成功（200），但要写一条 warn 日志。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/router/api.test.ts`
Expected: FAIL —— 响应里没有 `identity`

- [ ] **Step 3: 实现**

- `ApiServerOptions` 增加 `identity?: IdentityPort`；缺省时 `configPayload` 里 `identity` 返回空状态
  （`{ entries: [], bot: { botOpenIds: [], botNames: [], resolved: false, detail: '未启用' }, invalidCount: 0, pendingCount: 0 }`）。
- `configPayload(config, runtimeAdmin, identity?)` 追加 `identity: identity?.snapshot() ?? emptyIdentityStatus()`。
- `PUT /api/config` 在 `applyConfigPatch` 成功之后：
  ```ts
  if (opts.identity) {
    try {
      await opts.identity.refresh()
    } catch (error) {
      logger.warn('identity:refresh-failed', { message: errorMessage(error) })
    }
  }
  ```
  **刷新失败不得让保存失败**（catch 里写 warn，禁止空 catch）。
  刷新成功后重建 policy：调用已有的 `opts.engine.updatePolicy(policyOf(config, resolved))`，
  `resolved` 由 `identity` 端口一并提供（`IdentityPort` 增加可选 `policyIds?()` 返回
  `{ allowedOpenIds, allowedByChatOpenIds }`）。
- `src/cli/index.ts`：实现 `identity` 端口——`refresh()` 调用 `resolveRuntimeIdentity` 并更新
  `engine.updatePolicy(policyOf(config, resolved))` 与 `feishuConfig.actorNames`（**原地 mutate 同一个 Map**，
  通道侧无需重建）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/router/api.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/router/api.ts src/cli/index.ts tests/router/api.test.ts
git commit -m "feat(api): 配置保存后立即重解析允许名单并回传解析状态"
```

---

### Task 6: 面板文案与解析状态展示

**Files:**
- Modify: `src/web/client/fields.ts`（名单字段文案）
- Modify: `src/web/client/api.ts`（`ConfigBundle` 增加 `identity`）
- Modify: `src/web/client/app.tsx`（飞书区块展示状态）
- Create: `src/web/client/identity-status.ts`（纯函数，供测试与渲染共用）
- Test: `tests/web/identity-status.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `IdentityStatusView`（前端用同构类型 `IdentityStatusView` 在 `api.ts` 里重声明）
- Produces:
  ```ts
  // src/web/client/identity-status.ts
  export interface IdentityEntryView {
    entry: string; kind: 'email' | 'open_id' | 'invalid'; status: 'resolved' | 'invalid' | 'pending'
    name: string; detail: string
  }
  export interface IdentityStatusView {
    entries: IdentityEntryView[]
    bot: { botOpenIds: string[]; botNames: string[]; resolved: boolean; detail: string }
    invalidCount: number
    pendingCount: number
  }
  export function summarizeIdentity(status: IdentityStatusView | undefined): { kind: 'ok' | 'warn' | 'error'; text: string }
  export function describeEntry(entry: IdentityEntryView): string
  ```

- [ ] **Step 1: 写失败测试 `tests/web/identity-status.test.ts`**

- `summarizeIdentity(undefined)` → `{ kind: 'ok', text: ... }`（不报错）。
- `invalidCount>0` → `kind:'error'`，text 含「没能解析到」。
- `pendingCount>0` 且 `invalidCount===0` → `kind:'warn'`。
- 全部 resolved → `kind:'ok'`。
- `describeEntry` 对 email 条目只显示掩码后的邮箱（不含完整邮箱）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/web/identity-status.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

- `fields.ts`：
  - `feishu.allowed` → label `'全局允许名单（推荐邮箱，兼容 ou_xxx）'`，placeholder `'alice@company.com, bob@company.com'`，hint `'推荐填邮箱；换应用后 open_id 会变，邮箱不会'`
  - `feishu.botOpenIds` / `feishu.botNames` → label 追加 `'（高级，默认自动识别）'`，hint `'留空 = 按 App ID 自动识别机器人'`
  - `feishu.bots`（可引用的机器人）**保持原样**：机器人没有邮箱，仍只收 `ou_xxx`。
  - 落盘**不归一化**：邮箱保持用户原样写进 `config.yaml`，只在解析时小写比较。
  - 群级 allowed 的文案在聊天配置组件里同步（与全局一致）。
- `api.ts`：`ConfigBundle` 增加 `identity?: IdentityStatusView`。
- `app.tsx`：飞书区块顶部渲染 `summarizeIdentity(config.identity)` 的提示条；`invalidCount>0` 时列出条目与建议；
  `bot.resolved===false` 时提示「机器人身份没识别出来，@ 模式的消息不会被接收」。
  提示条沿用现有 `Notice` 风格（`kind: 'ok' | 'warn' | 'error'`）。
- `identity-status.ts`：纯函数，不引 React。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/web/identity-status.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/web/client/fields.ts src/web/client/api.ts src/web/client/app.tsx src/web/client/identity-status.ts tests/web/identity-status.test.ts
git commit -m "feat(web): 允许名单改为推荐邮箱，并展示身份解析状态"
```

---

### Task 7: doctor 判定、日志事件表与文档

**Files:**
- Modify: `src/cli/doctor.ts`
- Modify: `docs/OPERATIONS.md`（日志事件表）
- Modify: `docs/CONFIGURATION.md`（允许名单写邮箱的说明）
- Test: `tests/cli-doctor.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `resolveBotIdentity`
- Produces: 无新接口

- [ ] **Step 1: 写失败测试 `tests/cli-doctor.test.ts` 追加**

- `feishu.botOpenIds` 为空但**自动识别成功**（群成员里有同 appId 的 bot）→ 「配置必填项」不再判 fail。
- 自动识别失败 → 「配置必填项」判 fail，hint 指向 `feishu.appId` 或群成员。
- 「机器人在群内」检查按自动识别结果判断：识别到 → ok；没识别到 → fail。
- 群成员查询抛错 → 该项判 warn（不是 fail），detail 含错误原因。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/cli-doctor.test.ts`
Expected: FAIL —— 空 `botOpenIds` 仍判 fail

- [ ] **Step 3: 实现**

- `doctor.ts`：把 `config.feishu.botOpenIds.length === 0` 从「必填缺失」里去掉，改成：
  先跑 `resolveBotIdentity({ appId: config.feishu.appId, chatIds: 配置的群 })`；
  识别成功 → 必填项里不再列 `feishu.botOpenIds`；失败 → 列进去并给 hint。
- 「机器人在群内」检查复用同一结果，去掉对 `config.feishu.botOpenIds` 的硬依赖（手动填了仍然优先）。
- `docs/OPERATIONS.md` 日志事件表补 6 个事件：
  `identity:resolved`(info)、`identity:resolve-failed`(warn)、`identity:resolve-deferred`(warn)、
  `config:identity-invalid`(warn)、`feishu:bot-identity-resolved`(info)、`feishu:bot-identity-failed`(error)、
  `feishu:chat-allowlist-empty`(error)、`identity:refresh-failed`(warn)。
  每行写清来源、关键字段与含义。
- `docs/CONFIGURATION.md`：把「全局允许名单」写成推荐填邮箱，说明 open_id 会随应用变化。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/cli-doctor.test.ts`
Expected: PASS

- [ ] **Step 5: 全量校验与提交**

Run: `pnpm typecheck && pnpm test`
Expected: 全部通过

```bash
git add src/cli/doctor.ts docs/OPERATIONS.md docs/CONFIGURATION.md tests/cli-doctor.test.ts
git commit -m "feat(doctor): 机器人身份改为自动识别判定，并补齐身份相关日志文档"
```

---

## 收尾

- [ ] **Step 1: 端到端验证（本机）**

```bash
# 1) 把本地配置改成邮箱，验证解析与生效
ra config set feishu.allowed pengzhen02@dewu.com
ra config set feishu.botOpenIds ''    # 清空，交给自动识别
ra start
```

在【RA-Bot】Router-Agent 群里 `@Pz小助手` 发一条，确认：
- `~/.router-agent/logs/router-agent.log` 出现 `identity:resolved`（`name=阿振(Pz)`）与 `feishu:bot-identity-resolved`；
- 消息不再出现 `trigger:dropped reason=mention:required`；
- 机器人正常回复。

- [ ] **Step 2: 验证告警路径**

把允许名单改成另一个应用的 `ou_82fb106b096ac2a7563f9a2a6077a44d`，确认面板提示「解析不到」且日志出现
`identity:resolve-failed`；把 `feishu.appId` 改成一个不存在的值，确认启动日志出现
`feishu:bot-identity-failed`（error 级）。

- [ ] **Step 3: 构建**

Run: `pnpm build`
Expected: 通过
