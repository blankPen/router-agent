# 飞书身份配置改造设计（邮箱优先，兼容 open_id）

日期：2026-11-11
状态：已确认，待实现

## 一、为什么要改

事故：`oc_20812405b3aec3a2838df24295889833`（【RA-Bot】Router-Agent 群）配置为 `mode: mention`，
但 `feishu.botOpenIds` / `feishu.botNames` 都是空数组，导致该群消息全部命中
`trigger:dropped reason=mention:required`，机器人一条都没回。

同期发现第二个配置错误：`feishu.allowed` 里写的是 `ou_82fb106b096ac2a7563f9a2a6077a44d`，
而当前应用（`cli_a9225095e04cdbc2`）看到的同一个用户是
`ou_aa94092a6fd14dd0672a7f327a00fd61`。用机器人身份查前者会直接报错
`code 99992361 open_id cross app`。

根因不是某一行代码写错，而是**配置模型让用户去填应用内部 id**：

- `open_id` 的作用域是「应用 × 用户」，换应用就换一个值，用户既看不到也无从校验；
- 换过 `feishu.appId` 之后，旧名单里的 id 静默失效，服务不报错、只丢消息；
- Web 面板把「全局允许名单」「机器人自身 open_id」直接暴露成 `ou_xxx` 输入框。

结论：**open_id 继续作为内部存储与运行时匹配的主键**（飞书 API 只认它），
但**不再要求用户手写 open_id**。配置层改为「邮箱优先，兼容 ou_xxx」。

## 二、目标 / 非目标 / 反目标

### 目标

1. `feishu.allowed` 与群级 `allowed` 的条目同时接受邮箱（推荐）与 `ou_xxx`。
2. Web 面板不再诱导用户手填 open_id：文案、placeholder、提示都指向邮箱。
3. Web 保存后名单**立即生效**，不需要重启服务。
4. 机器人自身身份（`botOpenIds` / `botNames`）由服务自动解析，不再要求手填。
5. 任何解析不了的名单条目都要**看得见**：启动告警 + 面板提示 + 日志事件，而不是静默丢消息。
6. 名单内的人在工单与日志里显示姓名（`actorName`），排查时不用再对着 `ou_xxx` 猜是谁。

### 非目标（本期不做）

- 不做「群成员勾选式选择器」这类重 UI（另开一期）。
- 不把 `user_id` / `union_id` 引入为运行时主键；`open_id` 仍是主键，profile 只作附加信息。
- 不在消息入站链路上调用通讯录 API（已确认：只读缓存）。
- 不改事件订阅方式、不改飞书侧配置。
- 不做跨租户 / 多开发者部署的身份合并。

### 反目标

- 不要为了「自动」而牺牲可诊断性：任何自动解析失败都必须留下日志与面板提示。
- 不要在入站主链路上做通讯录查询（哪怕有缓存也不做，避免拖慢首字响应）。
- 不要因为解析失败把名单悄悄清空——那正是这次事故的形态。

## 三、事实依据（已在本机验证）

| 事实 | 验证方式 |
|-|-|
| 消息事件只带 `sender_id`（open_id），无姓名/邮箱/user_id | lark-cli 事件文档：`sender_id is open_id only` |
| 机器人身份可把 open_id 解析成姓名/邮箱/user_id/union_id | `lark-cli contact +get-user --user-id ou_... --as bot` |
| 机器人身份可把邮箱批量解析成 open_id | `lark-cli api POST /open-apis/contact/v3/users/batch_get_id`（`data.user_list[].user_id` 即 open_id） |
| 邮箱查无此人时**不报错**，只是该条没有 `user_id` 字段 | 实测：需按字段缺失判断，不能只看 `ok` |
| 跨应用 open_id 会被飞书拒绝 | 查 `ou_82fb...` 返回 `99992361 open_id cross app` |
| 机器人没有邮箱 | 群成员列表里 bot 只有 `app_id` 与 `member_id` |

三个 id 的作用域：open_id = 应用；union_id = 开发者；user_id = 租户。
本方案内仍以 open_id 为主键，邮箱仅作为配置层入口。

## 四、方案

### 4.1 配置层：条目语义

`feishu.allowed`（全局）、群级 `allowed` 仍是**字符串数组**，格式不变，只扩展条目语义：

| 条目形态 | 判定 | 处理 |
|-|-|-|
| 含 `@` | 邮箱 | 归一化（trim + 小写），用 `batch_get_id` 解析成 open_id |
| `ou_` 前缀 | open_id | 直接采用；顺带查一次通讯录拿名字（查不到按 §4.6 分类处理） |
| 其它 | 非法 | 告警并忽略该条目 |

`feishu.bots`（可引用的机器人）保持 open_id 语义——机器人没有邮箱。

### 4.2 解析时机与缓存

解析发生在**服务启动 / 配置变更（Web 保存）**，不在消息主链路上：

- 运行时**只按 open_id 匹配**，不做邮箱字符串比对。邮箱只在配置层解析一次，
  之后名单比较就是两个 open_id 集合的相交，零查询、零延迟。
