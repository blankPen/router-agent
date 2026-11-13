/**
 * Worker 技能文件读取。
 *
 * 技能随运行时包一起发布，落在 `spec/worker/` 下（`SKILL.md` + `references/`）；
 * 用户覆盖文件固定放在 `<home>/specs/worker/<相对路径>`。
 * 读取顺序：覆盖文件优先，读不到就用随包内置文件。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 覆盖文件的固定路径：`<home>/specs/worker/<file>`。 */
export function workerSpecPath(home: string, file: string): string {
  return join(home, 'specs', 'worker', file)
}

/** 随包内置模板路径；编译后与 reader.js 同目录。 */
export function bundledWorkerSpecPath(file: string): string {
  return fileURLToPath(new URL(`./${file}`, import.meta.url))
}

/** 随包内置技能根目录（`worker/`）。 */
export function bundledWorkerSkillRoot(): string {
  return fileURLToPath(new URL('./worker', import.meta.url))
}

/** 用户技能目录：`<home>/specs/worker`。 */
export function workerSkillDir(home: string): string {
  return join(home, 'specs', 'worker')
}

export function readWorkerSpec(home: string | undefined, file: string): string {
  if (home) {
    const path = workerSpecPath(home, file)
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        // 覆盖文件被并发删除 / 权限异常时不要阻塞派工，回落到内置模板。
      }
    }
  }
  return readFileSync(bundledWorkerSpecPath(file), 'utf8')
}

/**
 * 读技能文件（相对 `worker/` 根，如 `SKILL.md`、`references/reply-protocol.md`）。
 *
 * 技能文件不参与模板渲染：里面的 `{{...}}` 是给命令示例看的占位符，
 * 不能被替换成真实工单号。
 */
export function readWorkerSkill(home: string | undefined, relative: string): string {
  return readWorkerSkillWithPath(home, relative).content
}

function readWorkerSkillWithPath(home: string | undefined, relative: string): { content: string; path: string } {
  if (home) {
    const path = join(workerSkillDir(home), relative)
    if (existsSync(path)) {
      try {
        return { content: readFileSync(path, 'utf8'), path }
      } catch {
        // 覆盖文件被并发删除 / 权限异常时不要阻塞派工，回落到内置文件。
      }
    }
  }
  const path = join(bundledWorkerSkillRoot(), relative)
  return { content: readFileSync(path, 'utf8'), path }
}

/**
 * 派工前把缺失的内置技能文件补到用户目录；已有的覆盖文件一律不动。
 *
 * 引导里给的是 `<home>/specs/worker` 目录路径，只补 SKILL.md 会让 references 仍不可读。
 */
export function ensureWorkerSkillDir(home: string): string {
  const target = workerSkillDir(home)
  mkdirSync(target, { recursive: true })
  const copyMissing = (source: string, relative: string): void => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const from = join(source, entry.name)
      const to = join(target, relative, entry.name)
      if (entry.isDirectory()) {
        mkdirSync(to, { recursive: true })
        copyMissing(from, join(relative, entry.name))
      } else if (!existsSync(to)) {
        copyFileSync(from, to)
      }
    }
  }
  copyMissing(bundledWorkerSkillRoot(), '')
  return target
}

export interface WorkerSkillSnapshot {
  name: string
  version: string
  sha256: string
  path: string
}

/**
 * 当前生效的 `SKILL.md` 指纹。
 *
 * 派工时写进 assignment meta 与 `launch:skill` 日志，事后能回答
 * 「这张工单当时用的是哪版交付规范」；覆盖文件改了也会得到不同的 sha。
 */
export function workerSkillSnapshot(home: string | undefined): WorkerSkillSnapshot {
  const { content, path } = readWorkerSkillWithPath(home, 'SKILL.md')
  const sha256 = createHash('sha256').update(content).digest('hex')
  const header = content.match(/^---\n([\s\S]*?)\n---/)
  const field = (key: string): string => {
    const match = header?.[1]?.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    return match?.[1]?.trim() ?? ''
  }
  return {
    name: field('name') || 'router-agent-worker',
    version: field('version') || '0',
    sha256,
    path,
  }
}
