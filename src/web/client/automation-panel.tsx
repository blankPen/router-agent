/**
 * 自动化页：左边任务栏 + 右边大 Chat 会话。
 *
 * 布局照 ChatGPT Codex 的样子：整个页面主区就是会话窗口，
 * 底部浮着一个消息输入框；左边的任务卡点一下就把会话切过去（历史接得上）。
 *
 * 新建任务走**会话**（自然语言一句话），不再有填表弹窗。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson, saveConfigPatch, sendJson } from './api.js'
import { Icon } from './icons.js'
import { AutomationConversationView } from './automation-conversation.js'
import {
  MODE_LABEL,
  RUN_PHASE_LABEL,
  RUN_STATUS_LABEL,
  conversationIdOf,
  durationText,
  modeClass,
  phaseText,
  removedTasks,
  runStatusClass,
  toggledTasks,
  triggerSummary,
  type AutomationRun,
  type AutomationTask,
  type ConversationRecord,
} from './automation-model.js'

interface AutomationsPayload {
  tasks: AutomationTask[]
  runs: AutomationRun[]
}

interface Notice {
  kind: 'ok' | 'warn' | 'error'
  text: string
}

/** 自动化页。 */
export function AutomationView(): JSX.Element {
  const [tasks, setTasks] = useState<AutomationTask[]>([])
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [conversations, setConversations] = useState<ConversationRecord[]>([])
  const [tab, setTab] = useState<'chat' | 'runs'>('chat')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  /** 当前打开的会话；空表示还没有会话（页面刚进来）。 */
  const [conversationId, setConversationId] = useState<string | undefined>(undefined)
  /** 有任务正在执行：轮询加快，阶段才看得出在动。 */
  const running = runs.some(run => run.status === 'running')

  const load = useCallback(async () => {
    try {
      const data = await getJson<AutomationsPayload>('/api/automations')
      setTasks(data.tasks ?? [])
      setRuns(data.runs ?? [])
      const list = await getJson<{ conversations: ConversationRecord[] }>('/api/automations/conversations')
      setConversations(list.conversations ?? [])
      setLoaded(true)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
    // 有任务在跑时快一点（3 秒），否则回到 10 秒：执行中要能看出进度在动。
    const timer = setInterval(() => { void load() }, running ? 3_000 : 10_000)
    return () => clearInterval(timer)
  }, [load, running])

  const saveTasks = useCallback(async (next: AutomationTask[]): Promise<void> => {
    const payload = next.map(task => ({
      id: task.id,
      name: task.name,
      description: task.description,
      type: task.type,
      prompt: task.prompt,
      ...(task.script ? { script: task.script } : {}),
      trigger: task.trigger,
      ...(task.skill ? { skill: task.skill } : {}),
      ...(task.notifyTo ? { notifyTo: task.notifyTo } : {}),
      ...(task.conversationId ? { conversationId: task.conversationId } : {}),
      runtimeId: task.runtimeId,
      project: task.project,
      repo: task.repo,
      branch: task.branch,
      enabled: task.enabled,
      createdBy: task.createdBy ?? '',
      createdAt: task.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }))
    await saveConfigPatch({ 'automation.tasks': payload })
  }, [])

  /** 新建：开一条空会话，助手在那边等着听用户说话。 */
  const openCreate = () => {
    setTab('chat')
    setConversationId(undefined)
  }

  /**
   * 恢复会话：回到这条任务绑定的原会话，历史接得上。
   *
   * 任务自己存着 `conversationId` 就用它；没有的话反查会话列表
   * 里 `taskId` 指向它的那条（会话化之前建的任务也能找回）。
   */
  const resumeConversation = (task: AutomationTask) => {
    const target = conversationIdOf(task, conversations)
    if (!target) {
      setNotice({ kind: 'warn', text: `「${task.name}」没有会话记录，这条任务是会话化之前建的。` })
      return
    }
    setTab('chat')
    setConversationId(target)
  }

  const toggle = async (task: AutomationTask) => {
    setBusy(true)
    try {
      await saveTasks(toggledTasks(tasks, task.id))
      await load()
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (task: AutomationTask) => {
    if (!confirm(`删除自动化「${task.name}」？执行记录会保留。`)) return
    setBusy(true)
    try {
      await saveTasks(removedTasks(tasks, task.id))
      setNotice({ kind: 'warn', text: `已删除自动化「${task.name}」。` })
      await load()
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const trigger = async (task: AutomationTask) => {
    setBusy(true)
    setNotice({ kind: 'ok', text: `已触发「${task.name}」，进度见「执行记录」。` })
    try {
      await sendJson<{ run: AutomationRun }>('/api/automations/trigger', 'POST', { id: task.id })
      // 触发立即返回：执行还在后台跑，这里只报「已触发」，进度靠轮询。
      setNotice({ kind: 'ok', text: `「${task.name}」已触发，正在执行。` })
      await load()
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 生成脚本：显式一步，生成结果落到任务定义里，人工再决定改不改。
   *
   * 定时执行跑的就是这份脚本，不会每次重新生成。
   */
  const generateScript = async (task: AutomationTask) => {
    setBusy(true)
    setNotice({ kind: 'ok', text: `正在为「${task.name}」生成脚本…` })
    try {
      const data = await sendJson<{ script: string }>('/api/automations/script', 'POST', { id: task.id })
      const next = tasks.map(item => (item.id === task.id ? { ...item, script: data.script } : item))
      await saveTasks(next)
      setNotice({ kind: 'ok', text: `「${task.name}」的脚本已生成，可以在「编辑」里继续修改。` })
      await load()
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const enabledCount = useMemo(() => tasks.filter(task => task.enabled).length, [tasks])

  if (!loaded) return <div className="empty-state tall"><p>正在读取自动化任务…</p></div>

  return (
    <>
      <div className="page-head">
        <div>
          <h1>自动化</h1>
          <p>任务既是定时计划，也是事件订阅：一句话说清订阅什么、命中后做什么。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={openCreate}>
            <Icon name="plus" size={13} />用一句话新建
          </button>
          <button className="btn ghost" onClick={() => { void load() }} disabled={busy}>刷新</button>
        </div>
      </div>

      {error && <div className="banner danger"><Icon name="alert" />{error}</div>}
      {notice && <div className={`banner ${notice.kind === 'error' ? 'danger' : notice.kind === 'warn' ? 'warn' : ''}`} onClick={() => setNotice(null)}>{notice.text}</div>}

      <div className="segmented automation-tabs" role="tablist">
        <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
          会话
        </button>
        <button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>
          执行记录{runs.length ? `（${runs.length}）` : ''}
        </button>
      </div>

      {tab === 'chat' ? (
        <div className="automation-workspace">
          {/* 左边：所有自动化任务的精简卡片，竖着排。 */}
          <aside className="automation-rail">
            <div className="automation-rail-head">
              <h3>自动化任务</h3>
              <span>{tasks.length ? `${enabledCount} 条启用` : '还没有任务'}</span>
            </div>
            <div className="automation-rail-body">
              {tasks.length === 0 ? (
                <div className="automation-rail-empty">
                  <p>还没有自动化任务。</p>
                  <p className="muted">用一句话建一个，比如「订阅 GitHub 的 CI 失败，有价值的就立即修复」。</p>
                </div>
              ) : (
                tasks.map(task => (
                  <TaskRailItem
                    key={task.id}
                    task={task}
                    active={conversationId !== undefined && conversationIdOf(task, conversations) === conversationId}
                    busy={busy}
                    onOpen={() => resumeConversation(task)}
                    onTrigger={() => void trigger(task)}
                    onToggle={() => void toggle(task)}
                    onRemove={() => void remove(task)}
                    onGenerateScript={() => void generateScript(task)}
                  />
                ))
              )}
            </div>
          </aside>

          {/* 右边：整个主区就是会话窗口，底部浮着输入框。 */}
          <section className="automation-chat">
            <header className="automation-chat-head">
              <h2>{conversationId ? '任务会话' : '新建自动化 · 会话'}</h2>
              <p>
                {conversationId
                  ? '接着上次的对话继续改这条任务；确认后才写回任务。'
                  : '说清要订阅什么、命中后做什么；助手会追问缺的那一项，确认后才落库。'}
              </p>
            </header>
            <AutomationConversationView
              conversationId={conversationId}
              onTaskCreated={() => { void load() }}
            />
          </section>
        </div>
      ) : (
        runs.length === 0 ? (
          <div className="empty-state">
            <p>还没有执行记录。</p>
            <p className="muted">任务触发后，每次执行都会在这里留一条。</p>
          </div>
        ) : (
          <table className="event-table automation-run-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>耗时</th>
                <th>结果</th>
                <th>产出</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => (
                <tr key={run.id}>
                  <td>
                    <strong>{run.automationName}</strong>
                    <div className="event-meta">
                      <span>{formatTime(run.startedAt)}</span>
                      {run.manual && <><span className="dot-sep">·</span><span>手动</span></>}
                    </div>
                    {run.status === 'running' && run.phase && (
                      <div className="automation-run-phase">
                        <span className="automation-spinner" aria-hidden="true" />
                        <span>{phaseText(run.phase)}</span>
                      </div>
                    )}
                  </td>
                  <td><span className={`automation-status ${runStatusClass(run.status)}`}>{RUN_STATUS_LABEL[run.status] ?? run.status}</span></td>
                  <td>{durationText(run.durationMs)}</td>
                  <td>
                    <span className="automation-run-summary">{run.summary || '—'}</span>
                    {run.error && <div className="automation-run-error">{run.error}</div>}
                  </td>
                  <td>
                    <RunOutputs outputs={run.outputs} />
                    <div className="automation-run-logs">
                      <a
                        className="automation-output-link"
                        href={`#logs?keyword=${encodeURIComponent(run.automationId)}`}
                        title="在日志页里看这条任务的日志"
                      >
                        查看日志
                      </a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </>
  )
}

/** 任务栏里的一条任务：精简到一行标题 + 一行摘要，操作收在 hover 出来的按钮里。 */
function TaskRailItem({ task, active, busy, onOpen, onTrigger, onToggle, onRemove, onGenerateScript }: {
  task: AutomationTask
  /** 这条任务是不是当前打开的会话。 */
  active: boolean
  busy: boolean
  onOpen: () => void
  onTrigger: () => void
  onToggle: () => void
  onRemove: () => void
  onGenerateScript: () => void
}): JSX.Element {
  return (
    <article className={`rail-item automation-rail-item ${active ? 'active' : ''} ${task.enabled ? '' : 'off'}`}>
      <button className="rail-item-main" onClick={onOpen} title={task.description || task.prompt}>
        <span className="rail-item-head">
          <span className={`rail-dot ${task.enabled ? 'on' : ''}`} aria-hidden="true" />
          <strong>{task.name}</strong>
        </span>
        <span className="rail-item-meta">
          {task.trigger.kind === 'event' ? (
            <span className={modeClass(task.trigger.mode)}><i />{MODE_LABEL[task.trigger.mode]}</span>
          ) : null}
          <span className="rail-item-trigger">{triggerSummary(task.trigger)}</span>
        </span>
      </button>
      <div className="rail-item-actions">
        <button className="icon-btn" title="执行一次" aria-label={`执行一次 ${task.name}`} onClick={onTrigger} disabled={busy}>
          <Icon name="play" size={13} />
        </button>
        {task.type === 'script' && (
          <button className="icon-btn" title="生成脚本" aria-label={`生成脚本 ${task.name}`} onClick={onGenerateScript} disabled={busy}>
            <Icon name="zap" size={13} />
          </button>
        )}
        <button className="icon-btn" title={task.enabled ? '停用' : '启用'} aria-label={`${task.enabled ? '停用' : '启用'} ${task.name}`} onClick={onToggle} disabled={busy}>
          <Icon name={task.enabled ? 'stop' : 'play'} size={13} />
        </button>
        <button className="icon-btn danger" title="删除" aria-label={`删除 ${task.name}`} onClick={onRemove} disabled={busy}>
          <Icon name="trash" size={13} />
        </button>
      </div>
    </article>
  )
}

/** 执行产出的跳转：直接跳到对应的面板入口。 */
function RunOutputs({ outputs }: { outputs: AutomationRun['outputs'] }): JSX.Element {
  if (!outputs.ticketIds.length && !outputs.eventIds.length) return <span className="muted">无产出</span>
  return (
    <div className="automation-outputs">
      {outputs.ticketIds.map(id => <a key={id} href={`#tickets/${encodeURIComponent(id)}`} className="automation-output-link">工单 {id}</a>)}
      {outputs.eventIds.map(id => <a key={id} href="#events" className="automation-output-link">事件 {id}</a>)}
    </div>
  )
}

/** 时间展示：本地时区，去掉年份噪音。 */
function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