- 新增 `IdentityResolver`（`src/sources/feishu-identity.ts`），职责：
  - `resolveEntries(entries)` → `{ openIds, names: Map<openId, name>, invalid: Entry[], pending: Entry[] }`
  - 解析顺序：先查缓存 → 未命中才调通讯录 → 结果写缓存
  - 名字只在**名单条目**解析时取（条目数量很少），入站链路不取名字
- 缓存表（`state.db`）：
  - `identity_aliases(app_id, kind, value, open_id, name, updated_at)`：`kind` 为 `email` / `open_id`。
    键里带 `app_id`，换应用后自然失效重解析。
  - 命中缓存零进程调用；解析失败不写缓存，下次重试。
- 名字缓存同时作为**内存 map**（open_id → name）供入站填 `actorName`，入站只读内存，不发请求。

### 4.3 运行时匹配

`Policy` 增加两个字段，原始条目保留不动：

```
allowed: string[]                          // 原始条目（邮箱或 ou_），保留供展示与提示词
allowedOpenIds: string[]                   // 名单条目解析出的 open_id 集合，运行时匹配用
allowedByChatOpenIds: Record<string, string[]>   // 群级名单的解析结果
```

- `policyOf(config)` 保持同步纯函数；解析结果由调用方（服务启动 / 配置变更）注入。
- **所有**按 open_id 语义消费名单的地方统一改用解析结果，不只 `gate()`：
  - `core/policy.ts` `gate()`（名单内 → explicit）
  - `core/policy.ts` `revalidateMandate()`（在途工单恢复校验；不改会造成名单改成邮箱后工单被判 `sender:not-allowed`）
  - `router/agent-loop.ts` `canMutate()`（写工具授权）
  - `router/agent-loop.ts` `isAllowed()` → 会话复用与 `/new` 处理
  - `router/agent-loop.ts` `contextPrompt()`：展示名单时用解析出的姓名，不把邮箱喂给模型
- `policy.version` 仍只由**原始配置**计算，避免解析结果抖动导致 policy 频繁变更。
- 入站：`trigger.actorName` 从内存 name map 取（只读，无网络调用）；取不到留空，不影响处理。

### 4.4 立即生效

- Web `PUT /api/config` 保存成功后，若变更涉及 `feishu.allowed` 或群级 allowed：
  后台异步解析 → 更新 `engine` 的 policy → 面板收到 `policyChanged` 刷新。
  **不需要重启服务**。
- 其余飞书配置（`feishu.appId` 等）保持现有 `restartRequired` 语义。
- `ra config set` / 手改 `config.yaml` 这条路：服务收不到通知，仍需重启；
  面板上明确提示「命令行改配置需要重启服务」。

### 4.5 告警（不阻断保存）

按已确认的决定：**解析不出来也允许保存，靠告警暴露**。可见点：

1. **启动 / 配置变更时**：逐条扫描名单，解析不了的写 `config:identity-invalid`（warn），
   条目用掩码形式（`p***@dewu.com`）入日志。
2. **面板**：飞书配置区块顶部列出「有 N 条名单条目没能解析到具体的人」，并给出建议
   （改用邮箱 / 确认对方在群里 / 重新授权通讯录权限）；每个条目旁标状态。
3. **群级名单全部解析不出来时**（已确认的处理方式）：该群**拒绝所有人**并标红告警——
   语义不变（配了名单就以它为准），不退回全局名单，避免悄悄放宽。

另：`mode: mention` 的群但机器人身份解析失败时，服务启动要写 error 级事件并明确提示，
不再静默全丢——这是本次事故的直接原因。

### 4.6 机器人自身身份自动解析

- 用 `feishu.appId` 对 `im +chat-members-list` 的 bot 列表做匹配，得到 `member_id`（open_id）
  与显示名，写入运行时内存中的 `botOpenIds` / `botNames`。
- 扫描范围：所有配置了 `mode: mention` 的群取并集；按 `app_id` 匹配（机器人没有邮箱）。
- 解析失败：启动写 error 事件（`feishu:bot-identity-failed`），面板同步提示；
  同时 `mode: mention` 的群在面板上标红。
- **配置项保留**：`feishu.botOpenIds` / `feishu.botNames` 不删除，降级为「高级·手动覆盖」，
  手动填了就不自动解析（保留逃生口）。
- 自动识别结果**只放内存与面板只读展示，不回写 `config.yaml`**（避免服务自动改用户配置）。
- `ra doctor` 的判定同步调整：`feishu.botOpenIds` 为空不再直接判 fail，改为
  「自动识别成功 = ok，识别失败 = fail 并提示原因」；「机器人在群内」检查同样按自动识别结果判断。

### 4.7 解析失败要分类，不能一律丢弃

解析失败有好几种，后果完全不同：

