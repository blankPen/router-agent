/**
 * 面板访问令牌：从地址栏取令牌并抹掉明文。
 */
import { describe, expect, it } from 'vitest'
import { takeTokenFromUrl } from '../../src/web/client/access-token.js'

describe('面板访问令牌', () => {
  it('地址栏带 token 时取出令牌，并把参数从 URL 上摘掉', () => {
    const result = takeTokenFromUrl('http://192.168.31.121:3083/?token=lan-secret-token#setup')
    expect(result.token).toBe('lan-secret-token')
    expect(result.url).not.toContain('lan-secret-token')
    expect(result.url).toContain('#setup')
  })

  it('地址栏没有 token 时原样返回', () => {
    const result = takeTokenFromUrl('http://127.0.0.1:3083/#setup')
    expect(result.token).toBe('')
    expect(result.url).toBe('http://127.0.0.1:3083/#setup')
  })
})
