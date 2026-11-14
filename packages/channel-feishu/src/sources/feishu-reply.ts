import type { CardAction, QuestionCardUpdate } from '@router-agent/channel'
import type { ReplyBlock, ReplyOption, ReplyPayload, ReplyTone } from '@router-agent/core/reply.js'
import { normalizeCardMarkdown } from './card-markdown.js'

/** 飞书卡片 1.0 的 header 颜色。 */
const TONE_TEMPLATE: Record<ReplyTone, string> = {
  neutral: 'blue',
  success: 'green',
  warning: 'orange',
  danger: 'red',
}

export interface ReplyCardImage {
  imgKey?: string
  /** 已经是可访问 URL 的图片：直接降级成文字链接。 */
  url?: string
  /** 上传失败时保留图注，卡片降级成文字。 */
  failed?: boolean
}

export type ReplyCardImages = Map<string, ReplyCardImage>

export interface ReplyCardInput {
  payload: ReplyPayload
  images: ReplyCardImages
  /** choices 块用按钮还是序号；由 Router 按通道能力决定。 */
  choicesMode?: 'callback' | 'text'
}

/**
 * 把中立载荷拼成飞书互动卡片（Card 1.0）。
 *
 * 卡片尽量保留所有块；某张图上传失败只降级那一块，不让整条回复丢失。
 */
export function buildReplyCard(input: ReplyCardInput): Record<string, unknown> {
  const { payload, images } = input
  const elements: Record<string, unknown>[] = []
  let header: Record<string, unknown> | undefined
  const cardBlock = payload.blocks.find((block): block is Extract<ReplyBlock, { type: 'card' }> => block.type === 'card')

  if (cardBlock) {
    header = {
      template: TONE_TEMPLATE[cardBlock.tone ?? 'neutral'],
      title: { tag: 'plain_text', content: cardBlock.title },
    }
  }

  for (const block of payload.blocks) {
    switch (block.type) {
      case 'markdown':
        pushMarkdown(elements, block.text)
        break
      case 'image':
        pushImage(elements, block.image.path ?? block.image.url ?? '', block.image.alt ?? '', images, block.caption)
        break
      case 'imagePair':
        pushMarkdown(elements, '**Before**')
        pushImage(elements, block.before.path ?? block.before.url ?? '', block.before.alt ?? 'Before', images, '')
        pushMarkdown(elements, '**After**')
        pushImage(elements, block.after.path ?? block.after.url ?? '', block.after.alt ?? 'After', images, '')
        if (block.caption) pushMarkdown(elements, `同一视口、同一主题：${block.caption}`)
        break
      case 'card': {
        if (block.markdown) pushMarkdown(elements, block.markdown)
        if (block.fields?.length) {
          elements.push({
            tag: 'div',
            fields: block.fields.map(field => ({
              is_short: false,
              text: { tag: 'lark_md', content: `**${field.label}**\n${field.value}` },
            })),
          })
        }
        if (block.actions?.length) {
          elements.push({
            tag: 'action',
            actions: block.actions.map(action => ({
              tag: 'button',
              text: { tag: 'plain_text', content: action.label },
              type: 'default',
              // 回调按钮回传 value；跳转按钮带 url。
              ...(action.value ? { value: action.value } : { url: action.url ?? '' }),
            })),
          })
        }
        break
      }
      case 'choices':
        pushChoices(elements, block.prompt, block.options, block.multi, block.mode ?? input.choicesMode ?? 'text', block.questionId)
        break
      case 'doc':
        pushMarkdown(elements, `**${block.title}**\n\n${block.markdown}`)
        break
    }
  }

  if (elements.length === 0) pushMarkdown(elements, payload.fallbackText)
  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true },
    elements,
  }
  if (header) card.header = header
  return card
}

function pushMarkdown(elements: Record<string, unknown>[], text: string): void {
  const content = normalizeCardMarkdown(text.trim())
  if (!content) return
  elements.push({ tag: 'markdown', content })
}

