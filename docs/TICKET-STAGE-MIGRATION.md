# 工单阶段迁移：八阶段 → 五阶段

## 1. 背景

旧版工单阶段有八种：`draft`、`accepted`、`assigned`、`running`、`review`、`person`、`idle`、`closed`。
对发起人来说，其中多组状态没有可感知的差别，看板与 CLI 过滤也越来越难用。本次收敛为五种：

| 新阶段 | 中文名 | 含义 |
| --- | --- | --- |
| `todo` | 待办 | 已接单，尚未派工 |
| `running` | 进行中 | 已派工，worker 正在执行 |
| `review` | 审核中 | worker 已交付，等待发起人验收 |
| `blocked` | 已阻塞 | 等待人工回答、worker 失败/退出，或需要人工推动 |
| `done` | 已完成 | 工单闭环（PR 合并/关闭或人工结束） |

`done` 是终态；其余四种阶段之间可以互相流转。

## 2. 旧阶段到新阶段的映射

| 旧阶段 | 新阶段 | 说明 |
| --- | --- | --- |
| `draft` | `todo` | 旧版定义但从未产生工单，仅作防御性映射 |
| `accepted` | `todo` | 已接单、未派工 |
| `assigned` | `running` | 已派工，对发起人来说工作已开始 |
| `running` | `running` | 不变 |
| `review` | `review` | 不变 |
| `person` | `blocked` | 等人处理 → 已阻塞 |
| `idle` | `blocked` | worker 空闲但活未完，同样需要人工推动 |
| `closed` | `done` | 已关闭 → 已完成 |

反向还原是有损的（`todo` 无法区分 `draft/accepted`，`running` 无法区分 `assigned`，`blocked` 无法区分 `person/idle`），**因此回滚不依赖反向映射，而是恢复迁移前的数据库备份**。

## 3. 兼容策略（迁移前也能正常跑）

- **读时归一化**：`src/store/db.ts` 在把行映射成 `Ticket` 时调用 `normalizeStage()`，旧值会按上表映射成新阶段，仅存在于内存，不写库。
- **查询兼容**：`listOpenTickets()` 同时排除 `done` 与旧终态 `closed`；按新阶段过滤时会带上旧别名（例如 `todo` 同时匹配 `draft/accepted`）。
- **不自动迁移**：应用启动时**不会**写 `tickets.stage`。历史数据只会在正常业务更新该工单时被顺带改写；批量迁移必须由人工执行脚本。

## 4. 迁移脚本

脚本：`scripts/migrate-ticket-stages.mjs`

```bash
# 1. 先 dry-run：只统计，不写库
node scripts/migrate-ticket-stages.mjs

# 指定其他状态库
node scripts/migrate-ticket-stages.mjs --db /path/to/state.db

# 机器可读输出
node scripts/migrate-ticket-stages.mjs --json
```

dry-run 会输出每类旧阶段的数量与目标阶段，并提示尚未写入任何数据。

确认无误后执行真正的迁移：

```bash
# 2. 停止 Router，避免与运行中的写入/WAL 并发
ra stop

# 3. 执行迁移（写库前自动备份）
node scripts/migrate-ticket-stages.mjs --apply

# 4. 重启
ra start
```

行为说明：

- `--apply` 会先执行 `VACUUM INTO <db>.bak.<时间戳>` 生成包含 WAL 内容的一致性备份，再在单个事务里按映射 `UPDATE`。
- 脚本是幂等的：重复执行时旧阶段已被改写，不会产生额外变化。
- 只更新 `stage`，**不修改** `updated_at` / `closed_at`，不影响闲置治理与巡检水位。
- 如果库里出现映射表之外的阶段值，脚本会中止且不写任何数据，需要先人工确认来源。
- Router 仍在运行时会拒绝 `--apply`；确需热迁移可加 `--force`（不推荐）。

## 5. 回滚

回滚使用迁移前的备份文件，而不是反向映射：

```bash
ra stop
cp "<db>.bak.<时间戳>" "<db>"
rm -f "<db>-wal" "<db>-shm"
ra start
```

`<db>` 默认是 `~/.router-agent/state.db`（或 `$RA_HOME/state.db`）。脚本执行成功后会在输出里打印实际的备份路径。

## 6. 验证

迁移后可以用只读 SQL 检查：

```sql
SELECT stage, COUNT(*) FROM tickets GROUP BY stage;
```

预期只会出现 `todo / running / review / blocked / done` 五种值（若仍有旧值，说明迁移未完成或该记录是在迁移后由旧版本写入的）。

也可以直接查看：

```bash
ra status
ra tickets --stage blocked
```

## 7. 受影响的代码与界面

- 状态推导：`src/core/stage.ts`
- 工单存储与读时兼容：`src/store/db.ts`
- 工单生命周期：`src/core/engine.ts`、`src/service.ts`
- CLI：`ra tickets --stage todo|running|review|blocked|done`
- Web 看板：五列（待办 / 进行中 / 审核中 / 已阻塞 / 已完成）
- 工具协议：`router_ticket_list` / `router_ticket` 的 `stage` 枚举同步收敛为五种
