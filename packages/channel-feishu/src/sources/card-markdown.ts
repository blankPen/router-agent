/**
 * 卡片 markdown 元素（Card 1.0）只支持基础语法：不带标题、引用、表格的渲染，
 * 这里把不支持的写法降级为卡片能正常显示的形式，避免用户看到 Markdown 源码。
 */
export function normalizeCardMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n')
  const out: string[] = []
  let fence: string | null = null

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]!
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]![0]!
      else if (fenceMatch[1]![0] === fence) fence = null
      out.push(line)
      continue
    }
    if (fence !== null) {
      out.push(line)
      continue
    }

    // 换行标签与图片语法在卡片里都不成立：<br> 转真换行，图片转可点击链接。
    line = line.replace(/<br\s*\/?>/gi, '\n')
    line = line.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_match, alt: string, url: string) =>
      alt.trim() ? `[${alt.trim()}](${url})` : `[图片](${url})`)

    // 表格：1.0 卡片不渲染表格，降级为「加粗表头 + 列表行」。
    if (isTableRow(line) && index + 1 < lines.length && isTableDivider(lines[index + 1]!)) {
      const header = parseTableCells(line)
      index += 1
      const rows: string[][] = []
      while (index + 1 < lines.length && isTableRow(lines[index + 1]!)) {
        index += 1
        rows.push(parseTableCells(lines[index]!))
      }
      out.push(header.map(cell => `**${cell}**`).join(' · '))
      for (const row of rows) out.push(`- ${row.join(' · ')}`)
      continue
    }

    // 标题：卡片不渲染 #，统一降级成加粗行。
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      out.push(`**${heading[1]}**`)
      continue
    }

    // 引用：卡片不渲染 >，用竖线前缀保留引用观感。
    const quote = /^\s{0,3}(?:>\s?)+(.*)$/.exec(line)
    if (quote) {
      out.push(`▍${quote[1]}`)
      continue
    }

    // 任务列表：卡片不支持 [ ] / [x]，换成勾选框字符。
    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (task) {
      out.push(`${task[1]}- ${task[2] === ' ' ? '☐' : '☑'} ${task[3]}`)
      continue
    }

    out.push(line)
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line)
}

function parseTableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map(cell => cell.trim())
}
