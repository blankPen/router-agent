/**
 * 插件配置区：内置 runtime / channel 状态 + 自定义插件入口。
 *
 * 这里只写配置点路径；真正的加载发生在服务重启时，所以保存后统一提示重启。
 * npm 包入口可以先保存再点「安装依赖」，服务端会把它下载到 `<RA_HOME>/node_modules`。
 */
import { useState } from 'react'
import { getJson, sendJson, type PluginView } from './api.js'
import { Icon } from './icons.js'
import type { RuntimeNotice } from './runtime-cards.js'

export interface PluginSettingsProps {
  plugins?: PluginView[]
  draft: unknown
  onChange: (path: string, value: unknown) => void
  onNotice?: (notice: RuntimeNotice | null) => void
  /** 安装依赖改变了磁盘上的插件包，父级据此显示持久的「需重启」提示。 */
  onPendingRestart?: () => void
}

interface PluginInstallJobView {
  id: string
  status: 'running' | 'ok' | 'failed'
  phase: string
  packageName: string
  version: string
  installedVersion?: string
  lines?: string[]
  error?: string
  startedAt: string
  finishedAt?: string
}

interface InstallState {
  busy: boolean
  job?: PluginInstallJobView
}

/** 与 packages/infra/plugin-install.ts 的 npmPackageNameOf 保持一致；面板据此决定是否显示安装按钮。 */
const NPM_PACKAGE_PATTERN = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

function npmPackageOf(value: string): string | undefined {
  const text = value.trim()
  if (!text || text.startsWith('.') || text.startsWith('/') || text.startsWith('file:')) return undefined
  if (text.includes('\\') || /\s/.test(text)) return undefined
  return NPM_PACKAGE_PATTERN.test(text) ? text : undefined
}

/** 插件入口可能是字符串或 `{ plugin | path | package }`，统一取成可显示的一行。 */
function entryText(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim()
  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>
    for (const key of ['plugin', 'path', 'package']) {
      if (typeof record[key] === 'string' && (record[key] as string).trim()) return (record[key] as string).trim()
    }
  }
  return ''
}

function entryOf(draft: unknown, kind: 'runtime' | 'channel', id: string): string {
  if (!draft || typeof draft !== 'object') return ''
  const doc = draft as Record<string, any>
  const entry = kind === 'runtime' ? doc.runtime?.plugins?.[id] : doc.channels?.[id]
  return entryText(entry)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => window.setTimeout(resolvePromise, ms))
}

