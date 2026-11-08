import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../../src/core/model.js'
import {
  attachImageText,
  imageDownloadCommand,
  imageKeysOf,
  messageImageKeysCommand,
  parseImageKeysFromContent,
  parseMessageImageKeys,
  parseSavedPath,
  readImageInput,
} from '../../src/sources/feishu-image.js'
import type { CommandRunner } from '../../src/infra/process.js'

function trigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1',
    source: 'feishu',
    externalId: 'om_1',
    threadId: 'feishu:oc_dev:om_1',
    chatId: 'oc_dev',
    chatName: '研发群',
    actorId: 'ou_alice',
    actorName: 'Alice',
    isBot: false,
    text: '[图片]',
    addressed: 'mention',
    mediaOnly: true,
    receivedAt: '2026-11-06T10:00:00.000Z',
    disposition: 'pending',
    raw: { messageType: 'image' },
    ...over,
  }
}

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ra-image-test-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseImageKeysFromContent', () => {
  it('支持原始 JSON、markdown 标记与 post 嵌套节点', () => {
    expect(parseImageKeysFromContent('{"image_key":"img_v3_abc"}')).toEqual(['img_v3_abc'])
    expect(parseImageKeysFromContent('![Image](img_v3_abc)')).toEqual(['img_v3_abc'])
    expect(parseImageKeysFromContent('<img key="img_v3_abc" width="10"/>')).toEqual(['img_v3_abc'])
    expect(parseImageKeysFromContent(JSON.stringify({
      title: '',
      content: [[{ tag: 'text', text: '看下' }, { tag: 'img', image_key: 'img_v3_abc' }]],
    }))).toEqual(['img_v3_abc'])
  })

  it('去重并忽略非图片 key', () => {
    expect(parseImageKeysFromContent('![Image](img_a) 和 ![Image](img_a) 以及 file_v3_x')).toEqual(['img_a'])
    expect(parseImageKeysFromContent('普通文字')).toEqual([])
    expect(parseImageKeysFromContent('')).toEqual([])
  })
})

describe('mget 回查 image_key', () => {
  it('生成 mget 命令', () => {
    expect(messageImageKeysCommand('om_1')).toEqual(['im', '+messages-mget', '--message-ids', 'om_1', '--as', 'bot', '--format', 'json'])
  })

  it('优先解析目标消息的 content', () => {
    const stdout = JSON.stringify({
      data: {
        messages: [
          { message_id: 'om_other', msg_type: 'image', content: '{"image_key":"img_other"}' },
          { message_id: 'om_1', msg_type: 'image', content: '{"image_key":"img_v3_abc"}' },
        ],
      },
    })
    expect(parseMessageImageKeys(stdout, 'om_1')).toEqual(['img_v3_abc'])
    expect(parseMessageImageKeys(stdout, 'om_missing')).toEqual(['img_other'])
    expect(parseMessageImageKeys('not-json', 'om_1')).toEqual([])
  })
})

describe('下载命令与落盘路径', () => {
  it('生成资源下载命令', () => {
    expect(imageDownloadCommand('om_1', 'img_v3_abc', '/tmp/x')).toEqual([
      'im', '+messages-resources-download',
      '--message-id', 'om_1',
      '--file-key', 'img_v3_abc',
      '--type', 'image',
      '--output', '/tmp/x',
      '--as', 'bot',
      '--format', 'json',
    ])
  })

  it('兼容 saved_path / savedPath / path 三种字段', () => {
    expect(parseSavedPath(JSON.stringify({ data: { saved_path: '/tmp/a.png' } }))).toBe('/tmp/a.png')
    expect(parseSavedPath(JSON.stringify({ data: { savedPath: '/tmp/b.png' } }))).toBe('/tmp/b.png')
    expect(parseSavedPath(JSON.stringify({ path: '/tmp/c.png' }))).toBe('/tmp/c.png')
    expect(parseSavedPath('bad')).toBe('')
  })

  it('读取图片时按文件头识别 MIME', () => {
    const dir = tempDir()
    const path = join(dir, 'no-extension')
    writeFileSync(path, PNG_HEADER)
    expect(readImageInput(path)).toMatchObject({ mimeType: 'image/png' })
    expect(readImageInput(join(dir, 'missing'))).toBeNull()
  })
})

