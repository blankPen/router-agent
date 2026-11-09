/**
 * 图片转文字（多模态模型）的基础设施。
 *
 * 只依赖 OpenAI 兼容的 `/chat/completions` 接口，不引入新 SDK：
 * 飞书图片先由消息层下载成 base64，再交给这里转成可进入研判的文本。
 */

export interface ImageInput {
  /** base64 编码（不含 `data:` 前缀）。 */
  data: string
  /** 如 image/png、image/jpeg。 */
  mimeType: string
}

export interface ImageTranscriber {
  transcribe(image: ImageInput): Promise<string>
}

export interface VisionModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
}

export interface VisionOptions {
  /** 识别提示词；不传用内置的「转写 + 描述」。 */
  prompt?: string
  /** 单张图片的硬超时，默认 60s。 */
  timeoutMs?: number
  /** 转写结果的最大字符数，超出截断。 */
  maxChars?: number
  /** 输出 token 上限，默认 1500。 */
  maxTokens?: number
  /** 测试注入点。 */
  fetchImpl?: typeof fetch
}

export const DEFAULT_VISION_PROMPT = [
  '把这张聊天图片转换成可以直接进入研发研判的纯文本：',
  '1. 逐字转写图片里所有可见文字，保留报错信息、日志、代码、命令行和表格结构；',
  '2. 如果图片是界面截图，说明这是哪个页面/功能区域，以及图里表现出的异常或操作意图；',
  '3. 如果图片是设计稿或流程图，按层级概述它的结构与关键信息。',
  '看不清的内容写「[看不清]」，不要猜测或编造。',
  '直接输出纯文本，不要加 Markdown 代码块，也不要解释你在做什么。',
].join('\n')

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_CHARS = 2_000
const DEFAULT_MAX_TOKENS = 1_500

/** 把 OpenAI 兼容的 baseUrl 规范成 chat/completions 地址。 */
export function chatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '')
  if (!clean) throw new Error('image:vision-base-url-missing')
  if (clean.endsWith('/chat/completions')) return clean
  return `${clean}/chat/completions`
}

/** 从 `chat/completions` 的返回里取 assistant 文本；兼容字符串与分段数组。 */
export function parseChatCompletionText(payload: unknown): string {
  const root = payload as Record<string, any> | null
  const content = root?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part: Record<string, unknown>) => (part && part.type === 'text' ? String(part.text ?? '') : ''))
      .join('')
      .trim()
  }
  return ''
}

/**
 * 创建视觉转写器。
 *
 * 结构性失败（模型不支持图片、接口不存在）会熔断：同一进程里后续图片直接快速失败，
 * 避免每张图都等一次超时、刷一屏同样的错误。
 */
export function createVisionTranscriber(model: VisionModelConfig, opts: VisionOptions = {}): ImageTranscriber {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : DEFAULT_MAX_CHARS
  const maxTokens = opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : DEFAULT_MAX_TOKENS
  const prompt = opts.prompt?.trim() || DEFAULT_VISION_PROMPT
  const url = chatCompletionsUrl(model.baseUrl)
  let unsupported: string | null = null

  return {
    async transcribe(image: ImageInput): Promise<string> {
      if (unsupported) throw new Error(`image:vision-unsupported: ${unsupported}`)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: model.model,
            temperature: model.temperature ?? 0.1,
            max_tokens: maxTokens,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
                ],
              },
            ],
          }),
          signal: controller.signal,
        })
      } catch (error) {
        if (isAbortError(error)) throw new Error(`image:vision-timeout(${timeoutMs}ms)`)
        throw new Error(`image:vision-request-failed: ${errorText(error)}`)
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200)
        // 404/415/422，或 400 且明确提到 image/vision，基本可判定为「这个模型/接口不接受图片」。
        // 「图片太大」之类的 400 不熔断，换一张图仍可能成功。
        const looksUnsupported = response.status === 404 || response.status === 415 || response.status === 422 ||
          (response.status === 400 && /(not|doesn'?t|unsupported).{0,40}(support|image|vision)|modalit|multimodal/i.test(detail))
        if (looksUnsupported) unsupported = `http-${response.status}${detail ? `: ${detail}` : ''}`
        throw new Error(`image:vision-http-${response.status}${detail ? `: ${detail}` : ''}`)
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        throw new Error(`image:vision-invalid-json: ${errorText(error)}`)
      }
      const text = parseChatCompletionText(payload)
      if (!text) throw new Error('image:vision-empty')
      return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
    },
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
