/**
 * 自动化会话面板：用一句话建任务。
 *
 * 这是「新建自动化」的唯一入口（旧的表单弹窗退场）。
 * 会话与任务一一绑定：任务卡的「恢复会话」回到同一条会话，历史接得上。
 *
 * 流式：助手逐字吐字（SSE），断线按 `seq` 补齐增量（§12.7）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, openEventStream, sendJson } from './api.js'
import { Icon } from './icons.js'
import { AutomationPreviewCard, type AutomationPreview } from './automation-preview-card.js'
import { mergeMissedMessages, mergeTurnMessage, type ConversationMessage } from './automation-model.js'

/** 会话记录（与服务端 `AutomationConversation` 同形的子集）。 */
export interface ConversationRecord {
  id: string
  taskId?: string
  source: string
  requester: string
  text: string
  step: string
  status: 'active' | 'confirmed' | 'abandoned'
  createdAt: string
  updatedAt: string
}

interface Notice {
  kind: 'ok' | 'warn' | 'error'
  text: string
}

/** 会话面板。 */
export function AutomationConversationView({ conversationId, onTaskCreated, onClose }: {
  /** 打开哪条会话；空表示新建。 */
  conversationId?: string
  /** 任务落库后回调（父组件刷新任务列表）。 */
  onTaskCreated?: (taskId: string) => void
  onClose?: () => void
}): JSX.Element {
  const [conversation, setConversation] = useState<ConversationRecord | null>(null)
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [catalogHint, setCatalogHint] = useState('')
  const streamRef = useRef<AbortController | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  /** 已经收到的最大 seq；断线后按它补齐遗漏的消息（§12.7 V30）。 */
  const lastSeqRef = useRef(0)

  /** 断线补齐：按 seq 拉遗漏的消息，追加到消息流末尾。 */
  const catchUp = useCallback(async (id: string): Promise<void> => {
    try {
      const data = await getJson<{ messages: ConversationMessage[] }>(
        `/api/automations/conversations/${encodeURIComponent(id)}/messages?after=${lastSeqRef.current}`,
      )
      const missed = data.messages ?? []
      if (missed.length === 0) return
      lastSeqRef.current = Math.max(lastSeqRef.current, ...missed.map(item => item.seq))
      setMessages(current => mergeMissedMessages(current, missed))
    } catch {
      // 补齐失败不打断界面：下一轮或用户手动刷新还能拿到。
    }
  }, [])

  const send = useCallback(async (text: string): Promise<void> => {
    const id = conversation?.id
    if (!id || busy) return
    setBusy(true)
    setNotice(null)
    // 用户这条先上屏，助手的话随后从 SSE 进来。
    setMessages(current => [...current, { seq: current.length + 1, role: 'user', text }])
    setInput('')
    const controller = new AbortController()
    streamRef.current = controller
    // 助手逐字吐出来的片段：先攒着，turn 事件到了再合成一条消息。
    let spoken = ''
    let speechSeq = 0
    await openEventStream(
      `/api/automations/conversations/${encodeURIComponent(id)}/stream`,
      { text },
      {
        onEvent: (event, data) => {
          if (event === 'message') {
            // 增量片段：单独一格显示，让用户看得到助手在逐字说话。
            const chunk = (data as { text?: string }).text ?? ''
            if (!chunk) return
            spoken += chunk
            speechSeq += 1
            setMessages(current => [
              ...current,
              { seq: current.length + 1, role: 'assistant', text: chunk, step: 'speech' },
            ])
            return
          }
          if (event === 'turn') {
            const turn = data as {
              message?: string
              step?: string
              missing?: string[]
              preview?: AutomationPreview
              done?: boolean
              speech?: string
            }
            setMessages(current => mergeTurnMessage(current, turn, spoken))
          } else if (event === 'error') {
            const failure = data as { message?: string }
            setNotice({ kind: 'error', text: failure.message ?? '会话流中断了' })
          }
        },
        onError: error => {
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
          // 断线了也要把丢掉的增量补回来（V30）。
          void catchUp(id)
        },
      },
      controller.signal,
    )
    // 流正常结束或断开后都补一次：断线期间写进会话的消息要显示出来。
    await catchUp(id)
    streamRef.current = null
    setBusy(false)
  }, [conversation?.id, busy, catchUp])

  const confirm = useCallback(async (): Promise<void> => {
    const id = conversation?.id
    if (!id) return
    setBusy(true)
    try {
      const data = await sendJson<{ turn: { taskId?: string } }>(
        `/api/automations/conversations/${encodeURIComponent(id)}/confirm`,
        'POST',
        {},
      )
      setNotice({ kind: 'ok', text: '任务已建好，在下面的任务列表里能看到。' })
      setMessages(current => [
        ...current,
        { seq: current.length + 1, role: 'assistant', text: '已建好。' },
      ])
      if (data.turn?.taskId) onTaskCreated?.(data.turn.taskId)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }, [conversation?.id, onTaskCreated])

  // 开面板：要么接着给定会话，要么新建一条。
  useEffect(() => {
    let cancelled = false
    const start = async (): Promise<void> => {
      try {
        if (conversationId) {
          const data = await getJson<{ messages: ConversationMessage[] }>(
            `/api/automations/conversations/${encodeURIComponent(conversationId)}/messages`,
          )
          if (cancelled) return
          const loaded = data.messages ?? []
          setMessages(loaded)
          lastSeqRef.current = loaded.reduce((max, item) => Math.max(max, item.seq), 0)
          const list = await getJson<{ conversations: ConversationRecord[] }>('/api/automations/conversations')
          if (cancelled) return
          setConversation(list.conversations?.find(item => item.id === conversationId) ?? null)
        } else {
          const data = await sendJson<{ conversation: ConversationRecord }>('/api/automations/conversations', 'POST', {
            source: 'web-panel',
            requester: 'panel',
          })
          if (cancelled) return
          setConversation(data.conversation)
          setMessages([{
            seq: 1,
            role: 'assistant',
            text: '要建个什么样的自动化？比如「订阅飞书消息里跟 Teamwork 相关的优化事项，有人答应了就立刻去做」。',
            step: 'catalog',
          }])
        }
      } catch (error) {
        if (!cancelled) setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
      }
    }
    void start()
    return () => {
      cancelled = true
      streamRef.current?.abort()
    }
  }, [conversationId])

  // 消息到底部：助手逐字吐字时视野跟着走。
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const stepText = useMemo(() => (step: string | undefined): string => {
    switch (step) {
      case 'catalog': return '会话助手 · 已加载可用事件源目录'
      case 'speech': return '会话助手 · 正在说'
      case 'parse': return '会话助手 · 已抽取参数'
      case 'clarify': return '会话助手 · 缺项回问'
      case 'preview': return '会话助手 · 参数已齐'
      case 'create': return '会话助手 · 已落库'
      default: return '会话助手'
    }
  }, [])

  const pendingPreview = useMemo(
    () => [...messages].reverse().find(item => item.preview)?.preview,
    [messages],
  )

  return (
    <div className="conv">
      <div className="conv-stream">
        {notice && <div className={`banner ${notice.kind === 'error' ? 'danger' : ''}`} onClick={() => setNotice(null)}>{notice.text}</div>}
        {messages.map(message => (
          <div key={message.seq} className={`conv-msg ${message.role === 'user' ? 'user' : ''}`}>
            <span className="conv-avatar">{message.role === 'user' ? '我' : 'RA'}</span>
            <div className={message.preview ? 'conv-bubble conv-bubble-plain' : 'conv-bubble'}>
              {message.step && <div className="conv-step">{stepText(message.step)}</div>}
              {message.text && <div>{message.text}</div>}
              {message.preview && (
                <AutomationPreviewCard
                  preview={message.preview}
                  busy={busy}
                  onConfirm={() => void confirm()}
                  onAdjust={() => setInput('再改改：')}
                />
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
        <form
          className="conv-compose"
          onSubmit={event => {
            event.preventDefault()
            if (input.trim()) void send(input.trim())
          }}
        >
          <input
            value={input}
            placeholder={pendingPreview ? '还要改什么？直接说，例如「关键词加上退款」' : '用一句话说清要订阅什么、命中后做什么'}
            onChange={event => setInput(event.target.value)}
            disabled={busy}
            aria-label="会话输入"
          />
          <button className="btn tiny primary" type="submit" disabled={busy || !input.trim()}>
            {busy ? '处理中…' : '发送'}
          </button>
        </form>
        {catalogHint && <p className="editor-hint">{catalogHint}</p>}
      </div>

      <aside className="side-panel">
        <div className="side-panel-head">
          <h3>会话</h3>
          <p>{conversation ? `当前会话 ${conversation.id}` : '正在新建会话…'}</p>
        </div>
        <div className="side-panel-body">
          <div className="side-row active">
            <strong>{conversation?.text?.slice(0, 40) || '新会话'}</strong>
            <span>{conversation?.status === 'confirmed' ? '已落库' : '进行中'}</span>
          </div>
        </div>
        {onClose && (
          <div className="preview-foot">
            <button className="btn tiny ghost" onClick={onClose}>
              <Icon name="close" size={11} />收起会话
            </button>
          </div>
        )}
      </aside>
    </div>
  )
}

