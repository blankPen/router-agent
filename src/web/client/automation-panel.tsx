/**
 * 自动化页：任务列表与执行记录两个 Tab。
 *
 * 视觉沿用收件箱与配置页的既有规范（页头、表格、卡片、弹窗），
 * 弹窗字段顺序与「添加决策规则」保持一致：名称 → 类型 → 提示词 → 运行时 → 项目 → 执行时间。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson, saveConfigPatch, sendJson } from './api.js'
import { Icon } from './icons.js'
import {
  RUN_STATUS_LABEL,
  SCHEDULE_KIND_LABEL,
  blankDraft,
  draftOf,
  editorDraftOf,
  durationText,
  runStatusClass,
  scheduleText,
  validateDraft,
  weekdayOptions,
  type AutomationDraftRecord,
  type AutomationDraft,
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
  drafts: AutomationDraftRecord[]
}

interface Notice {
  kind: 'ok' | 'warn' | 'error'
  text: string
}

/** 自动化页。 */
export function AutomationView(): JSX.Element {
  const [tasks, setTasks] = useState<AutomationTask[]>([])
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [drafts, setDrafts] = useState<AutomationDraftRecord[]>([])
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [tab, setTab] = useState<'tasks' | 'runs'>('tasks')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<AutomationDraft | null>(null)
  /** 正在编辑的待确认草稿 id；保存成功后把它标记为已处理。 */
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await getJson<AutomationsPayload>('/api/automations')
      setTasks(data.tasks ?? [])
      setRuns(data.runs ?? [])
      setDrafts(data.drafts ?? [])
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
    const timer = setInterval(() => { void load() }, 10_000)
    return () => clearInterval(timer)
  }, [load])

  const saveTasks = useCallback(async (next: AutomationTask[]): Promise<void> => {
    const payload = next.map(task => ({
      id: task.id,
      name: task.name,
      description: task.description,
      type: task.type,
      prompt: task.prompt,
      ...(task.script ? { script: task.script } : {}),
      schedule: task.schedule,
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
    setEditingDraftId(null)
    setEditing(blankDraft())
  }

  const openEdit = (task: AutomationTask) => {
    setEditingDraftId(null)
    setEditing(draftOf(task))
  }

  /** 打开飞书草稿：字段与新建弹窗一致，保存后才写正式任务。 */
  const openDraft = (record: AutomationDraftRecord) => {
    setEditingDraftId(record.id)
    setEditing(editorDraftOf(record))
  }

  const dismissDraft = async (record: AutomationDraftRecord) => {
    setBusy(true)
    try {
      await sendJson<{ ok: boolean }>('/api/automations/drafts/dismiss', 'POST', { id: record.id })
      setNotice({ kind: 'warn', text: `已忽略草稿「${record.draft.name}」。` })
      await load()
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const commit = async (draft: AutomationDraft) => {
    const message = validateDraft(draft)
    if (message) {
      setNotice({ kind: 'error', text: message })
      return
    }
    setBusy(true)
    try {
      const now = new Date().toISOString()
      const existing = tasks.find(task => task.id === draft.id)
      const task: AutomationTask = {
        id: draft.id || `auto_${Date.now().toString(36)}`,
        name: draft.name.trim(),
        description: draft.description.trim(),
        type: draft.type,
        prompt: draft.prompt.trim(),
        ...(draft.type === 'script' && draft.script.trim() ? { script: draft.script.trim() } : {}),
        schedule: draft.schedule,
        runtimeId: draft.runtimeId,
        project: draft.project,
        repo: draft.repo,
        branch: draft.branch,
        enabled: draft.enabled,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      const next = existing
        ? tasks.map(item => (item.id === task.id ? task : item))
        : [...tasks, task]
      await saveTasks(next)
      // 草稿确认后标记为已处理，避免面板里继续显示同一条待确认项。
      if (editingDraftId) {
        await sendJson<{ ok: boolean }>('/api/automations/drafts/dismiss', 'POST', { id: editingDraftId })
      }
      setNotice({ kind: 'ok', text: `自动化「${task.name}」已保存。` })
      setEditingDraftId(null)
      setEditing(null)
      await load()
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (task: AutomationTask) => {
    setBusy(true)
    try {
      const next = tasks.map(item => (item.id === task.id ? { ...item, enabled: !item.enabled } : item))
      await saveTasks(next)
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
      await saveTasks(tasks.filter(item => item.id !== task.id))
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
    setNotice({ kind: 'ok', text: `正在执行「${task.name}」…` })
    try {
      const data = await sendJson<{ run: AutomationRun }>('/api/automations/trigger', 'POST', { id: task.id })
      const run = data.run
      setNotice({
        kind: run.status === 'success' ? 'ok' : 'error',
        text: `「${task.name}」执行${RUN_STATUS_LABEL[run.status] ?? run.status}：${run.summary || '（无摘要）'}`,
      })
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
          <p>按计划触发的任务：服务在跑就自动执行，执行记录留在这里可查。</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={openCreate}>
            <Icon name="plus" size={13} />新建自动化
          </button>
          <button className="btn ghost" onClick={() => { void load() }} disabled={busy}>刷新</button>
        </div>
      </div>

      {error && <div className="banner danger"><Icon name="alert" />{error}</div>}
      {notice && <div className={`banner ${notice.kind === 'error' ? 'danger' : ''}`} onClick={() => setNotice(null)}>{notice.text}</div>}

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
        {drafts.length > 0 && (
          <section className="automation-drafts">
            <header>
              <h2>待确认草稿</h2>
              <p>来自飞书的自然语言整理结果；检查后保存才会成为正式任务。</p>
            </header>
            <div className="source-cards">
              {drafts.map(record => (
                <article key={record.id} className="source-card automation-draft-card">
                  <div className="source-card-top">
                    <span className="source-logo"><Icon name="radio" size={16} /></span>
                    <div className="source-card-title">
                      <strong>{record.draft.name}</strong>
                      <span>
                        {scheduleText(record.draft.schedule)} · {record.draft.project || '未选项目'} · 来自 {record.source || '组织'}
                      </span>
                    </div>
                  </div>
                  <p className="source-card-status">{record.draft.prompt}</p>
                  <div className="source-card-actions">
                    <button className="btn tiny" onClick={() => openDraft(record)} disabled={busy}>编辑并保存</button>
                    <button className="btn tiny ghost" onClick={() => void dismissDraft(record)} disabled={busy}>忽略</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
        {tasks.length === 0 ? (
          <div className="empty-state">
            <p>还没有自动化任务。</p>
            <p className="muted">新建一个：说明要做什么、选个项目、定个执行时间。</p>
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
                      {task.type === 'script' ? '脚本自动化' : 'AI 自动化'} · {scheduleText(task.schedule)} · {task.project}
                    </span>
                  </div>
                </div>
                <p className="source-card-status">{task.description || task.prompt}</p>
                <p className="source-card-package" title={task.prompt}>{task.prompt}</p>
                <div className="source-card-fields">
                  {task.nextRunAt ? `下次触发 ${formatTime(task.nextRunAt)}` : '尚未排期'}
                  {task.lastStatus ? ` · 上次 ${RUN_STATUS_LABEL[task.lastStatus] ?? task.lastStatus}` : ''}
                </div>
                <div className="source-card-actions">
                  <button className="btn tiny" onClick={() => openEdit(task)}>编辑</button>
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
                  </td>
                  <td><span className={`automation-status ${runStatusClass(run.status)}`}>{RUN_STATUS_LABEL[run.status] ?? run.status}</span></td>
                  <td>{durationText(run.durationMs)}</td>
                  <td>
                    <span className="automation-run-summary">{run.summary || '—'}</span>
                    {run.error && <div className="automation-run-error">{run.error}</div>}
                  </td>
                  <td><RunOutputs outputs={run.outputs} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {editing && (
        <AutomationEditor
          draft={editing}
          runtimes={runtimes}
          projects={projects}
          busy={busy}
          onChange={setEditing}
          onClose={() => { setEditing(null); setEditingDraftId(null) }}
          onSave={() => void commit(editing)}
        />
      )}
    </>
  )
}

/** 执行产出的跳转：直接跳到对应的面板入口。 */
function RunOutputs({ outputs }: { outputs: AutomationRun['outputs'] }): JSX.Element {
  if (!outputs.ticketIds.length && !outputs.eventIds.length) return <>无产出</>
  return (
    <div className="automation-outputs">
      {outputs.ticketIds.map(id => <a key={id} href={`#tickets/${encodeURIComponent(id)}`} className="automation-output-link">工单 {id}</a>)}
      {outputs.eventIds.map(id => <a key={id} href="#events" className="automation-output-link">事件 {id}</a>)}
    </div>
  )
}

/** 新建 / 编辑自动化弹窗。 */
export function AutomationEditor({ draft, runtimes, projects, busy, onChange, onClose, onSave }: {
  draft: AutomationDraft
  runtimes: RuntimeOption[]
  projects: ProjectOption[]
  busy: boolean
  onChange: (draft: AutomationDraft) => void
  onClose: () => void
  onSave: () => void
}): JSX.Element {
  const message = validateDraft(draft)
  const pickProject = (name: string) => {
    const project = projects.find(item => item.name === name)
    onChange({
      ...draft,
      project: name,
      repo: project?.repo ?? draft.repo,
      branch: project?.defaultBranch ?? draft.branch,
    })
  }
  const setSchedule = (patch: Partial<AutomationDraft['schedule']>) => {
    onChange({ ...draft, schedule: { ...draft.schedule, ...patch } })
  }

  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="modal modal-wide rule-modal" role="dialog" aria-modal="true" aria-label="新建自动化">
        <header className="modal-head rule-modal-head">
          <div>
            <h2>{draft.id ? '编辑自动化' : '新建自动化'}</h2>
            <p className="rule-modal-sub">
              <span className="mono">{scheduleText(draft.schedule)}</span>
              <span className="rule-modal-dot">·</span>
              <span>{draft.project || '未选项目'}</span>
            </p>
          </div>
          <button className="icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="modal-body rule-modal-body">
          <section className="rule-section">
            <header className="rule-section-head">
              <h3><span className="rule-step">1</span>基本信息</h3>
              <p>名称与描述只给人看；执行时以「提示词」为准。</p>
            </header>
            <label className="modal-field">
              <span>名称</span>
              <input
                value={draft.name}
                placeholder="例如：每周检查依赖更新"
                onChange={event => onChange({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="modal-field">
              <span>描述<span className="rule-field-key">可选</span></span>
              <input
                value={draft.description}
                placeholder="一句话说明这个自动化做什么"
                onChange={event => onChange({ ...draft, description: event.target.value })}
              />
            </label>
          </section>

          <section className="rule-section">
            <header className="rule-section-head">
              <h3><span className="rule-step">2</span>类型与内容</h3>
              <p>AI 自动化只给提示词；脚本自动化先由 AI 生成脚本，脚本会保存下来可以人工改。</p>
            </header>
            <label className="modal-field">
              <span>类型</span>
              <span className="select-wrap">
                <select value={draft.type} onChange={event => onChange({ ...draft, type: event.target.value as AutomationDraft['type'] })}>
                  <option value="ai">AI 自动化（自然语言提示词）</option>
                  <option value="script">脚本自动化（AI 生成脚本，可人工编辑）</option>
                </select>
                <Icon name="chevron" size={12} className="select-chevron" />
              </span>
            </label>
            <label className="modal-field">
              <span className="rule-field-label">
                {draft.type === 'script' ? '脚本要达成的目标' : '提示词'}
              </span>
              <textarea
                className="rule-textarea"
                rows={4}
                value={draft.prompt}
                placeholder="例如：检查 package.json 里的依赖有没有新版本，有就列出清单"
                onChange={event => onChange({ ...draft, prompt: event.target.value })}
              />
            </label>
            {draft.type === 'script' && (
              <label className="modal-field">
                <span className="rule-field-label">脚本正文<span className="rule-field-key">可留空，首次执行时生成</span></span>
                <textarea
                  className="rule-textarea"
                  rows={4}
                  value={draft.script}
                  placeholder="留空则首次执行时由 AI 生成；生成后可以在这里直接改。"
                  onChange={event => onChange({ ...draft, script: event.target.value })}
                />
              </label>
            )}
          </section>

          <section className="rule-section">
            <header className="rule-section-head">
              <h3><span className="rule-step">3</span>执行环境</h3>
              <p>任务在所选项目里跑，超出项目范围的资源不会被访问。</p>
            </header>
            <label className="modal-field">
              <span>运行时</span>
              <span className="select-wrap">
                <select value={draft.runtimeId} onChange={event => onChange({ ...draft, runtimeId: event.target.value })}>
                  <option value="">跟随默认运行时</option>
                  {runtimes.map(runtime => (
                    <option key={runtime.id} value={runtime.id}>{runtime.name}</option>
                  ))}
                </select>
                <Icon name="chevron" size={12} className="select-chevron" />
              </span>
            </label>
            <label className="modal-field">
              <span>目标项目</span>
              <span className="select-wrap">
                <select value={draft.project} onChange={event => pickProject(event.target.value)}>
                  <option value="">请选择项目</option>
                  {projects.map(project => (
                    <option key={project.name} value={project.name}>{project.name}</option>
                  ))}
                </select>
                <Icon name="chevron" size={12} className="select-chevron" />
              </span>
            </label>
            {draft.repo && (
              <p className="modal-hint">
                <Icon name="folder" size={12} />{draft.repo}
                {draft.branch ? ` @ ${draft.branch}` : ''}
              </p>
            )}
          </section>

          <section className="rule-section">
            <header className="rule-section-head">
              <h3><span className="rule-step">4</span>执行时间</h3>
              <p>服务没在跑时错过的触发不会补跑，会记成「已错过」。</p>
            </header>
            <label className="modal-field">
              <span>频率</span>
              <span className="select-wrap">
                <select
                  value={draft.schedule.kind}
                  onChange={event => setSchedule({ kind: event.target.value as AutomationDraft['schedule']['kind'] })}
                >
                  {Object.entries(SCHEDULE_KIND_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <Icon name="chevron" size={12} className="select-chevron" />
              </span>
            </label>
            {draft.schedule.kind === 'daily' && (
              <label className="modal-field">
                <span>执行时刻</span>
                <input
                  type="time"
                  value={draft.schedule.at ?? '09:00'}
                  onChange={event => setSchedule({ at: event.target.value })}
                />
              </label>
            )}
            {draft.schedule.kind === 'weekly' && (
              <div className="modal-grid">
                <label className="modal-field">
                  <span>星期</span>
                  <span className="select-wrap">
                    <select
                      value={draft.schedule.weekday ?? 1}
                      onChange={event => setSchedule({ weekday: Number(event.target.value) })}
                    >
                      {weekdayOptions().map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <Icon name="chevron" size={12} className="select-chevron" />
                  </span>
                </label>
                <label className="modal-field">
                  <span>执行时刻</span>
                  <input
                    type="time"
                    value={draft.schedule.time ?? '09:00'}
                    onChange={event => setSchedule({ time: event.target.value })}
                  />
                </label>
              </div>
            )}
            {draft.schedule.kind === 'cron' && (
              <label className="modal-field">
                <span className="rule-field-label">Cron 表达式<span className="rule-field-key">分 时 日 月 周</span></span>
                <input
                  value={draft.schedule.cron ?? ''}
                  placeholder="0 9 * * 1"
                  onChange={event => setSchedule({ cron: event.target.value })}
                />
                <p className="modal-hint">五段式；例如 0 9 * * 1 表示每周一 09:00。</p>
              </label>
            )}
          </section>
        </div>
        <footer className="modal-foot rule-modal-foot">
          {message && (
            <p className="rule-modal-error" role="alert">
              <Icon name="alert" size={13} />
              <span>{message}</span>
            </p>
          )}
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={onSave} disabled={busy}>保存</button>
        </footer>
      </div>
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
