import type { Attachment } from '#core/model.js'

/**
 * 从 Trigger.raw 里读 Router 已落盘的附件。
 *
 * Source（当前是飞书图片链路）负责把附件写进 raw.attachments；
 * Engine / Worker 只认这个通用结构，不感知具体 Source 的消息格式。
 */
export function attachmentsOf(raw: unknown): Attachment[] {
  if (!raw || typeof raw !== 'object') return []
  const value = (raw as Record<string, unknown>).attachments
  if (!Array.isArray(value)) return []
  const out: Attachment[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path.trim() : ''
    if (!path || seen.has(path)) continue
    seen.add(path)
    const mimeType = typeof record.mimeType === 'string' && record.mimeType.trim() ? record.mimeType.trim() : 'application/octet-stream'
    out.push({ path, mimeType, ...(record.quoted === true ? { quoted: true } : {}) })
  }
  return out
}

/** 附件在追问文本里的清单，Worker 收到后可直接 Read。 */
export function attachmentManifest(attachments: Attachment[]): string {
  if (attachments.length === 0) return ''
  const lines = attachments.map(item => `- ${item.path}${item.quoted ? '（引用消息里的图片）' : ''}`)
  return ['【原始图片已落盘，可直接用 Read 查看】', ...lines].join('\n')
}

/** 把附件清单拼到一段文本后面；没有附件时原样返回。 */
export function withAttachmentManifest(text: string, attachments: Attachment[]): string {
  const manifest = attachmentManifest(attachments)
  return manifest ? [text.trim(), manifest].filter(Boolean).join('\n\n') : text
}
