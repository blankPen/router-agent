-- ============================================================================
-- 2026-11-12 tk-51「worker 被删后反复重建、反复投递」修复
--
-- 背景：
--   1) worker 会话被删后，Router 只把 assignment 标 ended，已投递未 ack 的
--      input 仍停在 delivered。下一轮巡检看到「未 ack 输入 + 已结束派工」
--      就重新 launch，于是 Orca 里反复新建 worker。
--   2) ack 的 SQL 带 assignment_id，新 worker 的确认匹配不到旧派工下的输入，
--      输入永远停在 delivered，被无限重投。
--   新代码已修复：丢失时把未 ack 输入标 expired、ack 按 ticket 收敛、
--   同一批输入只允许触发一次重建。
--
--   本 SQL 只清理修复前遗留的两类脏数据：
--     - 已关闭工单上停在 delivered 的历史输入 → expired
--     - 被进程重启打断、永远重试不成功的 inflight stop-worker effect → done
--     两者都不属于在办工单，不会影响任何正在执行的任务。
--
-- 执行步骤：
--   1) 停止服务：      ra stop
--   2) 备份数据库：    cp ~/.router-agent/state.db ~/.router-agent/state.db.bak.$(date +%Y%m%d%H%M%S)
--   3) 执行本文件：    sqlite3 ~/.router-agent/state.db < scripts/repair-20261112-worker-lost.sql
--   4) 启动服务：      ra start
--
-- 注意：数据库写操作由你本人确认后执行，工具不会自动连库写入。
-- ============================================================================

-- 执行前确认命中范围（应先看到 8 条 input、3 条 effect，且都不属于在办工单）
SELECT i.id, i.ticket_id, i.status, t.stage
FROM inputs i
JOIN tickets t ON t.id = i.ticket_id
WHERE i.status = 'delivered';

SELECT e.id, e.key, e.kind, e.status, e.attempts
FROM effects e
WHERE e.status = 'inflight';

BEGIN;

-- 已关闭工单上没被 ack 的输入：终端已不存在，不会再有人确认，标 expired。
-- 保留记录供审计，但不参与重投与派工判断。
UPDATE inputs
SET status = 'expired'
WHERE status = 'delivered'
  AND ticket_id IN (SELECT id FROM tickets WHERE stage = 'done');

-- 重启前被打断的 stop-worker：终端句柄早已失效，重试也不会成功。
UPDATE effects
SET status = 'done',
    last_error = 'repair-20261112: stale terminal handle, marked done'
WHERE status = 'inflight'
  AND kind = 'stop-worker';

COMMIT;

-- 执行后校验：两条查询都应为空
SELECT i.id, i.ticket_id
FROM inputs i
JOIN tickets t ON t.id = i.ticket_id
WHERE i.status = 'delivered';

SELECT e.id, e.key
FROM effects e
WHERE e.status = 'inflight';
