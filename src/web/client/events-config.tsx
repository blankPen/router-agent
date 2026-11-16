/**
 * 配置页的「事件来源」编辑区。
 *
 * 来源只做一件事：把事件收进来。这里用卡片列出每个来源，卡上带开关与设置弹窗；
 * 想要新的来源就装一个 npm 包（和「添加运行时」一个路子）。
 * 改完的值写回配置草稿，跟其它配置项一样由底部保存条统一落盘。
 */
import { useMemo, useState } from 'react'
import { getJson, sendJson, type ConfigDoc } from './api.js'
import { npmPackageOf } from './npm-package.js'
import { SourceLogo } from './event-source-logos.js'
import { sourceFieldDefs, type SourceMeta } from './event-sources.js'
import { GithubSubscriptions } from './github-subscriptions.js'
import { getByPath, type FieldDef } from './fields.js'
import { Icon } from './icons.js'

/** 来源状态 → 卡片上的一句话。 */
const STATUS_TEXT: Record<string, string> = {
  idle: '已启用，暂无新事件',
  ok: '运行正常',
  error: '拉取失败',
  unsupported: '未启用',
}

const KIND_LABEL: Record<string, string> = {
  github: 'GitHub',
  feishu: '飞书',
  plugin: '自定义来源',
  event: '事件来源',
}

/** 安装任务视图；与运行时插件安装共用同一套接口。 */
interface PluginInstallJobView {
  id: string
  status: 'running' | 'ok' | 'failed'
  phase: string
  packageName: string
  version: string
  installedVersion?: string
  declaredId?: string
  lines?: string[]
  error?: string
  startedAt: string
  finishedAt?: string
}

/** 事件来源编辑区。 */
export function EventSourcesConfig({ sources, draft, defaults, setField, errors, onNotice }: {
  sources: SourceMeta[]
  draft: ConfigDoc | null
  defaults: ConfigDoc
  setField: (path: string, value: unknown) => void
  errors: Map<string, string>
  onNotice?: (notice: { kind: 'ok' | 'warn' | 'error'; text: string }) => void
}): JSX.Element {
  const [editing, setEditing] = useState<SourceMeta | null>(null)
  const [adding, setAdding] = useState(false)

  // GitHub 来源单独成区：仓库卡片 + 添加按钮，不混在通用来源卡片里。
  const cards = useMemo(() => sources
    .filter(source => source.kind !== 'github')
    .map(source => ({
      source,
      fields: sourceFieldDefs(source.id, source.fields),
    })), [sources])

  return (
    <>
      <GithubSubscriptions draft={draft} setField={setField} />

      {cards.length > 0 && (
        <>
          <div className="source-cards-head">
            <p className="editor-hint">其它来源：开关与参数改完点底部「保存配置」即生效。</p>
            <button className="btn tiny" onClick={() => setAdding(true)}>
              <Icon name="plus" size={12} />添加自定义事件
            </button>
          </div>
          <div className="source-cards">
            {cards.map(({ source, fields }) => {
              const enabled = Boolean(getByPath(draft, `events.sources.${source.id}.enabled`))
              return (
                <article key={source.id} className={`source-card ${enabled ? 'on' : ''}`}>
                  <div className="source-card-top">
                    <span className="source-logo"><SourceLogo kind={source.kind} /></span>
                    <div className="source-card-title">
                      <strong>{source.id}</strong>
                      <span>
                        {KIND_LABEL[source.kind] ?? source.kind}
                        {source.placeholder && <em className="source-card-placeholder">暂未开放</em>}
                      </span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      className={`toggle ${enabled ? 'on' : ''}`}
                      onClick={() => setField(`events.sources.${source.id}.enabled`, !enabled)}
                    >
                      <span className="toggle-track"><span className="toggle-knob" /></span>
                    </button>
                  </div>
                  <p className="source-card-status">{source.message ?? STATUS_TEXT[source.status] ?? source.status}</p>
                  {source.package && <p className="source-card-package" title={source.package}>{source.package}</p>}
                  <div className="source-card-actions">
                    <button className="btn tiny" onClick={() => setEditing(source)}>设置</button>
                    <span className="source-card-fields">{fields.length} 项可配置</span>
                  </div>
                </article>
              )
            })}
          </div>
        </>
      )}

      {editing && (
        <SourceSettingsDialog
          source={editing}
          fields={sourceFieldDefs(editing.id, editing.fields)}
          draft={draft}
          defaults={defaults}
          errors={errors}
          onChange={setField}
          onClose={() => setEditing(null)}
        />
      )}
      {adding && (
        <AddEventSourceDialog
          onAdd={(id, entry) => {
            setField(`events.sources.${id}.plugin`, entry)
            setField(`events.sources.${id}.enabled`, true)
          }}
          onNotice={onNotice}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  )
}

/** 来源设置弹窗：按来源自己声明的字段渲染，改完写回草稿。 */
function SourceSettingsDialog({ source, fields, draft, defaults, errors, onChange, onClose }: {
  source: SourceMeta
  fields: FieldDef[]
  draft: ConfigDoc | null
  defaults: ConfigDoc
  errors: Map<string, string>
  onChange: (path: string, value: unknown) => void
  onClose: () => void
}): JSX.Element {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {}
    for (const field of fields) out[field.path] = getByPath(draft, field.path)
    return out
  })

  const apply = (): void => {
    for (const field of fields) {
      const next = values[field.path]
      if (next === undefined) continue
      onChange(field.path, next)
    }
    onClose()
  }

  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={`${source.id} 设置`}>
        <header className="modal-head">
          <div>
            <h3>{source.id} 设置</h3>
            <p>{KIND_LABEL[source.kind] ?? source.kind}来源。确定后点底部「保存配置」生效。</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="close" size={14} /></button>
        </header>
        <div className="modal-body">
          {fields.length === 0 && <p className="modal-hint">这个来源没有可配置项。</p>}
          {fields.map(field => (
            <ModalField
              key={field.path}
              field={field}
              value={values[field.path]}
              error={errors.get(field.path)}
              defaultValue={getByPath(defaults, field.path)}
              onChange={value => setValues(current => ({ ...current, [field.path]: value }))}
            />
          ))}
        </div>
        <footer className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={apply} disabled={fields.length === 0}>确定</button>
        </footer>
      </div>
    </div>
  )
}

