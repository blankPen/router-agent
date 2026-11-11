/**
 * 日志页的「智能问题排查助手」。
 *
 * 日志页回答的是「发生了什么」，助手回答的是「这意味着什么、接下来做什么」。
 * 它复用日志页当前的级别 / 关键字筛选范围，所以用户看到的日志就是排查依据。
 *
 * 服务端没装这个端点时（老版本 daemon）整个面板隐藏，不在页面上留死按钮。
 */
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { sendJson } from './api.js'
import { Icon } from './icons.js'

export interface LogSuggestion {
  id: string
  title: string
  example: string
}

export interface LogEvidence {
  at: string
  level: string
  message: string
  detail?: string
}

export interface LogCause {
  title: string
  detail: string
  events: string[]
}

export interface LogDiagnosis {
  summary: string
  causes: LogCause[]
  actions: string[]
  evidence: LogEvidence[]
  /** llm = 模型总结；rules = 规则降级。 */
  source: 'llm' | 'rules'
  degraded?: string
}

export interface LogAssistantStatus {
  llmConfigured: boolean
  suggestions: LogSuggestion[]
}

export function LogAssistantPanel({ level, keyword }: { level: string; keyword: string }): JSX.Element | null {
  const [status, setStatus] = useState<LogAssistantStatus | null>(null)
  const [supported, setSupported] = useState(true)
  const [collapsed, setCollapsed] = useState(false)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LogDiagnosis | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/logs/assistant')
        if (res.status === 404) {
          if (!cancelled) setSupported(false)
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as LogAssistantStatus
        if (!cancelled) setStatus(data)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => { cancelled = true }
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const data = await sendJson<{ diagnosis: LogDiagnosis }>('/api/logs/assistant', 'POST', {
        question: question.trim(),
        level,
        keyword: keyword.trim(),
      })
      setResult(data.diagnosis)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [question, level, keyword])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter 换行、Cmd/Ctrl + Enter 提交：长描述能分行写，提交也不用去够按钮。
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (!busy) void submit()
    }
  }, [busy, submit])

  if (!supported) return null

  return (
    <section className={`log-assistant ${collapsed ? 'collapsed' : ''}`} aria-label="智能问题排查助手">
      <div className="log-assistant-head">
        <div className="log-assistant-title">
          <Icon name="zap" size={15} />
          <strong>智能问题排查助手</strong>
          <span className="log-assistant-hint">描述遇到的问题，助手结合最近的服务日志给出可能原因与下一步</span>
        </div>
        <button
          type="button"
          className="btn ghost tiny"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(value => !value)}
        >
          {collapsed ? '展开' : '收起'}
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="log-assistant-input">
            <textarea
              value={question}
              onChange={event => setQuestion(event.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              placeholder="例如：飞书发消息机器人完全没反应，日志里能看到消息吗？"
              aria-label="描述遇到的问题"
            />
            <button className="btn" onClick={() => void submit()} disabled={busy || question.trim().length === 0}>
              <Icon name={busy ? 'clock' : 'zap'} size={14} />
              {busy ? '分析中…' : '分析'}
            </button>
          </div>

          {status && status.suggestions.length > 0 && (
            <div className="log-assistant-chips" role="group" aria-label="常见问题">
              {status.suggestions.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className="log-assistant-chip"
                  title={item.title}
                  onClick={() => setQuestion(item.example)}
                >
                  {item.title}
                </button>
              ))}
            </div>
          )}

          {status && !status.llmConfigured && (
            <p className="log-assistant-note">
              未配置模型，助手按内置的事件规则排查；配置 LLM 后可得到自然语言总结。
            </p>
          )}

          {error && (
            <div className="log-alert" role="alert">
              <Icon name="alert" size={14} />
              <div>
                <strong>排查失败</strong>
                <span>{error}</span>
              </div>
              <button className="btn ghost tiny" onClick={() => void submit()}>重试</button>
            </div>
          )}

          {result && <AssistantResult result={result} />}
        </>
      )}
    </section>
  )
}

function AssistantResult({ result }: { result: LogDiagnosis }): JSX.Element {
  return (
    <div className="log-assistant-result">
      <div className="log-assistant-summary">
        <Icon name="check" size={14} />
        <span>{result.summary}</span>
        <span className={`log-assistant-tag ${result.source === 'llm' ? 'llm' : 'rules'}`}>
          {result.source === 'llm' ? '模型总结' : '规则排查'}
        </span>
      </div>

      {result.degraded && (
        <p className="log-assistant-note warn">{result.degraded}</p>
      )}

      {result.causes.length > 0 && (
        <div className="log-assistant-block">
          <h4>可能原因</h4>
          <ol className="log-assistant-list">
            {result.causes.map((cause, index) => (
              <li key={`${cause.title}-${index}`}>
                <strong>{cause.title}</strong>
                {cause.detail && <span>{cause.detail}</span>}
                {cause.events.length > 0 && (
                  <span className="log-assistant-events">
                    {cause.events.map(event => <code key={event}>{event}</code>)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {result.actions.length > 0 && (
        <div className="log-assistant-block">
          <h4>建议的下一步</h4>
          <ul className="log-assistant-list">
            {result.actions.map((action, index) => <li key={`${action}-${index}`}>{action}</li>)}
          </ul>
        </div>
      )}

      {result.evidence.length > 0 && (
        <details className="log-assistant-block">
          <summary>证据日志（{result.evidence.length} 条）</summary>
          <div className="log-assistant-evidence">
            {result.evidence.map((item, index) => (
              <div key={`${item.at}-${index}`} className={`log-assistant-evidence-row level-${item.level}`}>
                <span className="log-time">{formatClock(item.at)}</span>
                <span className="log-level">{(item.level || 'info').toUpperCase()}</span>
                <span className="log-message">
                  {item.message}
                  {item.detail && <span className="log-data"> {item.detail}</span>}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

function formatClock(at: string): string {
  if (!at) return '—'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}
