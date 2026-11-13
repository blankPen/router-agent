import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ReplyBlock, ReplyImage, ReplyOption, ReplyPayload } from '#core/reply.js'

export interface ReplyOptions {
  ticket: string
  state?: string
  summary?: string
  assignment?: string
  turn?: string
  humanAction?: string
  prNumber?: string
  prUrl?: string
  /** 简写：`--pr` 与 `--pr-number` 等价。 */
  pr?: string
  /** 显式声明本次改动是否涉及 UI；不传时 Router 按改动文件推断。 */
  uiChange?: boolean | string
  /** 要发给发起人的完整回复：字面量、`@文件路径` 或 `-`（从 stdin 读）。 */
  body?: string
  /** `ra report` 别名沿用的旧参数名。 */
  reply?: string
  kind?: string
  /** 可重复的图片参数：`before=./a.png` / `after=./b.png` / `./c.png`。 */
  image?: string[]
  images?: string[]
  ask?: boolean
  question?: string
  /** 可重复的选项：`标识|说明`。 */
  option?: string[]
  options?: string[]
  multi?: boolean
  ack?: string[]
}

export interface ReplyDeps {
  home: string
  port: number
  stdout(line: string): void
  stderr(line: string): void
  fetchImpl?: typeof fetch
  stdin?: () => string
  now?: () => string
  /** 注入点：测试替换文档创建；生产由 CLI 用 lark-cli。 */
  createDocument?: (title: string, markdown: string) => Promise<string>
  /** 兼容旧调用方。 */
  documenter?: { createDocument(title: string, markdown: string): Promise<string> }
}

const STATES = ['progress', 'ready', 'blocked', 'failed', 'dropped', 'waiting']
const KINDS = ['auto', 'text', 'markdown', 'image', 'images', 'pr', 'doc', 'ask']

interface ReplyBuild {
  payload?: ReplyPayload
  /** 无结构化块时仍走旧的纯文本回复路径。 */
  reply: string
  summary: string
}

/**
 * Worker 的统一上报入口：优先 POST 给本地 Router，服务不可用时落回 state.json。
 *
 * `ra reply` 与旧 `ra report` 共用这一实现；别名只做参数映射。
 */
