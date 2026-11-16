/**
 * GitHub 来源的设置弹窗：添加仓库、逐仓库选监听内容。
 *
 * 来源层只显示一张 GitHub 卡片；仓库列表与增删都收在设置弹窗里。
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
export function githubSubscriptionsOf(draft: ConfigDoc | null): Array<{ id: string; source: GithubSubscription }> {
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

/** GitHub 来源的设置弹窗：仓库列表 + 添加仓库 + 逐仓库选监听内容。 */
export function GithubSourceSettings({ draft, setField, onClose }: {
  draft: ConfigDoc | null
  setField: (path: string, value: unknown) => void
  onClose: () => void
}): JSX.Element {
  const [repo, setRepo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const subscriptions = githubSubscriptionsOf(draft)
  const editingSource = editing ? subscriptions.find(item => item.id === editing)?.source : undefined

  const write = (id: string, source: GithubSubscription | null): void => {
    setField(`events.sources.${id}`, source)
  }

  const add = (): void => {
    const issue = githubRepoIssue(repo)
    if (issue) {
      setError(issue)
      return
    }
    const id = nextGithubSourceId(Object.keys(draft?.events?.sources ?? {}))
    const source = withGithubRepo(id, repo)
    if (!source) {
      setError('请填写仓库地址')
      return
    }
    write(id, source)
    setRepo('')
    setError(null)
  }

  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="GitHub 设置">
        <header className="modal-head">
          <div>
            <h3>{editingSource ? '监听内容' : 'GitHub 设置'}</h3>
            <p>
              {editingSource
                ? `${editingSource.repo || '未填仓库'}：勾选要收的事件；一个都不勾表示全部都收。`
                : '一个仓库一条订阅：只收你勾选的事件，收到的动静先进事件队列，由决策判断要不要处理。'}
            </p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="close" size={14} /></button>
        </header>
        <div className="modal-body github-settings">
          {editingSource ? (
            <GithubEventsPicker
              value={editingSource.events ?? []}
              onChange={events => {
                if (editing) write(editing, { ...editingSource, events })
              }}
            />
          ) : (
            <>
              <div className="github-settings-head">
                <h4>仓库</h4>
                <span>{subscriptions.length} 个已添加</span>
              </div>
              <div className="github-add-row">
                <label className={`modal-field ${error ? 'has-error' : ''}`}>
                  <span>仓库地址</span>
                  <input
                    className="text-input"
                    value={repo}
                    placeholder="owner/repo"
                    onChange={event => {
                      setRepo(event.target.value)
                      setError(null)
                    }}
                    onKeyDown={event => { if (event.key === 'Enter') add() }}
                  />
                </label>
                <button className="btn primary" onClick={add}><Icon name="plus" size={12} />添加</button>
              </div>
              {error
                ? <p className="modal-field-error">{error}</p>
                : <p className="modal-field-hint">需要已安装并登录 gh CLI 才能拉到事件。</p>}

              {subscriptions.length === 0 ? (
                <p className="editor-empty">还没有订阅任何 GitHub 仓库。填一个 owner/repo 就能添加。</p>
              ) : (
                <div className="github-settings-list">
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
            </>
          )}
        </div>
        <footer className="modal-foot">
          {editingSource ? (
            <>
              <button className="btn ghost" onClick={() => setEditing(null)}>返回</button>
              <button className="btn primary" onClick={() => setEditing(null)}>完成</button>
            </>
          ) : (
            <button className="btn primary" onClick={onClose}>完成</button>
          )}
        </footer>
      </div>
    </div>
  )
}

/** 监听内容摘要：全选显示「全部事件」，否则列出类型。 */
function eventsSummary(events: string[]): string {
  if (events.length === 0) return '监听全部事件'
  return events.map(id => githubEventLabel(id)).join('、')
}

/** 监听内容：按 Issue / PR / Action 分组多选。 */
function GithubEventsPicker({ value, onChange }: {
  value: string[]
  onChange: (events: string[]) => void
}): JSX.Element {
  const groups = githubEventTypesByKind()
  const allIds = groups.flatMap(group => group.types.map(type => type.id))
  const selected = new Set(value)
  const allOn = allIds.every(id => selected.has(id))

  return (
    <div className="github-events-picker">
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
  )
}

