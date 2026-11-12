import { describe, expect, it } from 'vitest'
import { ticketSlug, workBranch, worktreeName } from '#runtime/naming.js'

describe('工单命名', () => {
  it('英文标题转成短横线 slug', () => {
    expect(ticketSlug('Fix login timeout in auth service')).toBe('fix-login-timeout-in-auth-service')
    expect(ticketSlug('  Upgrade   VUE  to 3.0 ')).toBe('upgrade-vue-to-3-0')
  })

  it('中英混排优先用英文词，纯中文标题保留中文', () => {
    expect(ticketSlug('修复 login timeout 问题')).toBe('login-timeout')
    expect(ticketSlug('调整登录超时')).toBe('调整登录超时')
    expect(ticketSlug('改造工单为简短编号，并语义化分支命名')).toBe('改造工单为简短编号并语义化分支命名')
  })

  it('全角字符会先归一化', () => {
    expect(ticketSlug('Ｆｉｘ 登录')).toBe('fix')
  })

  it('取不到有效内容时用 task 兜底，且长度受限', () => {
    expect(ticketSlug('!!! ???')).toBe('task')
    expect(ticketSlug('')).toBe('task')
    expect(ticketSlug('a'.repeat(120)).length).toBe(36)
  })

  it('分支名是 ra/<工单号>-<语义>，worktree 目录名与分支名一致', () => {
    const ticket = { id: 'tk-12', title: 'Fix login timeout' }
    expect(workBranch(ticket)).toBe('ra/tk-12-fix-login-timeout')
    expect(workBranch({ id: 'tk-13', title: '调整登录超时' })).toBe('ra/tk-13-调整登录超时')
    expect(worktreeName(ticket)).toBe('ra-tk-12-fix-login-timeout')
    expect(worktreeName({ id: 'tk-13', title: '调整登录超时' })).toBe('ra-tk-13-调整登录超时')
  })
})
