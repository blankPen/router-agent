/**
 * 订阅参数的探活：确认参数指向的资源真的存在。
 *
 * 建任务时最常见的失败是「格式对、资源不存在」——
 * 比如说「订阅 xxx/yyy 这个仓库」，格式没问题，但仓库根本没建。
 * 任务建好后它会永远等不到事件，用户还以为系统坏了（§12.1 V6）。
 *
 * 探活只在会话建任务时跑一次；跑不动（没装 gh、没登录）时一律放行，
 * 不因为探活能力缺失而挡住用户建任务。
 */
import type { CommandRunner } from '#infra/process.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'

export interface ParamProbeDeps {
  /** 执行 gh 的运行器。 */
  runner: CommandRunner
  logger?: Logger
}

/**
 * 探活一个来源的订阅参数。
 *
 * 返回字符串表示「不能用」，文案直接回给用户；
 * 返回 null 表示通过。
 */
export async function probeSubscriptionParams(
  source: string,
  params: Record<string, string>,
  deps: ParamProbeDeps,
): Promise<string | null> {
  const logger = deps.logger ?? noopLogger
  if (source === 'github') return probeGithubRepo(params.repo ?? '', deps)
  // 其它来源暂不探活：格式与闭集校验已经在解析阶段做过了。
  logger.info('event:param-probe-skipped', { sourceId: source })
  return null
}

/** GitHub 仓库探活：格式先过，再问 gh 仓库在不在。 */
async function probeGithubRepo(repo: string, deps: ParamProbeDeps): Promise<string | null> {
  const logger = deps.logger ?? noopLogger
  const value = repo.trim()
  if (!value) return '订阅哪个仓库？给我 owner/repo 就行。'
  if (!/^[\w.-]+\/[\w.-]+$/.test(value)) {
    return `仓库「${value}」格式不对，要写成 owner/repo（比如 blankPen/router-agent）。`
  }
  let result
  try {
    result = await deps.runner.run(['api', `repos/${value}`], { timeoutMs: 20_000 })
  } catch (error) {
    // 探活失败不等于资源不存在：可能没装 gh、没登录、网络不通。
    // 这时候放行，让任务建起来，问题留给事件拉取时报错。
    logger.warn('event:param-probe-failed', { sourceId: 'github', repo: value, message: errorMessage(error) })
    return null
  }
  if (result.code === 0) return null
  const detail = (result.stderr || result.stdout).toLowerCase()
  // 404 与「找不到」是明确的资源不存在；其它错误（限流、鉴权、网络）一律放行。
  if (result.code === 1 && (detail.includes('not found') || detail.includes('404'))) {
    return `仓库「${value}」不存在或你看不到它；检查一下 owner/repo 拼写，或确认 GitHub 账号有访问权限。`
  }
  logger.warn('event:param-probe-failed', {
    sourceId: 'github',
    repo: value,
    code: result.code,
    message: (result.stderr || result.stdout).slice(0, 200),
  })
  return null
}
