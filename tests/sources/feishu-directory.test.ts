import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChatDirectory, parseChatList } from '@router-agent/channel-feishu'
import type { CommandRunner } from '#infra/process.js'

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

describe('群名目录日志', () => {
  function recorder() {
    const logs: { level: string; message: string; extra?: Record<string, unknown> }[] = []
    return {
      logs,
      logger: {
        info: () => {},
        warn: (message: string, extra?: Record<string, unknown>) => logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }),
        error: () => {},
      },
    }
  }

  it('缓存文件损坏时记 chats:cache-invalid，目录按空处理', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ra-dir-')), 'chats.json')
    writeFileSync(file, '{broken', 'utf8')
    const { logs, logger } = recorder()
    const dir = new ChatDirectory(file, logger)
    expect(dir.entries()).toEqual([])
    expect(logs[0]?.message).toBe('chats:cache-invalid')
  })

  it('lark-cli 返回非 0 时记 chats:refresh-failed，旧值保留', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ra-dir-')), 'chats.json')
    const { logs, logger } = recorder()
    const dir = new ChatDirectory(file, logger)
    expect(await dir.refresh({ run: async () => ({ code: 2, stdout: '', stderr: 'boom' }) })).toBe(0)
    expect(logs[0]?.message).toBe('chats:refresh-failed')
    expect(logs[0]?.extra?.code).toBe(2)
  })

  it('返回内容不是 JSON 时记 chats:parse-failed', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ra-dir-')), 'chats.json')
    const { logs, logger } = recorder()
    const dir = new ChatDirectory(file, logger)
    expect(await dir.refresh({ run: async () => ({ code: 0, stdout: 'not-json', stderr: '' }) })).toBe(0)
    expect(logs[0]?.message).toBe('chats:parse-failed')
  })
})
