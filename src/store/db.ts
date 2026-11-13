import { DatabaseSync } from 'node:sqlite'
import type {
  Assignment,
  Attachment,
  DecisionRecord,
  DispatchDraft,
  Input,
  Intake,
  IntakeReport,
  IntakeTurn,
  Mandate,
  Question,
  Report,
  SourceKind,
  Stage,
  Subscription,
  Ticket,
  Thread,
  Trigger,
  TriggerDisposition,
} from '#core/model.js'
import type { Policy } from '#core/policy.js'
import type { ReplyBlock } from '#core/reply.js'
import { normalizeStage, stageAliases } from '#core/stage.js'

/** sessionKey 迁移记录 ID；与手工执行的 SQL 文件保持一致。 */
export const SESSION_KEY_MIGRATION_ID = '2026-11-session-key-channel'

export interface SessionMigrationState {
  totalSessions: number
  totalResets: number
  pendingSessions: number
  pendingResets: number
  migratedSessions: number
  /** 既不是旧格式也不是新格式的 key；脚本不猜，列出来人工处理。 */
  anomalies: { table: 'chat_sessions' | 'chat_session_resets'; id: string; sessionKey: string }[]
  applied: boolean
}

export interface SessionMigrationResult {
  sessions: number
  resets: number
  skipped: boolean
}

export interface SessionMigrationVerifyResult {
  ok: boolean
  applied: boolean
  totalSessions: number
  pendingSessions: number
  pendingResets: number
  anomalies: number
}

export interface OutboxItem {
  id: string
  key: string
  channelKind: string
  channelId: string
  threadId: string
  text: string
  status: string
  attempts: number
  nextAt: string
  createdAt: string
  lastError?: string
  /** 触发这条回复的用户消息，回复成功后用于撤销回执表情。 */
  originMessageId?: string
  /** 结构化回复块；为空时按 `text` 的 Markdown / 纯文本渲染。 */
  blocks?: ReplyBlock[]
}

export interface EffectItem {
  id: string
  key: string
  kind: string
  payload: Record<string, unknown>
  status: string
  attempts: number
  nextAt: string
  createdAt: string
  lastError?: string
}

/** 一个会话（群/话题 + 人）当前的落盘 session。 */
export interface ChatSessionRecord {
  sessionKey: string
  chatId: string
  actorId: string
  threadId: string
  sessionFile: string
  sessionId: string
  soulVersion: string
  policyVersion: string
  createdAt: string
  lastUsedAt: string
  status: 'active' | 'superseded' | 'purged'
  resetAt: string | null
  resetBy: string | null
  purgedAt: string | null
}

export interface ChatSessionResetRecord {
  id: string
  sessionKey: string
  chatId: string
  actorId: string
  oldFile: string
  newFile: string
  actorName: string
  createdAt: string
}

export interface EnqueueOutbox {
  id: string
  key: string
  channelKind: string
  channelId: string
  threadId: string
  text: string
  now: string
  /** 最早可投递时间；缺省等于 `now`。静默时段的通知用它推迟到时段结束。 */
  nextAt?: string
  /** 用户消息 ID（不是话题根），用于回复后撤销回执表情。 */
  originMessageId?: string
  /** 结构化回复块；为空时只发 `text`。 */
  blocks?: ReplyBlock[]
}

/**
 * 事件总线的事件本体（一行一条，只追加）。
 *
 * 幂等键是 (source, external_id)：同一个来源的同一条外部事件只会进来一次。
 */
export interface EventRecord {
  id: string
  source: string
  type: string
  externalId: string
  lane: string
  subject: string
  summary: string
  detail?: string
  detailRef?: string
  link?: string
  actorId: string
  actorName: string
  actorType: string
  chatId?: string
  project?: string
  priorityHint: number
  costClass: string
  hops: number
  parentEventId?: string
  receivedAt: string
  deadlineAt?: string
}

/** 事件在队列里的状态投影：判定、延后、派发、审核都改这里。 */
export interface EventQueueRecord {
  eventId: string
  lane: string
  priority: number
  tier: string
  state: string
  reason?: string
  decidedBy?: string
  /** 延后到的时间点；空表示随时可取。 */
  notBefore?: string
  attempts: number
  leaseUntil?: string
  ticketId?: string
  createdAt: string
  updatedAt: string
}

/** 队列筛选条件。 */
export interface EventQueueFilter {
  state?: string
  tier?: string
  source?: string
  project?: string
  /** 关键字：在摘要与对象标识里做包含匹配。 */
  q?: string
  limit?: number
  offset?: number
}

/** 队列统计。 */
export interface EventQueueStats {
  total: number
  byState: Record<string, number>
  byTier: Record<string, number>
}

export interface EnqueueEffect {
  id: string
  key: string
  kind: string
  payload: Record<string, unknown>
  now: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version TEXT NOT NULL,
  body TEXT NOT NULL
);

-- 一次性数据迁移记录；迁移只由人手动执行，不在启动时自动写库。
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  channel_id TEXT,
  external_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_name TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  is_bot INTEGER NOT NULL,
  text TEXT NOT NULL,
  addressed TEXT NOT NULL,
  unaddressed_admitted INTEGER NOT NULL DEFAULT 0,
  media_only INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  disposition TEXT NOT NULL,
  decision_id TEXT,
  raw TEXT,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_triggers_pending ON triggers (disposition, received_at);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  channel_id TEXT,
  root_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 线程的外部标识别名：话题 ID（omt_）、根消息 ID（om_）、消息自身 ID 都指向同一个 Thread。
-- 飞书不同客户端入口给不全字段，靠这张表把同一话题的消息收敛到同一条线程。
CREATE TABLE IF NOT EXISTS thread_aliases (
  source TEXT NOT NULL,
  alias TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source, alias)
);
CREATE INDEX IF NOT EXISTS idx_thread_aliases_thread ON thread_aliases (thread_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  strength TEXT NOT NULL,
  reason TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  would_accept INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_thread ON decisions (thread_id, created_at);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  strength TEXT NOT NULL,
  scope TEXT NOT NULL,
  rules TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  source TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source TEXT NOT NULL,
  channel_id TEXT,
  chat_id TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  repo TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',
  request TEXT NOT NULL DEFAULT '',
  request_actor_name TEXT NOT NULL DEFAULT '',
  request_at TEXT NOT NULL DEFAULT '',
  pr_number INTEGER NOT NULL DEFAULT 0,
  pr_url TEXT NOT NULL DEFAULT '',
  pr_state TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_stage ON tickets (stage, created_at);

CREATE TABLE IF NOT EXISTS dispatch_drafts (
  chat_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  task TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, actor_id)
);

