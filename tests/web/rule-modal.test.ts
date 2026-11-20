import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RuleEditor } from '../../src/web/client/event-rules.js'
import { blankRule } from '../../src/web/client/event-rules-model.js'

// 弹窗视觉与交互由 CSS 驱动，这里锁定它与组件之间的契约：
// 保存失败时错误必须在弹窗内可见，而不是被遮罩挡住。
describe('决策规则弹窗', () => {
  const render = (error: string | null): string =>
    renderToStaticMarkup(
      createElement(RuleEditor, {
        rule: blankRule('rule-github-issues-opened', 'github.issues.opened'),
        groups: [],
        title: '添加决策规则',
        error,
        onChange: () => undefined,
        onClose: () => undefined,
        onSave: () => undefined,
      }),
    )

  it('没有错误时不留错误位', () => {
    expect(render(null)).not.toContain('rule-modal-error')
  })

  it('保存失败时错误显示在弹窗底部', () => {
    const html = render('第 1 条规则的 is_valid 缺少 instructions')
    expect(html).toContain('rule-modal-error')
    expect(html).toContain('第 1 条规则的 is_valid 缺少 instructions')
    expect(html).toContain('role="alert"')
  })

  it('标题区分新建与编辑', () => {
    expect(render(null)).toContain('添加决策规则')
  })

  it('按范围 / 意图 / 四问 / 流程 / 阈值分五段', () => {
    const html = render(null)
    expect(html.match(/class="rule-section"/g)).toHaveLength(5)
    expect(html).toContain('规则范围')
    expect(html).toContain('四个判定问题')
    expect(html).toContain('执行流程')
    expect(html).toContain('阈值与护栏')
  })
})
