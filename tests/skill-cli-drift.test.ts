import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli/index.js'

/** 技能文件随包发布；示例里的参数必须和真实 `ra reply` 定义一致。 */
function workerSkillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return workerSkillFiles(path)
    return entry.name.endsWith('.md') ? [path] : []
  })
}

function flagsInReplyExamples(markdown: string): string[] {
  return [...markdown.matchAll(/```(?:bash|sh|shell)?\n([\s\S]*?)```/g)]
    .map(match => match[1] ?? '')
    .filter(block => block.includes('ra reply'))
    .flatMap(block => block.match(/(?<![\w-])--[a-z][a-z0-9-]*/g) ?? [])
}

describe('worker 技能与 CLI 防漂移', () => {
  it('技能文件里 ra reply 示例的参数都在命令定义中存在', async () => {
    const skillDir = join(process.cwd(), 'packages/runtime/src/spec/worker')
    const documented = new Set(workerSkillFiles(skillDir).flatMap(path => flagsInReplyExamples(readFileSync(path, 'utf8'))))

    const lines: string[] = []
    expect(await runCli(['reply', '--help'], {
      stdout: line => lines.push(line),
      stderr: line => lines.push(line),
      env: { RA_HOME: join(tmpdir(), 'ra-skill-drift') },
    })).toBe(0)
    const defined = new Set(lines.join('\n').match(/--[a-z][a-z0-9-]*/g) ?? [])

    const missing = [...documented].filter(flag => !defined.has(flag))
    expect(missing, `技能文档用了命令里没有的参数：${missing.join(', ')}`).toEqual([])
  })
})
