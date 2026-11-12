import { errorMessage, noopLogger, type Logger } from '../infra/logger.js'
import { createDefaultPiSession } from './pi-decision-engine.js'
import type { PiModelConfig } from './model-config.js'
import type { PiToolDefinition } from './tool-spec.js'
import { Type } from 'typebox'
import { openSync, readSync, closeSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * 分析子 Agent 可用的只读代码工具。
 *
 * 不直接复用 Pi 的内置 read / grep / ls：那套工具接受任意绝对路径，
 * 等于把整台机器交给分析模型。这里用自定义工具把访问范围钉死在当前项目目录内，
 * 仍然只有「读」，没有 shell / 写文件 / PR 能力。
 */
export const INTAKE_READ_ONLY_TOOLS = ['code_ls', 'code_read', 'code_grep'] as const

/**
 * 需求识别引擎端口。
 *
 * 与 DecisionEngine 一样只负责「跑一轮模型」，prompt 结构与 JSON 解析由 AgentLoop 统一处理：
 * - 初筛与分析的 system prompt 来自 `specs/router/intake-*.md`；
 * - 分析阶段只有只读代码工具，且只允许看当前群绑定的项目目录；
 * - 引擎不写库、不派单，所有状态变化仍由 AgentLoop 经 Store / Engine 完成。
 */
export interface IntakeRunRequest {
  systemPrompt: string
  userPrompt: string
  /** 允许读取的项目本地目录；为空或 `readCode=false` 时不暴露任何工具。 */
  projectPath?: string
  readCode: boolean
  timeoutMs?: number
}

export interface IntakeEngine {
  /** 跑一轮初筛或分析，返回模型最终 assistant 文本（由调用方解析 JSON）。 */
  run(req: IntakeRunRequest): Promise<string>
}

export interface PiIntakeEngineOptions {
  model: PiModelConfig
  /** Pi 的独立配置目录；与研判引擎一致，默认 `<home>/pi`。 */
  agentDir: string
  /** 没有项目目录时的 cwd；默认状态目录。 */
  cwd: string
  /** 单轮硬超时，默认 120s。 */
  timeoutMs?: number
  /** 测试注入点。 */
  runSession?: (req: IntakeRunRequest & { cwd: string; toolNames: string[] }) => Promise<string>
  logger?: Logger
}

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Pi 实现：每次识别新开一个 in-memory session，不落盘、不继承用户 ~/.pi。
 *
 * 需求识别是低频、短链路的能力：一个 intake 的完整对话会随每轮 userPrompt 一起注入，
 * 不依赖会话复用，避免多一个需要清理与隔离的持久化面。
 */
export class PiIntakeEngine implements IntakeEngine {
  private readonly model: PiModelConfig
  private readonly agentDir: string
  private readonly cwd: string
  private readonly timeoutMs: number
  private readonly runSession?: PiIntakeEngineOptions['runSession']
  private readonly logger: Logger

  constructor(opts: PiIntakeEngineOptions) {
    this.model = opts.model
    this.agentDir = opts.agentDir
    this.cwd = opts.cwd
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
    this.runSession = opts.runSession
    this.logger = opts.logger ?? noopLogger
  }

  async run(req: IntakeRunRequest): Promise<string> {
    const readCode = req.readCode && Boolean(req.projectPath)
    const toolNames = readCode ? [...INTAKE_READ_ONLY_TOOLS] : []
    const cwd = readCode && req.projectPath ? req.projectPath : this.cwd
    const timeoutMs = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : this.timeoutMs
    const tools = readCode && req.projectPath ? createCodeTools(req.projectPath, this.logger) : []

    if (this.runSession) return this.runSession({ ...req, cwd, toolNames })

    const session = await createDefaultPiSession({
      cwd,
      agentDir: this.agentDir,
      systemPrompt: req.systemPrompt,
      toolNames,
      tools,
      apiKey: this.model.apiKey,
      baseUrl: this.model.baseUrl,
      model: this.model.model,
      ...(this.model.api ? { api: this.model.api } : {}),
      ...(this.model.authHeader !== undefined ? { authHeader: this.model.authHeader } : {}),
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void session.abort().catch((error: unknown) => {
        this.logger.warn('intake:abort-failed', { stage: 'abort', detail: errorMessage(error) })
      })
    }, timeoutMs)
    timer.unref?.()
    try {
      await session.prompt(req.userPrompt)
    } finally {
      clearTimeout(timer)
      try {
        session.dispose()
      } catch (error) {
        // dispose 失败不影响已拿到的结果，但要让排查的人知道发生过。
        this.logger.warn('intake:dispose-failed', { stage: 'dispose', detail: errorMessage(error) })
      }
    }
    if (timedOut) throw new Error(`intake:timeout(${timeoutMs}ms)`)
    const text = lastAssistantText(session.messages).trim()
    if (!text) throw new Error('intake:empty-reply')
    this.logger.info('intake:ran', { readCode, cwd, chars: text.length })
    return text
  }
}

/** 取最后一条 assistant 的文本块；Pi 的 content 可能是字符串或块数组。 */
export function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown } | undefined
    if (message?.role !== 'assistant') continue
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      return message.content
        .filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === 'object' && (block as { type?: string }).type === 'text')
        .map(block => String(block.text ?? ''))
        .join('\n')
    }
  }
  return ''
}

