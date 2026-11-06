import { describe, expect, it } from 'vitest'
import { proposalFromJson } from '../../src/router/decision-engine.js'

describe('DecisionEngine 提案解析', () => {
  it('accept 解析成完整 proposal，并保留可选字段', () => {
    expect(proposalFromJson({
      decision: 'accept',
      reason: 'ok',
      title: 't',
      scope: 's',
      repo: 'r',
      branch: 'main',
      rules: ['bugfix'],
    }, 't1', 'explicit')).toEqual({
      kind: 'proposal',
      proposal: {
        triggerId: 't1',
        decision: 'accept',
        strength: 'explicit',
        reason: 'ok',
        title: 't',
        scope: 's',
        repo: 'r',
        branch: 'main',
        rules: ['bugfix'],
      },
    })
  })

  it('unavailable 走单独分支，非法决定报错', () => {
    expect(proposalFromJson({ decision: 'unavailable', reason: '模型挂了' }, 't1', 'inferred')).toEqual({
      kind: 'unavailable',
      reason: '模型挂了',
    })
    expect(proposalFromJson({ decision: 'nope' }, 't1', 'inferred')).toEqual({
      kind: 'error',
      reason: '非法决定：nope',
    })
    expect(proposalFromJson({}, 't1', 'inferred').kind).toBe('error')
  })

  it('ignore / stop 也保留 reason，rules 缺省为空数组', () => {
    const ignored = proposalFromJson({ decision: 'ignore', reason: '闲聊' }, 't1', 'inferred')
    expect(ignored.kind).toBe('proposal')
    if (ignored.kind === 'proposal') {
      expect(ignored.proposal.decision).toBe('ignore')
      expect(ignored.proposal.reason).toBe('闲聊')
      expect(ignored.proposal.rules).toEqual([])
    }
    expect(proposalFromJson({ decision: 'stop', reason: '停一下' }, 't1', 'explicit').kind).toBe('proposal')
  })
})