/**
 * 会话流的客户端行为：逐字增量、断线补齐、正常收流。
 *
 * 覆盖 §12.7（V29~V31）。
 * 服务端那侧用假的 SSE 字节流喂，不连真网络。
 */
import { describe, expect, it } from 'vitest'
import { parseSseChunk, readEventStream } from '../../src/web/client/api.js'
import {
  mergeMissedMessages,
  mergeTurnMessage,
  type ConversationMessage,
} from '../../src/web/client/automation-model.js'

/** 把若干段文本拼成 SSE 字节流；每段单独 push，模拟分片到达。 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index]!))
      index += 1
    },
  })
}

describe('SSE 解析', () => {
  it('解析出事件名与数据', () => {
    expect(parseSseChunk('event: turn\ndata: {"message":"好"}')).toEqual({
      event: 'turn',
      data: { message: '好' },
    })
  })

  it('心跳注释行被忽略，不当成消息', () => {
    expect(parseSseChunk(': ping')).toBeNull()
  })

  it('没有 data 行的块被忽略', () => {
    expect(parseSseChunk('event: turn')).toBeNull()
  })

  it('数据不是 JSON 时原样交给调用方', () => {
    expect(parseSseChunk('event: turn\ndata: 不是JSON')).toEqual({ event: 'turn', data: '不是JSON' })
  })
})

describe('会话流', () => {
  it('助手逐字吐字：收到多个 message 增量片段（V29）', async () => {
    const events: Array<{ event: string; data: unknown }> = []
    await readEventStream(
      streamOf([
        'event: message\ndata: {"text":"我先"}\n\n',
        'event: message\ndata: {"text":"看一"}\n\n',
        'event: message\ndata: {"text":"眼"}\n\n',
      ]),
      { onEvent: (event, data) => events.push({ event, data }) },
    )
    const chunks = events.filter(item => item.event === 'message')
    expect(chunks).toHaveLength(3)
    expect(chunks.map(item => (item.data as { text: string }).text).join('')).toBe('我先看一眼')
  })

  it('一轮说完收到 done 事件，连接关闭（V31）', async () => {
    const events: string[] = []
    await readEventStream(
      streamOf([
        'event: turn\ndata: {"message":"好了","done":true}\n\n',
        'event: done\ndata: {"ok":true}\n\n',
      ]),
      { onEvent: event => events.push(event) },
    )
    expect(events).toEqual(['turn', 'done'])
  })

  it('心跳不会打断消息（V29 / V31）', async () => {
    const events: string[] = []
    await readEventStream(
      streamOf([
        ': ping\n\n',
        'event: message\ndata: {"text":"在"}\n\n',
        ': ping\n\n',
        'event: done\ndata: {"ok":true}\n\n',
      ]),
      { onEvent: event => events.push(event) },
    )
    expect(events).toEqual(['message', 'done'])
  })
})

describe('会话消息合并', () => {
  it('逐字片段先进消息流，turn 到达后补结论且不重复正文（V29）', () => {
    const withSpeech: ConversationMessage[] = [
      { seq: 1, role: 'user', text: '订阅 CI 失败' },
      { seq: 2, role: 'assistant', text: '我先', step: 'speech' },
    ]
    const merged = mergeTurnMessage(
      withSpeech,
      { message: '我先看一眼目录', step: 'preview', done: false },
      '我先',
    )
    expect(merged).toHaveLength(3)
    // 已经逐字显示过的话不再整段重复。
    expect(merged[2]!.text).toBe('')
    expect(merged[2]!.step).toBe('preview')
  })

  it('没有逐字片段时 turn 的正文直接上屏', () => {
    const merged = mergeTurnMessage([], { message: '参数齐了', step: 'preview' }, '')
    expect(merged[0]!.text).toBe('参数齐了')
  })

  it('断线补齐：遗漏的消息按 seq 接在后面，已显示的不重复（V30）', () => {
    const current: ConversationMessage[] = [
      { seq: 1, role: 'user', text: '订阅 CI 失败' },
      { seq: 2, role: 'assistant', text: '我先' },
    ]
    const missed: ConversationMessage[] = [
      { seq: 2, role: 'assistant', text: '我先' },
      { seq: 3, role: 'assistant', text: '看完了' },
      { seq: 4, role: 'assistant', text: '参数齐了' },
    ]
    const merged = mergeMissedMessages(current, missed)
    expect(merged.map(item => item.seq)).toEqual([1, 2, 3, 4])
    expect(merged.map(item => item.text)).toEqual(['订阅 CI 失败', '我先', '看完了', '参数齐了'])
  })

  it('没有遗漏消息时列表原样返回', () => {
    const current: ConversationMessage[] = [{ seq: 1, role: 'user', text: '嗨' }]
    expect(mergeMissedMessages(current, [])).toBe(current)
  })
})
