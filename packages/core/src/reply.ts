/**
 * Worker 交付载荷的中立形态。
 *
 * 内核只描述「要表达什么」，不关心飞书卡片怎么拼；通道适配器按自身能力
 * 逐块渲染，渲染不了时回落到 `fallbackText`。
 */
export type ReplyTone = 'neutral' | 'success' | 'warning' | 'danger'

/** 出站图片：Router 侧上传本地文件，或直接引用已有 URL。 */
export interface ReplyImage {
  /** 本机绝对路径；由 Router 上传后替换成通道图片 key。 */
  path?: string
  /** 已经可访问的图片 URL；有 url 时不用再上传。 */
  url?: string
  alt?: string
}

export interface ReplyField {
  label: string
  value: string
}

export interface ReplyAction {
  label: string
  /** 跳转链接；与 `value` 二选一。 */
  url?: string
  /** 回调按钮携带的值；与 `url` 二选一，由通道回传给 Router。 */
  value?: Record<string, unknown>
}

export interface ReplyOption {
  id: string
  label: string
  description?: string
}

export type ReplyBlock =
  | { type: 'markdown'; text: string }
  | { type: 'image'; image: ReplyImage; caption?: string }
  | { type: 'imagePair'; before: ReplyImage; after: ReplyImage; caption?: string }
  | {
    type: 'card'
    title: string
    tone?: ReplyTone
    markdown?: string
    fields?: ReplyField[]
    actions?: ReplyAction[]
  }
  | {
    type: 'choices'
    questionId: string
    prompt: string
    options: ReplyOption[]
    multi?: boolean
    /** 通道是否能回调；text 时题面补序号，由用户回复序号。 */
    mode?: 'callback' | 'text'
  }
  | { type: 'doc'; title: string; markdown: string }

export interface ReplyPayload {
  blocks: ReplyBlock[]
  /** 必填：纯文本通道 / 卡片失败时的最后兜底。 */
  fallbackText: string
}

export interface ReplyQuestion {
  id: string
  prompt: string
  options: ReplyOption[]
  multi?: boolean
}

/** 带 choices 块的载荷里，第一道题就是本次要创建的 Question。 */
export function choiceBlockOf(payload: ReplyPayload): Extract<ReplyBlock, { type: 'choices' }> | null {
  return payload.blocks.find((block): block is Extract<ReplyBlock, { type: 'choices' }> => block.type === 'choices') ?? null
}

/** 载荷必须有可发送的正文；空块与空文本都不算完整交付。 */
export function isReplyPayload(value: unknown): value is ReplyPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<ReplyPayload>
  if (typeof payload.fallbackText !== 'string' || !Array.isArray(payload.blocks)) return false
  return payload.blocks.length > 0 && payload.blocks.every(isReplyBlock)
}

function isReplyBlock(value: unknown): value is ReplyBlock {
  if (!value || typeof value !== 'object') return false
  const block = value as { type?: unknown }
  switch (block.type) {
    case 'markdown':
      return typeof (value as { text?: unknown }).text === 'string'
    case 'image':
      return isReplyImage((value as { image?: unknown }).image)
    case 'imagePair': {
      const pair = value as { before?: unknown; after?: unknown }
      return isReplyImage(pair.before) && isReplyImage(pair.after)
    }
    case 'card':
      return typeof (value as { title?: unknown }).title === 'string'
        && isOptionalArray((value as { fields?: unknown }).fields, isReplyField)
        && isOptionalArray((value as { actions?: unknown }).actions, isReplyAction)
    case 'choices': {
      const choices = value as { questionId?: unknown; prompt?: unknown; options?: unknown }
      return typeof choices.questionId === 'string'
        && typeof choices.prompt === 'string'
        && Array.isArray(choices.options)
        && choices.options.length >= 2
        && choices.options.every(isReplyOption)
    }
    case 'doc':
      return typeof (value as { title?: unknown }).title === 'string'
        && typeof (value as { markdown?: unknown }).markdown === 'string'
    default:
      return false
  }
}

function isReplyImage(value: unknown): value is ReplyImage {
  if (!value || typeof value !== 'object') return false
  const image = value as ReplyImage
  return (typeof image.path === 'string' && image.path.length > 0)
    || (typeof image.url === 'string' && image.url.length > 0)
}

function isReplyOption(value: unknown): value is ReplyOption {
  if (!value || typeof value !== 'object') return false
  const option = value as ReplyOption
  return typeof option.id === 'string' && typeof option.label === 'string'
}

function isOptionalArray<T>(value: unknown, guard: (item: unknown) => item is T): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.every(guard))
}

function isReplyField(value: unknown): value is ReplyField {
  if (!value || typeof value !== 'object') return false
  const field = value as ReplyField
  return typeof field.label === 'string' && typeof field.value === 'string'
}

function isReplyAction(value: unknown): value is ReplyAction {
  if (!value || typeof value !== 'object') return false
  const action = value as ReplyAction
  if (typeof action.label !== 'string') return false
  if (typeof action.url === 'string') return true
  // 回调按钮：值必须是对象，通道原样回传。
  return typeof action.value === 'object' && action.value !== null && !Array.isArray(action.value)
}
