/**
 * 从「还没收完的 JSON」里抠出 `speech` 字段的已到部分。
 *
 * 会话助手要逐字说话，但参数得用 JSON 交给宿主校验 —— 所以模型同时给两样：
 * `speech` 是给人听的一句人话，其余字段是参数。
 *
 * 流式收到的 JSON 永远是残缺的，这里做的是「能读多少读多少」：
 * 找到 `"speech"` 的值就逐字符解出来，读到一半的转义序列就停下来。
 */

/** 解出一段 JSON 字符串字面量的已解文本；遇到未收完的转义就停。 */
export function decodePartialString(literal: string): string {
  let out = ''
  for (let index = 0; index < literal.length; index += 1) {
    const char = literal[index]!
    if (char === '\\') {
      const next = literal[index + 1]
      if (next === undefined) return out
      if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else if (next === 'r') out += '\r'
      else if (next === 'b') out += '\b'
      else if (next === 'f') out += '\f'
      else if (next === 'u') {
        const hex = literal.slice(index + 2, index + 6)
        if (hex.length < 4) return out
        const code = Number.parseInt(hex, 16)
        if (!Number.isFinite(code)) return out
        out += String.fromCharCode(code)
        index += 4
      } else {
        out += next
      }
      index += 1
      continue
    }
    if (char === '"') return out
    out += char
  }
  return out
}

/** 找出 `speech` 字段值的字面量原文；没有就返回 null。 */
export function speechLiteralOf(raw: string): string | null {
  const match = /"speech"\s*:\s*"/.exec(raw)
  if (!match) return null
  return raw.slice(match.index + match[0].length)
}

/**
 * 取当前已经能读出来的 `speech` 文本。
 *
 * 没这个字段就返回空串 —— 调用方据此判断「还没开始说话」。
 */
export function speechOf(raw: string): string {
  const literal = speechLiteralOf(raw)
  if (literal === null) return ''
  return decodePartialString(literal)
}

/**
 * 取相对 `seen` 的新增部分。
 *
 * 模型重说一遍时文本会变短，这时返回空串而不是乱序的重复文本。
 */
export function speechDelta(raw: string, seen: string): { text: string; seen: string } {
  const current = speechOf(raw)
  if (!current.startsWith(seen)) return { text: '', seen: current }
  return { text: current.slice(seen.length), seen: current }
}
