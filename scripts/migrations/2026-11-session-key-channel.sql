-- 历史 sessionKey 迁移：chat:<chatId>... -> channel:feishu:chat:<chatId>...
--
-- 使用前提：
--   1. 已停止 Router（ra stop）；
--   2. 已备份 ~/.router-agent/state.db（VACUUM INTO 生成一致性快照）；
--   3. 已执行 ra migrate sessions --dry-run 并确认待迁移数量与异常 key。
--
-- 说明：
--   - 只修改 chat_sessions / chat_session_resets 的 session_key 与 id；
--   - 会话文件（session_file）不改名、不改内容，因此不会丢上下文；
--   - 异常 key（既不是 chat: 也不是 channel:）不会被修改；
--   - 可重复执行：迁移记录已存在时重复执行不会再改数据。
--
-- 执行：sqlite3 ~/.router-agent/state.db < scripts/migrations/2026-11-session-key-channel.sql

BEGIN IMMEDIATE;

-- 迁移前快照，便于审计与人工回滚参考
CREATE TABLE IF NOT EXISTS _session_key_backup AS
SELECT id, session_key FROM chat_sessions
WHERE session_key LIKE 'chat:%' AND session_key NOT LIKE 'channel:%';

CREATE TABLE IF NOT EXISTS _session_reset_key_backup AS
SELECT id, session_key FROM chat_session_resets
WHERE session_key LIKE 'chat:%' AND session_key NOT LIKE 'channel:%';

UPDATE chat_sessions
SET id          = 'channel:feishu:' || id,
    session_key = 'channel:feishu:' || session_key
WHERE session_key LIKE 'chat:%' AND session_key NOT LIKE 'channel:%';

UPDATE chat_session_resets
SET id          = 'channel:feishu:' || id,
    session_key = 'channel:feishu:' || session_key
WHERE session_key LIKE 'chat:%' AND session_key NOT LIKE 'channel:%';

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (id, applied_at)
VALUES ('2026-11-session-key-channel', datetime('now'));

COMMIT;