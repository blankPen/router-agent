/**
 * 飞书事件目录：25 个可订阅事件类型。
 *
 * 类型 id 是我们自己定义的（`feishu.*`），不是飞书的 EventKey（`im.message.receive_v1`）：
 * - EventKey 带协议版本号（`_v1` / `_v4`），版本号不是业务语义，飞书升版会让旧订阅静默失配；
 * - EventKey 命名是飞书 API 的历史包袱（`participant_meeting_started` 里的 participant 是冗余的），
 *   而事件类型 id 会直接出现在自然语言会话的提示词里，id 越短模型越不容易选错。
 *
 * 可用性标注来自实测（`lark-cli event consume <key> --dry-run`，2026-11-26）：
 * 7 个开箱可用、18 个需要先在飞书开放平台订阅事件类型、其中 9 个还需要用户身份。
 */
import type { EventCatalog, EventTypeDescriptor } from '#event/port.js'

/** 飞书事件类型的来源前缀。 */
export const FEISHU_EVENT_PREFIX = 'feishu'

/** 飞书事件类型分组；顺序即面板里的分组顺序。 */
export const FEISHU_EVENT_GROUPS = [
  '消息与互动',
  '群与成员',
  '审批·任务·卡片',
  '文档与会议',
  '应用与白板',
] as const

export type FeishuEventGroup = (typeof FEISHU_EVENT_GROUPS)[number]

/** 一个飞书事件类型的完整定义。 */
export interface FeishuEventTypeDef {
  /** 事件类型 id（带 feishu. 前缀）。 */
  id: string
  /** 面板上显示的人话。 */
  label: string
  /** 分组。 */
  group: FeishuEventGroup
  /** 飞书官方的 EventKey；拉取长连接时用它。 */
  eventKey: string
  /** 开箱可用（当前 app 已订阅且权限齐全）。 */
  ready: boolean
  /** 需要在飞书开放平台订阅该事件类型。 */
  requiresConsoleSubscription?: boolean
  /** 只能用用户身份订阅（bot 身份会被拒）。 */
  requiresUserIdentity?: boolean
  /** 额外需要的权限 scope。 */
  requiresScopes?: string[]
  /** 订阅时必须提供的参数。 */
  requiredParams?: string[]
}

const CONSOLE = { requiresConsoleSubscription: true }
const CONSOLE_USER = { requiresConsoleSubscription: true, requiresUserIdentity: true }

/** 全部 25 个飞书事件类型；与 `lark-cli event list` 一一对应。 */
export const FEISHU_EVENT_TYPES: readonly FeishuEventTypeDef[] = [
  // 档一 · 消息与互动（开箱可用）
  { id: 'feishu.message', label: '群聊 / 私聊消息', group: '消息与互动', eventKey: 'im.message.receive_v1', ready: true },
  { id: 'feishu.message.reaction.created', label: '表情回应', group: '消息与互动', eventKey: 'im.message.reaction.created_v1', ready: true },
  { id: 'feishu.message.reaction.deleted', label: '取消表情', group: '消息与互动', eventKey: 'im.message.reaction.deleted_v1', ready: true },
  { id: 'feishu.message.read', label: '已读回执', group: '消息与互动', eventKey: 'im.message.message_read_v1', ready: true },

  // 档二 · 群与成员
  { id: 'feishu.chat.member.bot.added', label: '机器人被拉进群', group: '群与成员', eventKey: 'im.chat.member.bot.added_v1', ready: true },
  { id: 'feishu.chat.member.bot.deleted', label: '机器人被移出群', group: '群与成员', eventKey: 'im.chat.member.bot.deleted_v1', ready: true },
  { id: 'feishu.chat.member.user.added', label: '有人进群', group: '群与成员', eventKey: 'im.chat.member.user.added_v1', ready: false, ...CONSOLE },
  { id: 'feishu.chat.member.user.deleted', label: '有人退群', group: '群与成员', eventKey: 'im.chat.member.user.deleted_v1', ready: false, ...CONSOLE },
  { id: 'feishu.chat.member.user.withdrawn', label: '邀请被撤回', group: '群与成员', eventKey: 'im.chat.member.user.withdrawn_v1', ready: false, ...CONSOLE },
  { id: 'feishu.chat.updated', label: '群信息变更', group: '群与成员', eventKey: 'im.chat.updated_v1', ready: false, ...CONSOLE },
  { id: 'feishu.chat.disbanded', label: '群解散', group: '群与成员', eventKey: 'im.chat.disbanded_v1', ready: false, ...CONSOLE },

  // 档三 · 审批
  { id: 'feishu.approval.instance.status_changed', label: '审批实例状态变化', group: '审批·任务·卡片', eventKey: 'approval.instance.status_changed_v4', ready: false, ...CONSOLE_USER },
  { id: 'feishu.approval.task.status_changed', label: '审批任务状态变化', group: '审批·任务·卡片', eventKey: 'approval.task.status_changed_v4', ready: false, ...CONSOLE_USER },

  // 档四 · 任务与卡片
  { id: 'feishu.task.updated', label: '飞书任务变更', group: '审批·任务·卡片', eventKey: 'task.task.update_user_access_v2', ready: false, ...CONSOLE },
  { id: 'feishu.card.action', label: '卡片按钮点击', group: '审批·任务·卡片', eventKey: 'card.action.trigger', ready: true },

  // 档五 · 文档与会议
  { id: 'feishu.minute.generated', label: '妙记生成', group: '文档与会议', eventKey: 'minutes.minute.generated_v1', ready: false, ...CONSOLE_USER },
  { id: 'feishu.vc.meeting.started', label: '会议开始', group: '文档与会议', eventKey: 'vc.meeting.participant_meeting_started_v1', ready: false, ...CONSOLE_USER },
  { id: 'feishu.vc.meeting.joined', label: '有人入会', group: '文档与会议', eventKey: 'vc.meeting.participant_meeting_joined_v1', ready: false, ...CONSOLE_USER },
  { id: 'feishu.vc.meeting.ended', label: '会议结束', group: '文档与会议', eventKey: 'vc.meeting.participant_meeting_ended_v1', ready: false, ...CONSOLE_USER },
  { id: 'feishu.vc.note.generated', label: '会议笔记生成', group: '文档与会议', eventKey: 'vc.note.generated_v1', ready: false, ...CONSOLE_USER },
  { id: 'feishu.vc.recording.started', label: '录制开始', group: '文档与会议', eventKey: 'vc.recording.recording_started_v1', ready: false, ...CONSOLE_USER, requiresScopes: ['vc:recording:read'] },
  { id: 'feishu.vc.recording.transcript_generated', label: '录制转写生成', group: '文档与会议', eventKey: 'vc.recording.recording_transcript_generated_v1', ready: false, ...CONSOLE_USER, requiresScopes: ['vc:recording:read'] },
  { id: 'feishu.vc.recording.ended', label: '录制结束', group: '文档与会议', eventKey: 'vc.recording.recording_ended_v1', ready: false, ...CONSOLE_USER, requiresScopes: ['vc:recording:read'] },

  // 档六 · 应用
  { id: 'feishu.bot.menu', label: '机器人菜单点击', group: '应用与白板', eventKey: 'application.bot.menu_v6', ready: false, ...CONSOLE },

  // 档七 · 白板
  { id: 'feishu.whiteboard.updated', label: '白板更新', group: '应用与白板', eventKey: 'board.whiteboard.updated_v1', ready: false, ...CONSOLE, requiredParams: ['whiteboard_id'] },
]

