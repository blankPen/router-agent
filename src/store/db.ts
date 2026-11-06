import { DatabaseSync } from 'node:sqlite'
import type {
  Assignment,
  DecisionRecord,
  DispatchDraft,
  Input,
  Mandate,
  Report,
  SourceKind,
  Stage,
  Subscription,
  Ticket,
  Trigger,
  TriggerDisposition,
} from '../core/model.js'
import type { Policy } from '../core/policy.js'

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

export interface EnqueueOutbox {
  id: string
  key: string
  channelKind: string
  channelId: string
  threadId: string
  text: string
  now: string
  /** 用户消息 ID（不是话题根），用于回复后撤销回执表情。 */
  originMessageId?: string
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

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_name TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  is_bot INTEGER NOT NULL,
  text TEXT NOT NULL,
  addressed TEXT NOT NULL,
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
  root_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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
  chat_id TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  repo TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  pr_number INTEGER NOT NULL DEFAULT 0,
  pr_url TEXT NOT NULL DEFAULT '',
  pr_state TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_stage ON tickets (stage, created_at);

CREATE TABLE IF NOT EXISTS dispatch_drafts (
  chat_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  task TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  backend_id TEXT NOT NULL,
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
  origin_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (status, next_at);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT PRIMARY KEY,
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
`

type Row = Record<string, unknown>

/** SQLite 存储层。只负责读写，不做业务判断。 */
export class Store {
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
    const columns = this.db.prepare('PRAGMA table_info(outbox)').all() as Row[]
    if (!columns.some(column => column.name === 'origin_message_id')) {
      this.db.exec('ALTER TABLE outbox ADD COLUMN origin_message_id TEXT')
    }
    const reportColumns = this.db.prepare('PRAGMA table_info(reports)').all() as Row[]
    if (!reportColumns.some(column => column.name === 'deliverable')) {
      this.db.exec('ALTER TABLE reports ADD COLUMN deliverable TEXT')
    }
    if (!reportColumns.some(column => column.name === 'reply')) {
      this.db.exec('ALTER TABLE reports ADD COLUMN reply TEXT')
    }
    const triggerColumns = this.db.prepare('PRAGMA table_info(triggers)').all() as Row[]
    if (!triggerColumns.some(column => column.name === 'media_only')) {
      this.db.exec('ALTER TABLE triggers ADD COLUMN media_only INTEGER NOT NULL DEFAULT 0')
    }
    const ticketColumns = this.db.prepare('PRAGMA table_info(tickets)').all() as Row[]
    if (!ticketColumns.some(column => column.name === 'repo')) {
      this.db.exec("ALTER TABLE tickets ADD COLUMN repo TEXT NOT NULL DEFAULT ''")
    }
    if (!ticketColumns.some(column => column.name === 'branch')) {
      this.db.exec("ALTER TABLE tickets ADD COLUMN branch TEXT NOT NULL DEFAULT ''")
    }
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
      (id, source, external_id, thread_id, chat_id, chat_name, actor_id, actor_name, is_bot, text, addressed, media_only, received_at, disposition, decision_id, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.id, t.source, t.externalId, t.threadId, t.chatId, t.chatName, t.actorId, t.actorName, t.isBot ? 1 : 0,
        t.text, t.addressed, t.mediaOnly ? 1 : 0, t.receivedAt, t.disposition, t.decisionId ?? null, t.raw === undefined ? null : JSON.stringify(t.raw))
    return Number(result.changes) > 0
  }

  getTrigger(id: string): Trigger | null {
    const row = this.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as Row | undefined
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

  upsertThread(thread: { id: string; source: SourceKind; rootId: string; chatId: string; createdAt: string }): void {
    this.db.prepare('INSERT OR IGNORE INTO threads (id, source, root_id, chat_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(thread.id, thread.source, thread.rootId, thread.chatId, thread.createdAt)
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
    this.db.prepare(`INSERT INTO tickets (id, title, thread_id, source, chat_id, mandate_id, stage, repo, branch, pr_number, pr_url, pr_state, created_at, updated_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.id, t.title, t.threadId, t.source, t.chatId, t.mandateId, t.stage, t.repo, t.branch, t.prNumber, t.prUrl, t.prState, t.createdAt, t.updatedAt, t.closedAt ?? null)
  }

  updateTicket(t: Ticket): void {
    this.db.prepare(`UPDATE tickets SET title = ?, stage = ?, repo = ?, branch = ?, pr_number = ?, pr_url = ?, pr_state = ?, updated_at = ?, closed_at = ? WHERE id = ?`)
      .run(t.title, t.stage, t.repo, t.branch, t.prNumber, t.prUrl, t.prState, t.updatedAt, t.closedAt ?? null, t.id)
  }

  getTicket(id: string): Ticket | null {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Row | undefined
    return row ? ticketFromRow(row) : null
  }

