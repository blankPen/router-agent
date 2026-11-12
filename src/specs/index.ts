/**
 * 规范类 markdown 的内置存储。
 *
 * 这些 markdown 原先一部分随包内置、一部分允许通过配置项指向任意文件路径
 * （例如 `router.persona.soulFile`）。现在统一收敛到 `<home>/specs/` 下：
 * - 没有覆盖文件时读取随包内置内容；
 * - Web 配置页直接读写覆盖文件，不再需要用户填写文件路径；
 * - 旧版自定义路径在服务启动时迁移一次，把文件内容导入内置存储，原文件保留。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { readWorkerSpec as readRuntimeWorkerSpec } from '#runtime/spec/reader.js'

export type SpecGroup = 'router' | 'worker'

interface SpecDefinition {
  id: string
  group: SpecGroup
  /** 随包内置文件名；覆盖文件路径固定为 `<group>/<file>`。 */
  file: string
  label: string
  description: string
  /** 保存后什么时候生效的说明，面板直接展示。 */
  applyHint: string
}

const GROUP_LABELS: Record<SpecGroup, string> = {
  router: 'Router',
  worker: 'Worker',
}

const SPECS: SpecDefinition[] = [
  {
    id: 'router.soul',
    group: 'router',
    file: 'soul.md',
    label: 'Router 人格（soul）',
    description: 'Router 的自我设定与语气，注入会话模式的 system prompt。',
    applyHint: '保存后需重启服务生效',
  },
  {
    id: 'router.orchestrator',
    group: 'router',
    file: 'orchestrator.md',
    label: 'Router 执行规范',
    description: '研判、派工与流程编排的主规范。',
    applyHint: '保存后需重启服务生效',
  },
  {
    id: 'router.admission',
    group: 'router',
    file: 'admission.md',
    label: '接单准入规范',
    description: '什么消息可以起步、如何追问与拒绝。',
    applyHint: '保存后需重启服务生效',
  },
  {
    id: 'router.conversation',
    group: 'router',
    file: 'conversation.md',
    label: '会话回复规范',
    description: '会话模式下如何组织回复与追问。',
    applyHint: '保存后需重启服务生效',
  },
  {
    id: 'router.intake-screener',
    group: 'router',
    file: 'intake-screener.md',
    label: '需求初筛规范',
    description: '轻量模型如何把群消息分成闲聊 / 咨询 / 疑似问题三类。',
    applyHint: '保存后立即生效',
  },
  {
    id: 'router.intake-analyst',
    group: 'router',
    file: 'intake-analyst.md',
    label: '需求分析规范',
    description: '分析子 Agent 如何追问、甄别并整理结构化需求单。',
    applyHint: '保存后立即生效',
  },
  {
    id: 'worker.prompt-mode',
    group: 'worker',
    file: 'prompt-mode.md',
    label: 'Worker 手册',
    description: '拼进 Worker 启动 prompt 的完整手册。',
    applyHint: '对之后派出的新工单生效',
  },
  {
    id: 'worker.contract',
    group: 'worker',
    file: 'contract.md',
    label: 'Worker 契约（中立运行时）',
    description: 'Claude Code / ACP 等非 Orca 运行时使用的任务契约。',
    applyHint: '保存后对之后派出的新工单生效',
  },
]

/** 覆盖文件的体积上限，避免误把大文件塞进规范存储。 */
const MAX_SPEC_BYTES = 512 * 1024

export type SpecErrorCode = 'unknown-spec' | 'no-home' | 'empty-content' | 'too-large'

export class SpecError extends Error {
  constructor(readonly code: SpecErrorCode, message: string) {
    super(message)
    this.name = 'SpecError'
  }
}

export interface SpecView {
  id: string
  group: SpecGroup
  groupLabel: string
  label: string
  description: string
  applyHint: string
  /** 是否存在用户覆盖文件（true 表示内容来自 Web 编辑 / 旧路径迁移）。 */
  isCustom: boolean
  /** 覆盖文件最后修改时间；内置默认内容为 null。 */
  updatedAt: string | null
  content: string
}

export interface LegacySoulMigration {
  /** 是否把旧自定义文件的内容导入到 `specs/router/soul.md`。 */
  imported: boolean
  /** 旧配置里的文件路径（`~` 已展开）。 */
  source?: string
  /** 是否从 config.yaml 移除了旧配置项。 */
  removedConfig: boolean
  /** 迁移失败原因；迁移失败不影响服务启动。 */
  error?: string
}

function definitionOf(id: string): SpecDefinition | undefined {
  return SPECS.find(spec => spec.id === id)
}

function definitionOrThrow(id: string): SpecDefinition {
  const def = definitionOf(id)
  if (!def) throw new SpecError('unknown-spec', `未知规范：${id}`)
  return def
}

function definitionForFile(group: SpecGroup, file: string): SpecDefinition | undefined {
  return SPECS.find(spec => spec.group === group && spec.file === file)
}

function builtinPath(group: SpecGroup, file: string): string {
  return fileURLToPath(new URL(`../router/prompts/${file}`, import.meta.url))
}

/** 覆盖文件的固定路径：`<home>/specs/<group>/<file>`。 */
export function specPath(home: string, id: string): string {
  const def = definitionOrThrow(id)
  return join(home, 'specs', def.group, def.file)
}

function stats(path: string): { isCustom: boolean; updatedAt: string | null } {
  if (!existsSync(path)) return { isCustom: false, updatedAt: null }
  try {
    return { isCustom: true, updatedAt: statSync(path).mtime.toISOString() }
  } catch {
    return { isCustom: false, updatedAt: null }
  }
}

