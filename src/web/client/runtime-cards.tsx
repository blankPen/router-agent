/**
 * 运行时卡片网格：初始化页与「配置 → 派工与服务」共用。
 *
 * 选中状态由父级 draft 控制；探测轮询、检测、安装、日志等临时状态收在组件内部。
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { ACP_RUNTIME_ID, normalizeRuntimeId } from '../../worker/runtimes/catalog.js'
import { getJson, sendJson } from './api.js'
import { Icon } from './icons.js'
import {
  isAcpAgentRuntime,
  isBuiltinRuntime,
  isDeprecatedRuntime,
  isRuntimeSelectable,
  mergeRuntimeChoices,
  runtimeDisplayName,
  runtimeSourceLabel,
  runtimeStatusLabel,
  type RuntimeChoiceView,
} from './runtime-model.js'
import { RuntimeLogo, runtimeLogoOf } from './runtime-logos.js'
import { runtimeOptionFields } from './fields.js'
import { RuntimeSettingsDialog } from './runtime-settings.js'

export interface RuntimeNotice {
  kind: 'ok' | 'warn' | 'error'
  text: string
}

interface InstallJobView {
  id: string
  runtimeId: string
  status: 'running' | 'ok' | 'failed'
  phase: string
  version?: string
  lines: string[]
  error?: string
  startedAt: string
  finishedAt?: string
}

interface CheckResult {
  ok: boolean
  detail: string
  at: string
}

interface RuntimeCardsProps {
  choices: RuntimeChoiceView[]
  detecting: boolean
  selected: string
  onSelect: (id: string) => void
  onChoices: Dispatch<SetStateAction<RuntimeChoiceView[]>>
  onDetecting: (detecting: boolean) => void
  onNotice: (notice: RuntimeNotice | null) => void
  /** 安装成功等操作改变了冷配置，父级可据此显示持久的「需重启」提示。 */
  onPendingRestart?: () => void
  /** 配置草稿与默认值：运行时选项弹窗直接读写父级 draft。 */
  draft?: unknown
  defaults?: unknown
  /** 运行时选项改动；缺省时设置按钮不可用。 */
  onOptionChange?: (path: string, value: unknown) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

