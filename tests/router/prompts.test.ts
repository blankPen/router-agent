import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const prompt = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/router/prompts/${file}`, import.meta.url)), 'utf8')

describe('Router 研判提示词', () => {
  it('诊断类提问默认接单，不因“只是提问”而忽略', () => {
    const text = prompt('orchestrator.md')
    expect(text).toContain('查现状 / 排查原因并给出结论')
    expect(text).toContain('**诊断类提问默认 `accept`**')
    expect(text).toContain('不要拿历史工单的结论代替当前现状')
  })

  it('重复只认未关闭的在办工单，已关闭工单不算重复', () => {
    const orchestrator = prompt('orchestrator.md')
    const admission = prompt('admission.md')
    expect(orchestrator).toContain('「重复」只算在办工单')
    expect(orchestrator).not.toContain('重复已经开过工单的请求')
    expect(admission).toContain('已关闭（closed）的工单不算重复')
    expect(admission).toContain('未关闭**（open / running）的工单')
  })

  it('引用历史工单结论时必须标注来源与时效', () => {
    const orchestrator = prompt('orchestrator.md')
    const conversation = prompt('conversation.md')
    expect(orchestrator).toContain('必须标明来源与时效')
    expect(conversation).toContain('必须标明来源与时效')
  })

  it('需求识别提示词约束住「不派单 / 只读 / 项目隔离」', () => {
    const analyst = prompt('intake-analyst.md')
    expect(analyst).toContain('没有派单权限')
    expect(analyst).toContain('code_read')
    expect(analyst).toContain('只能访问当前群绑定项目的目录')

    const screener = prompt('intake-screener.md')
    expect(screener).toContain('`issue`')
    expect(screener).toContain('拿不准是 `question` 还是 `issue` 时，选 `issue`')
  })
})
