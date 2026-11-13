/**
 * 跨包共享的配置视图。
 *
 * 应用侧 `src/config.ts` 里的 AppConfig 属于装配层，适配器包不应该反向依赖它；
 * 这里只放适配器真正需要的、稳定的字段形状，AppConfig 结构上天然兼容。
 */

/** 群级准入配置：适配器只关心「哪些群、什么接收方式、名单是谁」。 */
export interface ChatAdmissionSettings {
  chat: string
  /** all：全部消息，且不 @ 也会回复；mention：只收 @机器人。 */
  mode: 'all' | 'mention'
  /** 本群只允许这些 open_id 操作；空表示沿用全局名单。 */
  allowed: string[]
  /** 普通成员消息的终审管理员；邮箱或 open_id。 */
  members?: { approvers?: string[] }
}

/** worker 运行时选项：`runtime.options.<runtimeId>.<key>`。 */
export interface RuntimeSettingsView {
  default: string
  options?: Record<string, unknown>
  /** 运行时插件入口：id → npm 包名 / 本地路径 / 目录。 */
  plugins?: Record<string, unknown>
}

/** 运行时装配用到的配置视图；AppConfig 结构上兼容。 */
export interface RuntimeConfigView {
  runtime: RuntimeSettingsView
}

/** 通道装配用到的配置视图；AppConfig 结构上兼容。 */
export interface ChannelConfigView {
  /** 通道插件入口：id → npm 包名 / 本地路径 / 目录。 */
  channels?: Record<string, unknown>
  feishu: {
    appId: string
    allowed: string[]
    chats: ChatAdmissionSettings[]
    directMessages: boolean
    botOpenIds: string[]
    botNames: string[]
  }
}
