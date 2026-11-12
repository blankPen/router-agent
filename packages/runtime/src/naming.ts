import type { Ticket } from '@router-agent/core/model.js'

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

/**
 * Orca worktree 名：与工作分支一一对应，只把 `/` 换成 `-`。
 *
 * 例如分支 `ra/tk-12-fix-login-timeout` 对应目录 `ra-tk-12-fix-login-timeout`，
 * 在 `orca worktree list` 和文件系统里都能一眼对上，不会再出现「目录 ra-tk-12、
 * 分支 ra/tk-12-fix-login-timeout」这种对不上的情况。
 */
export function worktreeName(ticket: Pick<Ticket, 'id' | 'title'>): string {
  return workBranch(ticket).replace(/\//g, '-')
}

/** 实际工作分支：`ra/tk-12-<语义 slug>`，由 Orca 的 `--branch` 直接落成 git 分支名。 */
export function workBranch(ticket: Pick<Ticket, 'id' | 'title'>): string {
  return `${BRANCH_PREFIX}/${ticket.id}-${ticketSlug(ticket.title)}`
}
