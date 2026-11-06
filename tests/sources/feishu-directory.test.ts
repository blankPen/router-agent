import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChatDirectory, parseChatList } from '../../src/sources/feishu-directory.js'
import type { CommandRunner } from '../../src/infra/process.js'

const sample = JSON.stringify({
  ok: true,
  data: {
    chats: [
      { chat_id: 'oc_dev', name: '研发群' },
      { chat_id: 'oc_support', name: '客服支持群' },
    ],
  },
})

describe('飞书群名目录', () => {
  it('解析群列表，兼容 chats / items / 裸数组', () => {
    expect(parseChatList(sample)).toHaveLength(2)
    expect(parseChatList(JSON.stringify({ data: { items: [{ chat_id: 'oc_a', name: 'A' }] } }))).toEqual([{ chatId: 'oc_a', name: 'A' }])
    expect(parseChatList(JSON.stringify([{ chat_id: 'oc_b', name: 'B' }]))).toEqual([{ chatId: 'oc_b', name: 'B' }])
    expect(parseChatList('not json')).toEqual([])
  })

  it('刷新后可按 chat_id 取名，并持久化到文件', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ra-dir-')), 'chats.json')
    const runner: CommandRunner = { run: async () => ({ code: 0, stdout: sample, stderr: '' }) }
    const dir = new ChatDirectory(file)
    expect(dir.nameOf('oc_dev')).toBe('')
    expect(await dir.refresh(runner)).toBe(2)
    expect(dir.nameOf('oc_dev')).toBe('研发群')

    const reloaded = new ChatDirectory(file)
    expect(reloaded.nameOf('oc_support')).toBe('客服支持群')
  })

  it('刷新失败保留旧值', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ra-dir-')), 'chats.json')
    const dir = new ChatDirectory(file)
    await dir.refresh({ run: async () => ({ code: 0, stdout: sample, stderr: '' }) })
    expect(await dir.refresh({ run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) })).toBe(0)
    expect(dir.nameOf('oc_dev')).toBe('研发群')
  })
})
