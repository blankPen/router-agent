import { describe, expect, it } from 'vitest'
import { classifyModelFailure, modelFailureMessage } from '../../src/router/model-failure.js'

describe('模型失败分类', () => {
  it('额度耗尽归为 quota，并说明要充值 / 升级套餐', () => {
    const failure = classifyModelFailure(
      'pi:error:429: {"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)","http_code":"429"}',
    )
    expect(failure.kind).toBe('quota')
    expect(failure.hint).toContain('Token Plan')

    const message = modelFailureMessage(
      'pi:error:429: {"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)","http_code":"429"}',
      'assess',
    )
    expect(message).toContain('额度')
    expect(message).toContain('充值')
    expect(message).toContain('这轮没能开工')
  })

  it('纯限流（没有额度字样）归为 rate-limit', () => {
    const failure = classifyModelFailure('pi:error:429: {"type":"rate_limit_error","http_code":"429"}')
    expect(failure.kind).toBe('rate-limit')
    expect(modelFailureMessage('pi:error:429: {"type":"rate_limit_error"}')).toContain('限流')
  })

  it('鉴权失败归为 auth，并指向 llm.apiKey 配置', () => {
    const failure = classifyModelFailure('pi:error:401: {"message":"invalid api key"}')
    expect(failure.kind).toBe('auth')
    expect(modelFailureMessage('pi:error:401: invalid api key')).toContain('apiKey')
  })

  it('超时归为 timeout', () => {
    expect(classifyModelFailure('pi:timeout(60000ms)').kind).toBe('timeout')
    expect(classifyModelFailure('pi:timeout(60000ms)')).toBeTruthy()
    expect(modelFailureMessage('pi:timeout(60000ms)')).toContain('超时')
  })

  it('token 预算超限归为 budget', () => {
    expect(classifyModelFailure('pi:token-budget(32000)').kind).toBe('budget')
  })

  it('网络错误归为 network', () => {
    expect(classifyModelFailure('pi:error:fetch failed').kind).toBe('network')
    expect(classifyModelFailure('pi:error:ECONNREFUSED').kind).toBe('network')
  })

  it('模型没配置好归为 config', () => {
    expect(classifyModelFailure('pi:model-config-missing: 需要配置 baseUrl / apiKey / model').kind).toBe('config')
  })

  it('模型输出不可解析归为 output', () => {
    expect(classifyModelFailure('pi:no-decision').kind).toBe('output')
    expect(classifyModelFailure('模型未给出可解析的决定').kind).toBe('output')
  })

  it('认不出来时归为 unknown，并把原始原因带出去', () => {
    const failure = classifyModelFailure('something went sideways')
    expect(failure.kind).toBe('unknown')
    expect(failure.detail).toBe('something went sideways')
    expect(modelFailureMessage('something went sideways')).toContain('something went sideways')
  })

  it('回复环节的文案说的是「没能回复」，研判环节说的是「没能开工」', () => {
    expect(modelFailureMessage('pi:timeout(1ms)', 'reply')).toContain('没能回复')
    expect(modelFailureMessage('pi:timeout(1ms)', 'assess')).toContain('没能开工')
  })

  it('原始原因过长时截断，避免刷屏', () => {
    const failure = classifyModelFailure('x'.repeat(1000))
    expect(failure.detail.length).toBeLessThanOrEqual(301)
  })
})
