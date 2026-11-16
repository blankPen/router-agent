/**
 * GitHub 仓库订阅的界面：添加仓库、逐仓库选监听内容。
 *
 * 一个仓库 = 一张卡，卡上能开关订阅、选监听哪些事件、删掉这条订阅。
 * 监听内容按 Issue / PR / Action 分组多选，空选表示全部都收。
 */
import { useState } from 'react'
import { GITHUB_EVENT_TYPES, githubEventTypesByKind, githubEventLabel } from '#core/github-events.js'
import type { ConfigDoc } from './api.js'
import { Icon } from './icons.js'

/** 草稿里的一条 GitHub 订阅。 */
interface GithubSubscription {
  enabled: boolean
  kind?: string
  repo?: string
  events?: string[]
}

/** 读草稿里的 GitHub 订阅。 */
function subscriptionsOf(draft: ConfigDoc | null): Array<{ id: string; source: GithubSubscription }> {
  const sources = draft?.events?.sources
  if (!sources || typeof sources !== 'object') return []
  const out: Array<{ id: string; source: GithubSubscription }> = []
  for (const [id, value] of Object.entries(sources as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const source = value as GithubSubscription
    if (source.kind !== 'github') continue
    out.push({ id, source })
  }
  return out
}

/**
 * GitHub 仓库订阅的前端逻辑：来源 id 分配与新增订阅。
 *
 * 一个仓库 = 一个事件来源条目（id 形如 `github-1`），
 * 面板上的「添加仓库」按钮就是往配置里加一条这样的条目。
 */

/** 事件来源条目（配置里 events.sources.<id> 的形状）。 */
export interface EventSourceDraft {
  enabled: boolean
  kind?: string
  repo?: string
  events?: string[]
  plugin?: string
}

/** GitHub 来源的 id：`github-<序号>`。 */
export function githubSourceId(index: number): string {
  return `github-${index}`
}

/** 下一个可用的 GitHub 来源 id；已有的 id 不占号。 */
export function nextGithubSourceId(existingIds: string[]): string {
  const used = new Set(
    existingIds
      .map(id => /^github-(\d+)$/.exec(id)?.[1])
      .filter(Boolean)
      .map(text => Number(text)),
  )
  let index = 1
  while (used.has(index)) index += 1
  return githubSourceId(index)
}

/** 新增一个仓库订阅；仓库地址为空时不生成。 */
export function withGithubRepo(id: string, repo: string): EventSourceDraft | null {
  const trimmed = repo.trim()
  if (!trimmed) return null
  return { enabled: true, kind: 'github', repo: trimmed, events: [] }
}

/** 仓库地址格式校验：owner/repo。 */
export function githubRepoIssue(repo: string): string | null {
  const trimmed = repo.trim()
  if (!trimmed) return '请填写仓库地址'
  if (!/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return '仓库地址格式应为 owner/repo'
  return null
}

/** 勾选/取消一个事件类型，返回新的类型列表。 */
export function toggleEventType(current: string[], id: string, checked: boolean): string[] {
  const set = new Set(current)
  if (checked) set.add(id)
  else set.delete(id)
  // 按目录顺序排，保证保存后的配置稳定可比对。
  return GITHUB_EVENT_TYPES.map(type => type.id).filter(item => set.has(item))
}

/** GitHub 仓库订阅区：卡片列表 + 「添加仓库」按钮。 */
export function GithubSubscriptions({ draft, setField }: {
  draft: ConfigDoc | null
  setField: (path: string, value: unknown) => void
}): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const subscriptions = subscriptionsOf(draft)

  const write = (id: string, source: GithubSubscription | null): void => {
    setField(`events.sources.${id}`, source)
  }

  return (
    <div className="github-subs">
      <div className="source-cards-head">
        <p className="editor-hint">
          每个仓库一条订阅：只收你勾选的事件，收到的动静先进事件队列，由决策判断要不要处理。
        </p>
        <button className="btn tiny" onClick={() => setAdding(true)}>
          <Icon name="plus" size={12} />添加仓库
        </button>
      </div>

      {subscriptions.length === 0 ? (
        <p className="editor-empty">还没有订阅任何 GitHub 仓库。点「添加仓库」填一个 owner/repo。</p>
      ) : (
        <div className="github-subs-list">
          {subscriptions.map(({ id, source }) => (
            <article key={id} className={`github-sub ${source.enabled ? 'on' : ''}`}>
              <div className="github-sub-top">
                <span className="github-sub-repo">{source.repo || '（未填仓库）'}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(source.enabled)}
                  className={`toggle small ${source.enabled ? 'on' : ''}`}
                  onClick={() => write(id, { ...source, enabled: !source.enabled })}
                >
                  <span className="toggle-track"><span className="toggle-knob" /></span>
                </button>
              </div>
              <p className="github-sub-events">{eventsSummary(source.events ?? [])}</p>
              <div className="github-sub-actions">
                <button className="btn tiny" onClick={() => setEditing(id)}>监听内容</button>
                <button
                  className="btn tiny danger"
                  onClick={() => {
                    if (confirm(`删除订阅 ${source.repo || id}？`)) write(id, null)
                  }}
                >
                  <Icon name="trash" size={12} />删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {adding && (
        <AddRepoDialog
          existingIds={Object.keys(draft?.events?.sources ?? {})}
          onAdd={(id, source) => {
            write(id, source)
            setAdding(false)
          }}
          onClose={() => setAdding(false)}
        />
      )}
      {editing && (
        <GithubEventsDialog
          repo={subscriptions.find(item => item.id === editing)?.source.repo ?? ''}
          value={subscriptions.find(item => item.id === editing)?.source.events ?? []}
          onChange={events => {
            const current = subscriptions.find(item => item.id === editing)
            if (current) write(editing, { ...current.source, events })
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/** 监听内容摘要：全选显示「全部事件」，否则列出类型。 */
function eventsSummary(events: string[]): string {
  if (events.length === 0) return '监听全部事件'
  return events.map(id => githubEventLabel(id)).join('、')
}

/** 添加仓库：填 owner/repo，生成一条新的订阅。 */
function AddRepoDialog({ existingIds, onAdd, onClose }: {
  existingIds: string[]
  onAdd: (id: string, source: GithubSubscription) => void
  onClose: () => void
}): JSX.Element {
  const [repo, setRepo] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const issue = githubRepoIssue(repo)
    if (issue) {
      setError(issue)
      return
    }
    const id = nextGithubSourceId(existingIds)
    const source = withGithubRepo(id, repo)
    if (!source) {
      setError('请填写仓库地址')
      return
    }
    onAdd(id, source)
  }

  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="添加仓库">
        <header className="modal-head">
          <div>
            <h3>添加 GitHub 仓库</h3>
            <p>填仓库地址就能订阅；监听内容在添加后按需勾选。</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="close" size={14} /></button>
        </header>
        <div className="modal-body">
          <label className={`modal-field ${error ? 'has-error' : ''}`}>
            <span>仓库地址</span>
            <input
              className="text-input"
              value={repo}
              placeholder="owner/repo"
              autoFocus
              onChange={event => {
                setRepo(event.target.value)
                setError(null)
              }}
              onKeyDown={event => { if (event.key === 'Enter') submit() }}
            />
            {error ? <em className="modal-field-error">{error}</em> : <em className="modal-field-hint">需要已安装并登录 gh CLI 才能拉到事件。</em>}
          </label>
        </div>
        <footer className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={submit}>添加</button>
        </footer>
      </div>
    </div>
  )
}

/** 监听内容：按 Issue / PR / Action 分组多选。 */
function GithubEventsDialog({ repo, value, onChange, onClose }: {
  repo: string
  value: string[]
  onChange: (events: string[]) => void
  onClose: () => void
}): JSX.Element {
  const groups = githubEventTypesByKind()
  const allIds = groups.flatMap(group => group.types.map(type => type.id))
  const selected = new Set(value)
  const allOn = allIds.every(id => selected.has(id))

  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="监听内容">
        <header className="modal-head">
          <div>
            <h3>监听内容</h3>
            <p>{repo || '未填仓库'}：勾选要收的事件；一个都不勾表示全部都收。</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="close" size={14} /></button>
        </header>
        <div className="modal-body">
          <div className="github-events-toolbar">
            <button className="btn tiny" onClick={() => onChange(allOn ? [] : allIds)}>
              {allOn ? '全部取消' : '全选'}
            </button>
            <span className="github-events-count">已选 {value.length} / {allIds.length}</span>
          </div>
          {groups.map(group => (
            <fieldset key={group.kind} className="github-events-group">
              <legend>{group.label}</legend>
              {group.types.map(type => (
                <label key={type.id} className="github-events-item">
                  <input
                    type="checkbox"
                    checked={selected.has(type.id)}
                    onChange={event => onChange(toggleEventType(value, type.id, event.target.checked))}
                  />
                  <span>{type.label}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <footer className="modal-foot">
          <button className="btn primary" onClick={onClose}>完成</button>
        </footer>
      </div>
    </div>
  )
}

