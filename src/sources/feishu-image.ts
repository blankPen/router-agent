import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type { Trigger } from '../core/model.js'
import type { CommandRunner } from '../infra/process.js'
import type { ImageInput, ImageTranscriber } from '../infra/vision.js'

/** 一张图片在飞书消息里的资源标识。 */
export interface FeishuImageRef {
  /** `img_xxx`，下载资源时直接作为 --file-key。 */
  key: string
  /** 资源所属消息；引用图片属于被引用的那条消息，不是当前触发消息。 */
  messageId: string
  /** 是否来自引用的消息，用于文案区分。 */
  quoted?: boolean
}

export interface ImageLogger {
  warn(event: string, fields: Record<string, unknown>): void
}

export interface AttachImageTextOptions {
  runner: CommandRunner
  /** 未配置或模型不可用时传 null，图片保持原样（仍按纯附件处理）。 */
  transcriber?: ImageTranscriber | null
  as?: 'bot' | 'user'
  /** 单条消息最多处理几张图，默认 3。 */
  maxImages?: number
  /** 注入日志，失败时记录原因后按纯附件降级。 */
  logger?: ImageLogger
}

/** `![Image](img_xxx)` / `<img key="img_xxx"/>` / 原始 JSON 三种形态。 */
const IMAGE_KEY_PATTERNS = [
  /!\[[^\]\n]*\]\((img_[A-Za-z0-9_-]+)\)/g,
  /<img\b[^>]*\bkey=["'](img_[A-Za-z0-9_-]+)["'][^>]*\/?>/gi,
  /"image_key"\s*:\s*"(img_[A-Za-z0-9_-]+)"/g,
]
const IMAGE_KEY_RE = /^img_[A-Za-z0-9_-]+$/

/**
 * 从消息 content 里提取 image_key。
 *
 * 事件流里 lark-cli 会把图片 content 预渲染成人类可读文本（如 `![Image](img_xxx)`），
 * 补拉和 `messages-mget` 则可能是原始 JSON（`{"image_key":"img_xxx"}`），两种都要认。
 */
export function parseImageKeysFromContent(content: string): string[] {
  const text = String(content ?? '')
  const keys: string[] = []

  // 原始 JSON（含 post 里的嵌套 img 节点）。
  try {
    const doc = JSON.parse(text) as unknown
    collectJsonImageKeys(doc, keys)
  } catch {
    // 预渲染文本，交给下面的标记匹配。
  }

  for (const pattern of IMAGE_KEY_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      if (match[1]) keys.push(match[1])
    }
  }
  return [...new Set(keys)]
}

function collectJsonImageKeys(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectJsonImageKeys(item, out)
    return
  }
  const obj = node as Record<string, unknown>
  if (typeof obj.image_key === 'string' && IMAGE_KEY_RE.test(obj.image_key)) out.push(obj.image_key)
  if (typeof obj.imageKey === 'string' && IMAGE_KEY_RE.test(obj.imageKey)) out.push(obj.imageKey)
  if (typeof obj.key === 'string' && obj.tag === 'img' && IMAGE_KEY_RE.test(obj.key)) out.push(obj.key)
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'image_key' || key === 'imageKey') continue
    if (value && typeof value === 'object') collectJsonImageKeys(value, out)
  }
}

/** 从 Trigger.raw 里取归一化阶段已经解析出的 image_key。 */
export function imageKeysOf(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return []
  const value = (raw as Record<string, unknown>).imageKeys
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(String).filter(key => IMAGE_KEY_RE.test(key)))]
}

/** 消息类型（归一化阶段写入 raw.messageType）。 */
export function messageTypeOf(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const value = (raw as Record<string, unknown>).messageType
  return typeof value === 'string' ? value : ''
}

/** 引用消息里附带的图片：attachQuotedMessage 回查后写入 raw.quoteImages。 */
export function quoteImageRefsOf(raw: unknown, fallbackMessageId: string): FeishuImageRef[] {
  if (!raw || typeof raw !== 'object') return []
  const value = (raw as Record<string, unknown>).quoteImages
  if (!Array.isArray(value)) return []
  const out: FeishuImageRef[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const key = String(record.key ?? '')
    const messageId = String(record.messageId ?? fallbackMessageId)
    if (IMAGE_KEY_RE.test(key) && messageId) out.push({ key, messageId, quoted: true })
  }
  return out
}

/** 回查单条消息拿 image_key（事件流 content 被预渲染时用）。 */
export function messageImageKeysCommand(messageId: string, as = 'bot'): string[] {
  return ['im', '+messages-mget', '--message-ids', messageId, '--as', as, '--format', 'json']
}

/** 从 `+messages-mget` 的返回里取图片资源 key。 */
export function parseMessageImageKeys(stdout: string, messageId = ''): string[] {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return []
  }
  const root = json as Record<string, any>
  const list = root?.data?.messages ?? root?.messages
  if (!Array.isArray(list)) return []
  const messages = list as Record<string, any>[]
  const message = (messageId ? messages.find(item => String(item.message_id ?? '') === messageId) : undefined) ?? messages[0]
  if (!message) return []
  return parseImageKeysFromContent(String(message.content ?? ''))
}

/** 下载单张图片资源；--output 必须落在 cwd / /tmp / ~/files 之内。 */
export function imageDownloadCommand(messageId: string, fileKey: string, output: string, as = 'bot'): string[] {
  return [
    'im', '+messages-resources-download',
    '--message-id', messageId,
    '--file-key', fileKey,
    '--type', 'image',
    '--output', output,
    '--as', as,
    '--format', 'json',
  ]
}

