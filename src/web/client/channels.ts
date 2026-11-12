/**
 * 消息渠道的描述注册表。
 *
 * 配置页不再把「飞书」写死成一段分支，而是按描述渲染：
 *   - `blocks`  渠道自己的配置块（字段 + 自定义渲染）；
 *   - `custom`  无法用普通字段表达的专属面板（凭据、授权、目标列表……）；
 *   - `status`  渠道选择器上的状态徽标。
 *
 * 新增渠道 = 新增一个 ChannelDescriptor（描述 + 表单），页面代码不用改。
 * 内核侧已注册的渠道实例由 `GET /api/channels` 给出，按 id 与这里的描述合并。
 */
import type { ConfigDoc } from './api.js'
import type { ConfigBlock, FieldDef } from './fields.js'
import { blockPaths } from './fields.js'
import type { IdentityStatusView } from './identity-status.js'
import type { IconName } from './icons.js'
import type { ProjectDraft } from './config-shared.js'
import { feishuChannel } from './feishu-channel.js'

/** 渠道状态摘要：渠道选择器上的徽标。 */
export interface ChannelStatusSummary {
  label: string
  tone: 'ok' | 'warn' | 'muted'
}

/** 渠道专属面板的入参。 */
export interface ChannelPanelProps {
  draft: ConfigDoc
  /** 默认值快照，用于「恢复默认」。 */
  defaults: ConfigDoc
  setField: (path: string, value: unknown) => void
  errors: Map<string, string>
  identity?: IdentityStatusView
  /** 允许名单有未保存的修改：解析状态还是上一次保存后的结果。 */
  staleIdentity?: boolean
  /** 渠道可绑定的项目清单（群绑定等）。 */
  projects: ProjectDraft[]
  /** 当前 Worker 运行时的名字，用于提示文案。 */
  runtimeLabel: string
  /** 渠道面板写入凭据后回传最新配置。 */
  onConfigSaved: (config: ConfigDoc) => void
  /** 渠道自己的就绪状态回报（初始化页用它判断这一步是否完成）。 */
  onStatus?: (ready: boolean) => void
}

/** 渠道在初始化页要展示的接入项。 */
export interface ChannelSetup {
  /** 初始化页展示的块 id，按顺序渲染。 */
  blocks: string[]
  /** 初始化页额外展示的字段（如「接收私聊」开关）。 */
  fields?: FieldDef[]
}

/** 渠道描述：说明 + 表单。 */
export interface ChannelDescriptor {
  /** 与内核通道实例一致的 id。 */
  id: string
  /** 通道类型（feishu / slack / ...）。 */
  kind: string
  label: string
  /** 一句话说明这个渠道在 Router 里的角色。 */
  summary: string
  icon: IconName
  /** 渠道自己的配置块。 */
  blocks: ConfigBlock[]
  /** 自定义块渲染器，按块 id 取。 */
  custom?: Record<string, (props: ChannelPanelProps & { block: ConfigBlock }) => JSX.Element>
  /** 渠道自己的校验：返回「配置路径 → 错误信息」，空值表示通过。 */
  validate?: (draft: ConfigDoc) => Record<string, string>
  /** 初始化页要展示的接入项；缺省表示该渠道不参与初始化。 */
  setup?: ChannelSetup
  /** 这些路径变更后，身份解析状态就是旧的（面板据此提示）。 */
  identityPaths?: string[]
  /** 渠道状态摘要。 */
  status: (draft: ConfigDoc, identity?: IdentityStatusView) => ChannelStatusSummary
}

/** 已注册的渠道描述；面板按这里的顺序展示渠道列表。 */
export const CHANNELS: ChannelDescriptor[] = [feishuChannel]

export function channelById(id: string): ChannelDescriptor | undefined {
  return CHANNELS.find(channel => channel.id === id)
}

/** 所有渠道的字段路径，用于计算「哪些配置被改过」。 */
export function channelFieldPaths(channels: ChannelDescriptor[]): string[] {
  return channels.flatMap(channel => channel.blocks.flatMap(block => blockPaths(block)))
}

/** 初始化页要展示的块（按渠道描述的顺序）。 */
export function channelSetupBlocks(channel: ChannelDescriptor): ConfigBlock[] {
  const ids = channel.setup?.blocks ?? []
  return ids
    .map(id => channel.blocks.find(block => block.id === id))
    .filter((block): block is ConfigBlock => Boolean(block))
}

/** 初始化页要展示的字段：块内字段 + 渠道声明的额外字段。 */
export function channelSetupFields(channel: ChannelDescriptor): FieldDef[] {
  const extra = channel.setup?.fields ?? []
  const inBlocks = channelSetupBlocks(channel).flatMap(block => block.fields)
  const seen = new Set<string>()
  return [...inBlocks, ...extra].filter(field => {
    if (seen.has(field.path)) return false
    seen.add(field.path)
    return true
  })
}

/** 初始化页要单独展示的字段：不在任何接入块里的那些。 */
export function channelSetupExtraFields(channel: ChannelDescriptor): FieldDef[] {
  const inBlocks = new Set(channelSetupBlocks(channel).flatMap(block => block.fields).map(field => field.path))
  return (channel.setup?.fields ?? []).filter(field => !inBlocks.has(field.path))
}

/** 初始化页涉及的全部配置路径（字段路径 + 块自己管理的路径）。 */
export function channelSetupPaths(channel: ChannelDescriptor): string[] {
  const blocks = channelSetupBlocks(channel)
  const blockPathList = blocks.flatMap(block => blockPaths(block))
  const fieldPathList = (channel.setup?.fields ?? []).map(field => field.path)
  return [...new Set([...blockPathList, ...fieldPathList])]
}

/** 服务端已注册但前端还没有描述的通道：给出占位，避免用户以为渠道不存在。 */
export function mergeChannels(registered: { id: string; kind: string }[]): ChannelDescriptor[] {
  if (registered.length === 0) return CHANNELS
  const known = new Map(CHANNELS.map(channel => [channel.id, channel]))
  const merged: ChannelDescriptor[] = []
  for (const item of registered) {
    merged.push(known.get(item.id) ?? placeholderChannel(item.id, item.kind))
  }
  // 前端有描述但服务端没注册的渠道不展示：它还没真正接入。
  return merged
}

function placeholderChannel(id: string, kind: string): ChannelDescriptor {
  return {
    id,
    kind,
    label: id,
    summary: '该渠道已在内核注册，但面板还没有对应的配置表单。',
    icon: 'radio',
    blocks: [],
    status: () => ({ label: '暂无配置项', tone: 'muted' }),
  }
}
