import type { ChannelPlugin } from '@router-agent/channel'
import { FeishuChannel } from './feishu/index.js'
import type { FeishuChannelHooks } from './feishu/index.js'
import type { ImageTranscriber } from '@router-agent/infra/vision.js'
import type { UnaddressedAdmission } from './sources/feishu.js'

interface FeishuPluginServices {
  config?: Record<string, unknown>
  reaction?: string
  directory?: { nameOf(chatId: string): string }
  transcriber?: ImageTranscriber | null
  imagesRoot?: string
  allowUnaddressed?: UnaddressedAdmission
  hooks?: FeishuChannelHooks
  env?: Record<string, string | undefined>
}

const plugin: ChannelPlugin = {
  kind: 'channel',
  meta: {
    id: 'feishu',
    packageName: '@router-agent/channel-feishu',
    name: '飞书',
    hint: '飞书机器人消息、话题回复、互动卡片与 lark-cli 授权',
    default: true,
  },
  create(ctx) {
    const services = (ctx.services?.feishu ?? {}) as FeishuPluginServices
    const feishu = (services.config ?? ctx.config.feishu) as Record<string, unknown> | undefined
    if (!feishu) return null
    const chats = Array.isArray(feishu.chats) ? feishu.chats as never[] : []
    const config = {
      ...feishu,
      appId: typeof feishu.appId === 'string' ? feishu.appId : '',
      reaction: typeof feishu.reaction === 'string' ? feishu.reaction : 'Typing',
      chats,
      directMessages: feishu.directMessages !== false,
      allowed: Array.isArray(feishu.allowed) ? feishu.allowed as string[] : [],
      bots: Array.isArray(feishu.bots) ? feishu.bots as string[] : [],
      botOpenIds: Array.isArray(feishu.botOpenIds) ? feishu.botOpenIds as string[] : [],
      botNames: Array.isArray(feishu.botNames) ? feishu.botNames as string[] : [],
      images: feishu.images ?? { enabled: true, maxChars: 2000, timeoutMs: 60000 },
    }
    return new FeishuChannel({
      config: config as never,
      reaction: services.reaction ?? config.reaction,
      runner: ctx.runner('lark-cli'),
      logger: ctx.logger,
      ...(services.directory ? { directory: services.directory } : {}),
      ...(services.transcriber !== undefined ? { transcriber: services.transcriber } : {}),
      ...(services.imagesRoot ? { imagesRoot: services.imagesRoot } : {}),
      ...(services.allowUnaddressed ? { allowUnaddressed: services.allowUnaddressed } : {}),
      ...(services.hooks ? { hooks: services.hooks } : {}),
      ...(services.env ? { env: services.env } : {}),
    })
  },
}

export default plugin
export * from './feishu/index.js'
export * from './sources/feishu.js'
export * from './sources/feishu-image.js'
export * from './sources/feishu-bot-admin.js'
export * from './sources/feishu-directory.js'
export * from './sources/feishu-identity.js'
export * from './sources/lark.js'
export { createEffectsSender, type FeishuOutbound } from './legacy.js'
