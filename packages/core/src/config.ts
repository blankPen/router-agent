/**
 * 跨包共享的配置视图。
 *
 * 应用侧 `src/config.ts` 里的 AppConfig 属于装配层，适配器包不应该反向依赖它；
 * 这里只放适配器真正需要的、稳定的字段形状，AppConfig 结构上天然兼容。
 */

/** 群级准入配置：适配器只关心「哪些群、消息范围是什么、名单是谁」。 */
export interface ChatAdmissionSettings {
  chat: string
  /**
   * 消息处理范围：
   * - admins：仅接受管理员消息；
   * - mention：接受普通用户 @ 消息；
   * - all：接受所有消息。
   */
  scope: 'admins' | 'mention' | 'all'
  /** 本群的管理员扩充：在全局默认管理员之外再加这些人。 */
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
