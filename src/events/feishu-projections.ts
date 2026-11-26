/**
 * 飞书事件的归一化：每个 EventKey 一套投影 + 一个去重键生成规则。
 *
 * **为什么不用 `lark-cli --jq` 做投影**：jq 表达式写错时 `lark-cli` 会静默跳过事件，
 * 只在 stderr 打一行 WARN —— 消费者看起来活着却一条事件都不吐（最难排查的失败）。
 * 归一化放在宿主侧用 TypeScript 做，投影写错就是抛异常，日志里看得见。
 *
 * **两种信封形状**（实测 `lark-cli event schema <key> --json` 的 `jq_root_path`）：
 * - 扁平：载荷直接在根上（`im.message.receive_v1`、`card.action.trigger`、`approval.*`、
 *   `minutes.*`、`vc.*`、`application.bot.menu_v6`）；
 * - V2 信封：载荷在 `.event` 下（`im.message.reaction.*`、`im.message.message_read_v1`、
 *   `im.chat.*`、`im.chat.member.*`、`task.*`、`board.*`）。
 *
 * **去重键不能用统一的 `event_id`**：飞书官方字段说明写明
 * 「event_id 是事件投递 ID，不可作为消息去重键，要用 message_id」。
 * 因此每个 EventKey 按自己的业务维度拼复合键（见 §4.3.5）。
 */
import type { EventEnvelope } from '#event/port.js'
import { FEISHU_EVENT_TYPES, feishuTypeIdByEventKey } from './catalogs/feishu.js'

/** 事件类型 id → 投影规则。 */
export type FeishuProjections = Record<string, FeishuProjection>

/** 一个 EventKey 的投影规则。 */
export interface FeishuProjection {
  /** 载荷所在的路径：根上取 `.`，V2 信封取 `.event`。 */
  root: 'flat' | 'envelope'
  /**
   * 生成幂等键。
   *
   * 第二个参数是原始信封 —— V2 事件的时间戳在 `header.create_time`，
   * 不在 `.event` 里，成员事件的幂等键需要它。
   */
  dedupKey: (payload: Record<string, unknown>, raw: Record<string, unknown>) => string
  /** 生成事件标题。 */
  title: (payload: Record<string, unknown>, raw: Record<string, unknown>) => string
  /** 生成事件正文。 */
  body: (payload: Record<string, unknown>, raw: Record<string, unknown>) => string
  /** 生成上下文线索（群 id、发送人…）。 */
  context?: (payload: Record<string, unknown>, raw: Record<string, unknown>) => Record<string, string>
  /** 生成事件链接。 */
  url?: (payload: Record<string, unknown>, raw: Record<string, unknown>) => string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 取字符串；不是字符串就返回空串。 */
function str(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return ''
}

/** 取对象的某个字段。 */
function field(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key]
  return isRecord(value) ? value : {}
}

/** 飞书的用户对象里 open_id / union_id / user_id 三个口径，取 open_id 优先。 */
function openIdOf(value: unknown): string {
  if (typeof value === 'string') return value
  const obj = field({ v: value }, 'v')
  return str(obj.open_id) || str(obj.union_id) || str(obj.user_id)
}

