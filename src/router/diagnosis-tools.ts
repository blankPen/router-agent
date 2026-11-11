/**
 * 排查助手的只读工具集。
 *
 * 助手要能回答「这到底是不是 ra 的 bug」，光看日志不够：得能翻本机装的
 * router-agent 代码、看看当前配置长什么样。所以这里给模型三件工具：
 * 读配置、列目录、读文件、搜代码。
 *
 * 安全边界（这几条是硬约束，别为了方便放宽）：
 * - **只读**：没有任何写、删、执行命令的能力；
 * - **路径封闭**：所有路径都必须在 router-agent 安装目录内，`..` 越界一律拒绝；
 * - **限量**：单次读文件、行数、搜索结果都有上限，避免把整个目录塞进上下文。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { ChatToolSpec } from '../infra/chat.js'

export interface DiagnosisToolContext {
  /** router-agent 本地代码根目录（npm 安装目录或仓库根）。 */
  codeRoot: string
  /** 当前生效配置（已脱敏，不含明文密钥）。 */
  config: Record<string, unknown>
  /** 配置文件路径。 */
  configPath: string
  /** 当前版本号。 */
  version?: string
}

export interface DiagnosisTool {
  spec: ChatToolSpec
  run(args: Record<string, unknown>): string
}

/** 单次读文件最多返回的行数。 */
const MAX_READ_LINES = 400
/** 单次读文件最多返回的字符数。 */
const MAX_READ_CHARS = 20_000
/** 单次搜索最多返回的命中条数。 */
const MAX_SEARCH_HITS = 30
/** 搜索时跳过的目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm-store', 'coverage', 'dist-test'])

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml'])

export function createDiagnosisTools(ctx: DiagnosisToolContext): DiagnosisTool[] {
  const root = resolve(ctx.codeRoot)

  const resolveInside = (path: string): string | null => {
    const target = resolve(root, path || '.')
    if (target !== root && !target.startsWith(root + sep)) return null
    return target
  }

  const relativeToRoot = (target: string): string => relative(root, target) || '.'

  const listCode = (args: Record<string, unknown>): string => {
    const raw = typeof args.path === 'string' ? args.path : ''
    const target = resolveInside(raw)
    if (!target) return `路径越界：只能访问 ${root} 内的文件。`
    let stat
    try {
      stat = statSync(target)
    } catch {
      return `目录不存在：${relativeToRoot(target)}`
    }
    if (!stat.isDirectory()) return `${relativeToRoot(target)} 不是目录，用 read_code 读它。`
    const entries = readdirSync(target, { withFileTypes: true })
      .filter(item => !SKIP_DIRS.has(item.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    if (entries.length === 0) return `${relativeToRoot(target)} 下没有可列出的条目。`
    return entries
      .slice(0, 200)
      .map(item => `${item.isDirectory() ? 'dir ' : 'file'} ${relativeToRoot(join(target, item.name))}`)
      .join('\n')
  }

  const readCode = (args: Record<string, unknown>): string => {
    const raw = typeof args.path === 'string' ? args.path : ''
    if (!raw) return '缺少 path 参数。'
    const target = resolveInside(raw)
    if (!target) return `路径越界：只能访问 ${root} 内的文件。`
    let content: string
    try {
      content = readFileSync(target, 'utf8')
    } catch (error) {
      return `读取失败：${relativeToRoot(target)}（${error instanceof Error ? error.message : String(error)}）`
    }
    const start = Number(args.startLine ?? 1)
    const end = Number(args.endLine ?? Number.MAX_SAFE_INTEGER)
    const lines = content.split('\n')
    const from = Math.max(1, Number.isFinite(start) ? start : 1)
    const to = Math.min(lines.length, Number.isFinite(end) ? end : lines.length)
    if (from > lines.length) return `${relativeToRoot(target)} 只有 ${lines.length} 行，起始行超出范围。`
    const slice = lines.slice(from - 1, to)
    const body = slice
      .map((line, index) => `${from + index}\t${line}`)
      .join('\n')
      .slice(0, MAX_READ_CHARS)
    return `${relativeToRoot(target)}（第 ${from}-${Math.min(to, from + slice.length - 1)} 行，共 ${lines.length} 行）\n${body}`
  }

  const searchCode = (args: Record<string, unknown>): string => {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) return '缺少 query 参数。'
    const raw = typeof args.path === 'string' ? args.path : ''
    const target = resolveInside(raw)
    if (!target) return `路径越界：只能访问 ${root} 内的文件。`
    const hits: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (hits.length >= MAX_SEARCH_HITS || depth > 6) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of entries) {
        if (hits.length >= MAX_SEARCH_HITS) return
        if (item.name.startsWith('.') && item.name !== '.router-agent') continue
        if (SKIP_DIRS.has(item.name)) continue
        const full = join(dir, item.name)
        if (item.isDirectory()) {
          walk(full, depth + 1)
          continue
        }
        const ext = item.name.slice(item.name.lastIndexOf('.'))
        if (!TEXT_EXTENSIONS.has(ext)) continue
        let content: string
        try {
          content = readFileSync(full, 'utf8')
        } catch {
          continue
        }
        content.split('\n').forEach((line, index) => {
          if (hits.length >= MAX_SEARCH_HITS) return
          if (line.includes(query)) hits.push(`${relativeToRoot(full)}:${index + 1}: ${line.trim().slice(0, 200)}`)
        })
      }
    }
    walk(target, 0)
    if (hits.length === 0) return `没有匹配「${query}」的内容。`
    return hits.join('\n')
  }

  const readConfig = (): string => {
    const lines = [
      `配置文件：${ctx.configPath}`,
      `当前版本：${ctx.version ?? '未知'}`,
      `代码目录：${root}`,
      '当前生效配置（密钥已脱敏）：',
      JSON.stringify(ctx.config, null, 2).slice(0, MAX_READ_CHARS),
    ]
    return lines.join('\n')
  }

  return [
    {
      spec: {
        name: 'read_config',
        description: '读取 router-agent 当前生效的配置（密钥已脱敏）与配置文件路径，用来判断是不是配置问题。',
        parameters: { type: 'object', properties: {} },
      },
      run: readConfig,
    },
    {
      spec: {
        name: 'list_code',
        description: '列出 router-agent 本地安装目录下的文件与子目录（相对路径）。用来找入口文件与相关模块。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对安装根目录的路径，留空列根目录。' },
          },
        },
      },
      run: listCode,
    },
    {
      spec: {
        name: 'read_code',
        description: '读取 router-agent 本地安装目录下的一个文本文件内容（带行号）。用于确认某个事件 / 配置项在代码里是怎么处理的。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对安装根目录的文件路径，例如 src/router/log-tail.ts。' },
            startLine: { type: 'number', description: '起始行（1 起）。' },
            endLine: { type: 'number', description: '结束行（含）。' },
          },
          required: ['path'],
        },
      },
      run: readCode,
    },
    {
      spec: {
        name: 'search_code',
        description: '在 router-agent 本地安装目录里搜索关键字，返回 文件:行号:内容。用于定位某个日志事件名或配置项出现在哪。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要搜索的文本。' },
            path: { type: 'string', description: '限定搜索范围的相对目录，留空搜整个安装目录。' },
          },
          required: ['query'],
        },
      },
      run: searchCode,
    },
  ]
}

/** 工具声明列表，供模型侧声明。 */
export function toolSpecs(tools: DiagnosisTool[]): ChatToolSpec[] {
  return tools.map(tool => tool.spec)
}
