/**
 * 自动化页：任务列表与执行记录两个 Tab。
 *
 * 新建任务走**会话**（自然语言一句话），不再有填表弹窗；
 * 任务卡上带处理模式、订阅信息与「恢复会话」入口（§8.2 / §8.3）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson, saveConfigPatch, sendJson } from './api.js'
import { Icon } from './icons.js'
import { AutomationConversationView } from './automation-conversation.js'
import {
  MODE_LABEL,
  RUN_PHASE_LABEL,
  RUN_STATUS_LABEL,
  durationText,
  filterText,
  modeClass,
  phaseText,
  removedTasks,
  runStatusClass,
  toggledTasks,
  triggerText,
  type AutomationRun,
  type AutomationTask,
} from './automation-model.js'

/** 可选的 runtime。 */
export interface RuntimeOption {
  id: string
  name: string
}

/** 可选的项目。 */
export interface ProjectOption {
  name: string
  repo: string
  defaultBranch?: string
}

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
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [tab, setTab] = useState<'tasks' | 'runs'>('tasks')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  /** 正在进行的会话；空表示会话面板收起。 */
  const [conversationId, setConversationId] = useState<string | null>(null)
  /** 会话面板是否展开。 */
  const [conversationOpen, setConversationOpen] = useState(false)
  /** 有任务正在执行：轮询加快，阶段才看得出在动。 */
  const running = runs.some(run => run.status === 'running')

  const load = useCallback(async () => {
    try {
      const data = await getJson<AutomationsPayload>('/api/automations')
      setTasks(data.tasks ?? [])
      setRuns(data.runs ?? [])
      setLoaded(true)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoaded(true)
    }
  }, [])

  // 候选 runtime / 项目跟着配置走：面板「配置 → 运行时 / 项目」改完这里立刻能看到。
  useEffect(() => {
    void getJson<{ runtimeChoices?: Array<{ id: string; name: string }>; projects?: ProjectOption[] }>('/api/config')
      .then(data => {
        setRuntimes(data.runtimeChoices ?? [])
        setProjects(data.projects ?? [])
      })
      .catch(() => undefined)
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

  const openCreate = () => {
    setConversationId(null)
    setConversationOpen(true)
  }

  /** 恢复会话：回到这条任务绑定的原会话，历史接得上（§12.2 V8）。 */
  const resumeConversation = (task: AutomationTask) => {
    setConversationId(task.conversationId ?? null)
    setConversationOpen(true)
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
      const data = await sendJson<{ run: AutomationRun }>('/api/automations/trigger', 'POST', { id: task.id })
      const run = data.run
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
      {notice && <div className={`banner ${notice.kind === 'error' ? 'danger' : ''}`} onClick={() => setNotice(null)}>{notice.text}</div>}

      {conversationOpen && (
        <section className="automation-conversation">
          <header className="automation-conversation-head">
            <h2>{conversationId ? '恢复会话' : '新建自动化 · 会话'}</h2>
            <p>
              {conversationId
                ? '接着上次的对话继续改这条任务；确认后才写回任务。'
                : '说清要订阅什么、命中后做什么；助手会追问缺的那一项，确认后才落库。'}
            </p>
          </header>
          <AutomationConversationView
            conversationId={conversationId ?? undefined}
            onTaskCreated={() => { void load() }}
            onClose={() => setConversationOpen(false)}
          />
        </section>
      )}

      <div className="segmented automation-tabs" role="tablist">
        <button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>
          自动化任务{tasks.length ? `（${enabledCount}/${tasks.length} 启用）` : ''}
        </button>
        <button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>
          执行记录{runs.length ? `（${runs.length}）` : ''}
        </button>
      </div>

      {tab === 'tasks' ? (
        <>
        {tasks.length === 0 ? (
          <div className="empty-state">
            <p>还没有自动化任务。</p>
            <p className="muted">用一句话建一个：比如「订阅 GitHub 的 CI 失败，有价值的就立即修复」。</p>
          </div>
        ) : (
          <div className="source-cards">
            {tasks.map(task => (
              <article key={task.id} className={`source-card ${task.enabled ? 'on' : ''}`}>
                <div className="source-card-top">
                  <span className="source-logo"><Icon name="zap" size={16} /></span>
                  <div className="source-card-title">
                    <strong>{task.name}</strong>
                    <span>
                      {task.type === 'script' ? '脚本自动化' : 'AI 自动化'} · {triggerText(task.trigger)} · {task.project || '未选项目'}
                    </span>
                  </div>
                </div>
                <p className="source-card-status">{task.description || task.prompt}</p>
                {task.trigger.kind === 'event' && (
                  <p className="automation-task-tags">
                    <span className={modeClass(task.trigger.mode)}><i />{MODE_LABEL[task.trigger.mode]}</span>
                    {task.trigger.types.map(type => (
                      <span key={type} className="tag source">{type}</span>
                    ))}
                  </p>
                )}
                {task.trigger.kind === 'event' && (
                  <p className="source-card-package" title={filterText(task.trigger.filter)}>
                    {filterText(task.trigger.filter)}
                  </p>
                )}
                <p className="source-card-package" title={task.prompt}>{task.prompt}</p>
                {task.type === 'script' && (
                  <p className="automation-script-state">
                    {task.script
                      ? <>脚本已就绪（{task.script.split('\n').length} 行），定时执行跑的就是这份</>
                      : <>还没有脚本：先生成脚本，确认后才会执行</>}
                  </p>
                )}
                <div className="source-card-fields">
                  {task.trigger.kind === 'schedule'
                    ? (task.nextRunAt ? `下次触发 ${formatTime(task.nextRunAt)}` : '尚未排期')
                    : '按事件触发'}
                  {task.lastStatus ? ` · 上次 ${RUN_STATUS_LABEL[task.lastStatus] ?? task.lastStatus}` : ''}
                </div>
                <div className="source-card-actions">
                  <button className="btn tiny" onClick={() => resumeConversation(task)}>恢复会话</button>
                  {task.type === 'script' && (
                    <button className="btn tiny ghost" onClick={() => void generateScript(task)} disabled={busy}>
                      <Icon name="zap" size={11} />{task.script ? '重新生成脚本' : '生成脚本'}
                    </button>
                  )}
                  <button className="btn tiny ghost" onClick={() => void trigger(task)} disabled={busy}>
                    <Icon name="play" size={11} />执行一次
                  </button>
                  <button className="btn tiny ghost" onClick={() => void toggle(task)} disabled={busy}>
                    {task.enabled ? '停用' : '启用'}
                  </button>
                  <button className="btn tiny ghost" onClick={() => void remove(task)} disabled={busy}>删除</button>
                </div>
              </article>
            ))}
          </div>
        )
        }
        </>
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
