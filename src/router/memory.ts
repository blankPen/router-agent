import { REPLY_PREFERENCE_VALUES, type MemoryChange, type ReplyPreferenceKey } from '../core/memory.js'

type MemoryCommand =
  | { action: 'help' }
  | { action: 'list'; crossChat: boolean }
  | { action: 'change'; crossChat: boolean; change: MemoryChange }

export const MEMORY_HELP = [
  '用法：/记忆 保存 回复语言=简体中文，/记忆 列表，/记忆 删除 回复语言。',
  '支持的偏好：',
  ...Object.entries(REPLY_PREFERENCE_VALUES).map(([key, values]) => `- ${key}：${values.join('、')}`),
  '跨群偏好请在私聊管理，例如 /记忆 保存 跨群 回复语言=简体中文，/记忆 列表 跨群，/记忆 删除 跨群 回复语言。',
].join('\n')

function isPreferenceKey(key: string): key is ReplyPreferenceKey {
  return Object.hasOwn(REPLY_PREFERENCE_VALUES, key)
}

export function parseMemoryCommand(text: string): MemoryCommand | null {
  const command = /^\s*(?:@\S+[ \t]+)?\/记忆(?=\s|$)([\s\S]*)$/.exec(text)
  if (!command) return null
  const match = /^(保存|列表|删除)(?:[ \t]+(.*))?$/.exec((command[1] ?? '').trim())
  if (!match) return { action: 'help' }
  const args = match[2] ?? ''
  const crossChat = /^跨群(?:[ \t]+|$)/.test(args)
  const rest = crossChat ? args.slice('跨群'.length).trimStart() : args
  if (match[1] === '列表' && rest === '') return { action: 'list', crossChat }
  if (match[1] === '删除' && isPreferenceKey(rest)) {
    return { action: 'change', crossChat, change: { key: rest, value: null } }
  }
  if (match[1] === '保存') {
    const pair = /^([^=＝]+)[=＝]([^=＝]+)$/.exec(rest)
    if (pair?.[1] && pair[2]) {
      const key = pair[1].trim()
      const value = pair[2].trim()
      if (isPreferenceKey(key) && (REPLY_PREFERENCE_VALUES[key] as readonly string[]).includes(value)) {
        return { action: 'change', crossChat, change: { key, value } as MemoryChange }
      }
    }
  }
  return { action: 'help' }
}
