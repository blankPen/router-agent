import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { simulate } from '../src/cli/simulate.js'
import { defaultConfig, type AppConfig, chatEntry } from '../src/config.js'
import type { LlmClient } from '../src/router/llm.js'

function config(): AppConfig {
  const value = defaultConfig()
  value.projects = [{ name: 'teamwork-repos', repo: 'teamwork-repos', branches: [], defaultBranch: 'main' }]
  value.feishu.chats = [chatEntry('oc_dsh')]
  value.feishu.allowed = ['ou_me']
  value.feishu.botOpenIds = ['ou_bot']
  return value
}

class CountingLlm implements LlmClient {
  calls = 0
  constructor(private response: string) {}
  async complete() {
    this.calls += 1
    return { content: this.response, toolCalls: [] }
  }
}

describe('ra simulate', () => {
  it('显式请求经研判后建单', async () => {
    const llm = new CountingLlm('{"decision":"accept","reason":"明确","title":"改登录超时","scope":"只改超时"}')
    const result = await simulate({ home: mkdtempSync(join(tmpdir(), 'ra-sim-')), config: config(), llm }, { text: '把登录超时改成 30 秒', dryRun: true })
    expect(llm.calls).toBe(1)
    expect(result.decision?.decision).toBe('accept')
    expect(result.decision?.strength).toBe('explicit')
    expect(result.ticket?.title).toBe('改登录超时')
  })

  it('--infer 时走 LLM 研判，接受后建单', async () => {
    const llm = new CountingLlm('{"decision":"accept","reason":"可执行","title":"改超时","scope":"只改超时"}')
    const result = await simulate({ home: mkdtempSync(join(tmpdir(), 'ra-sim-')), config: config(), llm }, { text: '把登录超时改成 30 秒', addressed: 'none', dryRun: true })
    expect(llm.calls).toBe(1)
    expect(result.decision?.strength).toBe('inferred')
    expect(result.ticket?.title).toBe('改超时')
  })

  it('observe 模式下推断通过只记录「本应接单」，不建单', async () => {
    const cfg = config()
    cfg.policy.acceptMode = 'observe'
    const llm = new CountingLlm('{"decision":"accept","reason":"可执行","title":"改超时","scope":"x"}')
    const result = await simulate({ home: mkdtempSync(join(tmpdir(), 'ra-sim-')), config: cfg, llm }, { text: '把登录超时改成 30 秒', addressed: 'none', dryRun: true })
    expect(result.decision?.decision).toBe('ignore')
    expect(result.decision?.wouldAccept).toBe(true)
    expect(result.ticket).toBeUndefined()
  })

  it('模型给出 ignore 时不建单', async () => {
    const llm = new CountingLlm('{"decision":"ignore","reason":"闲聊"}')
    const result = await simulate({ home: mkdtempSync(join(tmpdir(), 'ra-sim-')), config: config(), llm }, { text: '今天天气不错', addressed: 'none', dryRun: true })
    expect(result.ticket).toBeUndefined()
    expect(result.decision?.decision).toBe('ignore')
  })

  it('寒暄会生成一条普通消息回复并随结果返回', async () => {
    const llm = new CountingLlm('你好呀，需要我帮你改点什么？')
    const result = await simulate({ home: mkdtempSync(join(tmpdir(), 'ra-sim-')), config: config(), llm }, { text: '你好，在吗', dryRun: true })
    expect(result.ticket).toBeUndefined()
    expect(result.replies).toEqual(['你好呀，需要我帮你改点什么？'])
  })

  it('接单会返回 ack 与话题开场两条回复', async () => {
    const llm = new CountingLlm('{"decision":"accept","reason":"ok","title":"改超时","scope":"x"}')
    const result = await simulate({ home: mkdtempSync(join(tmpdir(), 'ra-sim-')), config: config(), llm }, { text: '把登录超时改成 30 秒', dryRun: true })
    expect(result.replies[0]).toContain('我帮你创建了工单 T1')
    expect(result.replies[1]).toContain('后续进展会在这个话题里更新')
  })

  it('dryRun 不写 state.db', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-sim-'))
    await simulate({ home, config: config(), llm: new CountingLlm('{}') }, { text: 'x', dryRun: true })
    expect(existsSync(join(home, 'state.db'))).toBe(false)
  })
})