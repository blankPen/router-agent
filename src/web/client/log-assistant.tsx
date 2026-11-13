/**
 * Web 面板右下角的「智能问题排查助手」悬浮按钮与弹窗。
 *
 * 交互只有三步：
 * 1. 右下角一个按钮，点开就是排查面板——没有快捷菜单，也不会自动开始分析；
 * 2. 面板一打开就把当前存在的异常日志、配置错误与配置遗漏摆出来，
 *    不用先描述问题；用户看完点「分析」才发起一次分析；
 * 3. 结论面向普通用户：主区只说「发生了什么」「现在该做什么」，
 *    原始日志与专业术语收进折叠的补充信息。
 *
 * 服务端没装这个端点时（老版本 daemon）整个入口隐藏，不在页面上留死按钮。
 */
import { useCallback, useEffect, useState } from 'react'
import { sendJson } from './api.js'
import { Icon } from './icons.js'

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

/** 面板打开时展示的一条异常摘要。 */
export interface LogOverviewIssue {
  event: string
  title: string
  detail?: string
  at: string
  action?: string
}

/** 面板打开时展示的一条配置问题。 */
export interface LogOverviewConfigIssue {
  name: string
  detail: string
  hint?: string
  section?: string
  items?: string[]
}

export interface LogAssistantOverview {
  errorCount: number
  warnCount: number
  issues: LogOverviewIssue[]
  configIssues: LogOverviewConfigIssue[]
  window: { since: string; version: string }
}

export interface LogAssistantStatus {
  llmConfigured: boolean
  overview: LogAssistantOverview
}

export function LogAssistantFab({ onOpenConfig }: { onOpenConfig: (section?: string) => void }): JSX.Element | null {
  const [status, setStatus] = useState<LogAssistantStatus | null>(null)
  const [supported, setSupported] = useState(true)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LogDiagnosis | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [issue, setIssue] = useState<{ number: number; url: string } | null>(null)
  const [issuing, setIssuing] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/logs/assistant')
      if (res.status === 404) {
        setSupported(false)
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStatus((await res.json()) as LogAssistantStatus)
    } catch {
      // 状态拿不到时不影响面板的其它能力，先静默。
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 面板打开时刷新一次：面板可能开着半天，日志与配置都变了。
  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  const analyze = useCallback(async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    setIssue(null)
    try {
      const data = await sendJson<{ diagnosis: LogDiagnosis }>('/api/logs/assistant', 'POST', { question: '' })
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
      const issueStep = result.next?.find(step => step.kind === 'issue')
      const data = await sendJson<{ issue: { number: number; url: string } }>(
        '/api/logs/assistant/issue',
        'POST',
        { question: '', diagnosis: result, ...(issueStep?.issueTitle ? { title: issueStep.issueTitle } : {}) },
      )
      setIssue(data.issue)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setIssuing(false)
    }
  }, [result])

  useEffect(() => {
    if (!open) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!supported) return null

  const overview = status?.overview
  const errorCount = overview?.errorCount ?? 0
  const hasError = errorCount > 0
  const issueStep = result?.next?.find(step => step.kind === 'issue')
  const configStep = result?.next?.find(step => step.kind === 'config')

  return (
    <>
      <div className={`assistant-fab-wrap ${hasError ? 'has-error' : ''}`}>
        <button
          type="button"
          className="assistant-fab"
          onClick={() => setOpen(true)}
          aria-label={hasError ? `智能排查助手：最近有 ${errorCount} 条错误` : '智能排查助手'}
          title={hasError ? `最近有 ${errorCount} 条错误` : '智能排查助手'}
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
                <small>看最近这段时间的服务状态；有异常时再让它分析一次</small>
              </div>
              <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setOpen(false)}>
                <Icon name="close" size={15} />
              </button>
            </div>

            <div className="assistant-modal-body">
              {status && !status.llmConfigured && (
                <p className="assistant-note">当前没有配置模型，助手按内置规则判断；配置模型后结论更贴合你的情况。</p>
              )}

              <Overview status={status} onOpenConfig={onOpenConfig} />

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
              <button className="btn primary" onClick={() => void analyze()} disabled={busy}>
                <Icon name={busy ? 'clock' : 'zap'} size={14} />
                {busy ? '分析中…' : result ? '重新分析' : '分析'}
              </button>
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

/** 面板打开时的现状摘要：异常日志 + 配置问题，都用大白话。 */
function Overview({ status, onOpenConfig }: {
  status: LogAssistantStatus | null
  onOpenConfig: (section?: string) => void
}): JSX.Element {
  if (!status) {
    return <p className="assistant-note">正在读取服务状态…</p>
  }
  const { overview } = status
  const clean = overview.errorCount === 0 && overview.warnCount === 0 && overview.configIssues.length === 0

  return (
    <div className="assistant-overview">
      <div className="assistant-overview-head">
        <span className={`assistant-state ${clean ? 'ok' : 'warn'}`}>
          <Icon name={clean ? 'check' : 'alert'} size={14} />
          {clean ? '一切正常，暂时没有发现问题' : '发现了一些需要处理的问题'}
        </span>
        <span className="assistant-window">
          只看最近 3 小时{overview.window.version ? ` · 当前版本 v${overview.window.version}` : ''}
        </span>
      </div>

      {overview.issues.length > 0 && (
        <div className="assistant-block">
          <h4>最近的异常（{overview.errorCount} 条错误）</h4>
          <ul className="assistant-list">
            {overview.issues.map((item, index) => (
              <li key={`${item.event}-${index}`}>
                <strong>{item.title}</strong>
                {item.action && <span>{item.action}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {overview.configIssues.length > 0 && (
        <div className="assistant-block">
          <h4>配置还没配齐</h4>
          <ul className="assistant-list">
            {overview.configIssues.map((item, index) => (
              <li key={`${item.name}-${index}`}>
                <strong>{item.name}</strong>
                {item.items && item.items.length > 0 && (
                  <span className="assistant-sublist">
                    {item.items.map((entry, itemIndex) => (
                      <span key={`${entry}-${itemIndex}`}>{entry}</span>
                    ))}
                  </span>
                )}
                {!item.items?.length && <span>{item.detail}</span>}
                {item.hint && !item.items?.length && <span className="assistant-hint">{item.hint}</span>}
                {item.section && (
                  <button className="assistant-link" onClick={() => onOpenConfig(item.section)}>
                    去改这一项
                    <Icon name="chevron" size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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

      {result.actions.length > 0 && (
        <div className="assistant-block">
          <h4>现在该做什么</h4>
          <ul className="assistant-list">
            {result.actions.map((action, index) => <li key={`${action}-${index}`}>{action}</li>)}
          </ul>
        </div>
      )}

      <details className="assistant-block">
        <summary>补充细节（原因与原始日志）</summary>

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

        {result.toolsUsed && result.toolsUsed.length > 0 && (
          <p className="assistant-note">助手查阅了：{result.toolsUsed.join('、')}</p>
        )}

        {result.evidence.length > 0 && (
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
        )}
      </details>
    </div>
  )
}

function formatClock(at: string): string {
  if (!at) return '—'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