export function RuntimeCards({
  choices,
  detecting,
  selected,
  onSelect,
  onChoices,
  onDetecting,
  onNotice,
  onPendingRestart,
  draft,
  defaults,
  onOptionChange,
}: RuntimeCardsProps): JSX.Element {
  const [busy, setBusy] = useState<Record<string, 'check' | 'install'>>({})
  const [jobs, setJobs] = useState<Record<string, InstallJobView>>({})
  const [openLogs, setOpenLogs] = useState<Record<string, boolean>>({})
  const [checks, setChecks] = useState<Record<string, CheckResult>>({})
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  const mounted = useRef(true)
  const autoDetected = useRef(false)

  useEffect(() => () => { mounted.current = false }, [])

  const cards = useMemo(() => mergeRuntimeChoices(choices), [choices])
  const selectedId = normalizeRuntimeId(selected)
  const selectedChoice = cards.find(choice => choice.id === selectedId)
  // 打开设置弹窗的运行时；探测结果刷新后卡片可能消失，这里兜底成 null。
  const settingsChoice = settingsFor ? cards.find(choice => choice.id === settingsFor) ?? null : null

  const refresh = async (): Promise<void> => {
    onDetecting(true)
    try {
      const data = await sendJson<{ choices?: RuntimeChoiceView[]; detecting?: boolean }>('/api/runtimes/detect', 'POST', {})
      if (!mounted.current) return
      if (data.choices) onChoices(data.choices)
      onDetecting(Boolean(data.detecting))
    } catch (error) {
      if (!mounted.current) return
      onDetecting(false)
      onNotice({ kind: 'error', text: `重新检测失败：${errorText(error)}` })
    }
  }

  // 服务端快照可能还没生成：进入页面时自动探测一次。
  useEffect(() => {
    if (autoDetected.current || detecting) return
    autoDetected.current = true
    if (choices.length === 0) void refresh()
    // refresh 是每次渲染重建的函数，这里只在首次挂载时触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choices.length, detecting])

  // 探测进行中时轮询快照，完成后自动刷新卡片状态。
  useEffect(() => {
    if (!detecting) return
    const timer = window.setInterval(() => {
      void getJson<{ choices?: RuntimeChoiceView[]; detecting?: boolean }>('/api/runtimes')
        .then(data => {
          if (!mounted.current) return
          if (data.choices) onChoices(data.choices)
          onDetecting(Boolean(data.detecting))
        })
        .catch(() => {
          if (mounted.current) onDetecting(false)
        })
    }, 1_500)
    return () => window.clearInterval(timer)
  }, [detecting, onChoices, onDetecting])

  const check = async (choice: RuntimeChoiceView): Promise<void> => {
    setBusy(current => ({ ...current, [choice.id]: 'check' }))
    try {
      const result = await sendJson<{ ok: boolean; detail: string; choice?: RuntimeChoiceView }>(
        '/api/runtimes/check',
        'POST',
        { id: choice.id },
      )
      if (!mounted.current) return
      setChecks(current => ({
        ...current,
        [choice.id]: { ok: result.ok, detail: result.detail, at: new Date().toISOString() },
      }))
      if (result.choice) {
        const next = result.choice
        onChoices(current => current.some(item => item.id === next.id)
          ? current.map(item => (item.id === next.id ? next : item))
          : [...current, next])
      }
      const status = result.choice?.status ?? (result.ok ? 'ready' : 'incompatible')
      const verb = isAcpAgentRuntime(choice.id) ? '握手' : '检测'
      const name = runtimeDisplayName(choice)
      if (status === 'needs-auth') {
        onNotice({ kind: 'warn', text: `${name} 握手通过，但仍需登录：${result.choice?.reason ?? result.detail}` })
      } else if (result.ok) {
        onNotice({ kind: 'ok', text: `${name} ${verb}通过：${result.detail}` })
      } else {
        onNotice({ kind: 'error', text: `${name} ${verb}失败：${result.detail}` })
      }
    } catch (error) {
      if (mounted.current) onNotice({ kind: 'error', text: `${runtimeDisplayName(choice)} 检测失败：${errorText(error)}` })
    } finally {
      if (mounted.current) setBusy(current => withoutKey(current, choice.id))
    }
  }

  const pollJob = async (choice: RuntimeChoiceView, jobId: string): Promise<void> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await sleep(1_000)
      if (!mounted.current) return
      try {
        const job = await getJson<InstallJobView>(`/api/runtimes/install/${jobId}`)
        if (!mounted.current) return
        setJobs(current => ({ ...current, [choice.id]: job }))
        if (job.status === 'running') continue
        setBusy(current => withoutKey(current, choice.id))
        if (job.status === 'ok') {
          onNotice({ kind: 'ok', text: `${runtimeDisplayName(choice)} 安装完成${job.version ? `（${job.version}）` : ''}，重启服务后用于派工` })
          onPendingRestart?.()
          const snapshot = await getJson<{ choices?: RuntimeChoiceView[] }>('/api/runtimes')
          if (snapshot.choices && mounted.current) onChoices(snapshot.choices)
        } else {
          onNotice({ kind: 'error', text: `安装失败：${job.error ?? job.status}` })
        }
        return
      } catch (error) {
        if (!mounted.current) return
        const text = errorText(error)
        if (text.includes('job-not-found')) {
          setBusy(current => withoutKey(current, choice.id))
          onNotice({ kind: 'warn', text: '安装任务状态已丢失（服务可能重启过），请重新检测运行时' })
          return
        }
        // 单次网络抖动继续重试，只有最后一轮才报错。
        if (attempt >= 299) {
          setBusy(current => withoutKey(current, choice.id))
          onNotice({ kind: 'error', text: `读取安装状态失败：${text}` })
        }
      }
    }
  }

  const install = async (choice: RuntimeChoiceView): Promise<void> => {
    const target = choice.extension?.packageName ?? choice.packageName ?? runtimeDisplayName(choice)
    if (!confirm(`安装 ACP 扩展 ${target} 到 ~/.router-agent/runtimes？需要联网下载 npm 包。`)) return
    setBusy(current => ({ ...current, [choice.id]: 'install' }))
    setJobs(current => withoutKey(current, choice.id))
    try {
      const data = await sendJson<{ jobId: string }>('/api/runtimes/install', 'POST', { id: choice.id })
      void pollJob(choice, data.jobId)
    } catch (error) {
      if (mounted.current) setBusy(current => withoutKey(current, choice.id))
      onNotice({ kind: 'error', text: `启动安装失败：${errorText(error)}` })
    }
  }

  const groups = useMemo(() => {
    const visible = cards.filter(choice => {
      // 已有原生运行时替代品的（Claude Code / Codex 的 ACP 版本）不再展示，
      // 但当前正选中的要留着，否则用户看不到自己在用的运行时。
      if (isDeprecatedRuntime(choice) && choice.id !== selectedId) return false
      // 未配置的自定义 acp 只有当前选中时才展示，避免普通用户看到一张空卡。
      if (choice.id === ACP_RUNTIME_ID && choice.status === 'not-installed' && choice.id !== selectedId) return false
      return true
    })
    return [
      { title: '内置运行时', items: visible.filter(choice => isBuiltinRuntime(choice.id)) },
      { title: 'ACP Agent', items: visible.filter(choice => isAcpAgentRuntime(choice.id)) },
    ].filter(group => group.items.length > 0)
  }, [cards, selectedId])

  const anyBusy = Object.keys(busy).length > 0

  return (
    <div className="runtime-status">
      <div className="runtime-status-head">
        <div>
          <h3 className="editor-subtitle">运行时</h3>
          <p className="editor-hint">点击卡片切换；只影响新工单。</p>
        </div>
        <button className="btn tiny" onClick={() => void refresh()} disabled={detecting || anyBusy}>
          <Icon name="refresh" size={12} className={detecting ? 'spin' : undefined} />
          {detecting ? '检测中…' : '重新检测'}
        </button>
      </div>

      {selectedChoice && !isRuntimeSelectable(selectedChoice) && (
        <div className="banner warn compact">
          <Icon name="alert" size={14} />
          <span>
            当前运行时 <strong>{selectedChoice.id}</strong> 不可用：{selectedChoice.reason ?? runtimeStatusLabel(selectedChoice.status)}。请先安装/配置，或改选其它卡片。
          </span>
        </div>
      )}

      {groups.length === 0 && (
        <p className="editor-empty">{detecting ? '正在探测本机运行时…' : '还没有可展示的运行时。'}</p>
      )}

      {groups.map(group => (
        <div key={group.title} className="runtime-group">
          <div className="runtime-group-title">
            <span>{group.title}</span>
            <span className="runtime-group-count">{group.items.length}</span>
          </div>
          <div className="runtime-grid">
            {group.items.map(choice => {
              const busyKind = busy[choice.id]
              const selectable = isRuntimeSelectable(choice)
              const isSelected = choice.id === selectedId
              const checkResult = checks[choice.id]
              const job = jobs[choice.id]
              const requirement = choice.requires?.[0]
              const note = choice.reason
                ?? (requirement
                  ? `依赖 ${requirement.label}${requirement.version ? ` ${requirement.version}` : ''} ${requirement.ok ? '已满足' : '缺失'}`
                  : '')
              const meta = [
                choice.version ? `版本 ${choice.version}` : '',
                choice.source ? `来源 ${runtimeSourceLabel(choice.source)}` : '',
                choice.extension?.packageName ? `扩展 ${choice.extension.packageName}` : '',
              ].filter(Boolean).join(' · ')
              return (
                <article key={choice.id} className={`runtime-card status-${choice.status} ${isSelected ? 'selected' : ''}`}>
                  <div className="runtime-card-head">
                    <div className="runtime-card-identity">
                      <span className="runtime-card-logo">
                        <RuntimeLogo id={runtimeLogoOf(choice.id)} size={20} />
                      </span>
                      <div className="runtime-card-title-block">
                        <span className="runtime-card-title">{runtimeDisplayName(choice)}</span>
                        <span className="runtime-id">{choice.id}</span>
                      </div>
                    </div>
                    <span className={`runtime-badge ${choice.status}`}>{runtimeStatusLabel(choice.status)}</span>
                  </div>

                  <p className="runtime-card-desc" title={choice.hint}>{choice.hint}</p>
                  {meta && <p className="runtime-card-meta" title={meta}>{meta}</p>}
                  {note && (
                    <p className={`runtime-card-note ${requirement && !requirement.ok && !choice.reason ? 'fail' : ''}`} title={note}>
                      {note}
                    </p>
                  )}
                  <p className={`runtime-check-result ${checkResult ? (checkResult.ok ? 'ok' : 'fail') : 'idle'}`} title={checkResult?.detail}>
                    {checkResult
                      ? <Icon name={checkResult.ok ? 'check' : 'alert'} size={12} />
                      : <span className="runtime-check-dot" />}
                    {checkResult?.detail ?? '未检查'}
                  </p>

                  <div className="runtime-card-actions">
                    {runtimeOptionFields(choice.id).length > 0 && (
                      <button
                        className="btn ghost tiny"
                        disabled={!onOptionChange}
                        title={onOptionChange ? `设置 ${runtimeDisplayName(choice)}` : '当前页面不支持修改运行时设置'}
                        onClick={() => setSettingsFor(choice.id)}
                      >
                        <Icon name="sliders" size={12} />设置
                      </button>
                    )}
                    <button
                      className={`btn tiny ${isSelected ? '' : 'primary'}`}
                      disabled={!selectable || isSelected}
                      title={selectable ? undefined : choice.reason}
                      onClick={() => onSelect(choice.id)}
                    >
                      {isSelected ? <><Icon name="check" size={12} />当前使用</> : selectable ? '使用此运行时' : '不可用'}
                    </button>
                    {choice.status !== 'not-installed' && (
                      <button className="btn ghost tiny" disabled={Boolean(busyKind) || detecting} onClick={() => void check(choice)}>
                        {busyKind === 'check' ? '检测中…' : isAcpAgentRuntime(choice.id) ? '试启动' : '检测'}
                      </button>
                    )}
                    {choice.cli && !choice.cli.installed && choice.cli.installUrl && (
                      <a
                        className="btn ghost tiny"
                        href={choice.cli.installUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={`安装 ${choice.cli.label}`}
                      >
                        <Icon name="external" size={12} />安装 CLI
                      </a>
                    )}
                    {choice.extension?.installable && !choice.extension.installed && (
                      <button className="btn ghost tiny" disabled={Boolean(busyKind) || detecting} onClick={() => void install(choice)}>
                        {busyKind === 'install' ? '安装中…' : '安装 ACP 扩展'}
                      </button>
                    )}
                  </div>

                  {job && (
                    <div className="runtime-job">
                      <div className="runtime-job-head">
                        <span>
                          {job.status === 'running' ? `${job.phase}…` : job.status === 'ok' ? '安装完成' : '安装失败'}
                          {job.version ? ` · ${job.version}` : ''}
                        </span>
                        {job.lines.length > 0 && (
                          <button className="btn ghost tiny" onClick={() => setOpenLogs(current => ({ ...current, [choice.id]: !current[choice.id] }))}>
                            {openLogs[choice.id] ? '收起日志' : '查看日志'}
                          </button>
                        )}
                      </div>
                      {job.error && <p className="field-error">{job.error}</p>}
                      {openLogs[choice.id] && <pre className="runtime-log">{(job.lines ?? []).slice(-40).join('\n') || '(暂无输出)'}</pre>}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </div>
      ))}

      {settingsChoice && onOptionChange && (
        <RuntimeSettingsDialog
          choice={settingsChoice}
          draft={draft}
          defaults={defaults}
          onChange={onOptionChange}
          onClose={() => setSettingsFor(null)}
        />
      )}
    </div>
  )
}