| 失败类型 | 判定依据 | 条目去留 | 提示 |
|-|-|-|-|
| 查无此人 / 跨应用 open_id | 通讯录明确返回「无此人」或 `open_id cross app` | **丢弃**（不进 `allowedOpenIds`） | 告警，建议改用邮箱或确认对方在群里 |
| 通讯录权限缺失 / lark-cli 不可用 / 超时 | 调用报错或超时 | **保留原条目**（标记为「待重试」），下次重试 | 告警「暂时查不了，稍后重试」 |

把「权限没开」当成「查无此人」处理，会把整份 allowlist 清空，用户看到的就是机器人突然谁都不理——
正是这次事故想消灭的静默失效。所以这两类必须分开。

## 五、Web 面板改动

- `feishu.allowed` 字段：label 改为「全局允许名单（邮箱，兼容 ou_xxx）」，
  placeholder 改为 `alice@company.com, bob@company.com`，hint 说明「推荐填邮箱」。
- 群级 allowed 同样调整文案。
- `feishu.bots` 保持不变。
- `feishu.botOpenIds` / `feishu.botNames` 折叠进「高级」区域，注明「留空=自动识别」。
- 新增只读展示：名单解析状态（每个条目的解析结果与姓名/掩码邮箱）、群级名单全空的标红。
- 解析状态挂在 `GET /api/config` 的响应里（不另开端点），面板与 CLI 共用一份快照。

## 六、日志事件

新增（遵循 `CLAUDE.md` 日志规范：一行 JSON、`域:动作` kebab-case、错误细节进 `detail`、平铺字段）：

| 事件 | 级别 | 关键字段 | 含义 |
|-|-|-|-|
| `identity:resolved` | info | `entry`(掩码) `actor` `name` | 名单条目解析成功 |
| `identity:resolve-failed` | warn | `entry`(掩码) `detail` | 名单条目解析失败（查无此人 / 跨应用） |
| `identity:resolve-deferred` | warn | `entry`(掩码) `detail` | 暂时查不了（权限 / 网络），条目保留待重试 |
| `config:identity-invalid` | warn | `count` `detail` | 名单里有条目解析不到人 |
| `feishu:bot-identity-resolved` | info | `bot` `name` | 机器人身份自动识别成功 |
| `feishu:bot-identity-failed` | error | `detail` | 机器人身份识别失败（mention 群会丢消息） |
| `feishu:chat-allowlist-empty` | error | `chat` `name` | 群级名单解析为空，该群拒绝所有人 |

邮箱一律掩码后入日志（`p***@dewu.com`），不记完整邮箱。

`docs/OPERATIONS.md` 的日志事件表同步补齐。

## 七、测试

按 `CLAUDE.md` 第 9 条，失败路径必须有测试：

- 条目语义：邮箱 / `ou_` / 非法条目三类分别解析正确。
- 匹配：邮箱条目解析出的 open_id 命中 `gate()`；`ou_` 条目命中；不匹配时不命中。
  （大小写归一在**解析阶段**完成，运行时比较的是 open_id。）
- 跨应用 open_id：解析失败 → 进 `invalid`，且不进入 `allowedOpenIds`。
- 权限/网络类失败：条目进 `pending` 并保留，不被清空（§4.7）。
- 缓存：命中缓存不重复调 API；失败不写缓存；换 appId 后缓存失效重解析。
- `gate()` / `canMutate()` / `revalidateMandate()` / `isAllowed()`：用解析结果判定，行为与改前一致。
- 群级名单解析全空 → 该群拒绝所有人（不退回全局名单）。
- Web API：`PUT /api/config` 保存含邮箱的名单成功并落盘；解析失败**不**阻断保存（断言 200），
  响应里带解析状态；保存后 policy 立即更新（不需重启）。
- 入站不调用通讯录：断言消息处理过程中 runner 未被调用，`actorName` 从内存缓存取。
- 机器人身份：解析成功写入运行时配置；解析失败启动写 error 事件。

## 八、验收标准

1. 配置里只填邮箱 `pengzhen02@dewu.com`，该用户在该群的 @ 消息能被正常接收并回复，**且不需要重启**。
2. 配置里填当前应用的 `ou_`，行为与邮箱一致。
3. 配置里填另一个应用的 `ou_`：能保存，但面板与日志都能看到「解析不到」。
4. `mode: mention` 且机器人身份解析失败时，启动日志出现 error 级事件，不是静默丢消息。
5. `pnpm typecheck`、`pnpm test` 全绿；`pnpm build` 通过。

## 九、留给实现者的决定

- `IdentityResolver` 的落点与命名（建议 `src/sources/feishu-identity.ts`）。
- `state.db` 新表的具体 schema（走 `SCHEMA` 常量，`CREATE TABLE IF NOT EXISTS` 幂等）。
- 掩码邮箱的具体格式（建议 `p***@dewu.com`）。
- 面板「解析状态」的展示位置（建议飞书配置区块顶部一行 + 每个条目旁的状态标记）。
- 名单条目是否在落盘前归一化（trim + 邮箱小写）——会影响 `policy.version` 的指纹与 config.yaml 往返一致性，
  建议只在**解析时**归一，落盘保留用户原样。
