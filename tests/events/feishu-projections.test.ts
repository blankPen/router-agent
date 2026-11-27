/**
 * 飞书事件的归一化：投影 + 幂等键。
 *
 * 覆盖 §12.8 的 V33~V35 与 V41：
 * 同一条消息只入库一条、表情事件用复合键、加了再删再加工是三条独立事件、
 * 成员事件带 chat_id + user_id + operate_time。
 *
 * 这些样本按 `lark-cli event schema <key> --json` 的 `resolved_output_schema` 造，
 * 不连真实订阅 —— 投影写错会静默丢事件，所以先在这里测绿（§9 阶段 7a）。
 */
import { describe, expect, it } from 'vitest'
import { FEISHU_PROJECTIONS, missingProjections, normalizeFeishuEvent } from '../../src/events/feishu-projections.js'
import { FEISHU_EVENT_TYPES } from '../../src/events/catalogs/feishu.js'

describe('飞书事件投影', () => {
  it('目录里声明的 25 个 EventKey 全都有投影规则', () => {
    expect(missingProjections()).toEqual([])
    expect(FEISHU_EVENT_TYPES).toHaveLength(25)
  })

  it('消息事件按 message_id 去重：同一条消息两次投递只入库一条', () => {
    const payload = {
      message_id: 'om_abc123',
      chat_id: 'oc_dev',
      chat_type: 'group',
      content: '{"text":"退款什么时候到账"}',
      sender_id: { open_id: 'ou_alice' },
      sender_type: 'user',
      message_type: 'text',
      create_time: '1764000000000',
    }
    const first = normalizeFeishuEvent('im.message.receive_v1', payload)
    const second = normalizeFeishuEvent('im.message.receive_v1', payload)
    expect(first.externalId).toBe('om_abc123')
    expect(first.eventType).toBe('feishu.message')
    expect(second.externalId).toBe(first.externalId)
    expect(first.body).toContain('退款')
  })

  it('表情事件用「消息 id + 表情类型 + 操作时间」复合键（V34）', () => {
    const payload = {
      message_id: 'om_abc123',
      reaction_type: { emoji_type: 'THUMBSUP' },
      user_id: { open_id: 'ou_alice' },
      operator_type: 'user',
      action_time: '1764000000000',
    }
    const event = normalizeFeishuEvent('im.message.reaction.created_v1', { event: payload })
    expect(event.externalId).toBe('om_abc123:THUMBSUP:1764000000000')
    expect(event.eventType).toBe('feishu.message.reaction.created')
  })

  it('同一个表情先加后删再加，是三条独立事件', () => {
    const payload = {
      message_id: 'om_abc123',
      reaction_type: { emoji_type: 'THUMBSUP' },
      user_id: { open_id: 'ou_alice' },
      action_time: '1764000000000',
    }
    const added = normalizeFeishuEvent('im.message.reaction.created_v1', { event: payload })
    const removed = normalizeFeishuEvent('im.message.reaction.deleted_v1', { event: payload })
    const addedAgain = normalizeFeishuEvent('im.message.reaction.created_v1', { event: { ...payload, action_time: '1764000001000' } })
    expect(added.externalId).toBe(removed.externalId)
    expect(addedAgain.externalId).not.toBe(added.externalId)
    expect(removed.eventType).toBe('feishu.message.reaction.deleted')
  })

  it('成员退群事件的幂等键含 chat_id + user_id + 操作时间', () => {
    // 官方 schema：`users[].user_id.open_id` 是嵌套的；操作时间在 `header.create_time`。
    const payload = {
      chat_id: 'oc_dev',
      name: '研发群',
      users: [{ user_id: { open_id: 'ou_bob' } }],
      operator_id: { open_id: 'ou_alice' },
    }
    const event = normalizeFeishuEvent('im.chat.member.user.deleted_v1', {
      event: payload,
      header: { create_time: '1764000000000', event_id: 'evt_1', event_type: 'im.chat.member.user.deleted_v1' },
    })
    expect(event.externalId).toContain('oc_dev')
    expect(event.externalId).toContain('ou_bob')
    expect(event.externalId).toContain('1764000000000')
    expect(event.eventType).toBe('feishu.chat.member.user.deleted')
    expect(event.receivedAt).toBe('2025-11-24T16:00:00.000Z')
  })

  it('目录里没有的 EventKey 直接抛错，不静默吞掉', () => {
    expect(() => normalizeFeishuEvent('im.not.a.real.key', {})).toThrow(/unknown-event-key/)
  })

  it('载荷不是对象时抛错', () => {
    expect(() => normalizeFeishuEvent('im.message.receive_v1', 'not-an-object')).toThrow(/invalid-payload/)
  })

  it('算不出幂等键时抛错：宁可报错也不产生一条去不掉的记录', () => {
    expect(() => normalizeFeishuEvent('im.message.receive_v1', { chat_id: 'oc_dev' })).toThrow(/empty-dedup-key/)
  })
})