function builtinContent(def: SpecDefinition): string {
  // Worker 模板由运行时包自带（并负责 `<home>/specs/worker` 覆盖），这里不重复维护路径。
  if (def.group === 'worker') return readRuntimeWorkerSpec(undefined, def.file)
  return readFileSync(builtinPath(def.group, def.file), 'utf8')
}

/** 读取规范内容：有覆盖文件用覆盖文件，读取失败时回落到内置默认。 */
export function readSpecContent(home: string | undefined, id: string): string {
  const def = definitionOrThrow(id)
  if (home) {
    const path = specPath(home, id)
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        // 文件被并发删除 / 权限异常时不要让研判整体失败，直接用内置内容。
      }
    }
  }
  return builtinContent(def)
}

/** Router 提示词按内置文件名读取，保留 agent-loop 原有的调用形态。 */
export function readRouterPrompt(home: string | undefined, file: string): string {
  const def = definitionForFile('router', file)
  return def ? readSpecContent(home, def.id) : readFileSync(builtinPath('router', file), 'utf8')
}

/** Worker 规范按内置文件名读取，保留 worker/spec 原有的调用形态。 */
export function readWorkerSpec(home: string | undefined, file: string): string {
  const def = definitionForFile('worker', file)
  return def ? readSpecContent(home, def.id) : readFileSync(builtinPath('worker', file), 'utf8')
}

function viewOf(home: string | undefined, def: SpecDefinition): SpecView {
  const path = home ? specPath(home, def.id) : ''
  const meta = path ? stats(path) : { isCustom: false, updatedAt: null }
  return {
    id: def.id,
    group: def.group,
    groupLabel: GROUP_LABELS[def.group],
    label: def.label,
    description: def.description,
    applyHint: def.applyHint,
    isCustom: meta.isCustom,
    updatedAt: meta.updatedAt,
    content: readSpecContent(home, def.id),
  }
}

/** 面板列表：返回全部规范及当前内容，避免逐项再发请求。 */
export function listSpecs(home: string | undefined): SpecView[] {
  return SPECS.map(def => viewOf(home, def))
}

export function getSpec(home: string | undefined, id: string): SpecView | null {
  const def = definitionOf(id)
  return def ? viewOf(home, def) : null
}

/** 写入覆盖文件；空内容被拒绝，恢复默认请走 `resetSpec`。 */
export function saveSpec(home: string | undefined, id: string, content: unknown): SpecView {
  if (!home) throw new SpecError('no-home', '未配置状态目录，无法保存规范')
  const def = definitionOrThrow(id)
  if (typeof content !== 'string' || content.trim() === '') {
    throw new SpecError('empty-content', '规范内容不能为空；如需还原内置内容请使用「恢复默认」')
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_SPEC_BYTES) {
    throw new SpecError('too-large', `规范内容不能超过 ${MAX_SPEC_BYTES / 1024} KB`)
  }
  const path = specPath(home, id)
  mkdirSync(dirname(path), { recursive: true })
  // 先写临时文件再 rename，避免进程中途退出留下半截规范。
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
  return viewOf(home, def)
}

/** 删除覆盖文件，内容回落到随包内置版本。 */
export function resetSpec(home: string | undefined, id: string): SpecView {
  if (!home) throw new SpecError('no-home', '未配置状态目录，无法重置规范')
  const def = definitionOrThrow(id)
  const path = specPath(home, id)
  if (existsSync(path)) rmSync(path, { force: true })
  return viewOf(home, def)
}

function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

/**
 * 旧版 `router.persona.soulFile` 迁移：把自定义文件内容写入内置存储后删除旧配置项。
 * 原文件不删除；已经存在覆盖文件时不覆盖用户现有内容。
 */
export function migrateLegacySoul(home: string | undefined): LegacySoulMigration {
  const result: LegacySoulMigration = { imported: false, removedConfig: false }
  if (!home) return result
  const configPath = join(home, 'config.yaml')
  if (!existsSync(configPath)) return result

  let doc
  try {
    doc = parseDocument(readFileSync(configPath, 'utf8'))
  } catch (error) {
    return { ...result, error: error instanceof Error ? error.message : String(error) }
  }
  if (doc.errors.length > 0) return { ...result, error: doc.errors[0]?.message }

  const legacy = doc.getIn(['router', 'persona', 'soulFile'])
  if (legacy === undefined) return result

  const source = typeof legacy === 'string' ? legacy.trim() : ''
  const target = specPath(home, 'router.soul')
  // 已经存在覆盖文件（例如 Upgrade 前用户已在 Web 编辑过）时以现有内容为准。
  let canRemove = existsSync(target)

  if (source) {
    result.source = expandHome(source)
    if (!canRemove) {
      try {
        const content = readFileSync(result.source, 'utf8')
        if (content.trim()) {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, content, 'utf8')
          result.imported = true
        }
        canRemove = true
      } catch (error) {
        // 旧文件不在了：保留配置项，避免用户以为路径被凭空抹掉。
        result.error = error instanceof Error ? error.message : String(error)
      }
    }
  } else {
    // 空字符串等价于「使用内置人格」，直接移除即可。
    canRemove = true
  }

  if (canRemove) {
    doc.deleteIn(['router', 'persona', 'soulFile'])
    writeFileSync(configPath, doc.toString(), 'utf8')
    result.removedConfig = true
  }
  return result
}
