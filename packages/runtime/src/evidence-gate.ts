/**
 * UI 证据门禁：Worker 报 ready 前检查 PR / MR 描述里是否有 Before / After 对比证据。
 *
 * 判定顺序：
 * 1. 只处理 `ready`；progress / blocked / failed 一律放行。
 * 2. UI 工单判定优先用 Worker 的显式声明（`--ui-change`），未声明时按改动文件路径推断。
 * 3. 无法完成判断（workdir 丢失、git 查询失败、PR 查询失败）时放行并记 `report:evidence-unverified`，
 *    避免把「验证不了」误判成「缺证据」；真正缺失才拦截或告警。
 */
import { existsSync } from 'node:fs'
import type { CommandRunner } from '@router-agent/infra/process.js'
import type { PrInfo } from '@router-agent/core/pr.js'

/** 门禁档位：off=关闭；warn=只记日志不拦；enforce=拦截 ready。 */
export type UiEvidenceMode = 'off' | 'warn' | 'enforce'

export const UI_EVIDENCE_MODES: readonly UiEvidenceMode[] = ['off', 'warn', 'enforce']

/** 门禁需要的最小上报字段。 */
export interface EvidenceReport {
  state: string
  summary: string
  prNumber: number
  prUrl: string
  /** Worker 显式声明：true=改了 UI，false=明确没改 UI，undefined=交给路径推断。 */
  uiChange?: boolean
}

export interface EvidenceContext {
  ticketId: string
  repo: string
  branch: string
  workdir?: string
  mode: UiEvidenceMode
}

export interface EvidenceDeps {
  git: CommandRunner
  /** 查询 PR / MR 详情（需要 body）。 */
  prView: (repo: string, number: number, hint: { url?: string; cwd?: string }) => Promise<PrInfo | null>
}

export type EvidenceMissingReason = 'no-pr' | 'missing-labels' | 'missing-images'
export type EvidenceUnverifiedReason = 'workdir-missing' | 'changed-files-unknown' | 'pr-unavailable' | 'pr-body-unavailable'

export interface EvidenceDecision {
  /** 是否真正执行了 UI 判定。 */
  checked: boolean
  ui: boolean
  action: 'allow' | 'reject'
  /** 缺证据时命中的原因（warn 模式下 action 仍是 allow）。 */
  reason?: EvidenceMissingReason
  /** 缺证据的细节，直接用于日志与 422 文案。 */
  missing: string[]
  /** 无法判断时给出的降级原因。 */
  unverified?: EvidenceUnverifiedReason
  /** UI 判定的来源：显式声明或改动文件。 */
  source?: 'declared' | 'paths'
}

/** 证据缺失且当前档位为 enforce 时抛出；由 API 层映射成 422。 */
export class ReportRejectedError extends Error {
  constructor(
    readonly code: 'evidence-missing',
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ReportRejectedError'
  }
}

/** 前端常见扩展名；测试、快照、故事文件不算 UI 改动。 */
const UI_EXTENSION = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|styl|html?|hbs|handlebars|ejs|pug)$/i
/** 前端常见目录；只命中这些目录下的文件才推断为 UI 改动。 */
const UI_DIRECTORY = /(^|\/)(web|frontend|client|ui|pages|components|views|styles|layouts|templates)\//i
/** 测试 / 快照 / 脚手架文件不改变线上界面。 */
const NON_UI_FILE = /(^|\/)(__tests__|__snapshots__|stories|storybook)\/|\.(test|spec|stories)\.[^/]+$/i

/** 改动文件是否属于前端路径。 */
export function isUiPath(file: string): boolean {
  const path = file.trim().replace(/\\/g, '/')
  if (!path || NON_UI_FILE.test(path)) return false
  return UI_EXTENSION.test(path) || UI_DIRECTORY.test(path)
}

