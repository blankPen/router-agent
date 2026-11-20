/**
 * 游标（`cursors` 表）的有类型封装。
 *
 * `cursors` 是一张无类型的 KV 表（`key TEXT PRIMARY KEY / value TEXT NOT NULL`），
 * 却承载了 9 类结构完全不同的状态机：进展同步、派工失败、重新派工、中断恢复、
 * 关单提醒、主动巡检、PR 催办、僵尸治理、未 ack 提醒。
 *
 * 每一类的 key 字符串与 value 格式都不同，散落在 `src/service.ts` 各处。
 * 新人要理解「工单为什么被自动关闭」，得先知道有哪几个 key、value 又长什么样。
 *
 * 这里把每类 key 的 **key 字符串 / value 结构 / 序列化方式** 收在一处：
 *
 * - key 字符串与表结构都不变，存量数据继续可读；
 * - 行为不变：读不到或解析失败一律按「没有水位」处理；
 * - 解析失败仍记 `cursor:invalid`，字段与原来一致。
 */
import { errorMessage, type Logger } from '#infra/logger.js'

/** 游标底座：只要求 Store 的三个游标方法，方便单测用假实现。 */
export interface CursorStore {
  getCursor(key: string): string | null
  setCursor(key: string, value: string, at: string): void
  deleteCursor(key: string): void
}

/** 进展同步水位的起点标记：表示「从派工这一刻起」，之前没有需要同步的报告。 */
export const PROGRESS_FROM_START = '@start'

/** 派工失败水位：重启后仍能区分「失败前积压的旧输入」与「用户新回复」。 */
export interface LaunchFailureRecord {
  attempts: number
  /** 上次失败时工单上已存在的最大输入序号；序号不大于它的输入不再触发重试。 */
  lastSeq: number
  lastReason: string
}

/** 中断恢复水位：同一个被中断的轮次只处理一次，自动恢复次数也有上限。 */
export interface InterruptedRecord {
  /** 已处理过的被中断轮次 id；避免重启后反复恢复同一轮。 */
  turnIds: string[]
  /** 已自动恢复的次数。 */
  autoRecovered: number
}

/** 关单提醒水位：提醒时间、预定关闭时间与提醒消息的幂等键。 */
export interface ReminderRecord {
  remindedAt: number
  closeAt: number
  /** 提醒消息的 outbox key；用来确认提醒真的发出去了再关单。 */
  outboxKey?: string
}

/** 主动巡检水位：静默期起点、上次巡检时间、提醒次数与摘要指纹。 */
export interface ProbeRecord {
  /** 本轮静默期的起点（最后一次上报 / 新输入 / 派工时间）。 */
  lastProgressAt: number
  /** 上次主动巡检消息的发送时间。 */
  lastPostAt: number
  /** 本轮静默期的提醒次数，用来生成稳定的 outbox key。 */
  count: number
  /** 语义摘要指纹；摘要没变时可以明确告诉用户。 */
  snippetHash: string
}

// ---------- key 字符串：与拆分前逐字一致，存量数据才能继续读到 ----------

const progressKey = (ticketId: string): string => `progress:${ticketId}`
const launchFailureKey = (ticketId: string): string => `launch-failure:${ticketId}`
const relaunchKey = (ticketId: string): string => `relaunch:${ticketId}`
const interruptedKey = (ticketId: string): string => `interrupted:${ticketId}`
const reminderKey = (ticketId: string): string => `retention:reminder:${ticketId}`
const probeKey = (ticketId: string): string => `progress:probe:${ticketId}`
const prUrgeKey = (ticketId: string): string => `retention:pr-urge:${ticketId}`
const zombieKey = (ticketId: string): string => `retention:zombie:${ticketId}`
const unackedNoticeKey = (inputId: string): string => `input:unacked-notice:${inputId}`
const prTrackMissedKey = (ticketId: string, prNumber: number): string => `pr:track-missed:${ticketId}:${prNumber}`