-- 需求识别（intake）：初筛后的疑似问题由分析引擎在这里沉淀多轮对话与结构化报告。
-- 只有管理员终审通过后才会走原有 Engine.decide() 生成正式工单。
CREATE TABLE IF NOT EXISTS intakes (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  actor_name   TEXT NOT NULL DEFAULT '',
  project      TEXT NOT NULL DEFAULT '',
  repo         TEXT NOT NULL DEFAULT '',
  branch       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  raw_text     TEXT NOT NULL,
  turns        TEXT NOT NULL DEFAULT '[]',
  report       TEXT,
  questions    INTEGER NOT NULL DEFAULT 0,
  ticket_id    TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intakes_thread ON intakes (thread_id, actor_id, status);
CREATE INDEX IF NOT EXISTS idx_intakes_status ON intakes (status, updated_at);

-- 会话复用：一个 session_key（群/话题 + 人）对应一个落盘的 Pi session。
-- 一个 key 会随着 /new 留下多行历史：active 是当前，superseded 等清理，purged 是已删文件。
CREATE TABLE IF NOT EXISTS chat_sessions (
  id             TEXT PRIMARY KEY,
  session_key    TEXT NOT NULL,
  chat_id        TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  thread_id      TEXT NOT NULL DEFAULT '',
  session_file   TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  soul_version   TEXT NOT NULL DEFAULT '',
  policy_version TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  last_used_at   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  reset_at       TEXT,
  reset_by       TEXT,
  purged_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_key ON chat_sessions (session_key, status);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_owner ON chat_sessions (chat_id, actor_id, status);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_status ON chat_sessions (status, reset_at);

CREATE TABLE IF NOT EXISTS chat_session_resets (
  id           TEXT PRIMARY KEY,
  session_key  TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  old_file     TEXT NOT NULL,
  new_file     TEXT NOT NULL,
  actor_name   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_session_resets_key ON chat_session_resets (session_key, created_at);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  workdir TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assignments_ticket ON assignments (ticket_id, started_at);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  state TEXT NOT NULL,
  summary TEXT NOT NULL,
  human_action TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  reply TEXT,
  deliverable TEXT,
  acked_inputs TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (assignment_id, turn, at)
);
CREATE INDEX IF NOT EXISTS idx_reports_ticket ON reports (ticket_id, at);

CREATE TABLE IF NOT EXISTS inputs (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  source_key TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  acked_at TEXT,
  UNIQUE (ticket_id, seq)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  thread_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  context_only INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, ticket_id)
);

CREATE TABLE IF NOT EXISTS attention (
  ticket_id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL,
  multi INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  answer TEXT,
  operator_id TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_questions_open ON questions (status, expires_at);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  channel_kind TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_error TEXT,
  origin_message_id TEXT,
  blocks TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (status, next_at);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT,
  reaction_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cursors (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS effects (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_effects_due ON effects (status, next_at);

-- 事件总线：事件本体（只追加）与队列状态（可重放的投影）。
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  subject TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  detail_ref TEXT,
  link TEXT,
  actor_id TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL DEFAULT 'external',
  chat_id TEXT,
  project TEXT,
  priority_hint INTEGER NOT NULL DEFAULT 0,
  cost_class TEXT NOT NULL DEFAULT 'cheap',
  hops INTEGER NOT NULL DEFAULT 0,
  parent_event_id TEXT,
  received_at TEXT NOT NULL,
  deadline_at TEXT,
  raw TEXT,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_events_received ON events (received_at);

CREATE TABLE IF NOT EXISTS event_queue (
  event_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 't3',
  state TEXT NOT NULL DEFAULT 'queued',
  reason TEXT,
  decided_by TEXT,
  not_before TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  ticket_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_queue_pick ON event_queue (state, priority DESC, not_before);
CREATE INDEX IF NOT EXISTS idx_event_queue_lane ON event_queue (lane, state);

-- 身份别名缓存：邮箱 / open_id 解析成 open_id 的结果。
-- 键里必须带 app_id：open_id 是「应用 × 用户」维度的，换个应用同一个人的 open_id 就变了，
-- 旧应用的缓存不能被新应用复用。
CREATE TABLE IF NOT EXISTS identity_aliases (
  app_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  open_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, kind, value)
);
`

type Row = Record<string, unknown>

/** SQLite 存储层。只负责读写，不做业务判断。 */
export class Store {
  /** 工单来源上下文缓存：群名与发起人不会变。 */
  private originCache = new Map<string, { chat: string; chatName: string; actor: string; actorName: string; actorType: 'user' | 'bot' } | null>()

  readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /** 旧库补列：SQLite 的 CREATE TABLE IF NOT EXISTS 不会加新列。 */
  private migrate(): void {
    // 历史列名 backend_id 一次性改名为 runtime_id；迁移后不再引用旧名。
    const assignmentColumns = this.db.prepare('PRAGMA table_info(assignments)').all() as Row[]
    if (assignmentColumns.some(column => column.name === 'backend_id')
      && !assignmentColumns.some(column => column.name === 'runtime_id')) {
      this.db.exec('ALTER TABLE assignments RENAME COLUMN backend_id TO runtime_id')
    }
    const columns = this.db.prepare('PRAGMA table_info(outbox)').all() as Row[]
    if (!columns.some(column => column.name === 'origin_message_id')) {
      this.db.exec('ALTER TABLE outbox ADD COLUMN origin_message_id TEXT')
    }
    // 结构化回复：卡片 / 图片 / PR 对比不能只靠一列 Markdown 表达。
    if (!columns.some(column => column.name === 'blocks')) {
      this.db.exec('ALTER TABLE outbox ADD COLUMN blocks TEXT')
    }
    const reportColumns = this.db.prepare('PRAGMA table_info(reports)').all() as Row[]
    if (!reportColumns.some(column => column.name === 'deliverable')) {
      this.db.exec('ALTER TABLE reports ADD COLUMN deliverable TEXT')
    }
    if (!reportColumns.some(column => column.name === 'reply')) {
      this.db.exec('ALTER TABLE reports ADD COLUMN reply TEXT')
    }
    const reactionColumns = this.db.prepare('PRAGMA table_info(reactions)').all() as Row[]
    if (!reactionColumns.some(column => column.name === 'channel_id')) {
      this.db.exec('ALTER TABLE reactions ADD COLUMN channel_id TEXT')
    }
    const triggerColumns = this.db.prepare('PRAGMA table_info(triggers)').all() as Row[]
    if (!triggerColumns.some(column => column.name === 'media_only')) {
      this.db.exec('ALTER TABLE triggers ADD COLUMN media_only INTEGER NOT NULL DEFAULT 0')
    }
    if (!triggerColumns.some(column => column.name === 'unaddressed_admitted')) {
      this.db.exec('ALTER TABLE triggers ADD COLUMN unaddressed_admitted INTEGER NOT NULL DEFAULT 0')
    }
    if (!triggerColumns.some(column => column.name === 'channel_id')) {
      this.db.exec('ALTER TABLE triggers ADD COLUMN channel_id TEXT')
    }
    const threadColumns = this.db.prepare('PRAGMA table_info(threads)').all() as Row[]
    if (!threadColumns.some(column => column.name === 'channel_id')) {
      this.db.exec('ALTER TABLE threads ADD COLUMN channel_id TEXT')
    }
    const ticketColumns = this.db.prepare('PRAGMA table_info(tickets)').all() as Row[]
    if (!ticketColumns.some(column => column.name === 'repo')) {
      this.db.exec("ALTER TABLE tickets ADD COLUMN repo TEXT NOT NULL DEFAULT ''")
    }
    if (!ticketColumns.some(column => column.name === 'branch')) {
      this.db.exec("ALTER TABLE tickets ADD COLUMN branch TEXT NOT NULL DEFAULT ''")
    }
    if (!ticketColumns.some(column => column.name === 'attachments')) {
      this.db.exec("ALTER TABLE tickets ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")
    }
    // 用户原始请求：派工时要把原话一起给 Worker，否则用户写下的口径会丢。
    if (!ticketColumns.some(column => column.name === 'request')) {
      this.db.exec("ALTER TABLE tickets ADD COLUMN request TEXT NOT NULL DEFAULT ''")
    }
    if (!ticketColumns.some(column => column.name === 'request_actor_name')) {
      this.db.exec("ALTER TABLE tickets ADD COLUMN request_actor_name TEXT NOT NULL DEFAULT ''")
    }
    if (!ticketColumns.some(column => column.name === 'request_at')) {
      this.db.exec("ALTER TABLE tickets ADD COLUMN request_at TEXT NOT NULL DEFAULT ''")
    }
    // 通道实例只在多通道时需要；历史飞书数据按 feishu 兜底，不回填避免写错别家实例。
    if (!ticketColumns.some(column => column.name === 'channel_id')) {
      this.db.exec('ALTER TABLE tickets ADD COLUMN channel_id TEXT')
    }
    const inputColumns = this.db.prepare('PRAGMA table_info(inputs)').all() as Row[]
    if (!inputColumns.some(column => column.name === 'source_key')) {
      this.db.exec('ALTER TABLE inputs ADD COLUMN source_key TEXT')
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inputs_source_key ON inputs (ticket_id, source_key)')
    // 派工草稿从「一个群一条」改成「一个群 + 一个人一条」：旧库需要重建主键。
    const draftColumns = this.db.prepare('PRAGMA table_info(dispatch_drafts)').all() as Row[]
    const actorPk = Number(draftColumns.find(column => column.name === 'actor_id')?.pk ?? 0)
    if (actorPk === 0) {
      this.db.exec(`
        ALTER TABLE dispatch_drafts RENAME TO dispatch_drafts_legacy;
        CREATE TABLE dispatch_drafts (
          chat_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          task TEXT NOT NULL,
          repo TEXT NOT NULL,
          branch TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (chat_id, actor_id)
        );
        INSERT OR REPLACE INTO dispatch_drafts (chat_id, actor_id, thread_id, task, repo, branch, updated_at)
          SELECT chat_id, actor_id, thread_id, task, repo, branch, updated_at FROM dispatch_drafts_legacy;
        DROP TABLE dispatch_drafts_legacy;
      `)
    }
    // chat_sessions 早期版本用 session_key 做主键；改成 id 以保留 /new 后的历史文件。
    const sessionColumns = this.db.prepare('PRAGMA table_info(chat_sessions)').all() as Row[]
    if (sessionColumns.length > 0 && !sessionColumns.some(column => column.name === 'id')) {
      this.db.exec(`
        ALTER TABLE chat_sessions RENAME TO chat_sessions_legacy;
        CREATE TABLE chat_sessions (
          id             TEXT PRIMARY KEY,
          session_key    TEXT NOT NULL,
          chat_id        TEXT NOT NULL,
          actor_id       TEXT NOT NULL,
          thread_id      TEXT NOT NULL DEFAULT '',
          session_file   TEXT NOT NULL,
          session_id     TEXT NOT NULL,
          soul_version   TEXT NOT NULL DEFAULT '',
          policy_version TEXT NOT NULL DEFAULT '',
          created_at     TEXT NOT NULL,
          last_used_at   TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'active',
          reset_at       TEXT,
          reset_by       TEXT,
          purged_at      TEXT
        );
        INSERT INTO chat_sessions
          (id, session_key, chat_id, actor_id, thread_id, session_file, session_id, soul_version, policy_version, created_at, last_used_at, status, reset_at, reset_by, purged_at)
          SELECT session_key || ':' || session_id, session_key, chat_id, actor_id, thread_id, session_file, session_id, soul_version, policy_version, created_at, last_used_at, status, reset_at, reset_by, purged_at
          FROM chat_sessions_legacy;
        DROP TABLE chat_sessions_legacy;
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_key ON chat_sessions (session_key, status);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_owner ON chat_sessions (chat_id, actor_id, status);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_status ON chat_sessions (status, reset_at);
      `)
    }
  }

  // ---------- 事件总线 ----------

  /** 落一条事件；幂等命中返回 false（不覆盖已有事件）。 */
  insertEvent(event: EventRecord): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO events
      (id, source, type, external_id, lane, subject, summary, detail, detail_ref, link, actor_id, actor_name, actor_type, chat_id, project, priority_hint, cost_class, hops, parent_event_id, received_at, deadline_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.source, event.type, event.externalId, event.lane, event.subject, event.summary,
        event.detail ?? null, event.detailRef ?? null, event.link ?? null, event.actorId, event.actorName, event.actorType,
        event.chatId ?? null, event.project ?? null, event.priorityHint, event.costClass, event.hops,
        event.parentEventId ?? null, event.receivedAt, event.deadlineAt ?? null)
    return Number(result.changes) > 0
  }

  getEvent(id: string): EventRecord | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined
    return row ? eventFromRow(row) : null
  }

  /** 按幂等三元组查事件：(source, externalId)。 */
  getEventByKey(source: string, externalId: string): EventRecord | null {
    const row = this.db.prepare('SELECT * FROM events WHERE source = ? AND external_id = ?').get(source, externalId) as Row | undefined
    return row ? eventFromRow(row) : null
  }

  /** 写入队列状态；同事件已存在时按 event_id 覆盖。 */
  insertEventQueue(entry: EventQueueRecord): void {
    this.db.prepare(`INSERT INTO event_queue
      (event_id, lane, priority, tier, state, reason, decided_by, not_before, attempts, lease_until, ticket_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        lane = excluded.lane, priority = excluded.priority, tier = excluded.tier, state = excluded.state,
        reason = excluded.reason, decided_by = excluded.decided_by, not_before = excluded.not_before,
        attempts = excluded.attempts, lease_until = excluded.lease_until, ticket_id = excluded.ticket_id,
        updated_at = excluded.updated_at`)
      .run(entry.eventId, entry.lane, entry.priority, entry.tier, entry.state, entry.reason ?? null,
        entry.decidedBy ?? null, entry.notBefore ?? null, entry.attempts, entry.leaseUntil ?? null,
        entry.ticketId ?? null, entry.createdAt, entry.updatedAt)
  }

  /** 更新队列状态；只覆盖传入的字段。 */
  updateEventQueue(eventId: string, patch: Partial<EventQueueRecord>): void {
    const current = this.getEventQueue(eventId)
    if (!current) return
    const next: EventQueueRecord = {
      ...current,
      ...patch,
      eventId,
      createdAt: current.createdAt,
      updatedAt: patch.updatedAt ?? current.updatedAt,
    }
    this.insertEventQueue(next)
  }

  getEventQueue(eventId: string): EventQueueRecord | null {
    const row = this.db.prepare('SELECT * FROM event_queue WHERE event_id = ?').get(eventId) as Row | undefined
    return row ? eventQueueFromRow(row) : null
  }

  /** 按条件列队列；支持按来源与项目过滤（需要 join events）。 */
  listEventQueue(filter: EventQueueFilter = {}): EventQueueRecord[] {
    const where: string[] = []
    const params: string[] = []
    if (filter.state) { where.push('q.state = ?'); params.push(filter.state) }
    if (filter.tier) { where.push('q.tier = ?'); params.push(filter.tier) }
    if (filter.source) { where.push('e.source = ?'); params.push(filter.source) }
    if (filter.project) { where.push('e.project = ?'); params.push(filter.project) }
    if (filter.q) {
      where.push('(e.summary LIKE ? OR e.subject LIKE ?)')
      params.push(`%${filter.q}%`, `%${filter.q}%`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 200
    const offset = filter.offset && filter.offset > 0 ? filter.offset : 0
    const rows = this.db.prepare(`SELECT q.* FROM event_queue q
      JOIN events e ON e.id = q.event_id
      ${clause}
      ORDER BY q.priority DESC, q.created_at ASC
      LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[]
    return rows.map(eventQueueFromRow)
  }

  /** 取到期可处理的队列项：优先级高的先来。 */
  pickEventQueue(now: string, limit = 10): EventQueueRecord[] {
    const rows = this.db.prepare(`SELECT * FROM event_queue
      WHERE state IN ('queued', 'ready')
        AND (not_before IS NULL OR not_before <= ?)
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY priority DESC, not_before ASC, created_at ASC
      LIMIT ?`).all(now, now, limit) as Row[]
    return rows.map(eventQueueFromRow)
  }

  /** 延后到点的事件自动回到可取状态；返回回队条数。 */
  requeueDueDeferred(now: string): number {
    const row = this.db.prepare(`UPDATE event_queue
      SET state = 'ready', not_before = NULL, updated_at = ?
      WHERE state = 'deferred' AND (not_before IS NULL OR not_before <= ?)`).run(now, now)
    return Number(row.changes ?? 0)
  }

  /** 等待处理的事件数：queued + ready + deferred。 */
  eventQueueDepth(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM event_queue WHERE state IN ('queued', 'ready', 'deferred')").get() as Row | undefined
    return Number(row?.n ?? 0)
  }

  /** 排队中（非延后）最低分的若干事件 id；背压超限时按它丢弃。 */
  lowestQueuedIds(limit: number): string[] {
    const rows = this.db.prepare(`SELECT event_id FROM event_queue
      WHERE state IN ('queued', 'ready')
      ORDER BY priority ASC, created_at ASC
      LIMIT ?`).all(limit) as Row[]
    return rows.map(row => String(row.event_id))
  }

  /** 该 lane 是否还有未完成（在飞）的工单；用于同 lane 串行。 */
  laneHasLiveTicket(lane: string, excludeEventId: string): boolean {
    const rows = this.db.prepare(`SELECT ticket_id FROM event_queue
      WHERE lane = ? AND state = 'dispatched' AND ticket_id IS NOT NULL AND event_id != ?`).all(lane, excludeEventId) as Row[]
    for (const row of rows) {
      const ticket = this.getTicket(String(row.ticket_id))
      if (ticket && ticket.stage !== 'done') return true
    }
    return false
  }

  /** 队列统计：总数 + 按状态 + 按档位。 */
  eventQueueStats(): EventQueueStats {
    const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM event_queue').get() as Row).n ?? 0)
    const byState: Record<string, number> = {}
    for (const row of this.db.prepare('SELECT state, COUNT(*) AS n FROM event_queue GROUP BY state').all() as Row[]) {
      byState[String(row.state)] = Number(row.n)
    }
    const byTier: Record<string, number> = {}
    for (const row of this.db.prepare('SELECT tier, COUNT(*) AS n FROM event_queue GROUP BY tier').all() as Row[]) {
      byTier[String(row.tier)] = Number(row.n)
    }
    return { total, byState, byTier }
  }

  /** 统计某个时刻之后进来的事件数；预算按天算时用它。 */
  countEventsSince(since: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE received_at >= ?').get(since) as Row | undefined
    return Number(row?.n ?? 0)
  }

  close(): void {
    this.db.close()
  }

  // ---------- 策略 ----------

  setPolicy(policy: Policy): void {
    this.db.prepare('INSERT INTO policy (id, version, body) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, body = excluded.body')
      .run(policy.version, JSON.stringify(policy))
  }

  getPolicy(): Policy | null {
    const row = this.db.prepare('SELECT body FROM policy WHERE id = 1').get() as Row | undefined
    return row ? (JSON.parse(String(row.body)) as Policy) : null
  }

  // ---------- Trigger ----------

  insertTrigger(t: Trigger): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO triggers
      (id, source, channel_id, external_id, thread_id, chat_id, chat_name, actor_id, actor_name, is_bot, text, addressed, unaddressed_admitted, media_only, received_at, disposition, decision_id, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.id, t.source, t.channelId ?? null, t.externalId, t.threadId, t.chatId, t.chatName, t.actorId, t.actorName, t.isBot ? 1 : 0,
        t.text, t.addressed, t.unaddressedAdmitted ? 1 : 0, t.mediaOnly ? 1 : 0, t.receivedAt, t.disposition, t.decisionId ?? null, t.raw === undefined ? null : JSON.stringify(t.raw))
    return Number(result.changes) > 0
  }

  getTrigger(id: string): Trigger | null {
    const row = this.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as Row | undefined
    return row ? triggerFromRow(row) : null
  }

  /** 按 (source, external_id) 找触发消息；事件派工幂等靠它复用已有触发。 */
  getTriggerByExternal(source: string, externalId: string): Trigger | null {
    const row = this.db.prepare('SELECT * FROM triggers WHERE source = ? AND external_id = ?').get(source, externalId) as Row | undefined
    return row ? triggerFromRow(row) : null
  }

  listTriggers(): Trigger[] {
    return (this.db.prepare('SELECT * FROM triggers ORDER BY received_at').all() as Row[]).map(triggerFromRow)
  }

  listPendingTriggers(olderThan: string): Trigger[] {
    return (this.db.prepare("SELECT * FROM triggers WHERE disposition = 'pending' AND received_at <= ? ORDER BY received_at").all(olderThan) as Row[]).map(triggerFromRow)
  }

  /**
   * 原子领取一批待研判的 Trigger：把 pending 改成 evaluating 再返回，
   * 避免重叠的 tick 重复研判同一条消息。
   */
  claimPendingTriggers(olderThan: string, limit = 50): Trigger[] {
    const rows = this.db.prepare("SELECT * FROM triggers WHERE disposition = 'pending' AND received_at <= ? ORDER BY received_at LIMIT ?")
      .all(olderThan, limit) as Row[]
    const claim = this.db.prepare("UPDATE triggers SET disposition = 'evaluating' WHERE id = ? AND disposition = 'pending'")
    const claimed: Trigger[] = []
    for (const row of rows) {
      if (Number(claim.run(String(row.id)).changes) > 0) claimed.push(triggerFromRow(row))
    }
    return claimed
  }

  /** 进程重启时把中断在 evaluating 的 Trigger 放回队列。 */
  resetEvaluating(): number {
    return Number(this.db.prepare("UPDATE triggers SET disposition = 'pending' WHERE disposition = 'evaluating'").run().changes)
  }

  listTriggersByThread(threadId: string, limit = 50): Trigger[] {
    return (this.db.prepare('SELECT * FROM triggers WHERE thread_id = ? ORDER BY received_at DESC LIMIT ?').all(threadId, limit) as Row[]).map(triggerFromRow)
  }

  setTriggerDisposition(id: string, disposition: TriggerDisposition, decisionId?: string): void {
    this.db.prepare('UPDATE triggers SET disposition = ?, decision_id = ? WHERE id = ?').run(disposition, decisionId ?? null, id)
  }

  upsertThread(thread: { id: string; source: SourceKind; channelId?: string; rootId: string; chatId: string; createdAt: string }): void {
    this.db.prepare('INSERT OR IGNORE INTO threads (id, source, channel_id, root_id, chat_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(thread.id, thread.source, thread.channelId ?? null, thread.rootId, thread.chatId, thread.createdAt)
  }

  // ---------- Thread alias ----------

  /** 登记一个外部标识到规范 Thread 的映射。先登记的优先，不覆盖已有映射。 */
  registerThreadAlias(input: { source: SourceKind; alias: string; threadId: string; createdAt: string }): void {
    const alias = input.alias.trim()
    if (!alias) return
    this.db.prepare('INSERT OR IGNORE INTO thread_aliases (source, alias, thread_id, created_at) VALUES (?, ?, ?, ?)')
      .run(input.source, alias, input.threadId, input.createdAt)
  }

  listThreadAliases(source: SourceKind, threadId: string): string[] {
    const rows = this.db
      .prepare('SELECT alias FROM thread_aliases WHERE source = ? AND thread_id = ? ORDER BY created_at, rowid')
      .all(source, threadId) as Row[]
    return rows.map(row => String(row.alias))
  }

  listThreads(source: SourceKind): Thread[] {
    const rows = this.db.prepare('SELECT * FROM threads WHERE source = ? ORDER BY created_at, rowid').all(source) as Row[]
    return rows.map(row => ({
      id: String(row.id),
      source: row.source as SourceKind,
      ...(row.channel_id ? { channelId: String(row.channel_id) } : {}),
      rootId: String(row.root_id),
      chatId: String(row.chat_id),
      createdAt: String(row.created_at),
    }))
  }

  /**
   * 别名回填清单：线程根还是消息 ID（om_）、并且还没登记话题 ID（omt_）别名的线程。
   * 这些线程需要回查一次话题 ID，否则「话题内直接回复」的消息依然匹配不上。
   */
  threadAliasBacklog(source: SourceKind): Thread[] {
    return this.listThreads(source).filter(thread => {
      if (thread.rootId.startsWith('omt_')) return false
      const aliases = this.listThreadAliases(source, thread.id)
      return !aliases.some(alias => alias.startsWith('omt_'))
    })
  }

  /**
   * 把一条消息携带的线程标识解析成规范 Thread ID。
   *
   * 命中已有别名就复用那条线程；否则以 canonicalId 建新线程，并把全部标识登记为别名。
   * 这样「话题 ID / 根消息 ID / 消息自身 ID」任意一个到场，都能落回同一个 Thread。
   */
  resolveThread(input: { source: SourceKind; channelId?: string; chatId: string; keys: string[]; canonicalId: string; createdAt: string }): { threadId: string; created: boolean } {
    const keys = [...new Set(input.keys.map(key => key.trim()).filter(Boolean))]
    // 按传入顺序逐个查：keys 的先后就是权威性顺序（话题 ID > 根消息 ID > 消息自身 ID）。
    // 不能用 ORDER BY created_at——历史误拆的线程会用自己的 message_id 当根，登记得更早，
    // 那样「话题内直发」的消息会被拉回那条孤立的旧线程。
    for (const key of keys) {
      const row = this.db
        .prepare('SELECT thread_id FROM thread_aliases WHERE source = ? AND alias = ?')
        .get(input.source, key) as Row | undefined
      if (row) return { threadId: String(row.thread_id), created: false }
    }
    this.upsertThread({
      id: input.canonicalId,
      source: input.source,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      rootId: keys[0] ?? input.canonicalId.split(':').at(-1) ?? input.canonicalId,
      chatId: input.chatId,
      createdAt: input.createdAt,
    })
    for (const alias of keys) {
      this.registerThreadAlias({ source: input.source, alias, threadId: input.canonicalId, createdAt: input.createdAt })
    }
    return { threadId: input.canonicalId, created: true }
  }

  /**
   * 只读：按外部标识反查规范 Thread ID；没有登记过别名时返回 null。
   *
   * 与 resolveThread 的区别：不创建线程、不写别名表，只做查询。
   */
  findThreadIdByAlias(source: SourceKind, alias: string): string | null {
    const key = alias.trim()
    if (!key) return null
    const row = this.db
      .prepare('SELECT thread_id FROM thread_aliases WHERE source = ? AND alias = ?')
      .get(source, key) as Row | undefined
    return row ? String(row.thread_id) : null
  }

  /**
   * 只读：这些线程标识里，是否有任意一个命中「在办工单」的订阅。
   *
   * 用于判断「这个话题是不是已绑定工单」：工单订阅的是规范 Thread ID，
   * 消息带的是话题 / 根消息 / 消息自身的标识，要靠别名表换算。
   * 已关闭（stage=done）的工单不算绑定。
   */
  hasLiveTicketForThreadKeys(source: SourceKind, keys: string[]): boolean {
    for (const key of keys) {
      const threadId = this.findThreadIdByAlias(source, key)
      if (!threadId) continue
      for (const sub of this.listSubscriptions(threadId)) {
        const ticket = this.getTicket(sub.ticketId)
        if (ticket && ticket.stage !== 'done') return true
      }
    }
    return false
  }

  // ---------- Decision ----------

  insertDecision(d: DecisionRecord): void {
    this.db.prepare(`INSERT INTO decisions (id, trigger_id, thread_id, decision, strength, reason, policy_version, would_accept, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(d.id, d.triggerId, d.threadId, d.decision, d.strength, d.reason, d.policyVersion, d.wouldAccept ? 1 : 0, d.createdAt)
  }

  getDecision(id: string): DecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Row | undefined
    if (!row) return null
    return {
      id: String(row.id),
      triggerId: String(row.trigger_id),
      threadId: String(row.thread_id),
      decision: row.decision as DecisionRecord['decision'],
      strength: row.strength as DecisionRecord['strength'],
      reason: String(row.reason),
      policyVersion: String(row.policy_version),
      wouldAccept: Number(row.would_accept) === 1,
      createdAt: String(row.created_at),
    }
  }

  // ---------- Ticket / Mandate ----------

  insertTicket(t: Ticket): void {
    this.db.prepare(`INSERT INTO tickets (id, title, thread_id, source, channel_id, chat_id, mandate_id, stage, repo, branch, attachments, request, request_actor_name, request_at, pr_number, pr_url, pr_state, created_at, updated_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.id, t.title, t.threadId, t.source, t.channelId ?? null, t.chatId, t.mandateId, t.stage, t.repo, t.branch, JSON.stringify(t.attachments ?? []), t.request ?? '', t.requestActorName ?? '', t.requestAt ?? '', t.prNumber, t.prUrl, t.prState, t.createdAt, t.updatedAt, t.closedAt ?? null)
  }

  updateTicket(t: Ticket): void {
    this.db.prepare(`UPDATE tickets SET title = ?, stage = ?, repo = ?, branch = ?, attachments = ?, pr_number = ?, pr_url = ?, pr_state = ?, updated_at = ?, closed_at = ? WHERE id = ?`)
      .run(t.title, t.stage, t.repo, t.branch, JSON.stringify(t.attachments ?? []), t.prNumber, t.prUrl, t.prState, t.updatedAt, t.closedAt ?? null, t.id)
  }

  getTicket(id: string): Ticket | null {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Row | undefined
    return row ? ticketFromRow(row) : null
  }

  listTickets(filter: { stage?: Stage; limit?: number } = {}): Ticket[] {
    const limit = filter.limit ?? 200
    if (filter.stage) {
      // 查询参数可能来自旧脚本 / 旧文档（如 --stage accepted），先归一化再加旧别名。
      const normalized = normalizeStage(filter.stage)
      const aliases = normalized ? stageAliases(normalized) : [String(filter.stage)]
      const placeholders = aliases.map(() => '?').join(', ')
      return (this.db.prepare(`SELECT * FROM tickets WHERE stage IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`).all(...aliases, limit) as Row[]).map(ticketFromRow)
    }
    return (this.db.prepare('SELECT * FROM tickets ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(ticketFromRow)
  }

  listOpenTickets(): Ticket[] {
    // 'closed' 是迁移前的旧终态值；读侧先兼容，避免部署后旧单被当成在办工单。
    return (this.db.prepare("SELECT * FROM tickets WHERE stage NOT IN ('done', 'closed') ORDER BY created_at").all() as Row[]).map(ticketFromRow)
  }

  // ---------- 派工草稿（多项目 / 多分支补齐） ----------

  saveDispatchDraft(draft: DispatchDraft): void {
    this.db.prepare(`INSERT INTO dispatch_drafts (chat_id, actor_id, thread_id, task, repo, branch, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, actor_id) DO UPDATE SET thread_id = excluded.thread_id,
        task = excluded.task, repo = excluded.repo, branch = excluded.branch, updated_at = excluded.updated_at`)
      .run(draft.chatId, draft.actorId, draft.threadId, draft.task, draft.repo, draft.branch, draft.updatedAt)
  }

  getDispatchDraft(chatId: string, actorId: string): DispatchDraft | null {
    const row = this.db.prepare('SELECT * FROM dispatch_drafts WHERE chat_id = ? AND actor_id = ?').get(chatId, actorId) as Row | undefined
    if (!row) return null
    return {
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      actorId: String(row.actor_id),
      task: String(row.task),
      repo: String(row.repo),
      branch: String(row.branch),
      updatedAt: String(row.updated_at),
    }
  }

  clearDispatchDraft(chatId: string, actorId: string): void {
    this.db.prepare('DELETE FROM dispatch_drafts WHERE chat_id = ? AND actor_id = ?').run(chatId, actorId)
  }

  // ---------- 需求识别（intake） ----------

  insertIntake(intake: Intake): void {
    this.db.prepare(`INSERT INTO intakes (id, thread_id, chat_id, actor_id, actor_name, project, repo, branch, status, kind, raw_text, turns, report, questions, ticket_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        intake.id,
        intake.threadId,
        intake.chatId,
        intake.actorId,
        intake.actorName,
        intake.project,
        intake.repo,
        intake.branch,
        intake.status,
        intake.kind,
        intake.rawText,
        JSON.stringify(intake.turns),
        intake.report ? JSON.stringify(intake.report) : null,
        intake.questions,
        intake.ticketId ?? null,
        intake.createdAt,
        intake.updatedAt,
      )
  }

  updateIntake(intake: Intake): void {
    this.db.prepare(`UPDATE intakes SET project = ?, repo = ?, branch = ?, status = ?, kind = ?, raw_text = ?, turns = ?, report = ?, questions = ?, ticket_id = ?, updated_at = ? WHERE id = ?`)
      .run(
        intake.project,
        intake.repo,
        intake.branch,
        intake.status,
        intake.kind,
        intake.rawText,
        JSON.stringify(intake.turns),
        intake.report ? JSON.stringify(intake.report) : null,
        intake.questions,
        intake.ticketId ?? null,
        intake.updatedAt,
        intake.id,
      )
  }

  getIntake(id: string): Intake | null {
    const row = this.db.prepare('SELECT * FROM intakes WHERE id = ?').get(id) as Row | undefined
    return row ? intakeFromRow(row) : null
  }

  /** 列 intake；按状态筛选（统一待审核列表要用）。 */
  listIntakes(filter: { status?: string; limit?: number } = {}): Intake[] {
    const where: string[] = []
    const params: string[] = []
    if (filter.status) { where.push('status = ?'); params.push(filter.status) }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 200
    const rows = this.db.prepare(`SELECT * FROM intakes ${clause} ORDER BY updated_at DESC LIMIT ?`).all(...params, String(limit)) as Row[]
    return rows.map(intakeFromRow)
  }

  /** 找一条仍在进行（clarifying / ready）的 intake：同群 + 同人 + 同话题只允许一条。 */
  activeIntake(threadId: string, actorId: string): Intake | null {
    const row = this.db.prepare("SELECT * FROM intakes WHERE thread_id = ? AND actor_id = ? AND status IN ('clarifying', 'ready') ORDER BY updated_at DESC LIMIT 1")
      .get(threadId, actorId) as Row | undefined
    return row ? intakeFromRow(row) : null
  }

  /** 按群 + 人查最近一条 intake，不限制状态；用于「管理员终审通过后查原单」。 */
  latestIntakeByThread(threadId: string, actorId?: string): Intake | null {
    const row = actorId
      ? this.db.prepare('SELECT * FROM intakes WHERE thread_id = ? AND actor_id = ? ORDER BY updated_at DESC LIMIT 1').get(threadId, actorId) as Row | undefined
      : this.db.prepare('SELECT * FROM intakes WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1').get(threadId) as Row | undefined
    return row ? intakeFromRow(row) : null
  }

  /** 按话题取待终审（ready）的那条 intake；没有就返回 null。 */
  readyIntakeByThread(threadId: string): Intake | null {
    const row = this.db.prepare("SELECT * FROM intakes WHERE thread_id = ? AND status = 'ready' ORDER BY updated_at DESC LIMIT 1")
      .get(threadId) as Row | undefined
    return row ? intakeFromRow(row) : null
  }

  /**
   * 按需求单号反查已生成的工单。
   *
   * 终审流程里「建工单」和「回写需求单」是两步，中间崩溃会留下已建单但没回写的需求单；
   * 重试时按需求单号找到那张工单并复用，避免建出第二张重复工单。
   */
  ticketByIntakeRef(intakeId: string): Ticket | null {
    const marker = `需求单：${intakeId}`
    for (const ticket of this.listTickets()) {
      const mandate = this.getMandate(ticket.mandateId)
      if (mandate?.scope.includes(marker)) return ticket
    }
    return null
  }

  /** 按工单号反查 intake：终审通过后用于把工单与原需求单关联。 */
  intakeByTicket(ticketId: string): Intake | null {
    const row = this.db.prepare('SELECT * FROM intakes WHERE ticket_id = ? ORDER BY updated_at DESC LIMIT 1').get(ticketId) as Row | undefined
    return row ? intakeFromRow(row) : null
  }

  // ---------- 会话 key 迁移（只由 ra migrate sessions 手动触发） ----------

  /** 迁移记录 ID；与 scripts/migrations 下的 SQL 文件保持一致。 */
  static readonly SESSION_KEY_MIGRATION_ID = SESSION_KEY_MIGRATION_ID

  hasSessionKeyMigration(): boolean {
    const row = this.db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(SESSION_KEY_MIGRATION_ID) as Row | undefined
    return Boolean(row)
  }

  /** 启动检测：存在旧格式 key 且迁移未执行时，返回待迁移数量。 */
  legacySessionKeyCount(): number {
    return this.countWhere('chat_sessions', "session_key LIKE 'chat:%' AND session_key NOT LIKE 'channel:%'")
  }

  /** dry-run 用的只读快照。 */
  sessionMigrationState(): SessionMigrationState {
    const anomalies: SessionMigrationState['anomalies'] = []
    for (const table of ['chat_sessions', 'chat_session_resets'] as const) {
      const rows = this.db.prepare(
        `SELECT id, session_key FROM ${table}
         WHERE session_key NOT LIKE 'chat:%' AND session_key NOT LIKE 'channel:%'
         ORDER BY created_at LIMIT 50`,
      ).all() as Row[]
      for (const row of rows) {
        anomalies.push({ table, id: String(row.id), sessionKey: String(row.session_key) })
      }
    }
    return {
      totalSessions: this.countWhere('chat_sessions'),
      totalResets: this.countWhere('chat_session_resets'),
      pendingSessions: this.legacySessionKeyCount(),
      pendingResets: this.countWhere('chat_session_resets', "session_key LIKE 'chat:%' AND session_key NOT LIKE 'channel:%'"),
      migratedSessions: this.countWhere('chat_sessions', "session_key LIKE 'channel:%'"),
      anomalies,
      applied: this.hasSessionKeyMigration(),
    }
  }

  /**
   * 执行迁移：只给 `session_key LIKE 'chat:%'` 的行加 `channel:feishu:` 前缀。
   *
   * - 幂等：已有迁移记录直接返回 skipped；
   * - 事务：任一步失败整体回滚；
   * - 异常 key 不动，交由人确认。
   */
  applySessionKeyMigration(now: string): SessionMigrationResult {
    if (this.hasSessionKeyMigration()) return { sessions: 0, resets: 0, skipped: true }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const sessions = this.db.prepare(
        `UPDATE chat_sessions
         SET id = 'channel:feishu:' || id,
             session_key = 'channel:feishu:' || session_key
         WHERE session_key LIKE 'chat:%' AND session_key NOT LIKE 'channel:%'`,
      ).run()
      const resets = this.db.prepare(
        `UPDATE chat_session_resets
         SET id = 'channel:feishu:' || id,
             session_key = 'channel:feishu:' || session_key
         WHERE session_key LIKE 'chat:%' AND session_key NOT LIKE 'channel:%'`,
      ).run()
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(SESSION_KEY_MIGRATION_ID, now)
      this.db.exec('COMMIT')
      return { sessions: Number(sessions.changes), resets: Number(resets.changes), skipped: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 迁移后校验；只读。 */
  verifySessionKeyMigration(): SessionMigrationVerifyResult {
    const state = this.sessionMigrationState()
    return {
      ok: state.pendingSessions === 0 && state.pendingResets === 0 && state.anomalies.length === 0,
      applied: state.applied,
      totalSessions: state.totalSessions,
      pendingSessions: state.pendingSessions,
      pendingResets: state.pendingResets,
      anomalies: state.anomalies.length,
    }
  }

  private countWhere(table: 'chat_sessions' | 'chat_session_resets', where = '1 = 1'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as Row | undefined
    return Number(row?.n ?? 0)
  }

  // ---------- 会话复用（chat + 人） ----------

  getChatSession(sessionKey: string): ChatSessionRecord | null {
    const row = this.db.prepare("SELECT * FROM chat_sessions WHERE session_key = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get(sessionKey) as Row | undefined
    return row ? chatSessionFromRow(row) : null
  }

  getChatSessionByFile(sessionFile: string): ChatSessionRecord | null {
    const row = this.db.prepare('SELECT * FROM chat_sessions WHERE session_file = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionFile) as Row | undefined
    return row ? chatSessionFromRow(row) : null
  }

  upsertChatSession(record: ChatSessionRecord): void {
    const id = `${record.sessionKey}:${record.sessionId || record.sessionFile}`
    this.db.prepare(`INSERT INTO chat_sessions
      (id, session_key, chat_id, actor_id, thread_id, session_file, session_id, soul_version, policy_version, created_at, last_used_at, status, reset_at, reset_by, purged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_file = excluded.session_file,
        session_id = excluded.session_id,
        soul_version = excluded.soul_version,
        policy_version = excluded.policy_version,
        last_used_at = excluded.last_used_at,
        status = excluded.status,
        reset_at = excluded.reset_at,
        reset_by = excluded.reset_by,
        purged_at = excluded.purged_at`)
      .run(
        id, record.sessionKey, record.chatId, record.actorId, record.threadId, record.sessionFile, record.sessionId,
        record.soulVersion, record.policyVersion, record.createdAt, record.lastUsedAt, record.status,
        record.resetAt, record.resetBy, record.purgedAt,
      )
  }

  touchChatSession(sessionKey: string, at: string): void {
    this.db.prepare("UPDATE chat_sessions SET last_used_at = ? WHERE session_key = ? AND status = 'active'").run(at, sessionKey)
  }

  markChatSessionSuperseded(sessionKey: string, at: string, by: string): void {
    this.db.prepare("UPDATE chat_sessions SET status = 'superseded', reset_at = ?, reset_by = ? WHERE session_key = ? AND status = 'active'")
      .run(at, by, sessionKey)
  }

  listSupersededChatSessions(before: string): ChatSessionRecord[] {
    return (this.db.prepare("SELECT * FROM chat_sessions WHERE status = 'superseded' AND reset_at IS NOT NULL AND reset_at <= ? ORDER BY reset_at")
      .all(before) as Row[]).map(chatSessionFromRow)
  }

  markChatSessionPurged(sessionFile: string, at: string): void {
    this.db.prepare("UPDATE chat_sessions SET status = 'purged', purged_at = ? WHERE session_file = ? AND status = 'superseded'")
      .run(at, sessionFile)
  }

  insertChatSessionReset(reset: ChatSessionResetRecord): void {
    this.db.prepare(`INSERT OR IGNORE INTO chat_session_resets (id, session_key, chat_id, actor_id, old_file, new_file, actor_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reset.id, reset.sessionKey, reset.chatId, reset.actorId, reset.oldFile, reset.newFile, reset.actorName, reset.createdAt)
  }

  insertMandate(m: Mandate): void {
    this.db.prepare(`INSERT INTO mandates (id, ticket_id, policy_version, strength, scope, rules, actor_id, actor_name, source, chat_id, thread_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.id, m.ticketId, m.policyVersion, m.strength, m.scope, JSON.stringify(m.rules), m.actorId, m.actorName, m.source, m.chatId, m.threadId, m.createdAt)
  }

  getMandate(id: string): Mandate | null {
    const row = this.db.prepare('SELECT * FROM mandates WHERE id = ?').get(id) as Row | undefined
    if (!row) return null
    return {
      id: String(row.id),
      ticketId: String(row.ticket_id),
      policyVersion: String(row.policy_version),
      strength: row.strength as Mandate['strength'],
      scope: String(row.scope),
      rules: JSON.parse(String(row.rules)) as string[],
      actorId: String(row.actor_id),
      actorName: String(row.actor_name),
      source: row.source as SourceKind,
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      createdAt: String(row.created_at),
    }
  }

  /**
   * 工单来源的上下文：群、群名、发起人、发起人类型。
   *
   * 工单表里只有 chat_id，群名与「是用户还是机器人」都在来源消息上；
   * 工单日志要能回答「这是哪个群、谁提的需求」，只能从这里回捞。
   */
  ticketOrigin(ticketId: string): {
    chat: string
    chatName: string
    actor: string
    actorName: string
    actorType: 'user' | 'bot'
  } | null {
    // 群与发起人不会变，查一次就缓存住；日志写得勤，不该每行都回查库。
    const cached = this.originCache.get(ticketId)
    if (cached !== undefined) return cached
    const origin = this.readTicketOrigin(ticketId)
    if (this.originCache.size > 500) this.originCache.clear()
    this.originCache.set(ticketId, origin)
    return origin
  }

  private readTicketOrigin(ticketId: string): {
    chat: string
    chatName: string
    actor: string
    actorName: string
    actorType: 'user' | 'bot'
  } | null {
    const ticket = this.getTicket(ticketId)
    if (!ticket) return null
    const mandate = this.getMandate(ticket.mandateId)
    const source = this.db
      .prepare('SELECT chat_id, chat_name, actor_id, actor_name, is_bot FROM triggers WHERE thread_id = ? ORDER BY received_at ASC LIMIT 1')
      .get(ticket.threadId) as Row | undefined
    const chat = mandate?.chatId || ticket.chatId || String(source?.chat_id ?? '')
    return {
      chat,
      chatName: String(source?.chat_name ?? ''),
      // 授权人优先：工单可能由管理员指派给别人，那个人才是这条链路的负责人。
      actor: mandate?.actorId || String(source?.actor_id ?? ''),
      actorName: mandate?.actorName || String(source?.actor_name ?? ''),
      actorType: source?.is_bot ? 'bot' : 'user',
    }
  }

  /**
   * 工单日志上下文：群、群名、发起人、发起人类型、运行时。
   *
   * 日志行要能直接回答「哪个群、谁提的、哪个运行时在动」，
   * 所以这里把工单能查到的维度一次性拼齐。
   */
  ticketLogContext(ticketId: string): Record<string, unknown> {
    const origin = this.ticketOrigin(ticketId)
    const runtime = this.latestAssignment(ticketId)?.runtimeId ?? ''
    return {
      ...(origin?.chat ? { chat: origin.chat } : {}),
      ...(origin?.chatName ? { chatName: origin.chatName } : {}),
      ...(origin?.actor ? { actor: origin.actor } : {}),
      ...(origin?.actorName ? { actorName: origin.actorName } : {}),
      ...(origin?.actorType ? { actorType: origin.actorType } : {}),
      ...(runtime ? { runtime } : {}),
    }
  }

  // ---------- Assignment / Report / Input ----------

  insertAssignment(a: Assignment): void {
    this.db.prepare(`INSERT INTO assignments (id, ticket_id, runtime_id, handle, workdir, status, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, a.ticketId, a.runtimeId, a.handle, a.workdir, a.status, a.startedAt, a.endedAt ?? null)
  }

  updateAssignment(a: Assignment): void {
    this.db.prepare('UPDATE assignments SET handle = ?, workdir = ?, status = ?, ended_at = ? WHERE id = ?')
      .run(a.handle, a.workdir, a.status, a.endedAt ?? null, a.id)
  }

  getAssignment(id: string): Assignment | null {
    const row = this.db.prepare('SELECT * FROM assignments WHERE id = ?').get(id) as Row | undefined
    return row ? assignmentFromRow(row) : null
  }

  latestAssignment(ticketId: string): Assignment | null {
    const row = this.db.prepare('SELECT * FROM assignments WHERE ticket_id = ? ORDER BY started_at DESC LIMIT 1').get(ticketId) as Row | undefined
    return row ? assignmentFromRow(row) : null
  }

  /** 面板批量清理工作区用：按派工时间倒序列出全部 Assignment（每个工单可能有多条历史）。 */
  listAssignments(limit = 5_000): Assignment[] {
    const rows = this.db.prepare('SELECT * FROM assignments ORDER BY started_at DESC LIMIT ?').all(limit) as Row[]
    return rows.map(assignmentFromRow)
  }

  insertReport(r: Report): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO reports (id, ticket_id, assignment_id, turn, state, summary, human_action, pr_number, pr_url, reply, acked_inputs, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.ticketId, r.assignmentId, r.turn, r.state, r.summary, r.humanAction ?? null, r.prNumber ?? null, r.prUrl ?? null, r.reply ?? null, JSON.stringify(r.ackedInputs), r.at)
    return Number(result.changes) > 0
  }

  latestReport(ticketId: string): Report | null {
    const row = this.db.prepare('SELECT * FROM reports WHERE ticket_id = ? ORDER BY at DESC, turn DESC LIMIT 1').get(ticketId) as Row | undefined
    return row ? reportFromRow(row) : null
  }

  listReports(ticketId: string, limit = 50): Report[] {
    return (this.db.prepare('SELECT * FROM reports WHERE ticket_id = ? ORDER BY at DESC, turn DESC LIMIT ?').all(ticketId, limit) as Row[]).map(reportFromRow)
  }

  /**
   * 按入库顺序取某条报告之后的报告，供进展轮询做增量同步。
   * afterId 为空或已不存在时返回该工单的全部报告（配合 '@start' 基线使用）。
   */
  listReportsAfter(ticketId: string, afterId: string): Report[] {
    const marker = afterId
      ? (this.db.prepare('SELECT rowid FROM reports WHERE id = ?').get(afterId) as Row | undefined)
      : undefined
    const after = marker ? Number(marker.rowid) : 0
    return (this.db.prepare('SELECT * FROM reports WHERE ticket_id = ? AND rowid > ? ORDER BY rowid').all(ticketId, after) as Row[]).map(reportFromRow)
  }

  insertInput(i: Input): void {
    this.db.prepare(`INSERT OR IGNORE INTO inputs (id, ticket_id, assignment_id, seq, kind, text, source_key, status, created_at, delivered_at, acked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(i.id, i.ticketId, i.assignmentId, i.seq, i.kind, i.text, i.sourceKey ?? null, i.status, i.createdAt, i.deliveredAt ?? null, i.ackedAt ?? null)
  }

  updateInput(i: Input): void {
    this.db.prepare('UPDATE inputs SET status = ?, delivered_at = ?, acked_at = ? WHERE id = ?')
      .run(i.status, i.deliveredAt ?? null, i.ackedAt ?? null, i.id)
  }

  listInputs(ticketId: string): Input[] {
    return (this.db.prepare('SELECT * FROM inputs WHERE ticket_id = ? ORDER BY seq').all(ticketId) as Row[]).map(inputFromRow)
  }

  /** 按来源标识找已入库的输入；用于「同一条外部消息只入库一次」。 */
  findInputBySourceKey(ticketId: string, sourceKey: string): Input | null {
    const row = this.db.prepare('SELECT * FROM inputs WHERE ticket_id = ? AND source_key = ? ORDER BY seq LIMIT 1')
      .get(ticketId, sourceKey) as Row | undefined
    return row ? inputFromRow(row) : null
  }

  /** 按 id 取输入；用来确认刚插入的行是否真的落库。 */
  getInput(id: string): Input | null {
    const row = this.db.prepare('SELECT * FROM inputs WHERE id = ?').get(id) as Row | undefined
    return row ? inputFromRow(row) : null
  }

  /** 最近一段时间内内容相同的输入；用于跨来源（飞书 / 面板）去重。 */
  findRecentInputByText(ticketId: string, kind: Input['kind'], text: string, since: string): Input | null {
    const row = this.db.prepare(
      "SELECT * FROM inputs WHERE ticket_id = ? AND kind = ? AND text = ? AND created_at >= ? AND status IN ('pending','delivered') ORDER BY seq LIMIT 1",
    ).get(ticketId, kind, text, since) as Row | undefined
    return row ? inputFromRow(row) : null
  }

  pendingInputs(ticketId: string): Input[] {
    return (this.db.prepare("SELECT * FROM inputs WHERE ticket_id = ? AND status = 'pending' ORDER BY seq").all(ticketId) as Row[]).map(inputFromRow)
  }

  /** 已投递但 worker 还没 ack 的输入，用于下次唤醒时重投。 */
  unackedInputs(ticketId: string): Input[] {
    return (this.db.prepare("SELECT * FROM inputs WHERE ticket_id = ? AND status = 'delivered' ORDER BY seq").all(ticketId) as Row[]).map(inputFromRow)
  }

  nextInputSeq(ticketId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM inputs WHERE ticket_id = ?').get(ticketId) as Row
    return Number(row.m) + 1
  }

  /**
   * 按输入 id 标记已 ack。
   *
   * 刻意不限定 assignment_id：worker 丢失后 Router 会换一个新的派工接着投递，
   * 而输入是在旧派工下创建的。带上 assignment_id 会让新 worker 的 ack 匹配 0 行，
   * 输入永远停在 delivered，Router 于是无限重投（tk-51）。
   * 返回真正从「未 ack」变成「已 ack」的 id，供调用方清理重投计数。
   */
  ackInputs(ticketId: string, ids: string[], at: string): string[] {
    if (ids.length === 0) return []
    const update = this.db.prepare("UPDATE inputs SET status = 'acked', acked_at = ? WHERE id = ? AND ticket_id = ? AND status != 'acked'")
    const acked: string[] = []
    for (const id of ids) {
      if (Number(update.run(at, id, ticketId).changes) > 0) acked.push(id)
    }
    return acked
  }

  /** 把工单上尚未绑定派工的输入挂到新派工上。 */
  rebindInputs(ticketId: string, assignmentId: string): void {
    this.db.prepare("UPDATE inputs SET assignment_id = ? WHERE ticket_id = ? AND assignment_id = ''").run(assignmentId, ticketId)
  }

  /**
   * 标记这批输入已投递。
   *
   * 只标记真正送出去的那些：没送出的输入不能算送达，否则它会被当成「已投递等 ack」，
   * 既不会再重投，也查不出到底有没有送到 worker 终端。
   */
  markInputsDelivered(ticketId: string, ids: string[], at: string): void {
    if (ids.length === 0) return
    const update = this.db.prepare("UPDATE inputs SET status = 'delivered', delivered_at = ? WHERE id = ? AND ticket_id = ? AND status = 'pending'")
    for (const id of ids) update.run(at, id, ticketId)
  }

  /** 重投到上限仍未送达：标成 expired，不再重投，也不代表用户请求已被完成。 */
  expireInput(ticketId: string, id: string): number {
    return Number(this.db.prepare("UPDATE inputs SET status = 'expired' WHERE id = ? AND ticket_id = ? AND status = 'pending'").run(id, ticketId).changes)
  }

  /**
   * worker 在 ack 之前就丢了：把已投递未确认的输入标记为 expired。
   * 这些输入确实进过旧终端，但任务没完成；保留记录供审计，不再参与重投与派工判断。
   */
  expireUnackedInputs(ticketId: string): number {
    return Number(this.db.prepare("UPDATE inputs SET status = 'expired' WHERE ticket_id = ? AND status = 'delivered'").run(ticketId).changes)
  }

  // ---------- Subscription ----------

  subscribe(s: Subscription): void {
    this.db.prepare('INSERT OR IGNORE INTO subscriptions (thread_id, ticket_id, context_only, created_at) VALUES (?, ?, ?, ?)')
      .run(s.threadId, s.ticketId, s.contextOnly ? 1 : 0, s.createdAt)
  }

  unsubscribe(threadId: string, ticketId: string): void {
    this.db.prepare('DELETE FROM subscriptions WHERE thread_id = ? AND ticket_id = ?').run(threadId, ticketId)
  }

  listSubscriptions(threadId: string): Subscription[] {
    return (this.db.prepare('SELECT * FROM subscriptions WHERE thread_id = ? ORDER BY created_at').all(threadId) as Row[]).map(row => ({
      threadId: String(row.thread_id),
      ticketId: String(row.ticket_id),
      contextOnly: Number(row.context_only) === 1,
      createdAt: String(row.created_at),
    }))
  }

  ticketSubscriptions(ticketId: string): Subscription[] {
    return (this.db.prepare('SELECT * FROM subscriptions WHERE ticket_id = ? ORDER BY created_at').all(ticketId) as Row[]).map(row => ({
      threadId: String(row.thread_id),
      ticketId: String(row.ticket_id),
      contextOnly: Number(row.context_only) === 1,
      createdAt: String(row.created_at),
    }))
  }

  // ---------- Attention ----------

  setAttention(ticketId: string, question: string, at: string): void {
    this.db.prepare('INSERT INTO attention (ticket_id, question, created_at) VALUES (?, ?, ?) ON CONFLICT(ticket_id) DO UPDATE SET question = excluded.question, created_at = excluded.created_at')
      .run(ticketId, question, at)
  }

  clearAttention(ticketId: string): void {
    this.db.prepare('DELETE FROM attention WHERE ticket_id = ?').run(ticketId)
  }

  getAttention(ticketId: string): { question: string; createdAt: string } | null {
    const row = this.db.prepare('SELECT * FROM attention WHERE ticket_id = ?').get(ticketId) as Row | undefined
    return row ? { question: String(row.question), createdAt: String(row.created_at) } : null
  }

  // ---------- Questions（Worker --ask 的选择题） ----------

  upsertQuestion(q: Question): void {
    this.db.prepare(`INSERT INTO questions (id, ticket_id, assignment_id, chat_id, thread_id, turn, prompt, options, multi, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        prompt = excluded.prompt,
        options = excluded.options,
        multi = excluded.multi,
        chat_id = excluded.chat_id,
        thread_id = excluded.thread_id,
        expires_at = excluded.expires_at`).run(
      q.id, q.ticketId, q.assignmentId, q.chatId, q.threadId, q.turn, q.prompt,
      JSON.stringify(q.options), q.multi ? 1 : 0, q.createdAt, q.expiresAt,
    )
  }

  getQuestion(id: string): Question | null {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Row | undefined
    return row ? questionFromRow(row) : null
  }

  /** 只有 open 的题能被作答；重复点击返回 false，由调用方幂等处理。 */
  answerQuestion(id: string, answer: string, operatorId: string, at: string): boolean {
    const result = this.db.prepare("UPDATE questions SET status = 'answered', answer = ?, operator_id = ?, answered_at = ? WHERE id = ? AND status = 'open'")
      .run(answer, operatorId, at, id)
    return Number(result.changes) > 0
  }

  setQuestionMessage(id: string, messageId: string): void {
    this.db.prepare('UPDATE questions SET message_id = ? WHERE id = ?').run(messageId, id)
  }

  expireQuestion(id: string, at: string): boolean {
    const result = this.db.prepare("UPDATE questions SET status = 'expired', answered_at = ? WHERE id = ? AND status = 'open'").run(at, id)
    return Number(result.changes) > 0
  }

  /** 到期未答：标记 expired，返回本轮到期的题，供调用方发一次提醒。 */
  expireQuestions(before: string, at: string): Question[] {
    const rows = this.db.prepare("SELECT * FROM questions WHERE status = 'open' AND expires_at <= ?").all(before) as Row[]
    if (rows.length === 0) return []
    const stmt = this.db.prepare("UPDATE questions SET status = 'expired', answered_at = ? WHERE id = ? AND status = 'open'")
    for (const row of rows) stmt.run(at, String(row.id))
    return rows.map(row => ({ ...questionFromRow(row), status: 'expired' as const, answeredAt: at }))
  }

  // ---------- Outbox ----------

  enqueueOutbox(item: EnqueueOutbox): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO outbox (id, key, channel_kind, channel_id, thread_id, text, blocks, status, attempts, next_at, created_at, origin_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
      .run(item.id, item.key, item.channelKind, item.channelId, item.threadId, item.text, item.blocks ? JSON.stringify(item.blocks) : null, item.nextAt ?? item.now, item.now, item.originMessageId ?? null)
    return Number(result.changes) > 0
  }

  // ---------- 回执表情 ----------

  saveReaction(messageId: string, reactionId: string, at: string, channelId?: string): void {
    this.db.prepare('INSERT INTO reactions (message_id, channel_id, reaction_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET channel_id = excluded.channel_id, reaction_id = excluded.reaction_id')
      .run(messageId, channelId ?? null, reactionId, at)
  }

  getReaction(messageId: string): { messageId: string; reactionId: string } | null {
    const row = this.db.prepare('SELECT * FROM reactions WHERE message_id = ?').get(messageId) as Row | undefined
    return row ? { messageId: String(row.message_id), reactionId: String(row.reaction_id) } : null
  }

  getReactionChannel(messageId: string): string | null {
    const row = this.db.prepare('SELECT channel_id FROM reactions WHERE message_id = ?').get(messageId) as Row | undefined
    return row?.channel_id ? String(row.channel_id) : null
  }

  clearReaction(messageId: string): void {
    this.db.prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId)
  }

  // ---------- 游标（增量补拉） ----------

  getCursor(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM cursors WHERE key = ?').get(key) as Row | undefined
    return row ? String(row.value) : null
  }

  setCursor(key: string, value: string, at: string): void {
    this.db.prepare('INSERT INTO cursors (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, value, at)
  }

  deleteCursor(key: string): void {
    this.db.prepare('DELETE FROM cursors WHERE key = ?').run(key)
  }

  // ---------- workspace 回收标记 ----------

  /** 记下「这张工单的 workspace 已被回收」，用于关单后的话题提示。 */
  markWorkspaceRemoved(ticketId: string, at: string): void {
    this.setCursor(`workspace:removed:${ticketId}`, at, at)
  }

  /** workspace 是否已经被回收（目录已删）。 */
  isWorkspaceRemoved(ticketId: string): boolean {
    return this.getCursor(`workspace:removed:${ticketId}`) !== null
  }

  // ---------- 自增计数器 ----------

  /** 原子自增并返回新值；进程重启后从上次的值继续。 */
  nextCounter(key: string): number {
    const row = this.db.prepare('INSERT INTO counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = counters.value + 1 RETURNING value')
      .get(key) as Row
    return Number(row.value)
  }

  /** 工单编号：全局自增，重启后不回退。 */
  nextTicketSeq(): number {
    return this.nextCounter('ticket')
  }

  /**
   * 修复历史脏数据：旧版本可能把内部 id（feishu_om_…）当成话题 id 写进 Outbox，
   * 这些消息永远发不出去，启动时直接标记为已处理。
   */
  repairOutbox(): number {
    return Number(this.db.prepare("UPDATE outbox SET status = 'sent', last_error = 'repaired:invalid-thread-id' WHERE status = 'pending' AND thread_id != '' AND thread_id NOT LIKE 'om_%'").run().changes)
  }

  /** 只读列出最近的外发消息，用于模拟与排障。 */
  listOutbox(limit = 50): OutboxItem[] {
    return (this.db.prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?').all(limit) as Row[])
      .map(row => outboxFromRow(row, 0))
  }

  /** 按幂等 key 查外发状态：用于「提醒真的发出去了才自动关单」这类前置判断。 */
  getOutboxStatus(key: string): string | null {
    const row = this.db.prepare('SELECT status FROM outbox WHERE key = ?').get(key) as Row | undefined
    return row ? String(row.status) : null
  }

  claimOutbox(now: string, limit: number): OutboxItem[] {
    const rows = this.db.prepare("SELECT * FROM outbox WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?").all(now, limit) as Row[]
    const stmt = this.db.prepare("UPDATE outbox SET status = 'inflight', attempts = attempts + 1 WHERE id = ?")
    for (const row of rows) stmt.run(String(row.id))
    return rows.map(row => outboxFromRow(row, 1))
  }

  succeedOutbox(id: string, now: string): void {
    this.db.prepare("UPDATE outbox SET status = 'sent', next_at = ?, last_error = NULL WHERE id = ?").run(now, id)
  }

  failOutbox(id: string, error: string, now: string): void {
    const row = this.db.prepare('SELECT attempts FROM outbox WHERE id = ?').get(id) as Row | undefined
    const nextAt = new Date(new Date(now).getTime() + backoffMs(Number(row?.attempts ?? 1))).toISOString()
    this.db.prepare("UPDATE outbox SET status = 'pending', next_at = ?, last_error = ? WHERE id = ?").run(nextAt, error, id)
  }

  // ---------- Effects ----------

  enqueueEffect(item: EnqueueEffect): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO effects (id, key, kind, payload, status, attempts, next_at, created_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`)
      .run(item.id, item.key, item.kind, JSON.stringify(item.payload), item.now, item.now)
    return Number(result.changes) > 0
  }

  claimEffects(now: string, limit: number): EffectItem[] {
    const rows = this.db.prepare("SELECT * FROM effects WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?").all(now, limit) as Row[]
    const stmt = this.db.prepare("UPDATE effects SET status = 'inflight', attempts = attempts + 1 WHERE id = ?")
    for (const row of rows) stmt.run(String(row.id))
    return rows.map(row => effectFromRow(row, 1))
  }

  succeedEffect(id: string, now: string): void {
    this.db.prepare("UPDATE effects SET status = 'done', next_at = ?, last_error = NULL WHERE id = ?").run(now, id)
  }

  failEffect(id: string, error: string, now: string): void {
    const row = this.db.prepare('SELECT attempts FROM effects WHERE id = ?').get(id) as Row | undefined
    const nextAt = new Date(new Date(now).getTime() + backoffMs(Number(row?.attempts ?? 1))).toISOString()
    this.db.prepare("UPDATE effects SET status = 'pending', next_at = ?, last_error = ? WHERE id = ?").run(nextAt, error, id)
  }

  // ---------- 身份别名缓存 ----------

  /**
   * 读一条身份解析缓存。
   * 键里带 app_id：open_id 跨应用不通用，旧应用的缓存不能被新应用命中。
   */
  getIdentityAlias(appId: string, kind: 'email' | 'open_id', value: string): { openId: string; name: string } | null {
    const row = this.db.prepare('SELECT open_id, name FROM identity_aliases WHERE app_id = ? AND kind = ? AND value = ?')
      .get(appId, kind, value) as Row | undefined
    if (!row) return null
    return { openId: String(row.open_id), name: String(row.name ?? '') }
  }

  /** 写一条身份解析缓存；同一个键重复写入以最后一次为准。 */
  setIdentityAlias(appId: string, kind: 'email' | 'open_id', value: string, openId: string, name: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO identity_aliases (app_id, kind, value, open_id, name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(appId, kind, value, openId, name, new Date().toISOString())
  }
}

/** 首次 2 秒，之后每次翻倍，上限 60 秒。 */
export function backoffMs(attempts: number): number {
  const exp = Math.max(0, attempts - 1)
  return Math.min(2000 * 2 ** exp, 60_000)
}

function triggerFromRow(row: Row): Trigger {
  return {
    id: String(row.id),
    source: row.source as SourceKind,
    ...(row.channel_id ? { channelId: String(row.channel_id) } : {}),
    externalId: String(row.external_id),
    threadId: String(row.thread_id),
    chatId: String(row.chat_id),
    chatName: String(row.chat_name),
    actorId: String(row.actor_id),
    actorName: String(row.actor_name),
    isBot: Number(row.is_bot) === 1,
    text: String(row.text),
    addressed: row.addressed as Trigger['addressed'],
    ...(Number(row.unaddressed_admitted) === 1 ? { unaddressedAdmitted: true } : {}),
    mediaOnly: Number(row.media_only) === 1,
    receivedAt: String(row.received_at),
    disposition: row.disposition as TriggerDisposition,
    ...(row.decision_id ? { decisionId: String(row.decision_id) } : {}),
    ...(row.raw ? { raw: JSON.parse(String(row.raw)) } : {}),
  }
}

function ticketFromRow(row: Row): Ticket {
  const attachments = parseAttachments(row.attachments)
  return {
    id: String(row.id),
    title: String(row.title),
    threadId: String(row.thread_id),
    source: row.source as SourceKind,
    ...(row.channel_id ? { channelId: String(row.channel_id) } : {}),
    chatId: String(row.chat_id),
    mandateId: String(row.mandate_id),
    stage: normalizeStage(row.stage) ?? 'todo',
    repo: String(row.repo ?? ''),
    branch: String(row.branch ?? ''),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(row.request ? { request: String(row.request) } : {}),
    ...(row.request_actor_name ? { requestActorName: String(row.request_actor_name) } : {}),
    ...(row.request_at ? { requestAt: String(row.request_at) } : {}),
    prNumber: Number(row.pr_number),
    prUrl: String(row.pr_url),
    prState: row.pr_state as Ticket['prState'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.closed_at ? { closedAt: String(row.closed_at) } : {}),
  }
}

function intakeFromRow(row: Row): Intake {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    chatId: String(row.chat_id),
    actorId: String(row.actor_id),
    actorName: String(row.actor_name ?? ''),
    project: String(row.project ?? ''),
    repo: String(row.repo ?? ''),
    branch: String(row.branch ?? ''),
    status: row.status as Intake['status'],
    kind: row.kind as Intake['kind'],
    rawText: String(row.raw_text),
    turns: parseIntakeTurns(row.turns),
    ...(row.report ? { report: parseIntakeReport(row.report) } : {}),
    questions: Number(row.questions ?? 0),
    ...(row.ticket_id ? { ticketId: String(row.ticket_id) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

/** intakes.turns 是 JSON 数组；旧库/脏数据一律退回空数组。 */
function parseIntakeTurns(value: unknown): IntakeTurn[] {
  if (!value) return []
  try {
    const doc = JSON.parse(String(value)) as unknown
    if (!Array.isArray(doc)) return []
    const out: IntakeTurn[] = []
    for (const item of doc) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const text = typeof record.text === 'string' ? record.text : ''
      if (!text) continue
      out.push({
        role: record.role === 'router' ? 'router' : 'user',
        text,
        at: typeof record.at === 'string' ? record.at : '',
        ...(typeof record.actorId === 'string' && record.actorId ? { actorId: record.actorId } : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

/** intakes.report 是结构化需求单；字段缺失时按空字符串兜底，避免旧数据把整条 intake 读挂。 */
function parseIntakeReport(value: unknown): IntakeReport | undefined {
  try {
    const doc = JSON.parse(String(value)) as Record<string, unknown>
    if (!doc || typeof doc !== 'object') return undefined
    const text = (key: string): string => (typeof doc[key] === 'string' ? String(doc[key]) : '')
    return {
      title: text('title'),
      problem: text('problem'),
      background: text('background'),
      steps: text('steps'),
      environment: text('environment'),
      impact: text('impact'),
      expected: text('expected'),
      assessment: text('assessment'),
    }
  } catch {
    return undefined
  }
}

/** tickets.attachments 是 JSON 数组；旧库/脏数据一律退回空数组。 */
function parseAttachments(value: unknown): Attachment[] {
  if (!value) return []
  try {
    const doc = JSON.parse(String(value)) as unknown
    if (!Array.isArray(doc)) return []
    const out: Attachment[] = []
    for (const item of doc) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const path = typeof record.path === 'string' ? record.path.trim() : ''
      if (!path) continue
      out.push({
        path,
        mimeType: typeof record.mimeType === 'string' && record.mimeType ? record.mimeType : 'application/octet-stream',
        ...(record.quoted === true ? { quoted: true } : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

function assignmentFromRow(row: Row): Assignment {
  return {
    id: String(row.id),
    ticketId: String(row.ticket_id),
    runtimeId: String(row.runtime_id),
    handle: String(row.handle),
    workdir: String(row.workdir),
    status: row.status as Assignment['status'],
    startedAt: String(row.started_at),
    ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
  }
}

function reportFromRow(row: Row): Report {
  const reply = row.reply ? String(row.reply) : legacyReply(row.deliverable)
  return {
    id: String(row.id),
    ticketId: String(row.ticket_id),
    assignmentId: String(row.assignment_id),
    turn: Number(row.turn),
    state: row.state as Report['state'],
    summary: String(row.summary),
    ...(row.human_action ? { humanAction: String(row.human_action) } : {}),
    ...(row.pr_number !== null && row.pr_number !== undefined ? { prNumber: Number(row.pr_number) } : {}),
    ...(row.pr_url ? { prUrl: String(row.pr_url) } : {}),
    ...(reply ? { reply } : {}),
    ackedInputs: JSON.parse(String(row.acked_inputs)) as string[],
    at: String(row.at),
  }
}

/** 旧库里 deliverable 是 JSON；读出正文与链接拼成纯回复。 */
function legacyReply(value: unknown): string {
  if (!value) return ''
  try {
    const doc = JSON.parse(String(value)) as { content?: string; url?: string }
    return [doc.content?.trim(), doc.url?.trim()].filter(Boolean).join('\n\n')
  } catch {
    return ''
  }
}

function inputFromRow(row: Row): Input {
  return {
    id: String(row.id),
    ticketId: String(row.ticket_id),
    assignmentId: String(row.assignment_id),
    seq: Number(row.seq),
    kind: row.kind as Input['kind'],
    text: String(row.text),
    ...(row.source_key ? { sourceKey: String(row.source_key) } : {}),
    status: row.status as Input['status'],
    createdAt: String(row.created_at),
    ...(row.delivered_at ? { deliveredAt: String(row.delivered_at) } : {}),
    ...(row.acked_at ? { ackedAt: String(row.acked_at) } : {}),
  }
}

function outboxFromRow(row: Row, bump: number): OutboxItem {
  const blocks = parseBlocks(row.blocks)
  return {
    id: String(row.id),
    key: String(row.key),
    channelKind: String(row.channel_kind),
    channelId: String(row.channel_id),
    threadId: String(row.thread_id),
    text: String(row.text),
    status: 'inflight',
    attempts: Number(row.attempts) + bump,
    nextAt: String(row.next_at),
    createdAt: String(row.created_at),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    ...(row.origin_message_id ? { originMessageId: String(row.origin_message_id) } : {}),
    ...(blocks ? { blocks } : {}),
  }
}

function parseBlocks(value: unknown): ReplyBlock[] | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed as ReplyBlock[] : undefined
  } catch {
    return undefined
  }
}

function questionFromRow(row: Row): Question {
  let options: Question['options'] = []
  try {
    const parsed = JSON.parse(String(row.options)) as unknown
    if (Array.isArray(parsed)) options = parsed as Question['options']
  } catch {
    // 脏数据按空选项处理；题型本身仍可展示，不会阻塞主流程。
  }
  return {
    id: String(row.id),
    ticketId: String(row.ticket_id),
    assignmentId: String(row.assignment_id),
    chatId: String(row.chat_id),
    threadId: String(row.thread_id),
    turn: Number(row.turn),
    prompt: String(row.prompt),
    options,
    multi: Number(row.multi) === 1,
    status: String(row.status) as Question['status'],
    ...(row.answer ? { answer: String(row.answer) } : {}),
    ...(row.operator_id ? { operatorId: String(row.operator_id) } : {}),
    ...(row.message_id ? { messageId: String(row.message_id) } : {}),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    ...(row.answered_at ? { answeredAt: String(row.answered_at) } : {}),
  }
}

function effectFromRow(row: Row, bump: number): EffectItem {
  return {
    id: String(row.id),
    key: String(row.key),
    kind: String(row.kind),
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    status: 'inflight',
    attempts: Number(row.attempts) + bump,
    nextAt: String(row.next_at),
    createdAt: String(row.created_at),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
  }
}

function eventFromRow(row: Row): EventRecord {
  return {
    id: String(row.id),
    source: String(row.source),
    type: String(row.type),
    externalId: String(row.external_id),
    lane: String(row.lane),
    subject: String(row.subject),
    summary: String(row.summary),
    ...(row.detail ? { detail: String(row.detail) } : {}),
    ...(row.detail_ref ? { detailRef: String(row.detail_ref) } : {}),
    ...(row.link ? { link: String(row.link) } : {}),
    actorId: String(row.actor_id ?? ''),
    actorName: String(row.actor_name ?? ''),
    actorType: String(row.actor_type ?? 'external'),
    ...(row.chat_id ? { chatId: String(row.chat_id) } : {}),
    ...(row.project ? { project: String(row.project) } : {}),
    priorityHint: Number(row.priority_hint ?? 0),
    costClass: String(row.cost_class ?? 'cheap'),
    hops: Number(row.hops ?? 0),
    ...(row.parent_event_id ? { parentEventId: String(row.parent_event_id) } : {}),
    receivedAt: String(row.received_at),
    ...(row.deadline_at ? { deadlineAt: String(row.deadline_at) } : {}),
  }
}

function eventQueueFromRow(row: Row): EventQueueRecord {
  return {
    eventId: String(row.event_id),
    lane: String(row.lane),
    priority: Number(row.priority ?? 0),
    tier: String(row.tier ?? 't3'),
    state: String(row.state ?? 'queued'),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    ...(row.decided_by ? { decidedBy: String(row.decided_by) } : {}),
    ...(row.not_before ? { notBefore: String(row.not_before) } : {}),
    attempts: Number(row.attempts ?? 0),
    ...(row.lease_until ? { leaseUntil: String(row.lease_until) } : {}),
    ...(row.ticket_id ? { ticketId: String(row.ticket_id) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function chatSessionFromRow(row: Row): ChatSessionRecord {
  return {
    sessionKey: String(row.session_key),
    chatId: String(row.chat_id),
    actorId: String(row.actor_id),
    threadId: String(row.thread_id ?? ''),
    sessionFile: String(row.session_file),
    sessionId: String(row.session_id),
    soulVersion: String(row.soul_version ?? ''),
    policyVersion: String(row.policy_version ?? ''),
    createdAt: String(row.created_at),
    lastUsedAt: String(row.last_used_at),
    status: row.status as ChatSessionRecord['status'],
    resetAt: row.reset_at ? String(row.reset_at) : null,
    resetBy: row.reset_by ? String(row.reset_by) : null,
    purgedAt: row.purged_at ? String(row.purged_at) : null,
  }
}