/** 从下载命令的返回里取本地落盘路径。 */
export function parseSavedPath(stdout: string): string {
  try {
    const doc = JSON.parse(stdout) as Record<string, any>
    const data = doc?.data ?? doc
    const value = data?.saved_path ?? data?.savedPath ?? data?.path ?? doc?.saved_path
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/** 读取图片并识别 MIME；优先看文件头，避免下载器没给扩展名时误判。 */
export function readImageInput(path: string): ImageInput | null {
  if (!existsSync(path)) return null
  const bytes = readFileSync(path)
  if (bytes.length === 0) return null
  return { data: bytes.toString('base64'), mimeType: detectMime(bytes, path) }
}

function detectMime(bytes: Buffer, path: string): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  const ext = extname(path).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return 'image/jpeg'
}

/**
 * 把消息里的图片下载下来、转成文字，拼进 Trigger.text。
 *
 * 任何一步失败都按原样返回：图片仍按「纯附件」处理，由 AgentLoop 回一句请补充文字，
 * 不会因为识图失败把整条消息丢掉。
 */
export async function attachImageText(trigger: Trigger, opts: AttachImageTextOptions): Promise<Trigger> {
  if (!opts.transcriber) return trigger
  const as = opts.as ?? 'bot'
  const maxImages = opts.maxImages && opts.maxImages > 0 ? opts.maxImages : 3
  const raw = trigger.raw

  const sources: FeishuImageRef[] = imageKeysOf(raw).map(key => ({ key, messageId: trigger.externalId }))
  sources.push(...quoteImageRefsOf(raw, trigger.externalId))
  if (sources.length === 0 && messageTypeOf(raw) === 'image') {
    const keys = await lookupImageKeys(trigger, opts.runner, as, opts.logger)
    sources.push(...keys.map(key => ({ key, messageId: trigger.externalId })))
  }
  if (sources.length === 0) return trigger

  const seen = new Set<string>()
  const pairs: { key: string; messageId: string; quoted: boolean; text: string }[] = []
  for (const source of sources.slice(0, maxImages)) {
    const identity = `${source.messageId}:${source.key}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const text = await transcribeOne(source.messageId, source.key, opts, as)
    if (text) pairs.push({ key: source.key, messageId: source.messageId, quoted: Boolean(source.quoted), text })
  }
  if (pairs.length === 0) return trigger

  const cleaned = stripImageMarkers(trigger.text)
  const body = pairs
    .map((pair, index) => {
      const label = pairs.length === 1
        ? (pair.quoted ? '引用图片内容' : '图片内容')
        : `${pair.quoted ? '引用图片' : '图片'}${index + 1}内容`
      return `[${label}] ${pair.text}`
    })
    .join('\n\n')
  const parts = [body]
  if (cleaned && !isPlaceholder(cleaned)) parts.push(cleaned)

  return {
    ...trigger,
    text: parts.join('\n\n'),
    mediaOnly: false,
    raw: {
      ...(raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}),
      images: pairs.map(pair => ({ key: pair.key, messageId: pair.messageId, ...(pair.quoted ? { quoted: true } : {}), text: pair.text })),
    },
  }
}

async function lookupImageKeys(trigger: Trigger, runner: CommandRunner, as: string, logger?: ImageLogger): Promise<string[]> {
  try {
    const res = await runner.run(messageImageKeysCommand(trigger.externalId, as), { timeoutMs: 20_000 })
    if (res.code !== 0) {
      logger?.warn('feishu:image-mget-failed', { id: trigger.externalId, code: res.code, message: res.stderr.slice(0, 200) })
      return []
    }
    return parseMessageImageKeys(res.stdout, trigger.externalId)
  } catch (error) {
    logger?.warn('feishu:image-mget-failed', { id: trigger.externalId, message: errorText(error) })
    return []
  }
}

async function transcribeOne(
  messageId: string,
  key: string,
  opts: AttachImageTextOptions,
  as: string,
): Promise<string | null> {
  if (!opts.transcriber) return null
  const dir = makeTempDir()
  try {
    // 直接给 key 作文件名，让 lark-cli 按 Content-Type 推断扩展名。
    const res = await opts.runner.run(imageDownloadCommand(messageId, key, join(dir, key), as), { timeoutMs: 30_000 })
    if (res.code !== 0) {
      opts.logger?.warn('feishu:image-download-failed', { id: messageId, key, code: res.code, message: res.stderr.slice(0, 200) })
      return null
    }
    const saved = parseSavedPath(res.stdout)
    const path = saved || join(dir, key)
    const input = readImageInput(path)
    if (!input) {
      opts.logger?.warn('feishu:image-read-failed', { id: messageId, key, path })
      return null
    }
    const text = (await opts.transcriber.transcribe(input)).trim()
    return text || null
  } catch (error) {
    opts.logger?.warn('feishu:image-transcribe-failed', { id: messageId, key, message: errorText(error) })
    return null
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响主流程 */ }
  }
}

function makeTempDir(): string {
  // lark-cli 的 --output 只允许 cwd / /tmp / ~/files；macOS 的 os.tmpdir() 不在白名单内。
  const root = process.platform === 'win32' ? tmpdir() : '/tmp'
  return mkdtempSync(join(root, 'ra-image-'))
}

function stripImageMarkers(text: string): string {
  let out = String(text ?? '')
  for (const pattern of IMAGE_KEY_PATTERNS) out = out.replace(pattern, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

function isPlaceholder(text: string): boolean {
  return /^\[(?:图片|附件|文件|image|file)\]$/i.test(text.trim())
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