/**
 * 9 类游标的有类型读写。
 *
 * 每一类给一组「读 / 写 / 删」方法；调用方不再自己拼 key、自己
 * `JSON.parse`、自己判断 `Number(raw)` 是否可用。
 */
export class Cursors {
  constructor(
    private readonly store: CursorStore,
    private readonly now: () => string,
    private readonly logger: Logger,
  ) {}

  // ---------- 进展同步水位：value = report id 或 '@start' ----------

  /** 进展同步到哪条报告了；null 表示还没建立基线。 */
  progress(ticketId: string): string | null {
    return this.store.getCursor(progressKey(ticketId))
  }

  setProgress(ticketId: string, marker: string): void {
    this.store.setCursor(progressKey(ticketId), marker, this.now())
  }

  // ---------- 派工失败水位：value = LaunchFailureRecord ----------

  launchFailure(ticketId: string): LaunchFailureRecord | null {
    const raw = this.store.getCursor(launchFailureKey(ticketId))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<LaunchFailureRecord>
      if (typeof parsed.attempts !== 'number' || typeof parsed.lastSeq !== 'number') return null
      return {
        attempts: parsed.attempts,
        lastSeq: parsed.lastSeq,
        lastReason: typeof parsed.lastReason === 'string' ? parsed.lastReason : '',
      }
    } catch (error) {
      this.invalid(launchFailureKey(ticketId), error)
      return null
    }
  }

  setLaunchFailure(ticketId: string, record: LaunchFailureRecord): void {
    this.store.setCursor(launchFailureKey(ticketId), JSON.stringify(record), this.now())
  }

  clearLaunchFailure(ticketId: string): void {
    this.store.deleteCursor(launchFailureKey(ticketId))
  }

  // ---------- 重新派工水位：value = 输入序号（数字） ----------

  /** 上次重建 worker 时处理到的最大输入序号；没有记录时是 0。 */
  relaunchSeq(ticketId: string): number {
    const raw = this.store.getCursor(relaunchKey(ticketId))
    if (!raw) return 0
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  setRelaunchSeq(ticketId: string, seq: number): void {
    this.store.setCursor(relaunchKey(ticketId), String(seq), this.now())
  }

  // ---------- 中断恢复水位：value = InterruptedRecord ----------

  interrupted(ticketId: string): InterruptedRecord {
    const raw = this.store.getCursor(interruptedKey(ticketId))
    if (!raw) return { turnIds: [], autoRecovered: 0 }
    try {
      const parsed = JSON.parse(raw) as Partial<InterruptedRecord>
      return {
        turnIds: Array.isArray(parsed.turnIds) ? parsed.turnIds.filter(id => typeof id === 'string') : [],
        autoRecovered: typeof parsed.autoRecovered === 'number' && parsed.autoRecovered >= 0 ? parsed.autoRecovered : 0,
      }
    } catch {
      // 这一类历史上没记 cursor:invalid，保持原样：解析失败按「全新记录」处理。
      return { turnIds: [], autoRecovered: 0 }
    }
  }

  setInterrupted(ticketId: string, record: InterruptedRecord): void {
    this.store.setCursor(interruptedKey(ticketId), JSON.stringify(record), this.now())
  }

  // ---------- 关单提醒水位：value = ReminderRecord ----------

  reminder(ticketId: string): ReminderRecord | null {
    const raw = this.store.getCursor(reminderKey(ticketId))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<ReminderRecord>
      if (typeof parsed.remindedAt !== 'number' || typeof parsed.closeAt !== 'number') return null
      return {
        remindedAt: parsed.remindedAt,
        closeAt: parsed.closeAt,
        ...(typeof parsed.outboxKey === 'string' ? { outboxKey: parsed.outboxKey } : {}),
      }
    } catch (error) {
      this.invalid(reminderKey(ticketId), error)
      return null
    }
  }

  setReminder(ticketId: string, record: ReminderRecord): void {
    this.store.setCursor(reminderKey(ticketId), JSON.stringify(record), this.now())
  }

  clearReminder(ticketId: string): void {
    this.store.deleteCursor(reminderKey(ticketId))
  }

  // ---------- 主动巡检水位：value = ProbeRecord ----------

  probe(ticketId: string): ProbeRecord | null {
    const raw = this.store.getCursor(probeKey(ticketId))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<ProbeRecord>
      if (typeof parsed.lastProgressAt !== 'number' || typeof parsed.lastPostAt !== 'number') return null
      return {
        lastProgressAt: parsed.lastProgressAt,
        lastPostAt: parsed.lastPostAt,
        count: typeof parsed.count === 'number' ? parsed.count : 0,
        snippetHash: typeof parsed.snippetHash === 'string' ? parsed.snippetHash : '',
      }
    } catch (error) {
      this.invalid(probeKey(ticketId), error)
      return null
    }
  }

  setProbe(ticketId: string, record: ProbeRecord): void {
    this.store.setCursor(probeKey(ticketId), JSON.stringify(record), this.now())
  }

  // ---------- PR 催办水位：value = 时间戳（毫秒） ----------

  /** 这张工单是否已经催过 PR。 */
  hasPrUrge(ticketId: string): boolean {
    return this.store.getCursor(prUrgeKey(ticketId)) !== null
  }

  /** 催办时间；null 表示还没催过。 */
  prUrge(ticketId: string): number | null {
    return this.readTimestamp(prUrgeKey(ticketId))
  }

  markPrUrge(ticketId: string, atMs: number): void {
    this.store.setCursor(prUrgeKey(ticketId), String(atMs), this.now())
  }

  clearPrUrge(ticketId: string): void {
    this.store.deleteCursor(prUrgeKey(ticketId))
  }

  // ---------- 僵尸水位：value = 时间戳（毫秒） ----------

  /** 这张工单是否已经判成僵尸。 */
  hasZombie(ticketId: string): boolean {
    return this.store.getCursor(zombieKey(ticketId)) !== null
  }

  /** 转人工的时间；null 表示这张工单还没被判成僵尸。 */
  zombie(ticketId: string): number | null {
    return this.readTimestamp(zombieKey(ticketId))
  }

  markZombie(ticketId: string, atMs: number): void {
    this.store.setCursor(zombieKey(ticketId), String(atMs), this.now())
  }

  /** 清掉僵尸水位：有新进展后这张工单可以重新计时。 */
  clearZombie(ticketId: string): void {
    this.store.deleteCursor(zombieKey(ticketId))
  }

  // ---------- 未 ack 提醒水位：value = 时间戳（毫秒） ----------

  /** 这条输入是否已经提醒过人工。 */
  hasUnackedNotice(inputId: string): boolean {
    return this.store.getCursor(unackedNoticeKey(inputId)) !== null
  }

  markUnackedNotice(inputId: string, atMs: number): void {
    this.store.setCursor(unackedNoticeKey(inputId), String(atMs), this.now())
  }

  // ---------- PR 查询失败去重标记：value = 记录时间 ----------

  /** 这个工单的 PR 是否已经记过一次查询失败；5 秒轮询不再重复刷屏。 */
  hasPrTrackMissed(ticketId: string, prNumber: number): boolean {
    return this.store.getCursor(prTrackMissedKey(ticketId, prNumber)) !== null
  }

  markPrTrackMissed(ticketId: string, prNumber: number, at: string): void {
    this.store.setCursor(prTrackMissedKey(ticketId, prNumber), at, this.now())
  }

  // ---------- 内部 ----------

  /** 时间戳类游标：读不出正数就当没有水位。 */
  private readTimestamp(key: string): number | null {
    const raw = this.store.getCursor(key)
    if (!raw) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  }

  private invalid(key: string, error: unknown): void {
    this.logger.warn('cursor:invalid', { key, message: errorMessage(error) })
  }
}
