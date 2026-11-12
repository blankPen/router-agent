/**
 * Worker 规范模板读取。
 *
 * 模板随运行时包一起发布；用户覆盖文件固定放在 `<home>/specs/worker/<file>`。
 * 读取顺序与原来一致：覆盖文件优先，读不到就用随包内置模板。
 */
import { existsSync, readFileSync } from 'node:fs'
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