describe('attachImageText', () => {
  class ScriptedRunner implements CommandRunner {
    calls: { argv: string[] }[] = []
    handler: (argv: string[]) => { code: number; stdout: string; stderr: string }
    constructor(handler: (argv: string[]) => { code: number; stdout: string; stderr: string }) {
      this.handler = handler
    }
    async run(argv: string[]) {
      this.calls.push({ argv })
      return this.handler(argv)
    }
  }

  it('下载并转写后，占位文本替换为图片内容，mediaOnly 置 false', async () => {
    const dir = tempDir()
    const saved = join(dir, 'img_v3_abc.png')
    writeFileSync(saved, PNG_HEADER)
    const runner = new ScriptedRunner(argv => {
      if (argv[0] === 'im' && argv[1] === '+messages-mget') {
        return { code: 0, stdout: JSON.stringify({ data: { messages: [{ message_id: 'om_1', content: '{"image_key":"img_v3_abc"}' }] } }), stderr: '' }
      }
      return { code: 0, stdout: JSON.stringify({ data: { saved_path: saved } }), stderr: '' }
    })
    const transcriber = { async transcribe() { return '报错截图：Timeout 30s' } }

    const out = await attachImageText(trigger(), { runner, transcriber })
    expect(out.text).toBe('[图片内容] 报错截图：Timeout 30s')
    expect(out.mediaOnly).toBe(false)
    expect((out.raw as Record<string, any>).images).toEqual([{ key: 'img_v3_abc', messageId: 'om_1', text: '报错截图：Timeout 30s' }])
    expect(runner.calls[0]!.argv).toEqual(messageImageKeysCommand('om_1'))
    const download = runner.calls[1]!.argv
    expect(download.slice(0, 8)).toEqual(['im', '+messages-resources-download', '--message-id', 'om_1', '--file-key', 'img_v3_abc', '--type', 'image'])
    expect(download[9]).toMatch(/^\/tmp\/ra-image-.*\/img_v3_abc$/)
  })

  it('已有 imageKeys 时不再回查 mget，并保留用户补充的文字', async () => {
    const dir = tempDir()
    const saved = join(dir, 'img_v3_abc.png')
    writeFileSync(saved, PNG_HEADER)
    const runner = new ScriptedRunner(() => ({ code: 0, stdout: JSON.stringify({ data: { saved_path: saved } }), stderr: '' }))
    const transcriber = { async transcribe() { return '登录页面截图' } }

    const out = await attachImageText(trigger({
      text: '看下这个图 ![Image](img_v3_abc)',
      mediaOnly: false,
      raw: { messageType: 'post', imageKeys: ['img_v3_abc'] },
    }), { runner, transcriber })

    expect(runner.calls).toHaveLength(1)
    expect(out.text).toBe('[图片内容] 登录页面截图\n\n看下这个图')
    expect(out.mediaOnly).toBe(false)
  })

  it('多张图片分别标注序号', async () => {
    const dir = tempDir()
    const saved = join(dir, 'img.png')
    writeFileSync(saved, PNG_HEADER)
    const runner = new ScriptedRunner(() => ({ code: 0, stdout: JSON.stringify({ data: { saved_path: saved } }), stderr: '' }))
    let index = 0
    const transcriber = { async transcribe() { index += 1; return `图${index}` } }

    const out = await attachImageText(trigger({
      mediaOnly: false,
      raw: { messageType: 'post', imageKeys: ['img_a', 'img_b'] },
      text: '两张图',
    }), { runner, transcriber })

    expect(out.text).toBe('[图片1内容] 图1\n\n[图片2内容] 图2\n\n两张图')
  })

  it('引用图片用被引用消息的 message_id 下载，并标注为引用图片内容', async () => {
    const dir = tempDir()
    const saved = join(dir, 'img_v3_quote.png')
    writeFileSync(saved, PNG_HEADER)
    const runner = new ScriptedRunner(() => ({ code: 0, stdout: JSON.stringify({ data: { saved_path: saved } }), stderr: '' }))
    const transcriber = { async transcribe() { return '设计稿里按钮是蓝色的' } }

    const out = await attachImageText(trigger({
      text: '照这个改',
      mediaOnly: false,
      raw: { messageType: 'text', quoteImages: [{ key: 'img_v3_quote', messageId: 'om_parent' }] },
    }), { runner, transcriber })

    expect(out.text).toBe('[引用图片内容] 设计稿里按钮是蓝色的\n\n照这个改')
    expect((out.raw as Record<string, any>).images).toEqual([
      { key: 'img_v3_quote', messageId: 'om_parent', quoted: true, text: '设计稿里按钮是蓝色的' },
    ])
    expect(runner.calls[0]!.argv).toEqual(imageDownloadCommand('om_parent', 'img_v3_quote', runner.calls[0]!.argv[9]!, 'bot'))
  })

  it('下载或识别失败时原样返回，仍按纯附件处理', async () => {
    const runner = new ScriptedRunner(() => ({ code: 1, stdout: '', stderr: 'resource denied' }))
    const transcriber = { async transcribe() { throw new Error('should not run') } }
    const input = trigger()

    const out = await attachImageText(input, { runner, transcriber })
    expect(out).toBe(input)
    expect(out.mediaOnly).toBe(true)
  })

  it('没有 transcriber 时完全跳过下载', async () => {
    const runner = new ScriptedRunner(() => ({ code: 0, stdout: '{}', stderr: '' }))
    const input = trigger()
    expect(await attachImageText(input, { runner, transcriber: null })).toBe(input)
    expect(runner.calls).toHaveLength(0)
  })

  it('非图片消息不触发下载', async () => {
    const runner = new ScriptedRunner(() => ({ code: 0, stdout: '{}', stderr: '' }))
    const input = trigger({ text: '改下登录超时', mediaOnly: false, raw: { messageType: 'text' } })
    expect(await attachImageText(input, { runner, transcriber: { async transcribe() { return 'x' } } })).toBe(input)
    expect(runner.calls).toHaveLength(0)
  })

  it('imageKeysOf 只认 img_ 前缀', () => {
    expect(imageKeysOf({ imageKeys: ['img_ok', 'file_no', 3] })).toEqual(['img_ok'])
    expect(imageKeysOf(null)).toEqual([])
  })
})
