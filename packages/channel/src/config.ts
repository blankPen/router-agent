/** 飞书通道自己的配置视图；宿主 AppConfig 结构上兼容，通道包不反向依赖宿主。 */
export interface FeishuChannelSettings {
  appId: string
  allowed: string[]
  chats: import('@router-agent/core/config.js').ChatAdmissionSettings[]
  directMessages: boolean
  botOpenIds: string[]
  botNames: string[]
}

export interface FeishuIdentityConfigView {
  feishu: FeishuChannelSettings
}
