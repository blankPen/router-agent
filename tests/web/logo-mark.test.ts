import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LogoMark } from '../../src/web/client/icons.js'

// 动效由 app.css 驱动，这里锁定它与组件之间的契约：类名、交错延迟与 pathLength 归一化。
describe('品牌标识的信号流转动效结构', () => {
  const html = renderToStaticMarkup(createElement(LogoMark))

  it('六条辐条各有一条脉冲，且都做了 pathLength 归一化', () => {
    expect(html.match(/class="logo-signal"/g)).toHaveLength(6)
    expect(html.match(/pathLength="100"/g)).toHaveLength(6)
  })

  it('脉冲与外圈节点按 120ms 依次错开', () => {
    expect([...html.matchAll(/class="logo-signal"[^>]*style="animation-delay:(\d+)ms"/g)].map(m => m[1]))
      .toEqual(['0', '120', '240', '360', '480', '600'])
    expect([...html.matchAll(/class="logo-node"[^>]*style="animation-delay:(\d+)ms"/g)].map(m => m[1]))
      .toEqual(['0', '120', '240', '360', '480', '600'])
  })

  it('中心节点单独留出闪烁钩子', () => {
    expect(html).toContain('class="logo-hub"')
    expect(html).toContain('class="logo-nodes"')
  })
})