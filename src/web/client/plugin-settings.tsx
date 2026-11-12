/**
 * 插件配置区：内置 runtime / channel 状态 + 自定义插件入口。
 *
 * 这里只写配置点路径；真正的加载发生在服务重启时，所以保存后统一提示重启。
 */
import { useState } from 'react'
import { Icon } from './icons.js'
import type { PluginView } from './api.js'

export interface PluginSettingsProps {
  plugins?: PluginView[]
  draft: unknown
  onChange: (path: string, value: unknown) => void
}

function entryOf(draft: unknown, kind: 'runtime' | 'channel', id: string): string {
  if (!draft || typeof draft !== 'object') return ''
  const doc = draft as Record<string, any>
  const entry = kind === 'runtime' ? doc.runtime?.plugins?.[id] : doc.channels?.[id]
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') return String(entry.plugin ?? entry.path ?? entry.package ?? '')
  return ''
}

export function PluginSettings({ plugins, draft, onChange }: PluginSettingsProps): JSX.Element {
  const [runtimeId, setRuntimeId] = useState('')
  const [runtimeEntry, setRuntimeEntry] = useState('')
  const [channelId, setChannelId] = useState('')
  const [channelEntry, setChannelEntry] = useState('')

  const runtimePlugins = (plugins ?? []).filter(plugin => plugin.kind === 'runtime')
  const channelPlugins = (plugins ?? []).filter(plugin => plugin.kind === 'channel')

  const addRuntime = (): void => {
    const id = runtimeId.trim()
    const entry = runtimeEntry.trim()
    if (!id || !entry) return
    onChange(`runtime.plugins.${id}`, entry)
    setRuntimeId('')
    setRuntimeEntry('')
  }
  const addChannel = (): void => {
    const id = channelId.trim()
    const entry = channelEntry.trim()
    if (!id || !entry) return
    onChange(`channels.${id}`, entry)
    setChannelId('')
    setChannelEntry('')
  }

  return (
    <div className="plugin-settings">
      <p className="editor-hint">
        插件按配置里的包名或路径加载；保存后需要重启服务。运行时插件导出 <code>kind: 'runtime'</code>，
        通道插件导出 <code>kind: 'channel'</code>，模板见仓库 <code>templates/runtime-plugin</code> 与
        <code>templates/channel-plugin</code>。
      </p>

      <div className="plugin-group">
        <div className="plugin-group-title">
          <span>运行时插件</span>
          <span className="runtime-group-count">{runtimePlugins.length}</span>
        </div>
        {runtimePlugins.length === 0 && <p className="editor-empty">还没有加载到运行时插件。</p>}
        {runtimePlugins.map(plugin => (
          <PluginRow
            key={`runtime-${plugin.id}`}
            plugin={plugin}
            entry={entryOf(draft, 'runtime', plugin.id)}
            onChange={value => onChange(`runtime.plugins.${plugin.id}`, value)}
            onClear={() => onChange(`runtime.plugins.${plugin.id}`, '')}
          />
        ))}
        <div className="plugin-add">
          <input className="input tiny" value={runtimeId} placeholder="id，例如 my-runtime" onChange={event => setRuntimeId(event.target.value)} />
          <input className="input" value={runtimeEntry} placeholder="包名或 ./path/to/runtime" onChange={event => setRuntimeEntry(event.target.value)} />
          <button className="btn tiny" onClick={addRuntime} disabled={!runtimeId.trim() || !runtimeEntry.trim()}>
            <Icon name="plus" size={12} />添加运行时
          </button>
        </div>
      </div>

      <div className="plugin-group">
        <div className="plugin-group-title">
          <span>通道插件</span>
          <span className="runtime-group-count">{channelPlugins.length}</span>
        </div>
        {channelPlugins.length === 0 && <p className="editor-empty">还没有加载到通道插件。</p>}
        {channelPlugins.map(plugin => (
          <PluginRow
            key={`channel-${plugin.id}`}
            plugin={plugin}
            entry={entryOf(draft, 'channel', plugin.id)}
            onChange={value => onChange(`channels.${plugin.id}`, value)}
            onClear={() => onChange(`channels.${plugin.id}`, '')}
          />
        ))}
        <div className="plugin-add">
          <input className="input tiny" value={channelId} placeholder="id，例如 slack" onChange={event => setChannelId(event.target.value)} />
          <input className="input" value={channelEntry} placeholder="包名或 ./path/to/channel" onChange={event => setChannelEntry(event.target.value)} />
          <button className="btn tiny" onClick={addChannel} disabled={!channelId.trim() || !channelEntry.trim()}>
            <Icon name="plus" size={12} />添加通道
          </button>
        </div>
      </div>
    </div>
  )
}

function PluginRow({ plugin, entry, onChange, onClear }: {
  plugin: PluginView
  entry: string
  onChange: (value: unknown) => void
  onClear: () => void
}): JSX.Element {
  const status = plugin.status === 'failed'
    ? { label: '加载失败', className: 'fail' }
    : plugin.status === 'loaded' || plugin.status === 'builtin'
      ? { label: '已加载', className: 'ok' }
      : { label: '待重启', className: 'warn' }
  return (
    <div className="plugin-row">
      <div className="plugin-row-head">
        <div>
          <strong>{plugin.name ?? plugin.label ?? plugin.id}</strong>
          <code>{plugin.id}</code>
        </div>
        <span className={`plugin-status ${status.className}`}>{status.label}</span>
      </div>
      {plugin.hint && <p className="plugin-hint">{plugin.hint}</p>}
      {plugin.error && <p className="plugin-error">{plugin.error}</p>}
      {plugin.specifier && <p className="plugin-package">尝试加载：<code>{plugin.specifier}</code></p>}
      <input
        className="input"
        value={entry}
        placeholder={plugin.status === 'builtin' ? '内置包；留空使用默认' : 'npm 包名或本地路径'}
        onChange={event => onChange(event.target.value)}
      />
      <div className="plugin-row-foot">
        {plugin.packageName && <p className="plugin-package">包：<code>{plugin.packageName}</code></p>}
        {entry && (
          <button className="btn ghost tiny" onClick={onClear} title="删除配置里的入口，恢复内置包">
            恢复默认
          </button>
        )}
      </div>
    </div>
  )
}
