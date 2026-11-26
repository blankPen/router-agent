import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Automation } from '#core/automation.js'
import { runThroughRuntime } from '../../src/automation/runner.js'
import type { WorkerRuntime } from '#runtime/port.js'

function task(over: Partial<Automation> = {}): Automation {
  return {
    id: 'auto_1',
    name: '巡检',
    description: '',
    type: 'ai',
    prompt: '检查依赖更新',
    trigger: { kind: 'schedule', schedule: { kind: 'daily', at: '09:00' } },
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

/**
 * 一个假 runtime：状态恒为 running，agent 完成靠写信号文件表达。
 *
 * 第一次查状态时把信号文件写上，模拟 agent 干完活上报。
 */
function fakeRuntime(workdir: string): WorkerRuntime {
  let reported = false
  return {
    id: 'fake',
    async start() {
      return { handle: 'h1', workdir }
    },
    async status() {
      if (!reported) {
        reported = true
        writeFileSync(join(workdir, '.automation-result'), '检查了 3 个依赖\n', 'utf8')
      }
      return { alive: true, phase: 'running', acceptingInput: false }
    },
    async output() {
      return { status: 'running', lines: [] }
    },
    async stop() {},
  } as unknown as WorkerRuntime
}

describe('自动化执行桥', () => {
  it('runtime 侧的日志带上 runId，能把执行记录和日志串起来', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ra-automation-runner-'))
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
    await runThroughRuntime({
      automation: task(),
      runtime: fakeRuntime(workdir),
      contract: '做完了就上报',
      workdir,
      tools: [],
      timeoutMs: 60_000,
      runId: 'run_1',
    }, {
      home: '/tmp/ra-tk84-runner',
      collectOutputs: () => ({ ticketIds: [], eventIds: [] }),
      logger: {
        info: (event, fields) => logs.push({ event, fields: fields ?? {} }),
        warn: (event, fields) => logs.push({ event, fields: fields ?? {} }),
        error: (event, fields) => logs.push({ event, fields: fields ?? {} }),
      },
      sleep: async () => undefined,
    })

    expect(logs.length).toBeGreaterThan(0)
    for (const log of logs) {
      expect(log.fields.runId, `${log.event} 缺少 runId`).toBe('run_1')
    }
  })

  it('脚本自动化路径上的日志也带上 runId', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ra-automation-runner-'))
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
    await runThroughRuntime({
      automation: task({ type: 'script' }),
      runtime: fakeRuntime(workdir),
      contract: '跑脚本',
      script: 'echo hi',
      scriptPath: join(workdir, 'automation.sh'),
      workdir,
      tools: [],
      timeoutMs: 60_000,
      runId: 'run_2',
    }, {
      home: '/tmp/ra-tk84-runner',
      collectOutputs: () => ({ ticketIds: [], eventIds: [] }),
      logger: {
        info: (event, fields) => logs.push({ event, fields: fields ?? {} }),
        warn: (event, fields) => logs.push({ event, fields: fields ?? {} }),
        error: (event, fields) => logs.push({ event, fields: fields ?? {} }),
      },
      sleep: async () => undefined,
    })

    // 脚本落进 runtime 工作目录这条事件以前漏了 runId：日志串不起来。
    expect(logs.some(log => log.event === 'automation:script-staged')).toBe(true)
    for (const log of logs) {
      expect(log.fields.runId, `${log.event} 缺少 runId`).toBe('run_2')
    }
  })

  it('agent 报告完成后立即收尾，不再等到超时', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ra-automation-runner-'))
    const outcome = await runThroughRuntime({
      automation: task(),
      runtime: fakeRuntime(workdir),
      contract: '做完了就上报',
      workdir,
      tools: [],
      timeoutMs: 60_000,
    }, {
      home: '/tmp/ra-tk84-runner',
      collectOutputs: () => ({ ticketIds: [], eventIds: [] }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      sleep: async () => undefined,
    })

    expect(outcome.status).toBe('success')
    expect(outcome.summary).toBe('检查了 3 个依赖')
  })

  it('agent 没写完成信号文件就等到超时', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ra-automation-runner-'))
    const outcome = await runThroughRuntime({
      automation: task(),
      runtime: fakeRuntime(workdir),
      contract: '做完了就上报',
      workdir,
      tools: [],
      timeoutMs: 0,
    }, {
      home: '/tmp/ra-tk84-runner',
      collectOutputs: () => ({ ticketIds: [], eventIds: [] }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      sleep: async () => undefined,
    })

    expect(outcome.status).toBe('timeout')
  })

  it('agent 改过脚本时把改后的正文写回任务定义', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ra-automation-runner-'))
    const fixed = '#!/bin/sh\necho fixed\n'
    const saved: string[] = []
    const runtime: WorkerRuntime = {
      id: 'fake',
      async start() {
        return { handle: 'h1', workdir }
      },
      // agent 执行期间顺手把跑不起来的脚本修好。
      async status() {
        writeFileSync(join(workdir, 'automation.sh'), fixed, 'utf8')
        return { alive: true, phase: 'running' as const, acceptingInput: false }
      },
      async output() {
        return { status: 'running' as const, lines: [] }
      },
      async stop() {},
    } as unknown as WorkerRuntime
    // 时钟前两次给小数，第三次跳到超时之后：让轮询跑一轮就结束。
    let tick = 0
    await runThroughRuntime({
      automation: task(),
      runtime,
      contract: '执行脚本',
      script: '#!/bin/sh\necho broken\n',
      scriptPath: join(workdir, 'automation.sh'),
      workdir,
      tools: [],
      timeoutMs: 60,
    }, {
      home: '/tmp/ra-tk84-runner',
      collectOutputs: () => ({ ticketIds: [], eventIds: [] }),
      onScriptChanged: (_automation, script) => saved.push(script),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => (tick++ < 2 ? tick * 10 : 1_000),
      sleep: async () => undefined,
    })

    expect(saved).toEqual([fixed])
  })

  it('执行结束后回收 runtime 建的工作区', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ra-automation-runner-'))
    const removed: string[] = []
    const runtime = fakeRuntime(workdir) as WorkerRuntime & {
      removeWorkspace: (ref: { workdir: string }) => Promise<void>
    }
    runtime.removeWorkspace = async ref => { removed.push(ref.workdir) }
    await runThroughRuntime({
      automation: task(),
      runtime,
      contract: '做完了就上报',
      workdir,
      tools: [],
      timeoutMs: 0,
    }, {
      home: '/tmp/ra-tk84-runner',
      collectOutputs: () => ({ ticketIds: [], eventIds: [] }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      sleep: async () => undefined,
    })

    expect(removed).toEqual([workdir])
  })
})