export function PluginSettings({ plugins, draft, onChange, onNotice, onPendingRestart }: PluginSettingsProps): JSX.Element {
  const [runtimeId, setRuntimeId] = useState('')
  const [runtimeEntry, setRuntimeEntry] = useState('')
  const [channelId, setChannelId] = useState('')
  const [channelEntry, setChannelEntry] = useState('')
  const [installs, setInstalls] = useState<Record<string, InstallState>>({})

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

  const setInstall = (key: string, state: InstallState | null): void => {
    setInstalls(current => {
      const next = { ...current }
      if (state) next[key] = state
      else delete next[key]
      return next
    })
  }

  const pollJob = async (plugin: PluginView, jobId: string): Promise<void> => {
    const key = `${plugin.kind}:${plugin.id}`
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await sleep(1_000)
      try {
        const job = await getJson<PluginInstallJobView>(`/api/plugins/install/${jobId}`)
        setInstall(key, { busy: job.status === 'running', job })
        if (job.status === 'running') continue
        if (job.status === 'ok') {
          onNotice?.({
            kind: 'ok',
            text: `${plugin.name ?? plugin.id} 依赖安装完成（${job.installedVersion ?? job.packageName}），重启服务后生效`,
          })
          onPendingRestart?.()
        } else {
          onNotice?.({ kind: 'error', text: `${plugin.id} 依赖安装失败：${job.error ?? '未知错误'}` })
        }
        return
      } catch (error) {
        if (attempt >= 299) {
          setInstall(key, null)
          onNotice?.({ kind: 'error', text: `读取安装状态失败：${errorText(error)}` })
          return
        }
        const text = errorText(error)
        if (text.includes('job-not-found')) {
          setInstall(key, null)
          onNotice?.({ kind: 'warn', text: '安装任务状态已丢失（服务可能重启过），请重启后到日志里确认结果' })
          return
        }
        // 单次网络抖动继续重试，只有最后一轮才报错。
      }
    }
  }

  const install = async (plugin: PluginView, serverEntry: string): Promise<void> => {
    const packageName = npmPackageOf(serverEntry)
    if (!packageName) return
    if (!window.confirm(`安装 ${packageName} 到 <RA_HOME>/node_modules？需要联网下载 npm 包。`)) return
    const key = `${plugin.kind}:${plugin.id}`
    setInstall(key, { busy: true })
    try {
      const data = await sendJson<{ jobId: string }>('/api/plugins/install', 'POST', { kind: plugin.kind, id: plugin.id })
      setInstall(key, { busy: true, job: { id: data.jobId, status: 'running', phase: 'queued', packageName, version: 'latest', startedAt: new Date().toISOString() } })
      void pollJob(plugin, data.jobId)
    } catch (error) {
      setInstall(key, null)
      onNotice?.({ kind: 'error', text: `启动安装失败：${errorText(error)}` })
    }
  }

  return (
    <div className="plugin-settings">
      <p className="editor-hint">
        插件按配置里的包名或路径加载；npm 包点「安装依赖」下载到 <code>&lt;RA_HOME&gt;/node_modules</code>，
        保存后需要重启服务。运行时插件导出 <code>kind: 'runtime'</code>，
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
            serverEntry={entryText(plugin.entry)}
            installState={installs[`runtime:${plugin.id}`]}
            onChange={value => onChange(`runtime.plugins.${plugin.id}`, value)}
            onClear={() => onChange(`runtime.plugins.${plugin.id}`, '')}
            onInstall={serverEntry => void install(plugin, serverEntry)}
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
            serverEntry={entryText(plugin.entry)}
            installState={installs[`channel:${plugin.id}`]}
            onChange={value => onChange(`channels.${plugin.id}`, value)}
            onClear={() => onChange(`channels.${plugin.id}`, '')}
            onInstall={serverEntry => void install(plugin, serverEntry)}
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

function PluginRow({ plugin, entry, serverEntry, installState, onChange, onClear, onInstall }: {
  plugin: PluginView
  /** 面板里正在编辑的入口（可能还没保存）。 */
  entry: string
  /** 服务端已生效的入口；安装任务按它解析包名。 */
  serverEntry: string
  installState?: InstallState
  onChange: (value: unknown) => void
  onClear: () => void
  onInstall: (serverEntry: string) => void
}): JSX.Element {
  const status = plugin.status === 'failed'
    ? { label: '加载失败', className: 'fail' }
    : plugin.status === 'loaded' || plugin.status === 'builtin'
      ? { label: '已加载', className: 'ok' }
      : { label: '待重启', className: 'warn' }
  const packageName = npmPackageOf(serverEntry)
  const dirty = entry.trim() !== serverEntry.trim()
  const busy = installState?.busy === true
  const job = installState?.job
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
        <div className="plugin-actions">
          {packageName && (
            <button
              className="btn ghost tiny"
              onClick={() => onInstall(serverEntry)}
              disabled={busy || dirty}
              title={dirty ? '先保存配置，服务端才知道要安装哪个包' : `安装 ${packageName} 到 <RA_HOME>/node_modules`}
            >
              <Icon name="download" size={12} />{busy ? '安装中…' : plugin.status === 'loaded' ? '重新安装' : '安装依赖'}
            </button>
          )}
          {entry && (
            <button className="btn ghost tiny" onClick={onClear} title="删除配置里的入口，恢复内置包">
              恢复默认
            </button>
          )}
        </div>
      </div>
      {packageName && dirty && <p className="plugin-install-hint">入口改过还没保存；保存配置后才能安装依赖。</p>}
      {job && (
        <pre className="plugin-install-log">
          {(job.lines ?? []).slice(-8).join('\n') || (job.status === 'running' ? '正在启动 npm install…' : '')}
          {job.error ? `${job.lines?.length ? '\n' : ''}${job.error}` : ''}
        </pre>
      )}
    </div>
  )
}
