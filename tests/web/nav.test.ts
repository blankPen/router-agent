import { describe, expect, it } from 'vitest'
import { navItems } from '../../src/web/client/nav.js'

describe('侧栏菜单', () => {
  it('「事件」入口改名「收件箱」，路由标识不变', () => {
    const items = navItems(0)
    const inbox = items.find(item => item.tab === 'events')
    expect(inbox).toBeDefined()
    expect(inbox!.label).toBe('收件箱')
  })

  it('「收件箱」排在「工单」上方', () => {
    const tabs = navItems(0).map(item => item.tab)
    expect(tabs.indexOf('events')).toBeLessThan(tabs.indexOf('tickets'))
  })

  it('其余菜单项相对顺序保持不变', () => {
    const tabs = navItems(0).map(item => item.tab)
    expect(tabs).toEqual(['setup', 'events', 'tickets', 'config', 'sources', 'logs'])
  })

  it('在办工单数只挂在「工单」上', () => {
    const items = navItems(3)
    expect(items.find(item => item.tab === 'tickets')!.count).toBe(3)
    expect(items.filter(item => item.count !== undefined).map(item => item.tab)).toEqual(['tickets'])
  })
})
