import { describe, expect, it } from 'vitest'
import { ghPrViewCommand, ghRepoOf, parsePrView, parsePrList } from '../../src/sources/github.js'

describe('GitHub PR 状态解析', () => {
  it('merged PR 归一化为 merged', () => {
    expect(parsePrView(JSON.stringify({ number: 12, url: 'https://github.com/o/r/pull/12', state: 'MERGED', title: '修复登录超时', headRefName: 'ra/tk1' })))
      .toEqual({ number: 12, url: 'https://github.com/o/r/pull/12', state: 'merged', title: '修复登录超时', branch: 'ra/tk1' })
  })

  it('关闭但未合并归一化为 closed', () => {
    expect(parsePrView(JSON.stringify({ number: 3, url: "u", state: "CLOSED", title: "t", headRefName: "b" }))!.state).toBe('closed')
  })

  it('打开归一化为 open', () => {
    expect(parsePrView(JSON.stringify({ number: 3, url: "u", state: "OPEN", title: "t", headRefName: "b" }))!.state).toBe('open')
  })

  it('列表只取第一条（按 head 分支查 PR）', () => {
    const list = parsePrList(JSON.stringify([{ number: 5, url: 'u5', state: 'OPEN', title: 't5', headRefName: 'ra/tk1' }]))
    expect(list?.number).toBe(5)
    expect(parsePrList('[]')).toBeNull()
  })

  it('空输出或非法 JSON 返回 null 而不是抛出', () => {
    expect(parsePrView('')).toBeNull()
    expect(parsePrView('not json')).toBeNull()
  })
})

describe('仓库选择器归一化', () => {
  it('gh 只认 owner/name：剥掉 name:/id: 前缀，path 取最后两段', () => {
    expect(ghRepoOf('name:dsh/router-agent')).toBe('dsh/router-agent')
    expect(ghRepoOf('id:abc-123')).toBe('abc-123')
    expect(ghRepoOf('path:/Users/me/work/dsh/router-agent')).toBe('dsh/router-agent')
    expect(ghRepoOf('dsh/router-agent')).toBe('dsh/router-agent')
    expect(ghPrViewCommand('name:dsh/router-agent', 7)[4]).toBe('dsh/router-agent')
  })
})
