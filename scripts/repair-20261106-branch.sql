-- ============================================================================
-- 2026-11-06 工单派工失败修复
--
-- 背景：
--   1) projects.router-agent.defaultBranch 误配为 master（仓库实际分支是 main），
--      10:35~11:16 创建的 4 张工单把 master 快照进 tickets.branch，
--      orca worktree create --base-branch master 全部失败。
--   2) 旧代码在派工失败后不回退工单阶段，4 张单卡在 assigned 并永久占用
--      maxWorkers=4，导致后来分支正确的新工单也只能排队。
--   新代码（本次修复后）已经会：失败即转人工 + 释放并发 + 记录完整日志 + 在飞书话题回贴原因。
--   本 SQL 只负责把历史脏数据重新排进派工队列（或关闭重复单）。
--
-- 执行步骤：
--   1) 停止服务：      ra stop   （或 kill $(cat ~/.router-agent/router-agent.pid)）
--   2) 备份数据库：    cp ~/.router-agent/state.db ~/.router-agent/state.db.bak.$(date +%Y%m%d%H%M%S)
--                      同时备份 state.db-wal / state.db-shm 更稳妥
--   3) 执行本文件：    sqlite3 ~/.router-agent/state.db < scripts/repair-20261106-branch.sql
--   4) 重新构建并启动：pnpm build && ra start
--
-- 注意：数据库写操作由你本人确认后执行，工具不会自动连库写入。
-- ============================================================================

-- 执行前先确认命中的工单
SELECT id, stage, repo, branch, title
FROM tickets
WHERE repo = 'router-agent' AND branch = 'master';

-- ---------------------------------------------------------------------------
-- 方案 A（推荐）：关闭与最新工单重复的旧单，只重派两个独立需求
--   - tk_449582e2 / tk_d97f8d4a 与正在跑的 tk_28ddbc8b 是同一需求（整理可新增工具清单）
--   - tk_ec2d95dc（进展定时轮询）、tk_241d4b41（工单 T1/T2 编号）是独立需求，改回 main 重派
-- ---------------------------------------------------------------------------
BEGIN;

UPDATE tickets
SET stage = 'closed',
    closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  'tk_449582e2-bf9c-40d2-ae9b-e9cd5a0233bd',
  'tk_d97f8d4a-ae26-4aec-9a50-afb18c929957'
);

UPDATE tickets
SET branch = 'main',
    stage = 'accepted',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  'tk_ec2d95dc-1be7-46f5-97a1-e4812105f174',
  'tk_241d4b41-6830-4746-bce6-7e1ae18042cd'
);

COMMIT;

-- ---------------------------------------------------------------------------
-- 方案 B（备选）：4 张单全部改 main 并重新排队。
-- 会与正在跑的 tk_28ddbc8b 重复执行同一需求，建议只在你确实想全部重跑时使用。
-- 使用方法：把下面的注释去掉，且不要同时执行方案 A。
-- ---------------------------------------------------------------------------
-- BEGIN;
-- UPDATE tickets
-- SET branch = 'main',
--     stage = 'accepted',
--     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
-- WHERE repo = 'router-agent'
--   AND branch = 'master'
--   AND stage IN ('assigned', 'running');
-- COMMIT;

-- 执行后校验：不应再有 branch='master' 的未关闭工单
SELECT id, stage, repo, branch
FROM tickets
WHERE repo = 'router-agent' AND branch = 'master';