const MAX_READ_BYTES = 60_000
const MAX_LIST_ENTRIES = 200
const MAX_GREP_MATCHES = 50
/** grep 单个文件的最大读取量；超出的文件跳过并在结果里说明，不静默当成「没匹配」。 */
const MAX_GREP_FILE_BYTES = 400_000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'target', '.cache'])

/**
 * 项目内只读工具。
 *
 * 所有路径都先解析成绝对路径，再校验仍在 `root` 之内：`../`、绝对路径都不能把访问范围
 * 带出当前群绑定的项目。符号链接同样挡住：路径的**真实路径**也必须在项目真实根目录内，
 * 否则项目里一个指向外部的软链就能把读取范围带出去。项目隔离靠这一层保证，而不是靠模型自觉。
 */
export function createCodeTools(root: string, logger: Logger = noopLogger): PiToolDefinition[] {
  const base = resolve(root)
  const realBase = realPath(base) ?? base
  /** 词法包含判断：绝对路径必须在项目根之下。 */
  const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`)
  const inside = (target: string): string | null => {
    const abs = resolve(base, target || '.')
    if (!within(abs, base)) return null
    // 真实路径再判一次：软链指向项目外时直接拒绝。
    const real = realPath(abs)
    if (!real || !within(real, realBase)) return null
    return abs
  }

  return [
    {
      name: 'code_ls',
      label: 'code_ls',
      description: '列出项目目录下的文件与子目录（不进入 node_modules / .git 等目录）。',
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: '相对项目根目录的路径，默认项目根目录' })),
      }),
      async execute(_id, params) {
        const target = String(params.path ?? '')
        const abs = inside(target)
        if (!abs) return textResult({ error: 'path:outside-project' })
        try {
          const stat = statSync(abs)
          if (!stat.isDirectory()) return textResult({ error: 'path:not-a-directory' })
          const entries = readdirSync(abs, { withFileTypes: true })
            .filter(entry => !SKIP_DIRS.has(entry.name))
            .slice(0, MAX_LIST_ENTRIES)
            .map(entry => `${entry.isDirectory() ? 'dir' : 'file'} ${entry.name}`)
          return textResult({ path: relative(base, abs) || '.', entries })
        } catch (error) {
          logger.warn('intake:tool-failed', { stage: 'code_ls', detail: errorMessage(error) })
          return textResult({ error: `ls-failed: ${errorMessage(error)}` })
        }
      },
    },
    {
      name: 'code_read',
      label: 'code_read',
      description: '读取项目内一个文本文件的内容；超过 60KB 时只返回开头部分。',
      parameters: Type.Object({
        path: Type.String({ description: '相对项目根目录的文件路径' }),
      }),
      async execute(_id, params) {
        const abs = inside(String(params.path ?? ''))
        if (!abs) return textResult({ error: 'path:outside-project' })
        try {
          const stat = statSync(abs)
          if (!stat.isFile()) return textResult({ error: 'path:not-a-file' })
          const size = Math.min(stat.size, MAX_READ_BYTES)
          const buffer = Buffer.alloc(size)
          const fd = openSync(abs, 'r')
          try {
            readSync(fd, buffer, 0, size, 0)
          } finally {
            closeSync(fd)
          }
          const text = buffer.toString('utf8')
          return textResult({
            path: relative(base, abs),
            truncated: stat.size > MAX_READ_BYTES,
            content: text,
          })
        } catch (error) {
          logger.warn('intake:tool-failed', { stage: 'code_read', detail: errorMessage(error) })
          return textResult({ error: `read-failed: ${errorMessage(error)}` })
        }
      },
    },
    {
      name: 'code_grep',
      label: 'code_grep',
      description: '在项目内按纯文本搜索（大小写不敏感），返回文件与行号；不读项目外文件。',
      parameters: Type.Object({
        pattern: Type.String({ description: '要搜索的文本（按纯文本匹配，大小写不敏感）' }),
        path: Type.Optional(Type.String({ description: '搜索范围（相对项目根目录），默认整个项目' })),
      }),
      async execute(_id, params) {
        const pattern = String(params.pattern ?? '')
        if (!pattern) return textResult({ error: 'pattern:empty' })
        const abs = inside(String(params.path ?? ''))
        if (!abs) return textResult({ error: 'path:outside-project' })
        // 纯文本匹配：模型给的 pattern 不可信，直接当正则可能触发灾难性回溯。
        const needle = pattern.toLowerCase()
        const matcher = (line: string): boolean => line.toLowerCase().includes(needle)
        const matches: string[] = []
        const skipped: string[] = []
        walk(abs, matches, matcher, skipped)
        const capped = matches.length >= MAX_GREP_MATCHES
        return textResult({
          matches,
          truncated: capped,
          ...(skipped.length > 0 ? { skippedLargeFiles: skipped.slice(0, 20), partial: true } : {}),
        })
      },
    },
  ]

  function walk(dir: string, matches: string[], matcher: (line: string) => boolean, skipped: string[]): void {
    if (matches.length >= MAX_GREP_MATCHES) return
    let stat
    try {
      stat = statSync(dir)
    } catch (error) {
      logger.warn('intake:tool-failed', { stage: 'code_grep', detail: errorMessage(error) })
      return
    }
    // path 指向文件时直接搜这个文件，不要当目录去 readdir。
    if (stat.isFile()) {
      searchFile(dir, matches, matcher, skipped)
      return
    }
    if (!stat.isDirectory()) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      logger.warn('intake:tool-failed', { stage: 'code_grep', detail: errorMessage(error) })
      return
    }
    for (const entry of entries) {
      if (matches.length >= MAX_GREP_MATCHES) return
      if (SKIP_DIRS.has(entry.name)) continue
      const next = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(next, matches, matcher, skipped)
        continue
      }
      if (!entry.isFile()) continue
      searchFile(next, matches, matcher, skipped)
    }
  }

  /** 搜一个文件：整文件读取（受大小上限约束），超限的文件跳过并记账。 */
  function searchFile(file: string, matches: string[], matcher: (line: string) => boolean, skipped: string[]): void {
    let text = ''
    try {
      const stat = statSync(file)
      if (stat.size > MAX_GREP_FILE_BYTES) {
        skipped.push(relative(base, file))
        return
      }
      const buffer = Buffer.alloc(stat.size)
      const fd = openSync(file, 'r')
      try {
        readSync(fd, buffer, 0, buffer.length, 0)
      } finally {
        closeSync(fd)
      }
      text = buffer.toString('utf8')
    } catch (error) {
      logger.warn('intake:tool-failed', { stage: 'code_grep', detail: errorMessage(error) })
      return
    }
    if (!text || text.includes('\u0000')) return
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (!matcher(lines[index]!)) continue
      matches.push(`${relative(base, file)}:${index + 1}: ${lines[index]!.trim().slice(0, 200)}`)
      if (matches.length >= MAX_GREP_MATCHES) return
    }
  }
}

/** 真实路径；取不到（路径不存在等）时返回 null。 */
function realPath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function textResult(value: unknown): { content: { type: 'text'; text: string }[]; details: Record<string, unknown> } {
  return { content: [{ type: 'text', text: safeJson(value) }], details: {} }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
