export const REPLY_PREFERENCE_VALUES = {
  回复语言: ['简体中文', '繁體中文', '英语', '日语'],
  回复详略: ['简洁', '详细'],
} as const

export type ReplyPreferenceKey = keyof typeof REPLY_PREFERENCE_VALUES
export type ReplyPreferences = {
  [K in ReplyPreferenceKey]?: (typeof REPLY_PREFERENCE_VALUES)[K][number]
}

export type MemoryChange = {
  [K in ReplyPreferenceKey]: { key: K; value: NonNullable<ReplyPreferences[K]> }
}[ReplyPreferenceKey] | { key: ReplyPreferenceKey; value: null }

export interface MemoryOwner {
  channelId: string
  actorId: string
  /** 空字符串表示同一渠道实例内的跨群偏好。 */
  chatId: string
}