const BEFORE_LABEL = /(^|[^a-z])before([^a-z]|$)|改动前|变更前|修改前|之前/i
const AFTER_LABEL = /(^|[^a-z])after([^a-z]|$)|改动后|变更后|修改后|之后/i
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
const HTML_IMAGE = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
const HTML_VIDEO = /<(?:video|source)[^>]+src=["']([^"']+)["'][^>]*>/gi
const RAW_VISUAL_URL = /https?:\/\/[^\s<>()"']+\.(?:png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v)(?:\?[^\s<>()"']*)?/gi

/** 统计描述里的截图 / 录屏链接数量（去重）。 */
export function countVisualLinks(body: string): number {
  const links = new Set<string>()
  for (const re of [MARKDOWN_IMAGE, HTML_IMAGE, HTML_VIDEO, RAW_VISUAL_URL]) {
    re.lastIndex = 0
    for (const match of body.matchAll(re)) {
      const value = (match[1] ?? match[0]).trim()
      if (value) links.add(value)
    }
  }
  return links.size
}

export interface EvidenceBodyFacts {
  before: boolean
  after: boolean
  imageLinks: number
  missing: string[]
}

/** 解析 PR / MR 描述：必须同时出现 Before / After 标识，且至少两个可视化链接。 */
export function analyzeEvidenceBody(body: string): EvidenceBodyFacts {
  const before = BEFORE_LABEL.test(body)
  const after = AFTER_LABEL.test(body)
  const imageLinks = countVisualLinks(body)
  const missing: string[] = []
  if (!before) missing.push('Before 标识')
  if (!after) missing.push('After 标识')
  if (imageLinks < 2) missing.push(`至少 2 个截图或录屏链接（当前 ${imageLinks} 个）`)
  return { before, after, imageLinks, missing }
}

/**
 * 计算工作分支相对起始分支的改动文件。
 * 依次尝试 origin/<base> 的 merge-base、本地 <base>；用 `git diff <sha>` 同时覆盖已提交与未提交改动，
 * 再补上未跟踪文件。全部失败返回 null。
 */
export async function changedFilesSince(
  git: CommandRunner,
  workdir: string,
  baseBranch: string,
): Promise<string[] | null> {
  const base = baseBranch.trim()
  const refs = [`origin/${base}`, base].filter(ref => ref !== 'origin/')
  for (const ref of refs) {
    try {
      const mergeBase = await git.run(['merge-base', 'HEAD', ref], { cwd: workdir, timeoutMs: 10_000 })
      const sha = mergeBase.stdout.trim()
      if (mergeBase.code !== 0 || !sha) continue
      const diff = await git.run(['diff', '--name-only', sha], { cwd: workdir, timeoutMs: 10_000 })
      if (diff.code !== 0) continue
      const untracked = await git.run(['ls-files', '--others', '--exclude-standard'], { cwd: workdir, timeoutMs: 10_000 })
      return unique([...splitLines(diff.stdout), ...splitLines(untracked.code === 0 ? untracked.stdout : '')])
    } catch {
      // 单个 ref 查询失败继续试下一个；最终仍失败由调用方按「无法判断」放行。
    }
  }
  try {
    const diff = await git.run(['diff', '--name-only', 'HEAD'], { cwd: workdir, timeoutMs: 10_000 })
    if (diff.code === 0) return splitLines(diff.stdout)
  } catch {
    // 交给调用方降级。
  }
  return null
}

function splitLines(value: string): string[] {
  return value.split('\n').map(line => line.trim()).filter(Boolean)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/** 判断这次上报是否需要 UI 证据；无法推断时返回 unverified。 */
async function detectUiChange(
  report: EvidenceReport,
  ctx: EvidenceContext,
  git: CommandRunner,
): Promise<Pick<EvidenceDecision, 'ui' | 'source' | 'unverified'>> {
  if (report.uiChange === true) return { ui: true, source: 'declared' }
  if (report.uiChange === false) return { ui: false, source: 'declared' }
  if (!ctx.workdir || !existsSync(ctx.workdir)) return { ui: false, unverified: 'workdir-missing' }
  const files = await changedFilesSince(git, ctx.workdir, ctx.branch)
  if (files === null) return { ui: false, unverified: 'changed-files-unknown' }
  return { ui: files.some(isUiPath), source: 'paths' }
}

/**
 * 评估一次上报。
 * `action: reject` 只在 enforce 且确认缺证据时出现；warn 模式返回 allow 但带 reason。
 */
export async function evaluateUiEvidence(
  report: EvidenceReport,
  ctx: EvidenceContext,
  deps: EvidenceDeps,
): Promise<EvidenceDecision> {
  const allow = (extra: Partial<EvidenceDecision> = {}): EvidenceDecision => ({
    checked: false,
    ui: false,
    action: 'allow',
    missing: [],
    ...extra,
  })

  if (ctx.mode === 'off' || report.state !== 'ready') return allow()

  const detected = await detectUiChange(report, ctx, deps.git)
  if (detected.unverified) return allow(detected)
  if (!detected.ui) return allow(detected)

  const base: EvidenceDecision = { checked: true, ui: true, action: 'allow', missing: [], ...(detected.source ? { source: detected.source } : {}) }
  if (report.prNumber <= 0) {
    return {
      ...base,
      action: ctx.mode === 'enforce' ? 'reject' : 'allow',
      reason: 'no-pr',
      missing: ['PR / MR 编号或链接'],
    }
  }

  let pr: PrInfo | null = null
  try {
    pr = await deps.prView(ctx.repo, report.prNumber, {
      ...(report.prUrl ? { url: report.prUrl } : {}),
      ...(ctx.workdir ? { cwd: ctx.workdir } : {}),
    })
  } catch {
    return allow({ ...base, checked: false, ui: true, unverified: 'pr-unavailable' })
  }
  if (!pr) return allow({ ...base, checked: false, ui: true, unverified: 'pr-unavailable' })
  if (typeof pr.body !== 'string') {
    return allow({ ...base, checked: false, ui: true, unverified: 'pr-body-unavailable' })
  }

  const facts = analyzeEvidenceBody(pr.body)
  if (facts.missing.length === 0) return base
  return {
    ...base,
    action: ctx.mode === 'enforce' ? 'reject' : 'allow',
    reason: !facts.before || !facts.after ? 'missing-labels' : 'missing-images',
    missing: facts.missing,
  }
}

/** 把判定结果落成日志字段，warn / reject 共用。 */
export function decisionLogDetail(
  decision: EvidenceDecision,
  ctx: Pick<EvidenceContext, 'ticketId' | 'mode'>,
): Record<string, unknown> {
  return {
    ticketId: ctx.ticketId,
    mode: ctx.mode,
    action: decision.action,
    ...(decision.source ? { source: decision.source } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.unverified ? { unverified: decision.unverified } : {}),
    ...(decision.missing.length > 0 ? { missing: decision.missing.join('；') } : {}),
  }
}

/** 422 返回给 Worker 的文案：给补证路径，也给「确实截不了」的退路。 */
export function evidenceRejectedMessage(decision: EvidenceDecision): string {
  const detail = decision.missing.length > 0 ? decision.missing.join('；') : '未找到 Before / After 证据'
  return [
    `UI 工单缺少 PR / MR 证据：${detail}。`,
    '请补齐 Before / After 截图或录屏后，重新用 --state ready 上报。',
    '如果确实无法截图（没有可用环境、需要登录态、拿不到真实基线等），请改用 --state blocked，并在 --human-action 里说明具体限制。',
  ].join('\n')
}