/** 毫秒时间戳 → ISO。飞书的时间字段多是 `timestamp_ms` 形态的字符串。 */
function isoOf(value: unknown): string {
  const text = str(value)
  if (!text) return ''
  const ms = Number(text)
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

/** 复合键：把业务维度的唯一性拼进一个字符串。 */
function join(...parts: string[]): string {
  return parts.map(part => part.replace(/:/g, '_')).join(':')
}

/** 取 `.event` 载荷（V2 信封）。 */
function envelopePayload(raw: Record<string, unknown>): Record<string, unknown> {
  const inner = raw.event
  return isRecord(inner) ? inner : raw
}

/**
 * V2 信封的操作时间。
 *
 * 成员 / 群事件的「操作时间」不在 `.event` 里，而在 `header.create_time`
 * （实测 `lark-cli event schema`：`header.create_time` 是「事件创建时间，毫秒时间戳字符串」）。
 */
function operateTimeOf(raw: Record<string, unknown>): string {
  return str(field(raw, 'header').create_time)
}

/** 成员事件里的用户 id 列表。 */
function memberUserIds(payload: Record<string, unknown>): string[] {
  const users = payload.users
  if (!Array.isArray(users)) return []
  // 官方 schema：`users[].user_id.open_id`（嵌套一层），不是 `users[].open_id`。
  return users
    .map(user => {
      const record = isRecord(user) ? user : {}
      const nested = field(record, 'user_id')
      return openIdOf(nested) || openIdOf(user)
    })
    .filter(Boolean)
}

/**
 * 全部 25 个 EventKey 的投影规则。
 *
 * 键是飞书 EventKey；值是归一化规则。
 */
export const FEISHU_PROJECTIONS: FeishuProjections = {
  // ── 消息与互动 ────────────────────────────────────────────────
  'im.message.receive_v1': {
    root: 'flat',
    dedupKey: payload => str(payload.message_id),
    title: payload => `消息 · ${str(payload.chat_type) === 'p2p' ? '私聊' : '群聊'}`,
    body: payload => str(payload.content),
    context: payload => ({
      chatId: str(payload.chat_id),
      senderId: openIdOf(payload.sender_id),
      senderType: str(payload.sender_type),
      messageId: str(payload.message_id),
      messageType: str(payload.message_type),
    }),
  },
  'im.message.reaction.created_v1': {
    root: 'envelope',
    dedupKey: payload => join(
      str(payload.message_id),
      reactionTypeOf(payload),
      str(payload.action_time),
    ),
    title: payload => `表情回应 · ${reactionTypeOf(payload)}`,
    body: payload => `消息 ${str(payload.message_id)} 被加了表情 ${reactionTypeOf(payload)}`,
    context: payload => ({
      messageId: str(payload.message_id),
      reactionType: reactionTypeOf(payload),
      userId: openIdOf(payload.user_id),
      operatorType: str(payload.operator_type),
    }),
  },
  'im.message.reaction.deleted_v1': {
    root: 'envelope',
    dedupKey: payload => join(
      str(payload.message_id),
      reactionTypeOf(payload),
      str(payload.action_time),
    ),
    title: payload => `取消表情 · ${reactionTypeOf(payload)}`,
    body: payload => `消息 ${str(payload.message_id)} 的表情 ${reactionTypeOf(payload)} 被取消`,
    context: payload => ({
      messageId: str(payload.message_id),
      reactionType: reactionTypeOf(payload),
      userId: openIdOf(payload.user_id),
      operatorType: str(payload.operator_type),
    }),
  },
  'im.message.message_read_v1': {
    root: 'envelope',
    dedupKey: payload => {
      const reader = field(payload, 'reader')
      return join(
        str(payload.message_id_list),
        openIdOf(reader.reader_id),
        str(reader.read_time),
      )
    },
    title: payload => '消息已读',
    body: payload => {
      const reader = field(payload, 'reader')
      const ids = Array.isArray(payload.message_id_list) ? payload.message_id_list.map(str).filter(Boolean) : []
      return `消息 ${ids.join('、')} 被 ${openIdOf(reader.reader_id) || '某成员'} 阅读`
    },
    context: payload => {
      const reader = field(payload, 'reader')
      const ids = Array.isArray(payload.message_id_list) ? payload.message_id_list.map(str).filter(Boolean) : []
      return {
        messageId: ids.join(','),
        readerId: openIdOf(reader.reader_id),
      }
    },
  },

  // ── 群与成员 ──────────────────────────────────────────────────
  'im.chat.member.bot.added_v1': {
    root: 'envelope',
    dedupKey: (payload, raw) => join(str(payload.chat_id), openIdOf(payload.operator_id), operateTimeOf(raw)),
    title: payload => `机器人进群 · ${str(payload.name)}`,
    body: payload => `机器人被拉进群 ${str(payload.name) || str(payload.chat_id)}`,
    context: payload => ({ chatId: str(payload.chat_id), operatorId: openIdOf(payload.operator_id) }),
  },
  'im.chat.member.bot.deleted_v1': {
    root: 'envelope',
    dedupKey: (payload, raw) => join(str(payload.chat_id), openIdOf(payload.operator_id), operateTimeOf(raw)),
    title: payload => `机器人退群 · ${str(payload.name)}`,
    body: payload => `机器人被移出群 ${str(payload.name) || str(payload.chat_id)}`,
    context: payload => ({ chatId: str(payload.chat_id), operatorId: openIdOf(payload.operator_id) }),
  },
  'im.chat.member.user.added_v1': {
    root: 'envelope',
    dedupKey: (payload, raw) => join(str(payload.chat_id), memberUserIds(payload).join('+'), operateTimeOf(raw)),
    title: payload => `有人进群 · ${str(payload.name)}`,
    body: payload => `成员 ${memberUserIds(payload).join('、')} 加入群 ${str(payload.name) || str(payload.chat_id)}`,
    context: payload => ({
      chatId: str(payload.chat_id),
      operatorId: openIdOf(payload.operator_id),
      userIds: memberUserIds(payload).join(','),
    }),
  },
  'im.chat.member.user.deleted_v1': {
    root: 'envelope',
    dedupKey: (payload, raw) => join(str(payload.chat_id), memberUserIds(payload).join('+'), operateTimeOf(raw)),
    title: payload => `有人退群 · ${str(payload.name)}`,
    body: payload => `成员 ${memberUserIds(payload).join('、')} 离开群 ${str(payload.name) || str(payload.chat_id)}`,
    context: payload => ({
      chatId: str(payload.chat_id),
      operatorId: openIdOf(payload.operator_id),
      userIds: memberUserIds(payload).join(','),
    }),
  },
  'im.chat.member.user.withdrawn_v1': {
    root: 'envelope',
    dedupKey: (payload, raw) => join(str(payload.chat_id), memberUserIds(payload).join('+'), operateTimeOf(raw)),
    title: payload => `邀请被撤回 · ${str(payload.name)}`,
    body: payload => `成员 ${memberUserIds(payload).join('、')} 的入群邀请被撤回`,
    context: payload => ({
      chatId: str(payload.chat_id),
      operatorId: openIdOf(payload.operator_id),
      userIds: memberUserIds(payload).join(','),
    }),
  },
  'im.chat.updated_v1': {
    root: 'envelope',
    dedupKey: (payload, raw) => join(str(payload.chat_id), openIdOf(payload.operator_id), operateTimeOf(raw)),
    title: payload => '群信息变更',
    body: payload => {
      const before = field(payload, 'before_change')
      const after = field(payload, 'after_change')
      return [
        str(before.name) && str(after.name) && str(before.name) !== str(after.name)
          ? `群名：${str(before.name)} → ${str(after.name)}`
          : '',
        str(after.description) ? `群描述：${str(after.description)}` : '',
      ].filter(Boolean).join('\n') || '群信息发生变更'
    },
    context: payload => ({ chatId: str(payload.chat_id), operatorId: openIdOf(payload.operator_id) }),
  },
  'im.chat.disbanded_v1': {
    root: 'envelope',
    dedupKey: (payload, raw) => join(str(payload.chat_id), operateTimeOf(raw)),
    title: payload => `群解散 · ${str(payload.name)}`,
    body: payload => `群 ${str(payload.name) || str(payload.chat_id)} 已解散`,
    context: payload => ({ chatId: str(payload.chat_id), operatorId: openIdOf(payload.operator_id) }),
  },

  // ── 审批 ──────────────────────────────────────────────────────
  'approval.instance.status_changed_v4': {
    root: 'flat',
    dedupKey: payload => join(str(payload.instance_code), str(payload.status), str(payload.operate_time)),
    title: payload => `审批实例${statusLabelOf(payload.status)} · ${str(payload.instance_code)}`,
    body: payload => `审批单 ${str(payload.instance_code)} 状态变为 ${str(payload.status)}`,
    context: payload => ({
      instanceCode: str(payload.instance_code),
      approvalCode: str(payload.approval_code),
      status: str(payload.status),
    }),
  },
  'approval.task.status_changed_v4': {
    root: 'flat',
    dedupKey: payload => join(str(payload.task_id), str(payload.status), str(payload.operate_time)),
    title: payload => `审批任务${statusLabelOf(payload.status)} · ${str(payload.task_id)}`,
    body: payload => `审批任务 ${str(payload.task_id)} 状态变为 ${str(payload.status)}`,
    context: payload => ({
      taskId: str(payload.task_id),
      instanceCode: str(payload.instance_code),
      status: str(payload.status),
    }),
  },

  // ── 任务与卡片 ────────────────────────────────────────────────
  'task.task.update_user_access_v2': {
    root: 'envelope',
    dedupKey: (payload, raw) => join(str(payload.task_guid), str(payload.event_types), operateTimeOf(raw)),
    title: payload => '飞书任务变更',
    body: payload => `任务 ${str(payload.task_guid)} 的访问权限变更（${str(payload.event_types)}）`,
    context: payload => ({ taskGuid: str(payload.task_guid) }),
  },
  'card.action.trigger': {
    root: 'flat',
    dedupKey: payload => str(payload.event_id),
    title: payload => `卡片操作 · ${str(payload.action_name) || str(payload.action_tag)}`,
    body: payload => [
      str(payload.action_name) ? `操作：${str(payload.action_name)}` : '',
      str(payload.action_value) ? `取值：${str(payload.action_value)}` : '',
      str(payload.option) ? `选项：${str(payload.option)}` : '',
    ].filter(Boolean).join('\n') || '卡片被点击',
    context: payload => ({
      chatId: str(payload.chat_id),
      messageId: str(payload.message_id),
      operatorId: str(payload.operator_id),
      actionName: str(payload.action_name),
      actionValue: str(payload.action_value),
    }),
  },

  // ── 文档与会议 ────────────────────────────────────────────────
  'minutes.minute.generated_v1': {
    root: 'flat',
    dedupKey: payload => str(payload.minute_token),
    title: payload => `妙记生成 · ${str(payload.title) || '未命名'}`,
    body: payload => `妙记 ${str(payload.minute_token)} 已生成（来源：${str(payload.minute_source)}）`,
    context: payload => ({ minuteToken: str(payload.minute_token) }),
  },
  'vc.meeting.participant_meeting_started_v1': {
    root: 'flat',
    dedupKey: payload => join(str(payload.meeting_id), str(payload.timestamp)),
    title: payload => `会议开始 · ${str(payload.topic) || str(payload.meeting_id)}`,
    body: payload => `会议 ${str(payload.meeting_no) || str(payload.meeting_id)} 开始`,
    context: payload => ({ meetingId: str(payload.meeting_id) }),
  },
  'vc.meeting.participant_meeting_joined_v1': {
    root: 'flat',
    dedupKey: payload => join(str(payload.meeting_id), str(payload.timestamp), str(payload.start_time)),
    title: payload => `有人入会 · ${str(payload.topic) || str(payload.meeting_id)}`,
    body: payload => `有人加入会议 ${str(payload.meeting_no) || str(payload.meeting_id)}`,
    context: payload => ({ meetingId: str(payload.meeting_id) }),
  },
  'vc.meeting.participant_meeting_ended_v1': {
    root: 'flat',
    dedupKey: payload => join(str(payload.meeting_id), str(payload.end_time)),
    title: payload => `会议结束 · ${str(payload.topic) || str(payload.meeting_id)}`,
    body: payload => `会议 ${str(payload.meeting_no) || str(payload.meeting_id)} 结束`,
    context: payload => ({ meetingId: str(payload.meeting_id) }),
  },
  'vc.note.generated_v1': {
    root: 'flat',
    dedupKey: payload => str(payload.note_id),
    title: payload => '会议笔记生成',
    body: payload => `会议笔记 ${str(payload.note_id)} 已生成（来源：${str(payload.note_source)}）`,
    context: payload => ({ noteId: str(payload.note_id) }),
  },
  'vc.recording.recording_started_v1': {
    root: 'flat',
    dedupKey: payload => join(str(payload.unique_key), str(payload.event_time)),
    title: payload => '录制开始',
    body: payload => `录制 ${str(payload.unique_key)} 开始`,
    context: payload => ({ uniqueKey: str(payload.unique_key) }),
  },
  'vc.recording.recording_ended_v1': {
    root: 'flat',
    dedupKey: payload => join(str(payload.unique_key), str(payload.event_time)),
    title: payload => '录制结束',
    body: payload => `录制 ${str(payload.unique_key)} 结束`,
    context: payload => ({ uniqueKey: str(payload.unique_key) }),
  },
  'vc.recording.recording_transcript_generated_v1': {
    root: 'flat',
    dedupKey: payload => join(str(payload.unique_key), str(payload.event_time)),
    title: payload => '录制转写生成',
    body: payload => `录制 ${str(payload.unique_key)} 的转写已生成`,
    context: payload => ({ uniqueKey: str(payload.unique_key) }),
  },

  // ── 应用与白板 ────────────────────────────────────────────────
  'application.bot.menu_v6': {
    root: 'flat',
    dedupKey: payload => join(str(payload.event_id), str(payload.event_key)),
    title: payload => `机器人菜单 · ${str(payload.event_key)}`,
    body: payload => `用户 ${str(payload.operator_name) || str(payload.operator_id)} 点击了菜单 ${str(payload.event_key)}`,
    context: payload => ({ operatorId: str(payload.operator_id), eventKey: str(payload.event_key) }),
  },
  'board.whiteboard.updated_v1': {
    root: 'envelope',
    dedupKey: (payload, raw) => join(str(payload.whiteboard_id), operateTimeOf(raw)),
    title: payload => '白板更新',
    body: payload => `白板 ${str(payload.whiteboard_id)} 被更新`,
    context: payload => ({
      whiteboardId: str(payload.whiteboard_id),
      operatorIds: Array.isArray(payload.operator_ids) ? payload.operator_ids.map(str).join(',') : '',
    }),
  },
}

/** 表情类型：飞书给的是对象（`{emoji_type: 'THUMBSUP'}`），旧版本给的是字符串。 */
function reactionTypeOf(payload: Record<string, unknown>): string {
  const value = payload.reaction_type
  if (typeof value === 'string') return value
  if (isRecord(value)) return str(value.emoji_type)
  return ''
}

/** 审批状态的中文标签。 */
function statusLabelOf(status: unknown): string {
  const text = str(status).toUpperCase()
  if (text === 'APPROVED') return '通过'
  if (text === 'REJECTED') return '拒绝'
  if (text === 'CANCELED' || text === 'CANCELLED') return '撤销'
  return '变更'
}

/**
 * 归一化一条飞书事件。
 *
 * 载荷形状对不上就抛错 —— 宁可让调用方记一条 `event:feishu-parse-failed`，
 * 也不要静默产出一条字段全空的事件混进队列。
 */
export function normalizeFeishuEvent(eventKey: string, raw: unknown): EventEnvelope {
  const projection = FEISHU_PROJECTIONS[eventKey]
  if (!projection) throw new Error(`feishu:unknown-event-key: ${eventKey}`)
  if (!isRecord(raw)) throw new Error(`feishu:invalid-payload: ${eventKey}`)
  const payload = projection.root === 'envelope' ? envelopePayload(raw) : raw
  const typeId = feishuTypeIdByEventKey(eventKey)
  if (!typeId) throw new Error(`feishu:unmapped-event-key: ${eventKey}`)
  const externalId = projection.dedupKey(payload, raw)
  if (!externalId) throw new Error(`feishu:empty-dedup-key: ${eventKey}`)
  // 时间戳：扁平事件在根上，V2 信封在 `header.create_time`。
  const occurredAt = isoOf(payload.create_time)
    || isoOf(payload.timestamp)
    || isoOf(payload.operate_time)
    || isoOf(field(raw, 'header').create_time)
  const url = projection.url?.(payload, raw)
  return {
    externalId,
    eventType: typeId,
    title: projection.title(payload, raw),
    body: projection.body(payload, raw),
    ...(url ? { url } : {}),
    raw,
    ...(occurredAt ? { receivedAt: occurredAt } : {}),
    ...(projection.context ? { context: projection.context(payload, raw) } : {}),
  }
}

/** 目录里声明了、但还没有投影规则的 EventKey；实现与目录脱节时用它兜底。 */
export function missingProjections(): string[] {
  return FEISHU_EVENT_TYPES
    .map(type => type.eventKey)
    .filter(eventKey => !FEISHU_PROJECTIONS[eventKey])
}