/** 弹窗里的字段行：标签在上、控件在下，多行字段占满整行。 */
function ModalField({ field, value, defaultValue, error, onChange }: {
  field: FieldDef
  value: unknown
  defaultValue: unknown
  error?: string
  onChange: (value: unknown) => void
}): JSX.Element {
  const changed = defaultValue !== undefined && JSON.stringify(value) !== JSON.stringify(defaultValue)
  return (
    <label className={`modal-field ${error ? 'has-error' : ''}`}>
      <span>
        {field.label}
        {changed && <em className="modal-field-changed">已修改</em>}
      </span>
      {field.kind === 'switch' ? (
        <button
          type="button"
          role="switch"
          aria-checked={value === true}
          className={`toggle ${value === true ? 'on' : ''}`}
          onClick={() => onChange(!(value === true))}
        >
          <span className="toggle-track"><span className="toggle-knob" /></span>
          <span className="toggle-label">{value === true ? '开启' : '关闭'}</span>
        </button>
      ) : field.kind === 'select' ? (
        <select value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
          <option value="">（不设置）</option>
          {(field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : field.kind === 'textarea' ? (
        <textarea
          className="text-area"
          rows={5}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={event => onChange(event.target.value)}
          spellCheck={false}
        />
      ) : (
        <input
          className="text-input"
          type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={event => onChange(field.kind === 'number'
            ? (event.target.value === '' ? 0 : Number(event.target.value))
            : event.target.value)}
        />
      )}
      {error ? <em className="modal-field-error">{error}</em> : field.hint ? <em className="modal-field-hint">{field.hint}</em> : null}
    </label>
  )
}

/** 添加自定义事件来源：装一个 npm 包。 */
function AddEventSourceDialog({ onAdd, onNotice, onClose }: {
  onAdd: (id: string, entry: string) => void
  onNotice?: (notice: { kind: 'ok' | 'warn' | 'error'; text: string }) => void
  onClose: () => void
}): JSX.Element {
  const [entry, setEntry] = useState('')
  const [install, setInstall] = useState<{ busy: boolean; job?: PluginInstallJobView } | null>(null)

  const packageName = npmPackageOf(entry)
  /** 填了东西但不是合法 npm 包名：直接指出来，不让装到一半才失败。 */
  const entryInvalid = entry.trim().length > 0 && !packageName

  const pollInstall = async (jobId: string): Promise<void> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await sleep(1_000)
      try {
        const job = await getJson<PluginInstallJobView>(`/api/plugins/install/${jobId}`)
        setInstall({ busy: job.status === 'running', job })
        if (job.status === 'running') continue
        if (job.status === 'ok') {
          const declaredId = job.declaredId
          if (!declaredId) {
            onNotice?.({
              kind: 'warn',
              text: '插件包没有声明 meta.id，无法确定它是什么来源；请确认包默认导出 kind=event 并声明 meta.id',
            })
            return
          }
          onAdd(declaredId, entry.trim())
          onNotice?.({
            kind: 'ok',
            text: `已添加自定义事件来源 ${declaredId}（id 来自插件包声明）；保存配置后立即生效`,
          })
          onClose()
        } else {
          onNotice?.({ kind: 'error', text: `${job.packageName} 安装失败：${job.error ?? '未知错误'}` })
        }
        return
      } catch (error) {
        if (attempt >= 299) {
          setInstall(null)
          onNotice?.({ kind: 'error', text: `读取安装状态失败：${errorText(error)}` })
          return
        }
        const text = errorText(error)
        if (text.includes('job-not-found')) {
          setInstall(null)
          onNotice?.({ kind: 'warn', text: '安装任务状态已丢失（服务可能重启过），请到日志里确认结果' })
          return
        }
        // 单次网络抖动继续重试，只有最后一轮才报错。
      }
    }
  }

  const installPackage = async (): Promise<void> => {
    if (!packageName) return
    if (!window.confirm(`安装 ${packageName} 到 <RA_HOME>/node_modules？需要联网下载 npm 包。`)) return
    setInstall({ busy: true })
    try {
      const data = await sendJson<{ jobId: string }>('/api/plugins/install', 'POST', {
        kind: 'event',
        packageName,
      })
      setInstall({
        busy: true,
        job: { id: data.jobId, status: 'running', phase: 'queued', packageName, version: 'latest', lines: [], startedAt: new Date().toISOString() },
      })
      void pollInstall(data.jobId)
    } catch (error) {
      setInstall(null)
      onNotice?.({ kind: 'error', text: `启动安装失败：${errorText(error)}` })
    }
  }

  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="添加自定义事件">
        <header className="modal-head">
          <div>
            <h3>添加自定义事件</h3>
            <p>装一个 npm 包作为自定义事件来源；包默认导出 kind=event 并声明 meta.id。</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="close" size={14} /></button>
        </header>
        <div className="modal-body">
          <label className="modal-field">
            <span>npm 包名</span>
            <input className="input" value={entry} placeholder="例如 @scope/event-source" onChange={event => setEntry(event.target.value)} />
          </label>
          {packageName && (
            <p className="modal-hint">
              <Icon name="download" size={13} />
              安装后按插件包声明的 meta.id 登记来源。
            </p>
          )}
          {entryInvalid && (
            <p className="modal-hint">这里只认 npm 包名（例如 @scope/event-source）；本地路径请直接写进 config.yaml 的 events.sources。</p>
          )}
          {install?.job && (
            <pre className="runtime-log">
              {(install.job.lines ?? []).slice(-8).join('\n') || (install.job.status === 'running' ? '正在启动 npm install…' : '')}
              {install.job.error ? `${install.job.lines?.length ? '\n' : ''}${install.job.error}` : ''}
            </pre>
          )}
        </div>
        <footer className="modal-foot">
          <button className="btn primary" onClick={() => void installPackage()} disabled={install?.busy || !packageName}>
            <Icon name="download" size={12} />{install?.busy ? '安装中…' : '安装并添加'}
          </button>
        </footer>
      </div>
    </div>
  )
}

/** 轮询间隔。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 错误信息转文本。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
