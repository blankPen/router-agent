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

function harness(over: {
 generateScript?: (automation: Automation) => Promise<string | null>
 outcome?: RuntimeRunOutcome
} = {}): { input: () => RuntimeRunInput | null; executors: ReturnType<typeof createAutomationExecutors> } {
 let captured: RuntimeRunInput | null = null
 const executors = createAutomationExecutors({
   runtimes,
   ...(over.generateScript ? { generateScript: over.generateScript } : {}),
   runViaRuntime: async input => {
     captured = input
     return over.outcome ?? { status: 'success', summary: '完成', outputs: { ticketIds: [], eventIds: [] } }
   },
 })
 return { input: () => captured, executors }
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

 it('脚本为空时才调用一次生成器', async () => {
   const generated: string[] = []
   const { input, executors } = harness({
     generateScript: async () => {
       generated.push('call')
       return 'echo generated'
     },
   })
   const automation = task({ type: 'script' })
   await executors.get('script')!.execute({
     automation,
     tools,
     timeoutMs: 60_000,
     maxRetries: 0,
     workdir: workdir(),
     logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
   })

   expect(generated).toEqual(['call'])
   expect(input()!.script).toBe('echo generated')
 })
})
