/**
 * 配置页的「事件来源」编辑区。
 *
 * 来源只做一件事：把事件收进来。这里按来源声明的字段渲染成行，
 * 值写回配置草稿，跟其它配置项一样由底部保存条统一落盘。
 */
import { useMemo, useState } from 'react'
import type { ConfigDoc } from './api.js'
import { FieldRow } from './field-row.js'
import { getByPath } from './fields.js'
import { sourceFieldDefs, type SourceMeta } from './event-sources.js'
import { Icon } from './icons.js'

/** 来源状态 → 面板上的一句话。 */
const STATUS_TEXT: Record<string, string> = {
  idle: '已启用，暂无新事件',
  ok: '运行正常',
  error: '拉取失败',
  unsupported: '未启用',
}

const KIND_LABEL: Record<string, string> = {
  github: 'GitHub Issue',
  http: 'HTTP 推送',
  schedule: '定时任务',
  feishu: '飞书',
  plugin: '插件来源',
}

/** 事件来源编辑区。 */
export function EventSourcesConfig({ sources, draft, defaults, setField, errors }: {
  sources: SourceMeta[]
  draft: ConfigDoc | null
  defaults: ConfigDoc
  setField: (path: string, value: unknown) => void
  errors: Map<string, string>
}): JSX.Element {
  const [open, setOpen] = useState<string[]>([])

  const defs = useMemo(() => sources.map(source => ({
    source,
    fields: sourceFieldDefs(source.id, source.fields),
  })), [sources])

  if (defs.length === 0) return <p className="editor-empty">还没有注册任何事件来源。</p>

  return (
    <div className="source-list">
      {defs.map(({ source, fields }) => {
        const expanded = open.includes(source.id)
        const enabled = Boolean(getByPath(draft, `events.sources.${source.id}.enabled`))
        return (
          <section key={source.id} className={`source-item ${expanded ? 'open' : ''}`}>
            <header className="source-item-head">
              <button
                type="button"
                className="source-item-toggle"
                aria-expanded={expanded}
                onClick={() => setOpen(current => current.includes(source.id)
                  ? current.filter(id => id !== source.id)
                  : [...current, source.id])}
              >
                <Icon name="chevron" size={12} className="fold-chevron" />
                <span className="source-item-name">{source.id}</span>
                <span className="source-item-kind">{KIND_LABEL[source.kind] ?? source.kind}</span>
              </button>
              <div className="source-item-meta">
                <span className="source-item-status">{source.message ?? STATUS_TEXT[source.status] ?? source.status}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  className={`toggle ${enabled ? 'on' : ''}`}
                  onClick={() => setField(`events.sources.${source.id}.enabled`, !enabled)}
                >
                  <span className="toggle-track"><span className="toggle-knob" /></span>
                  <span className="toggle-label">{enabled ? '已启用' : '未启用'}</span>
                </button>
              </div>
            </header>
            {expanded && (
              <div className="source-item-body">
                {fields.length === 0
                  ? <p className="editor-empty">这个来源没有可配置项。</p>
                  : fields.map(field => (
                    <FieldRow
                      key={field.path}
                      field={field}
                      value={getByPath(draft, field.path)}
                      defaultValue={getByPath(defaults, field.path)}
                      error={errors.get(field.path)}
                      onChange={value => setField(field.path, value)}
                    />
                  ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