export async function runReply(deps: ReplyDeps, opts: ReplyOptions): Promise<number> {
  const state = (opts.state ?? 'ready').trim()
  if (!STATES.includes(state)) {
    deps.stderr(`非法 state: ${state}（可选 ${STATES.join(' / ')}）`)
    return 2
  }
  if (!opts.ticket.trim()) {
    deps.stderr('--ticket 不能为空')
    return 2
  }

  const kind = String(opts.kind ?? 'auto').trim()
  if (!KINDS.includes(kind)) {
    deps.stderr(`非法 kind: ${kind}（可选 ${KINDS.join(' / ')}）`)
    return 2
  }

  let built: ReplyBuild
  try {
    built = await buildReply(deps, opts, kind)
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    return 2
  }

  const reply = built.reply.trim()
  if (!reply && !built.payload && !built.summary.trim()) {
    deps.stderr('回复不能为空：用 --body / --image / --ask 或 --kind doc 指定内容')
    return 2
  }

  const uiChange = parseUiChangeFlag(opts.uiChange)
  if (uiChange === null) {
    deps.stderr('--ui-change 只接受 true / false')
    return 2
  }

  const prNumber = opts.prNumber ?? opts.pr
  const payload = {
    ticketId: opts.ticket.trim(),
    ...(opts.assignment ? { assignmentId: opts.assignment } : {}),
    ...(opts.turn ? { turn: Number(opts.turn) } : {}),
    state,
    summary: built.summary,
    ...(opts.humanAction ? { humanAction: opts.humanAction } : {}),
    ...(prNumber ? { prNumber: Number(prNumber) } : {}),
    ...(opts.prUrl ? { prUrl: opts.prUrl } : {}),
    ...(uiChange !== undefined ? { uiChange } : {}),
    ...(reply ? { reply } : {}),
    ...(built.payload ? { replyPayload: built.payload } : {}),
    ackedInputs: opts.ack ?? [],
    updatedAt: (deps.now ?? (() => new Date().toISOString()))(),
  }

  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(`http://127.0.0.1:${deps.port}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    if (res.ok) {
      const body = safeJson(text)
      deps.stdout(`已上报 ${payload.ticketId}  state=${state}  turn=${body?.turn ?? opts.turn ?? '?'}${reply ? `  回复=${reply.length}字` : ''}`)
      return 0
    }
    // 4xx 是参数 / 门禁拒绝，落文件也没用；把服务端原因完整带出来。
    if (res.status < 500) {
      const reason = safeJson(text)?.message
      deps.stderr(`上报失败(${res.status})：${typeof reason === 'string' && reason ? reason : text.slice(0, 300)}`)
      return 1
    }
    deps.stderr(`Router 服务异常(${res.status})，改为写入本地 state.json`)
  } catch (error) {
    deps.stderr(`Router 服务不可达（${error instanceof Error ? error.message : String(error)}），改为写入本地 state.json`)
  }

  return writeFallback(deps, payload)
}

/** 旧命令名保留为别名；参数原样映射。 */
export const runReport = runReply

export function readContentArg(deps: Pick<ReplyDeps, 'stdin'>, value?: string): string {
  if (!value) return ''
  if (value === '-') return deps.stdin ? deps.stdin() : readFileSync(0, 'utf8')
  if (value.startsWith('@')) return readFileSync(resolve(value.slice(1)), 'utf8')
  return value
}

async function buildReply(deps: ReplyDeps, opts: ReplyOptions, kind: string): Promise<ReplyBuild> {
  const body = readContentArg(deps, opts.body ?? opts.reply).trim()
  // 兼容旧用法：只给 summary 的 `ra report` 仍然可以上报，Router 会提示交付不完整。
  if (!body && !hasStructuredInput(opts)) {
    const summary = opts.summary?.trim() ?? ''
    if (kind !== 'auto' || !summary) {
      throw new Error('回复不能为空：用 --body / --image / --ask 或 --kind doc 指定内容')
    }
    return { reply: '', summary }
  }
  const resolvedKind = kind === 'auto' ? inferKind(opts, body) : kind
  const images = normalizeImageArgs(opts)
  if (images.length > 6) throw new Error('--image 最多 6 张')

  if (resolvedKind === 'text') {
    if (!body) throw new Error('--kind text 需要 --body')
    return { reply: body, summary: summaryOf(opts, body) }
  }

  if (resolvedKind === 'markdown') {
    if (!body) throw new Error('--kind markdown 需要 --body')
    return {
      reply: body,
      summary: summaryOf(opts, body),
      payload: { blocks: [{ type: 'markdown', text: body }], fallbackText: body },
    }
  }

  if (resolvedKind === 'image' || resolvedKind === 'images') {
    if (images.length === 0) throw new Error(`--kind ${resolvedKind} 需要 --image`)
    const blocks = [...(body ? [{ type: 'markdown' as const, text: body }] : []), ...imageBlocks(images)]
    const fallback = fallbackOf(body, images)
    return { reply: fallback, summary: summaryOf(opts, body || fallback), payload: { blocks, fallbackText: fallback } }
  }

  if (resolvedKind === 'pr') {
    const prNumber = opts.prNumber ?? opts.pr ?? ''
    if (!prNumber && !opts.prUrl) throw new Error('--kind pr 需要 --pr 或 --pr-url')
    const url = opts.prUrl ?? ''
    const title = `PR${prNumber ? ` #${prNumber}` : ''}`
    const fallback = [body, url ? `PR：${url}` : ''].filter(Boolean).join('\n\n')
    const blocks: ReplyBlock[] = [{
      type: 'card',
      title,
      tone: 'success',
      ...(body ? { markdown: body } : {}),
      ...(url ? { actions: [{ label: '打开 PR', url }] } : {}),
    }, ...imageBlocks(images)]
    return { reply: fallback, summary: summaryOf(opts, body || title), payload: { blocks, fallbackText: fallback } }
  }

  if (resolvedKind === 'doc') {
    if (!body) throw new Error('--kind doc 需要 --body')
    const title = opts.summary?.trim() || body.split('\n')[0]?.slice(0, 60) || opts.ticket
    let url = ''
    const create = deps.createDocument ?? deps.documenter?.createDocument
    try {
      if (!create) throw new Error('当前环境没有文档创建能力')
      url = await create(title, body)
    } catch (error) {
      deps.stderr(`文档创建失败，改为直接发送正文：${error instanceof Error ? error.message : String(error)}`)
    }
    const text = url ? `[${title}](${url})` : body
    const fallback = url ? `${title}\n${url}` : body
    return {
      reply: fallback,
      summary: summaryOf(opts, body),
      payload: { blocks: [{ type: 'markdown', text }], fallbackText: fallback },
    }
  }

  if (resolvedKind === 'ask') {
    const question = (opts.question ?? '').trim()
    const options = parseOptions(opts)
    if (!question) throw new Error('--kind ask 需要 --question')
    if (options.length < 2) throw new Error('--kind ask 至少需要两个 --option')
    const fallback = `${question}\n${options.map((option, index) => `${index + 1}. ${option.label}`).join('\n')}`
    return {
      reply: fallback,
      summary: summaryOf(opts, `等待选择：${question}`),
      payload: {
        blocks: [{
          type: 'choices',
          // Router 会在入库时生成稳定的 questionId（q_<ticket>_<turn>）。
          questionId: '',
          prompt: question,
          options,
          ...(opts.multi ? { multi: true } : {}),
        }],
        fallbackText: fallback,
      },
    }
  }

  throw new Error('无法推断回复形态：请给 --body / --image / --ask / --kind')
}

function hasStructuredInput(opts: ReplyOptions): boolean {
  return Boolean(opts.ask || opts.question || opts.prNumber || opts.pr || opts.prUrl)
    || normalizeImageArgs(opts).length > 0
    || (opts.option?.length ?? 0) > 0
}

function inferKind(opts: ReplyOptions, body: string): string {
  if (opts.ask || opts.question || (opts.option?.length ?? 0) > 0) return 'ask'
  if (opts.prNumber || opts.pr || opts.prUrl) return 'pr'
  if (normalizeImageArgs(opts).length > 0) return 'images'
  if (body) return 'markdown'
  throw new Error('auto 无法推断回复形态：请给 --body / --image / --ask')
}

interface LabeledImage extends ReplyImage {
  path: string
  label: 'before' | 'after' | ''
}

function normalizeImageArgs(opts: ReplyOptions): LabeledImage[] {
  return [...(opts.image ?? []), ...(opts.images ?? [])].map(raw => {
    if (raw.startsWith('before=')) return { path: imagePath(raw.slice('before='.length)), label: 'before' as const }
    if (raw.startsWith('after=')) return { path: imagePath(raw.slice('after='.length)), label: 'after' as const }
    return { path: imagePath(raw), label: '' as const }
  }).filter(image => image.path.trim())
}

/** 本地图片转绝对路径：Router 可能不在 worker 的 cwd 下；URL / data URI 原样保留。 */
function imagePath(path: string): string {
  const value = path.trim()
  if (!value || isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  return resolve(value)
}

function imageBlocks(images: LabeledImage[]): ReplyBlock[] {
  const before = images.find(image => image.label === 'before')
  const after = images.find(image => image.label === 'after')
  const blocks: ReplyBlock[] = []
  if (before && after) {
    blocks.push({
      type: 'imagePair',
      before: { path: before.path, alt: 'Before' },
      after: { path: after.path, alt: 'After' },
      caption: '同一场景、同一视口、同一主题',
    })
  }
  for (const image of images) {
    if (before && after && (image === before || image === after)) continue
    const caption = image.label === 'before' ? 'Before（基线）' : image.label === 'after' ? 'After（本分支）' : undefined
    blocks.push({
      type: 'image',
      image: { path: image.path, alt: image.label || '图片' },
      ...(caption ? { caption } : {}),
    })
  }
  return blocks
}

function fallbackOf(body: string, images: LabeledImage[]): string {
  const imageLines = images.map(image => `图片：${image.path}${image.label ? `（${image.label}）` : ''}`)
  return [body, ...imageLines].filter(Boolean).join('\n\n')
}

function parseOptions(opts: ReplyOptions): ReplyOption[] {
  return [...(opts.option ?? []), ...(opts.options ?? [])].map(raw => {
    const [id, description] = raw.split('|')
    const key = (id ?? '').trim()
    return { id: key, label: key, ...(description?.trim() ? { description: description.trim() } : {}) }
  }).filter(option => option.id)
}

function summaryOf(opts: ReplyOptions, fallback: string): string {
  const summary = (opts.summary ?? '').trim()
  if (summary) return summary
  const line = fallback.split('\n')[0]?.trim() ?? ''
  return (line || opts.ticket).slice(0, 80)
}

function parseUiChangeFlag(value: boolean | string | undefined): boolean | undefined | null {
  if (value === undefined) return undefined
  if (value === true || value === false) return value
  const text = String(value).trim().toLowerCase()
  if (text === 'true' || text === 'yes' || text === '1') return true
  if (text === 'false' || text === 'no' || text === '0') return false
  return null
}

/** 服务不可用时沿用旧的文件通道：写 state.json，由 poller 1 秒内捡起。 */
function writeFallback(
  deps: Pick<ReplyDeps, 'home' | 'stdout' | 'stderr'>,
  payload: {
    ticketId: string
    assignmentId?: string
    turn?: number
    state: string
    summary: string
    humanAction?: string
    prNumber?: number
    prUrl?: string
    uiChange?: boolean
    reply?: string
    replyPayload?: ReplyPayload
    ackedInputs: string[]
    updatedAt: string
  },
): number {
  const dir = join(deps.home, 'workers', payload.ticketId)
  const statePath = join(dir, 'state.json')
  let turn = payload.turn
  if (turn === undefined) {
    const existing = readJson(statePath)
    turn = Number(existing?.turn ?? 0) + 1
  }
  const file = {
    ticket_id: payload.ticketId,
    assignment_id: payload.assignmentId ?? String(readJson(join(dir, 'meta.json'))?.assignmentId ?? ''),
    turn,
    state: payload.state,
    summary: payload.summary,
    human_action: payload.humanAction ?? null,
    pr_number: payload.prNumber ?? 0,
    pr_url: payload.prUrl ?? '',
    ...(payload.uiChange !== undefined ? { ui_change: payload.uiChange } : {}),
    ...(payload.reply ? { reply: payload.reply } : {}),
    ...(payload.replyPayload ? { reply_payload: payload.replyPayload } : {}),
    acked_inputs: payload.ackedInputs,
    updated_at: payload.updatedAt,
  }
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    const tmp = `${statePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    renameSync(tmp, statePath)
    deps.stdout(`已写入 ${statePath}（turn=${turn}，Router 轮询后生效）`)
    // 服务不可达不是参数错误：正文已落盘；用 3 区分「需要 Router 起来再处理」。
    return 3
  } catch (error) {
    deps.stderr(`写入 state.json 失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function readJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
  } catch {
    return null
  }
}

function safeJson(text: string): Record<string, any> | null {
  try {
    return JSON.parse(text) as Record<string, any>
  } catch {
    return null
  }
}
