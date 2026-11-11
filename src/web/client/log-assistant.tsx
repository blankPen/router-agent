/**
 * Web 面板右下角的「智能问题排查助手」悬浮按钮与弹窗。
 *
 * 交互按三步走：
 * 1. 服务日志里出现 error 时，悬浮按钮变成「有异常」的样子（红点 + 数量）；
 * 2. 鼠标移上去展开快捷操作：智能分析异常 / 上报 GitHub issue / 看日志；
 * 3. 点开是弹窗，里面做问题分析，给出结论、可能原因、建议与证据，
 *    并按结论类型给出后续动作：配置类引导去改配置，缺陷类一键上报 issue。
 *
 * 服务端没装这个端点时（老版本 daemon）整个入口隐藏，不在页面上留死按钮。
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
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

export interface LogNextStep {
  kind: 'config' | 'issue'
  label: string
  section?: string
  issueTitle?: string
}

export interface LogDiagnosis {
  summary: string
  causes: LogCause[]
  actions: string[]
  evidence: LogEvidence[]
  source: 'llm' | 'rules'
  degraded?: string
  toolsUsed?: string[]
  next?: LogNextStep[]
}

export interface LogAssistantStatus {
  llmConfigured: boolean
  suggestions: LogSuggestion[]
}

interface LogBatch {
  entries: { level: string; message: string }[]
}

/** 悬浮按钮轮询日志的间隔；比日志页慢一点，避免重复读文件。 */
const POLL_MS = 5_000
/** 悬浮按钮一次看多少行日志。 */
const POLL_LINES = 200