function pushImage(
  elements: Record<string, unknown>[],
  ref: string,
  alt: string,
  images: ReplyCardImages,
  caption?: string,
): void {
  if (caption) pushMarkdown(elements, caption)
  const uploaded = images.get(ref)
  if (uploaded?.imgKey) {
    elements.push({
      tag: 'img',
      img_key: uploaded.imgKey,
      alt: { tag: 'plain_text', content: alt || '图片' },
    })
    return
  }
  if (uploaded?.url) {
    pushMarkdown(elements, `[${alt || '图片'}](${uploaded.url})`)
    return
  }
  // 图片上传失败不是整条回复失败：保留图注和文件名，至少让人知道缺了什么。
  pushMarkdown(elements, `[图片${uploaded?.failed ? '上传失败' : '不可用'}]${alt ? `：${alt}` : ''}`)
}

function pushChoices(
  elements: Record<string, unknown>[],
  prompt: string,
  options: ReplyOption[],
  multi: boolean | undefined,
  mode: 'callback' | 'text',
  questionId: string,
): void {
  pushMarkdown(elements, prompt)
  if (mode === 'callback') {
    elements.push({
      tag: 'action',
      actions: options.map((option, index) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: option.label },
        type: index === 0 ? 'primary' : 'default',
        value: { questionId, optionId: option.id },
      })),
    })
    if (multi) pushMarkdown(elements, '_可多选；提交后 Router 会把已选项合并成一条回答。_')
    return
  }
  // 无回调通道的正式形态：题面写序号，用户直接回复数字。
  pushMarkdown(
    elements,
    options.map((option, index) => `${index + 1}. ${option.label}${option.description ? `：${option.description}` : ''}`).join('\n')
      + `\n\n回复序号${multi ? '（可回复多个，如 1,3）' : ''}即可，Router 会把答案投给 Worker。`,
  )
}

/** 用户点选后回写的完整卡片：已选 / 已超时都不再出现按钮。 */
export function buildQuestionCard(state: QuestionCardUpdate): Record<string, unknown> {
  const answered = state.selected.length > 0
  const labels = state.question.options
    .filter(option => state.selected.includes(option.id))
    .map(option => option.label)
  const status = state.expired
    ? '已超时（30 分钟未选择）'
    : answered
      ? `已选择：${labels.join('、')}`
      : '等待选择'
  return {
    config: { wide_screen_mode: true },
    header: {
      template: state.expired ? 'orange' : answered ? 'green' : 'blue',
      title: { tag: 'plain_text', content: answered || state.expired ? '问题已关闭' : '需要你的选择' },
    },
    elements: [
      { tag: 'markdown', content: normalizeCardMarkdown(state.question.prompt) },
      { tag: 'markdown', content: `**${status}**` },
      ...(state.operatorId && answered ? [{ tag: 'markdown', content: `操作人：<at id=${state.operatorId}></at>` }] : []),
    ],
  }
}

/**
 * 解析 `card.action.trigger` 的扁平事件。
 *
 * `action_value` 可能是对象，也可能是 JSON 字符串；其他组件（下拉、表单）
 * 不是本协议要处理的按钮，直接丢弃。
 */
export function normalizeCardAction(raw: unknown): CardAction | null {
  if (!raw || typeof raw !== 'object') return null
  const event = raw as Record<string, unknown>
  if (event.action_tag !== 'button') return null
  const value = parseActionValue(event.action_value)
  if (!value) return null
  const chatId = String(event.chat_id ?? '')
  const messageId = String(event.message_id ?? '')
  const operatorId = String(event.operator_id ?? '')
  if (!chatId || !messageId || !operatorId) return null
  return {
    id: String(event.event_id ?? `${messageId}:${operatorId}:${String(event.timestamp ?? '')}`),
    channelId: 'feishu',
    chatId,
    messageId,
    operatorId,
    token: String(event.token ?? ''),
    value,
  }
}

function parseActionValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}