  listTickets(filter: { stage?: Stage; limit?: number } = {}): Ticket[] {
    const limit = filter.limit ?? 200
    if (filter.stage) {
      return (this.db.prepare('SELECT * FROM tickets WHERE stage = ? ORDER BY created_at DESC LIMIT ?').all(filter.stage, limit) as Row[]).map(ticketFromRow)
    }
    return (this.db.prepare('SELECT * FROM tickets ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(ticketFromRow)
  }

  listOpenTickets(): Ticket[] {
    return (this.db.prepare("SELECT * FROM tickets WHERE stage != 'closed' ORDER BY created_at").all() as Row[]).map(ticketFromRow)
  }

  // ---------- 派工草稿（多项目 / 多分支补齐） ----------

  saveDispatchDraft(draft: DispatchDraft): void {
    this.db.prepare(`INSERT INTO dispatch_drafts (chat_id, thread_id, actor_id, task, repo, branch, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET thread_id = excluded.thread_id, actor_id = excluded.actor_id,
        task = excluded.task, repo = excluded.repo, branch = excluded.branch, updated_at = excluded.updated_at`)
      .run(draft.chatId, draft.threadId, draft.actorId, draft.task, draft.repo, draft.branch, draft.updatedAt)
  }

  getDispatchDraft(chatId: string): DispatchDraft | null {
    const row = this.db.prepare('SELECT * FROM dispatch_drafts WHERE chat_id = ?').get(chatId) as Row | undefined
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

  clearDispatchDraft(chatId: string): void {
    this.db.prepare('DELETE FROM dispatch_drafts WHERE chat_id = ?').run(chatId)
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

  // ---------- Assignment / Report / Input ----------

  insertAssignment(a: Assignment): void {
    this.db.prepare(`INSERT INTO assignments (id, ticket_id, backend_id, handle, workdir, status, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, a.ticketId, a.backendId, a.handle, a.workdir, a.status, a.startedAt, a.endedAt ?? null)
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

  insertInput(i: Input): void {
    this.db.prepare(`INSERT INTO inputs (id, ticket_id, assignment_id, seq, kind, text, status, created_at, delivered_at, acked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(i.id, i.ticketId, i.assignmentId, i.seq, i.kind, i.text, i.status, i.createdAt, i.deliveredAt ?? null, i.ackedAt ?? null)
  }

  updateInput(i: Input): void {
    this.db.prepare('UPDATE inputs SET status = ?, delivered_at = ?, acked_at = ? WHERE id = ?')
      .run(i.status, i.deliveredAt ?? null, i.ackedAt ?? null, i.id)
  }

  listInputs(ticketId: string): Input[] {
    return (this.db.prepare('SELECT * FROM inputs WHERE ticket_id = ? ORDER BY seq').all(ticketId) as Row[]).map(inputFromRow)
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

  ackInputs(assignmentId: string, ids: string[], at: string): void {
    const stmt = this.db.prepare("UPDATE inputs SET status = 'acked', acked_at = ? WHERE id = ? AND assignment_id = ?")
    for (const id of ids) stmt.run(at, id, assignmentId)
  }

  /** 把工单上尚未绑定派工的输入挂到新派工上。 */
  rebindInputs(ticketId: string, assignmentId: string): void {
    this.db.prepare("UPDATE inputs SET assignment_id = ? WHERE ticket_id = ? AND assignment_id = ''").run(assignmentId, ticketId)
  }

  markInputsDelivered(ticketId: string, at: string): void {
    this.db.prepare("UPDATE inputs SET status = 'delivered', delivered_at = ? WHERE ticket_id = ? AND status = 'pending'").run(at, ticketId)
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

  // ---------- Outbox ----------

  enqueueOutbox(item: EnqueueOutbox): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO outbox (id, key, channel_kind, channel_id, thread_id, text, status, attempts, next_at, created_at, origin_message_id)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
      .run(item.id, item.key, item.channelKind, item.channelId, item.threadId, item.text, item.now, item.now, item.originMessageId ?? null)
    return Number(result.changes) > 0
  }

  // ---------- 回执表情 ----------

  saveReaction(messageId: string, reactionId: string, at: string): void {
    this.db.prepare('INSERT INTO reactions (message_id, reaction_id, created_at) VALUES (?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET reaction_id = excluded.reaction_id')
      .run(messageId, reactionId, at)
  }

  getReaction(messageId: string): { messageId: string; reactionId: string } | null {
    const row = this.db.prepare('SELECT * FROM reactions WHERE message_id = ?').get(messageId) as Row | undefined
    return row ? { messageId: String(row.message_id), reactionId: String(row.reaction_id) } : null
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
    externalId: String(row.external_id),
    threadId: String(row.thread_id),
    chatId: String(row.chat_id),
    chatName: String(row.chat_name),
    actorId: String(row.actor_id),
    actorName: String(row.actor_name),
    isBot: Number(row.is_bot) === 1,
    text: String(row.text),
    addressed: row.addressed as Trigger['addressed'],
    mediaOnly: Number(row.media_only) === 1,
    receivedAt: String(row.received_at),
    disposition: row.disposition as TriggerDisposition,
    ...(row.decision_id ? { decisionId: String(row.decision_id) } : {}),
    ...(row.raw ? { raw: JSON.parse(String(row.raw)) } : {}),
  }
}

function ticketFromRow(row: Row): Ticket {
  return {
    id: String(row.id),
    title: String(row.title),
    threadId: String(row.thread_id),
    source: row.source as SourceKind,
    chatId: String(row.chat_id),
    mandateId: String(row.mandate_id),
    stage: row.stage as Stage,
    repo: String(row.repo ?? ''),
    branch: String(row.branch ?? ''),
    prNumber: Number(row.pr_number),
    prUrl: String(row.pr_url),
    prState: row.pr_state as Ticket['prState'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.closed_at ? { closedAt: String(row.closed_at) } : {}),
  }
}

function assignmentFromRow(row: Row): Assignment {
  return {
    id: String(row.id),
    ticketId: String(row.ticket_id),
    backendId: String(row.backend_id),
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
    status: row.status as Input['status'],
    createdAt: String(row.created_at),
    ...(row.delivered_at ? { deliveredAt: String(row.delivered_at) } : {}),
    ...(row.acked_at ? { ackedAt: String(row.acked_at) } : {}),
  }
}

function outboxFromRow(row: Row, bump: number): OutboxItem {
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