export function LogAssistantFab({ onOpenConfig }: { onOpenConfig: (section?: string) => void }): JSX.Element | null {
  const [status, setStatus] = useState<LogAssistantStatus | null>(null)
  const [supported, setSupported] = useState(true)
  const [errorCount, setErrorCount] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LogDiagnosis | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [issue, setIssue] = useState<{ number: number; url: string } | null>(null)
  const [issuing, setIssuing] = useState(false)

  const seenRef = useRef<number | null>(null)

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
      } catch {
        // 状态拿不到时不影响悬浮按钮的其它能力，先静默。
      }
    })()
    return () => { cancelled = true }
  }, [])

  // 轮询日志里的 error 数量：有新错误就提醒一次，悬浮按钮也一直挂着红色角标。
  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/logs?limit=${POLL_LINES}`)
        if (!res.ok) return
        const batch = (await res.json()) as LogBatch
        const errors = batch.entries.filter(entry => entry.level === 'error').length
        if (cancelled) return
        const previous = seenRef.current
        seenRef.current = errors
        setErrorCount(errors)
        if (previous !== null && errors > previous) {
          setToast(`检测到 ${errors - previous} 条新的错误日志，点击查看排查建议`)
        }
      } catch {
        // 读不到日志就保持现状，下一轮再试。
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  const analyze = useCallback(async (text: string): Promise<void> => {
    setBusy(true)
    setFailure(null)
    setIssue(null)
    try {
      const data = await sendJson<{ diagnosis: LogDiagnosis }>('/api/logs/assistant', 'POST', { question: text })
      setResult(data.diagnosis)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const reportIssue = useCallback(async (): Promise<void> => {
    if (!result) return
    setIssuing(true)
    setFailure(null)
    try {
      const data = await sendJson<{ issue: { number: number; url: string } }>(
        '/api/logs/assistant/issue',
        'POST',
        { question, diagnosis: result },
      )
      setIssue(data.issue)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setIssuing(false)
    }
  }, [question, result])

  const openWithAnalysis = useCallback((text: string): void => {
    setOpen(true)
    setQuestion(text)
    void analyze(text)
  }, [analyze])

  useEffect(() => {
    if (!open) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!supported) return null

  const hasError = errorCount > 0
  const issueStep = result?.next?.find(step => step.kind === 'issue')
  const configStep = result?.next?.find(step => step.kind === 'config')

  return (
    <>
      {toast && (
        <button className="assistant-toast" onClick={() => { setToast(null); setOpen(true) }}>
          <Icon name="alert" size={14} />
          <span>{toast}</span>
        </button>
      )}

      <div className={`assistant-fab-wrap ${hasError ? 'has-error' : ''}`}>
        <div className="assistant-fab-menu" role="menu" aria-label="智能排查助手快捷操作">
          <button
            type="button"
            role="menuitem"
            onClick={() => openWithAnalysis('最近的错误日志是什么问题？帮我排查一下。')}
          >
            <Icon name="zap" size={14} />
            智能分析异常
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!status?.llmConfigured}
            title={status?.llmConfigured ? '先分析，再把结论与日志贴成 issue' : '需要先配置模型才能分析'}
            onClick={() => openWithAnalysis('最近的错误日志是什么问题？帮我排查一下。')}
          >
            <Icon name="external" size={14} />
            上报 GitHub issue
          </button>
          <button type="button" role="menuitem" onClick={() => setOpen(true)}>
            <Icon name="file-text" size={14} />
            打开排查面板
          </button>
        </div>
        <button
          type="button"
          className="assistant-fab"
          onClick={() => setOpen(true)}
          aria-label={hasError ? `智能排查助手：检测到 ${errorCount} 条错误日志` : '智能排查助手'}
          title={hasError ? `检测到 ${errorCount} 条错误日志` : '智能排查助手'}
        >
          <Icon name={hasError ? 'alert' : 'zap'} size={20} />
          {hasError && <span className="assistant-fab-badge">{errorCount > 99 ? '99+' : errorCount}</span>}
        </button>
      </div>

      {open && (
        <div className="assistant-modal-mask" onClick={() => setOpen(false)}>
          <div
            className="assistant-modal"
            role="dialog"
            aria-modal="true"
            aria-label="智能问题排查助手"
            onClick={event => event.stopPropagation()}
          >
            <div className="assistant-modal-head">
              <div>
                <strong>智能问题排查助手</strong>
                <small>结合服务日志、本机 router-agent 代码与当前配置给出结论</small>
              </div>
              <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setOpen(false)}>
                <Icon name="close" size={15} />
              </button>
            </div>

            <div className="assistant-modal-body">
              <div className="assistant-input">
                <textarea
                  value={question}
                  onChange={event => setQuestion(event.target.value)}
                  onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      if (!busy) void analyze(question)
                    }
                  }}
                  rows={2}
                  placeholder="描述你遇到的问题，例如：飞书发消息机器人完全没反应"
                  aria-label="描述遇到的问题"
                />
                <button
                  className="btn"
                  onClick={() => void analyze(question)}
                  disabled={busy || question.trim().length === 0}
                >
                  <Icon name={busy ? 'clock' : 'zap'} size={14} />
                  {busy ? '分析中…' : '分析'}
                </button>
              </div>

              {status && status.suggestions.length > 0 && (
                <div className="assistant-chips" role="group" aria-label="常见问题">
                  {status.suggestions.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      className="assistant-chip"
                      title={item.title}
                      onClick={() => setQuestion(item.example)}
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
              )}

              {status && !status.llmConfigured && (
                <p className="assistant-note">未配置模型，助手按内置的事件规则排查；配置 LLM 后可得到自然语言总结，并能读本机代码与配置。</p>
              )}

              {failure && (
                <div className="log-alert" role="alert">
                  <Icon name="alert" size={14} />
                  <div>
                    <strong>操作失败</strong>
                    <span>{failure}</span>
                  </div>
                </div>
              )}

              {result && <AssistantResult result={result} />}

              {issue && (
                <div className="assistant-issue-done" role="status">
                  <Icon name="check" size={14} />
                  <span>已上报 issue：</span>
                  <a href={issue.url} target="_blank" rel="noreferrer">#{issue.number}</a>
                </div>
              )}
            </div>

            <div className="assistant-modal-foot">
              {configStep && (
                <button
                  className="btn"
                  onClick={() => {
                    setOpen(false)
                    onOpenConfig(configStep.section)
                  }}
                >
                  <Icon name="sliders" size={14} />
                  {configStep.label}
                </button>
              )}
              {issueStep && (
                <button className="btn" onClick={() => void reportIssue()} disabled={issuing || !result}>
                  <Icon name="external" size={14} />
                  {issuing ? '上报中…' : issueStep.label}
                </button>
              )}
              {!configStep && !issueStep && result && (
                <span className="assistant-foot-note">这次没有明确指向配置或缺陷，按上面的建议手动处理即可。</span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function AssistantResult({ result }: { result: LogDiagnosis }): JSX.Element {
  return (
    <div className="assistant-result">
      <div className="assistant-summary">
        <Icon name="check" size={14} />
        <span>{result.summary}</span>
        <span className={`assistant-tag ${result.source === 'llm' ? 'llm' : 'rules'}`}>
          {result.source === 'llm' ? '模型总结' : '规则排查'}
        </span>
      </div>

      {result.degraded && <p className="assistant-note warn">{result.degraded}</p>}

      {result.toolsUsed && result.toolsUsed.length > 0 && (
        <p className="assistant-note">助手查阅了：{result.toolsUsed.join('、')}</p>
      )}

      {result.causes.length > 0 && (
        <div className="assistant-block">
          <h4>可能原因</h4>
          <ol className="assistant-list">
            {result.causes.map((cause, index) => (
              <li key={`${cause.title}-${index}`}>
                <strong>{cause.title}</strong>
                {cause.detail && <span>{cause.detail}</span>}
                {cause.events.length > 0 && (
                  <span className="assistant-events">
                    {cause.events.map(event => <code key={event}>{event}</code>)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {result.actions.length > 0 && (
        <div className="assistant-block">
          <h4>建议的下一步</h4>
          <ul className="assistant-list">
            {result.actions.map((action, index) => <li key={`${action}-${index}`}>{action}</li>)}
          </ul>
        </div>
      )}

      {result.evidence.length > 0 && (
        <details className="assistant-block">
          <summary>证据日志（{result.evidence.length} 条）</summary>
          <div className="assistant-evidence">
            {result.evidence.map((item, index) => (
              <div key={`${item.at}-${index}`} className={`assistant-evidence-row level-${item.level}`}>
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
