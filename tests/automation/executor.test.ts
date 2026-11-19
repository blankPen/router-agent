import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Automation, AutomationTool } from '#core/automation.js'
import { createAutomationExecutors, type RuntimeRunInput, type RuntimeRunOutcome } from '../../src/automation/executor.js'
import type { WorkerRuntime } from '#runtime/port.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function workdir(): string {
 const dir = mkdtempSync(join(tmpdir(), 'ra-automation-'))
 dirs.push(dir)
 return dir
}

function task(over: Partial<Automation> = {}): Automation {
 return {
   id: 'auto_1',
   name: '依赖巡检',
   description: '',
   type: 'ai',
   prompt: '检查依赖更新',
   schedule: { kind: 'daily', at: '09:00' },
   runtimeId: '',
   project: 'demo',
   repo: '/tmp/demo',
   branch: 'main',
   enabled: true,
   createdBy: '',
   createdAt: '2026-11-01T00:00:00.000Z',
   updatedAt: '2026-11-01T00:00:00.000Z',
   ...over,
 }
}

const runtime = { id: 'fake' } as WorkerRuntime
const runtimes = {
 has: () => true,
 get: () => runtime,
 default: () => runtime,
} as never

const tools: AutomationTool[] = [{
 name: 'automation_list_tickets',
 description: '查询本项目工单',
 parameters: { type: 'object' },
 mutates: false,
 handler: () => ({ tickets: [] }),
}]

const toolsWithParams: AutomationTool[] = [{
  name: 'automation_get_ticket',
  description: '按工单 ID 读取工单详情',
  parameters: {
    type: 'object',
    properties: { ticket_id: { type: 'string', description: '工单 ID，例如 tk-8' } },
    required: ['ticket_id'],
  },
  mutates: false,
  handler: () => ({ ticket: null }),
}]

function harness(over: {
 generateScript?: (automation: Automation) => Promise<string | null>
 outcome?: RuntimeRunOutcome
} = {}): {
  input: () => RuntimeRunInput | null
  executors: ReturnType<typeof createAutomationExecutors>
  phases: string[]
} {
 let captured: RuntimeRunInput | null = null
  const phases: string[] = []
 const executors = createAutomationExecutors({
   runtimes,
   ...(over.generateScript ? { generateScript: over.generateScript } : {}),
   runViaRuntime: async input => {
     captured = input
     return over.outcome ?? { status: 'success', summary: '完成', outputs: { ticketIds: [], eventIds: [] } }
   },
 })
  return { input: () => captured, executors, phases }
}

describe('自动化执行器', () => {
 it('AI 自动化把提示词与工具说明一并注入 runtime', async () => {
   const { input, executors } = harness()
   await executors.get('ai')!.execute({
     automation: task(),
     tools,
     timeoutMs: 60_000,
     maxRetries: 0,
     workdir: workdir(),
     logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
   })

   expect(input()!.contract).toContain('检查依赖更新')
   expect(input()!.contract).toContain('automation_list_tickets')
   expect(input()!.tools).toHaveLength(1)
   expect(input()!.workdir).toBeTruthy()
 })

 it('脚本自动化执行已持久化的脚本，不再重新生成', async () => {
   const { input, executors } = harness()
   const dir = workdir()
   const automation = task({ type: 'script', script: 'echo persisted' })
   await executors.get('script')!.execute({
     automation,
     tools,
     timeoutMs: 60_000,
     maxRetries: 0,
     workdir: dir,
     logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
   })

   expect(input()!.script).toBe('echo persisted')
   expect(readFileSync(join(dir, 'automation.sh'), 'utf8')).toBe('echo persisted')
   expect(input()!.contract).toContain('bash automation.sh')
 })

  it('AI 自动化契约说明何时结束，避免 runtime 一直探索到超时', async () => {
    const { input, executors } = harness()
    await executors.get('ai')!.execute({
      automation: task(),
      tools,
      timeoutMs: 60_000,
      maxRetries: 0,
      workdir: workdir(),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })

    expect(input()!.contract).toContain('什么时候结束')
  })

  it('脚本自动化契约说明脚本跑完就结束', async () => {
    const { input, executors } = harness()
    await executors.get('script')!.execute({
      automation: task({ type: 'script', script: 'echo persisted' }),
      tools,
      timeoutMs: 60_000,
      maxRetries: 0,
      workdir: workdir(),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })

    expect(input()!.contract).toContain('脚本跑完')
  })

  it('契约给出完成信号文件，agent 干完活就写文件结束', async () => {
    const { input, executors } = harness()
    await executors.get('ai')!.execute({
      automation: task(),
      tools,
      timeoutMs: 60_000,
      maxRetries: 0,
      workdir: workdir(),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })

    expect(input()!.contract).toContain('.automation-result')
  })

  it('脚本为空时直接失败，提示去面板生成，不在执行时偷偷生成', async () => {
   const generated: string[] = []
   const { input, executors } = harness({
     generateScript: async () => {
       generated.push('call')
       return 'echo generated'
     },
   })
   const automation = task({ type: 'script' })
    const result = await executors.get('script')!.execute({
     automation,
     tools,
     timeoutMs: 60_000,
     maxRetries: 0,
     workdir: workdir(),
     logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
   })

    expect(generated).toEqual([])
    expect(input()).toBeNull()
    expect(result.status).toBe('failed')
    expect(result.summary).toContain('生成脚本')
 })

  it('契约带上工具入参 schema，模型才知道每个工具要传哪些参数', async () => {
    const { input, executors } = harness()
    await executors.get('ai')!.execute({
      automation: task(),
      tools: toolsWithParams,
      timeoutMs: 60_000,
      maxRetries: 0,
      workdir: workdir(),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })

    const contract = input()!.contract
    expect(contract).toContain('ticket_id')
    expect(contract).toContain('必填')
  })

})
