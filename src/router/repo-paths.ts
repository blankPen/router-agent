import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { CommandRunner } from '#infra/process.js'
import { parseOrcaRepos } from '@router-agent/channel-feishu'

/** orca repo list 的超时：超过就按「拿不到路径」处理，退化为纯对话分析。 */
const ORCA_LOOKUP_TIMEOUT_MS = 15_000

export interface RepoPathResolverOptions {
  /** Orca 命令；没有 orca 运行时可以不传。 */
  orca?: CommandRunner
  /** 注入点：测试直接给选择器 → 路径映射。 */
  lookup?: (selector: string) => string | undefined
}

/**
 * 把项目清单里的 repo 选择器解析成本地目录。
 *
 * - `path:/abs`、`/abs`：直接可用；
 * - `name:dsh/router-agent`、`id:...`：需要问 Orca（`orca repo list --json`）；
 * - 解析不到或目录不存在时返回 undefined，调用方据此关闭代码读取，只基于对话判断。
 *
 * 这里只做一次解析并缓存结果：需求识别是低频链路，不需要为每条消息跑一次 orca。
 */
export function createRepoPathResolver(opts: RepoPathResolverOptions = {}): (selector: string) => Promise<string | undefined> {
  let orcaPaths: Map<string, string> | null = null

  const loadOrca = async (): Promise<Map<string, string>> => {
    if (orcaPaths) return orcaPaths
    orcaPaths = new Map()
    if (!opts.orca) return orcaPaths
    try {
      // 超时保护：orca 卡住不能把 intake 的串行 tick 一起拖死。
      const res = await opts.orca.run(['repo', 'list', '--json'], { timeoutMs: ORCA_LOOKUP_TIMEOUT_MS })
      if (res.code !== 0) return orcaPaths
      for (const repo of parseOrcaRepos(res.stdout)) {
        if (!repo.path) continue
        orcaPaths.set(repo.name.toLowerCase(), repo.path)
      }
    } catch {
      // Orca 不可用时按「拿不到路径」处理，需求识别退化为纯对话分析。
    }
    return orcaPaths
  }

  const direct = (selector: string): string | undefined => {
    const value = selector.trim()
    if (!value) return undefined
    if (value.startsWith('path:')) return existing(value.slice(5))
    if (isAbsolute(value)) return existing(value)
    const injected = opts.lookup?.(value)
    return injected ? existing(injected) : undefined
  }

  return async (selector: string): Promise<string | undefined> => {
    const hit = direct(selector)
    if (hit) return hit
    if (!opts.orca) return undefined
    const paths = await loadOrca()
    const bare = selector.trim().replace(/^(name|id):/, '')
    const mapped = paths.get(bare.toLowerCase()) ?? paths.get(selector.trim().toLowerCase())
    return mapped ? existing(mapped) : undefined
  }
}

function existing(path: string): string | undefined {
  return path && existsSync(path) ? path : undefined
}