/**
 * 每个 EventKey 的载荷形状对照。
 *
 * 这些字段名来自 `lark-cli event schema <key> --json` 的 `resolved_output_schema`
 * （2026-11-26 实测）。字段名对不上时投影会算出空幂等键 —— 事件被静默丢掉，
 * 正是 §11 风险 R11 要防的事，所以这里逐个钉死。
 */
const SCHEMA_FIELDS: Record<string, string[]> = {
  'im.message.receive_v1': ['chat_id', 'content', 'create_time', 'message_id', 'sender_id', 'sender_type', 'message_type'],
  'im.message.reaction.created_v1': ['action_time', 'message_id', 'reaction_type', 'user_id', 'operator_type'],
  'im.message.reaction.deleted_v1': ['action_time', 'message_id', 'reaction_type', 'user_id', 'operator_type'],
  'im.message.message_read_v1': ['message_id_list', 'reader'],
  'im.chat.member.bot.added_v1': ['chat_id', 'name', 'operator_id', 'operator_tenant_key'],
  'im.chat.member.bot.deleted_v1': ['chat_id', 'name', 'operator_id', 'operator_tenant_key'],
  'im.chat.member.user.added_v1': ['chat_id', 'name', 'operator_id', 'users'],
  'im.chat.member.user.deleted_v1': ['chat_id', 'name', 'operator_id', 'users'],
  'im.chat.member.user.withdrawn_v1': ['chat_id', 'name', 'operator_id', 'users'],
  'im.chat.updated_v1': ['after_change', 'before_change', 'chat_id', 'operator_id'],
  'im.chat.disbanded_v1': ['chat_id', 'name', 'operator_id'],
  'approval.instance.status_changed_v4': ['approval_code', 'instance_code', 'operate_time', 'status'],
  'approval.task.status_changed_v4': ['approval_code', 'instance_code', 'operate_time', 'status', 'task_id'],
  'task.task.update_user_access_v2': ['event_types', 'task_guid'],
  'card.action.trigger': ['action_name', 'action_tag', 'action_value', 'chat_id', 'event_id', 'message_id', 'operator_id'],
  'minutes.minute.generated_v1': ['minute_source', 'minute_token', 'title'],
  'vc.meeting.participant_meeting_started_v1': ['meeting_id', 'meeting_no', 'start_time', 'timestamp', 'topic'],
  'vc.meeting.participant_meeting_joined_v1': ['meeting_id', 'meeting_no', 'start_time', 'timestamp', 'topic'],
  'vc.meeting.participant_meeting_ended_v1': ['end_time', 'meeting_id', 'meeting_no', 'timestamp', 'topic'],
  'vc.note.generated_v1': ['note_id', 'note_source', 'note_token'],
  'vc.recording.recording_started_v1': ['event_time', 'source', 'unique_key'],
  'vc.recording.recording_ended_v1': ['event_time', 'source', 'unique_key'],
  'vc.recording.recording_transcript_generated_v1': ['event_time', 'source', 'unique_key'],
  'application.bot.menu_v6': ['app_id', 'event_id', 'event_key', 'operator_id', 'operator_name'],
  'board.whiteboard.updated_v1': ['operator_ids', 'whiteboard_id'],
}

/** 造一份「每个字段都有值」的载荷；字段值不参与断言，只保证投影算得出幂等键。 */
function payloadOf(fields: string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const name of fields) {
    payload[name] = name === 'message_id' || name === 'message_id_list'
      ? (name === 'message_id' ? 'om_1' : ['om_1'])
      : name === 'operator_id' || name === 'user_id' || name === 'reader'
        ? { open_id: 'ou_x', union_id: 'on_x', user_id: 'u_x', reader_id: { open_id: 'ou_x' } }
        : name === 'operator_ids'
          ? ['ou_x']
          : name === 'reaction_type'
            ? { emoji_type: 'THUMBSUP' }
            : name === 'users'
              ? [{ user_id: { open_id: 'ou_y' } }]
              : name === 'before_change' || name === 'after_change'
                ? { name: '研发群' }
                : `v_${name}`
  }
  return payload
}

describe('飞书事件投影 · 全量对照', () => {
  it('每个 EventKey 的载荷字段都与实测 schema 一致', () => {
    expect(Object.keys(SCHEMA_FIELDS).sort()).toEqual(FEISHU_EVENT_TYPES.map(type => type.eventKey).sort())
  })

  it('每个 EventKey 都能算出非空幂等键，不会静默丢事件', () => {
    for (const [eventKey, fields] of Object.entries(SCHEMA_FIELDS)) {
      const projection = FEISHU_PROJECTIONS[eventKey]!
      const payload = payloadOf(fields)
      const raw = projection.root === 'envelope'
        ? { event: payload, header: { create_time: '1764000000000', event_id: 'evt_1' } }
        : payload
      const event = normalizeFeishuEvent(eventKey, raw)
      expect(event.externalId, `${eventKey} 的幂等键为空`).not.toBe('')
      expect(event.title, `${eventKey} 没有标题`).not.toBe('')
    }
  })
})
