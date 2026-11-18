/**
 * 侧栏导航的条目定义。
 *
 * 顺序就是菜单里的上下顺序；`tab` 仍是页签标识（与 URL hash 一致），
 * 「收件箱」只是「事件」队列的用户可见叫法，不改路由与深链。
 */
import type { Tab } from './tabs.js'
import type { IconName } from './icons.js'

export interface NavItem {
  tab: Tab
  label: string
  icon: IconName
  /** 侧栏在办计数：只有这一项会带数字角标。 */
  count?: number
}

/**
 * 侧栏菜单。
 *
 * 「收件箱」放在「工单」上方：先看要处理的事件，再看已派出去的工单。
 * 其余项相对顺序保持不变。
 */
export function navItems(openTickets: number): NavItem[] {
  return [
    { tab: 'setup', label: '初始化', icon: 'zap' },
    { tab: 'events', label: '收件箱', icon: 'radio' },
    { tab: 'tickets', label: '工单', icon: 'inbox', count: openTickets },
    { tab: 'config', label: '配置', icon: 'sliders' },
    { tab: 'sources', label: '来源', icon: 'radio' },
    // 日志是排障时的末位入口，放在菜单最后，日常操作优先。
    { tab: 'logs', label: '日志', icon: 'file-text' },
  ]
}
