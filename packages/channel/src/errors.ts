/** 通道层错误：区分可重试与永久失败，避免 Outbox 对永久错误无限退避。 */
export class ChannelError extends Error {
  constructor(
    readonly channelId: string,
    readonly code: string,
    message: string,
    readonly retryable = true,
  ) {
    super(message)
    this.name = 'ChannelError'
  }
}