/** 事件类型 id → 定义。 */
const BY_ID = new Map(FEISHU_EVENT_TYPES.map(type => [type.id, type]))

/** EventKey → 事件类型 id；长连接按 EventKey 起进程时要用。 */
const BY_EVENT_KEY = new Map(FEISHU_EVENT_TYPES.map(type => [type.eventKey, type]))

/** 按 id 查飞书事件类型；不在目录里返回 undefined。 */
export function findFeishuEventType(id: string): FeishuEventTypeDef | undefined {
  return BY_ID.get(id.trim())
}

/** 按飞书 EventKey 查事件类型 id。 */
export function feishuTypeIdByEventKey(eventKey: string): string | undefined {
  return BY_EVENT_KEY.get(eventKey.trim())?.id
}

/** 飞书事件目录。 */
export const feishuCatalog: EventCatalog = {
  id: 'feishu',
  kind: 'feishu',
  name: '飞书',
  types: (): EventTypeDescriptor[] =>
    FEISHU_EVENT_TYPES.map(type => ({
      id: type.id,
      label: type.label,
      group: type.group,
      availability: {
        ready: type.ready,
        ...(type.requiresConsoleSubscription ? { requiresConsoleSubscription: true } : {}),
        ...(type.requiresUserIdentity ? { requiresUserIdentity: true } : {}),
        ...(type.requiresScopes ? { requiresScopes: [...type.requiresScopes] } : {}),
        ...(type.requiredParams ? { requiresParams: [...type.requiredParams] } : {}),
        ...(availabilityNote(type) ? { note: availabilityNote(type) } : {}),
      },
    })),
  params: () => [
    { key: 'appId', label: '飞书 App ID', kind: 'text', hint: '事件侧自有应用；与机器人对话用的 app 分开' },
    { key: 'appSecret', label: '飞书 App Secret', kind: 'password' },
    { key: 'home', label: 'lark-cli 配置目录', kind: 'text', hint: '与 Channel 侧隔离，避免两个 app 抢同一条流' },
  ],
}

/** 前置条件的一句话说明，给面板与提示词用。 */
function availabilityNote(type: FeishuEventTypeDef): string {
  const parts: string[] = []
  if (type.requiresConsoleSubscription) parts.push('需在飞书开放平台订阅该事件类型')
  if (type.requiresUserIdentity) parts.push('需用户身份')
  if (type.requiresScopes?.length) parts.push(`需权限 ${type.requiresScopes.join('、')}`)
  if (type.requiredParams?.length) parts.push(`需提供 ${type.requiredParams.join('、')}`)
  return parts.join(' · ')
}
