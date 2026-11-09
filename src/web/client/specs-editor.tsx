/**
 * 规范 markdown 编辑器：Router / Worker 的提示词规范统一从内置存储读取，
 * 直接在配置页查看、编辑、恢复默认，不再填写外部文件路径。
 */
import { useEffect, useMemo, useState } from 'react'
import { getJson, sendJson } from './api.js'
import { Icon } from './icons.js'

interface SpecView {
  id: string
  group: 'router' | 'worker'
  groupLabel: string
  label: string
  description: string
  applyHint: string
  isCustom: boolean
  updatedAt: string | null
  content: string
}

interface SpecListResponse {
  specs: SpecView[]
}

interface SpecResponse {
  spec: SpecView
}

interface Notice {
  kind: 'ok' | 'error'
  text: string
}

const GROUPS: Array<SpecView['group']> = ['router', 'worker']

export function SpecsEditor(): JSX.Element {
  const [specs, setSpecs] = useState<SpecView[] | null>(null)
  const [activeId, setActiveId] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getJson<SpecListResponse>('/api/specs')
      .then(data => {
        setSpecs(data.specs)
        const first = data.specs[0]
        if (first) {
          setActiveId(first.id)
          setDraft(first.content)
        }
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const active = useMemo(() => specs?.find(spec => spec.id === activeId), [specs, activeId])
  const dirty = active ? draft !== active.content : false

  const select = (id: string): void => {
    if (id === activeId) return
    if (dirty && !confirm('当前修改尚未保存，切换后将丢失，继续？')) return
    const next = specs?.find(spec => spec.id === id)
    if (!next) return
    setActiveId(id)
    setDraft(next.content)
    setNotice(null)
  }

  const applySaved = (spec: SpecView): void => {
    setSpecs(current => current?.map(item => (item.id === spec.id ? spec : item)) ?? null)
    setDraft(spec.content)
  }

  const save = async (): Promise<void> => {
    if (!active || busy) return
    setBusy('save')
    setNotice(null)
    try {
      const data = await sendJson<SpecResponse>(`/api/specs/${encodeURIComponent(active.id)}`, 'PUT', { content: draft })
      applySaved(data.spec)
      setNotice({
        kind: 'ok',
        text: active.group === 'router' ? '已保存；重启服务后生效。' : '已保存；之后派出的新工单会使用新内容。',
      })
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const reset = async (): Promise<void> => {
    if (!active || busy) return
    if (!confirm(`恢复到内置「${active.label}」？当前自定义内容会被删除。`)) return
    setBusy('reset')
    setNotice(null)
    try {
      const data = await sendJson<SpecResponse>(`/api/specs/${encodeURIComponent(active.id)}/reset`, 'POST', {})
      applySaved(data.spec)
      setNotice({ kind: 'ok', text: '已恢复内置内容。' })
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  if (error) {
    return (
      <div className="editor-block">
        <p className="field-error">读取规范失败：{error}</p>
      </div>
    )
  }
  if (!specs) {
    return (
      <div className="editor-block">
        <p className="editor-hint">正在读取规范…</p>
      </div>
    )
  }

  return (
    <div className="editor-block">
      <p className="editor-hint">
        自定义内容保存在状态目录的 <strong>specs/</strong> 下；<strong>恢复默认</strong>会删除自定义内容，回到随包内置版本。
      </p>
      <div className="spec-layout">
        <aside className="spec-nav">
          {GROUPS.map(group => {
            const items = specs.filter(spec => spec.group === group)
            if (items.length === 0) return null
            return (
              <div className="spec-nav-group" key={group}>
                <div className="spec-nav-title">{items[0]!.groupLabel}</div>
                {items.map(spec => (
                  <button
                    key={spec.id}
                    type="button"
                    className={`spec-nav-item ${spec.id === activeId ? 'active' : ''}`}
                    onClick={() => select(spec.id)}
                  >
                    <span>{spec.label}</span>
                    {spec.isCustom && <span className="spec-nav-dot" title="已自定义" />}
                  </button>
                ))}
              </div>
            )
          })}
        </aside>

        {active && (
          <div className="spec-panel">
            <div className="spec-panel-head">
              <div>
                <h4>{active.label}</h4>
                <p>{active.description}</p>
              </div>
              <span className={`badge ${active.isCustom ? 'dirty' : 'cold'}`}>
                {active.isCustom ? '已自定义' : '内置默认'}
              </span>
            </div>
            <div className="spec-meta">
              <span>{active.applyHint}</span>
              {active.updatedAt && <span>最后保存 {formatTime(active.updatedAt)}</span>}
              <span>{draft.length} 字符</span>
              {dirty && <span className="spec-unsaved">有未保存修改</span>}
            </div>
            <textarea
              className="spec-textarea"
              spellCheck={false}
              value={draft}
              onChange={event => {
                setDraft(event.target.value)
                setNotice(null)
              }}
            />
            <div className="spec-actions">
              <button className="btn ghost" onClick={() => void reset()} disabled={busy !== null || !active.isCustom}>
                {busy === 'reset' ? '恢复中…' : '恢复默认'}
              </button>
              <button
                className="btn primary"
                onClick={() => void save()}
                disabled={busy !== null || !dirty || draft.trim() === ''}
              >
                {busy === 'save' ? '保存中…' : '保存'}
              </button>
            </div>
            {notice && <div className={`spec-notice ${notice.kind}`}><Icon name={notice.kind === 'ok' ? 'check' : 'alert'} size={13} />{notice.text}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}
