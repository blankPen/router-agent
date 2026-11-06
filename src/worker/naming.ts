import type { Ticket } from '../core/model.js'

/** 分支名的语义部分最多保留多少字符，避免超出 git / 平台的显示长度。 */
const MAX_SLUG_LENGTH = 36

/** 分支名前缀；与 worker 手册里的 `ra/<工单号>-<语义>` 保持一致。 */
export const BRANCH_PREFIX = 'ra'

/**
 * 把工单标题压成分支名可用的语义 slug。
 *
 * - 标题里有足够英文/数字时优先用它们（`修复 login timeout` → `login-timeout`），
 *   这类分支名在任何平台上都不用转义；
 * - 纯中文标题没有可用的 ASCII 词，就保留中文本身（git 允许 UTF-8 分支名），
 *   总比退化成 `tk-12` 这个纯编号更有语义；
 * - 实在取不到内容时用 `task` 兜底。
 */
export function ticketSlug(title: string, maxLength = MAX_SLUG_LENGTH): string {
  const normalized = title.normalize('NFKC').toLowerCase()
  const ascii = normalized.match(/[a-z0-9]+/g)?.join('-') ?? ''
  const cjk = normalized.match(/[㐀-䶿一-鿿]+/g)?.join('') ?? ''
  const base = ascii.length >= 3 ? ascii : cjk || ascii
  const slug = base
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  return slug || 'task'
}

/** Orca worktree 名：短、纯 ASCII，目录里不会出现中文或 UUID。 */
export function worktreeName(ticket: Pick<Ticket, 'id'>): string {
  return sanitizeName(`ra-${ticket.id}`)
}

/** 实际工作分支：`ra/tk-12-<语义 slug>`，由 Orca 的 `--branch` 直接落成 git 分支名。 */
export function workBranch(ticket: Pick<Ticket, 'id' | 'title'>): string {
  return `${BRANCH_PREFIX}/${ticket.id}-${ticketSlug(ticket.title)}`
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 60)
}
