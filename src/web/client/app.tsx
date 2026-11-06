import { useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'

interface Ticket {
  id: string
  title: string
  stage: string
  /** 派工目标仓库与起始分支。 */
  repo: string
  branch: string
  threadId: string
  chatId: string
  prUrl: string
  prNumber: number
  prState: string
  createdAt: string
}

interface TicketDetail {
  ticket: Ticket
  mandate: { strength: string; scope: string; rules: string[]; policyVersion: string } | null
  assignment: { id: string; handle: string; workdir: string; status: string } | null
  reports: {
    state: string
    turn: number
    summary: string
    at: string
    reply?: string
  }[]
  inputs: { seq: number; status: string; text: string }[]
  attention: { question: string } | null
}

const STAGES = ['person', 'assigned', 'running', 'review', 'idle', 'accepted', 'closed']

const STAGE_LABEL: Record<string, string> = {
  draft: '草稿',
  accepted: '已接单',
  assigned: '已派工',
  running: '执行中',
  review: '待评审',
  person: '等人',
  idle: '空闲',
  closed: '已关闭',
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  return (await res.json()) as T
}

function App(): JSX.Element {
  const [tab, setTab] = useState<'tickets' | 'policy' | 'sources'>('tickets')
  return (
    <div className="app">
      <header>
        <h1>router-agent</h1>
        <nav>
          <button className={tab === 'tickets' ? 'active' : ''} onClick={() => setTab('tickets')}>工单</button>
          <button className={tab === 'policy' ? 'active' : ''} onClick={() => setTab('policy')}>策略</button>
          <button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}>来源</button>
        </nav>
      </header>
      <main>
        {tab === 'tickets' && <TicketsView />}
        {tab === 'policy' && <PolicyView />}
        {tab === 'sources' && <SourcesView />}
      </main>
    </div>
  )
}

function TicketsView(): JSX.Element {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<TicketDetail | null>(null)

  const load = (): void => {
    void getJson<{ tickets: Ticket[] }>('/api/tickets').then(data => setTickets(data.tickets))
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    void getJson<TicketDetail>(`/api/tickets/${selected}`).then(setDetail)
  }, [selected])

  const grouped = STAGES.map(stage => ({ stage, items: tickets.filter(t => t.stage === stage) })).filter(g => g.items.length > 0)

  return (
    <div className="split">
      <section className="list">
        {grouped.length === 0 && <p className="muted">暂无工单</p>}
        {grouped.map(group => (
          <div key={group.stage}>
            <h2>{STAGE_LABEL[group.stage] ?? group.stage} <span className="count">{group.items.length}</span></h2>
            {group.items.map(ticket => (
              <button key={ticket.id} className={`row ${selected === ticket.id ? 'selected' : ''}`} onClick={() => setSelected(ticket.id)}>
                <span className="title">{ticket.title}</span>
                <span className="meta">{ticket.prUrl ? `PR ${ticket.prNumber}` : ticket.id}</span>
              </button>
            ))}
          </div>
        ))}
      </section>
      <section className="detail">
        {!detail && <p className="muted">选择左侧工单查看详情</p>}
        {detail && <TicketDetailView detail={detail} onChange={() => setSelected(detail.ticket.id)} />}
      </section>
    </div>
  )
}

function TicketDetailView({ detail, onChange }: { detail: TicketDetail; onChange: () => void }): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const { ticket } = detail

  const sendInput = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    await fetch(`/api/tickets/${ticket.id}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'followup', text }),
    })
    setText('')
    setBusy(false)
    onChange()
  }

  const stop = async (): Promise<void> => {
    if (!confirm('确认停止这张工单？')) return
    await fetch(`/api/tickets/${ticket.id}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '面板停止' }),
    })
    onChange()
  }

  return (
    <div>
      <h2>{ticket.title}</h2>
      <dl>
        <dt>阶段</dt><dd>{STAGE_LABEL[ticket.stage] ?? ticket.stage}</dd>
        <dt>工单</dt><dd>{ticket.id}</dd>
        <dt>派工</dt><dd>{ticket.repo || '—'} @ {ticket.branch || '—'}</dd>
        <dt>会话</dt><dd>{ticket.threadId}</dd>
        <dt>PR</dt><dd>{ticket.prUrl ? <a href={ticket.prUrl}>{ticket.prUrl}</a> : '—'}</dd>
        {detail.mandate && (<><dt>授权范围</dt><dd>{detail.mandate.scope}</dd></>)}
        {detail.mandate && (<><dt>强度</dt><dd>{detail.mandate.strength}</dd></>)}
        {detail.assignment && (<><dt>终端</dt><dd>{detail.assignment.handle || '—'} / {detail.assignment.status}</dd></>)}
      </dl>
      {detail.attention && <p className="alert">待人工：{detail.attention.question}</p>}

      <h3>最近上报</h3>
      {detail.reports.length === 0 ? <p className="muted">暂无</p> : (
        <ul className="reports">
          {detail.reports.map((r, i) => (
            <li key={i}>
              <b>[{r.state}]</b> {r.summary}
              {r.reply && (
                <div className="reply">
                  <details>
                    <summary>查看完整回复（{r.reply.length} 字）</summary>
                    <pre>{r.reply}</pre>
                  </details>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>输入</h3>
      {detail.inputs.length === 0 ? <p className="muted">暂无</p> : (
        <ul>{detail.inputs.map(i => <li key={i.seq}>#{i.seq} {i.status} {i.text}</li>)}</ul>
      )}

      {ticket.stage !== 'closed' && (
        <>
          <form onSubmit={sendInput} className="inline">
            <input value={text} onChange={e => setText(e.target.value)} placeholder="给 worker 投递 follow-up" />
            <button type="submit" disabled={busy}>投递</button>
          </form>
          <button className="danger" onClick={stop}>停止工单</button>
        </>
      )}
    </div>
  )
}

function PolicyView(): JSX.Element {
  const [config, setConfig] = useState<{ acceptMode: string; maxWorkers: number } | null>(null)
  const [version, setVersion] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void getJson<{ policy: { version: string }; config: { acceptMode: string; maxWorkers: number } }>('/api/policy').then(data => {
      setConfig(data.config)
      setVersion(data.policy.version)
    })
  }, [])

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!config) return
    const res = await fetch('/api/policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    const data = await res.json() as { policy: { version: string } }
    setVersion(data.policy.version)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (!config) return <p className="muted">加载中…</p>
  return (
    <form onSubmit={save} className="panel">
      <h2>策略</h2>
      <label>
        accept mode
        <select value={config.acceptMode} onChange={e => setConfig({ ...config, acceptMode: e.target.value })}>
          <option value="off">off — 不自动接单</option>
          <option value="observe">observe — 只记录不开工</option>
          <option value="auto">auto — 研判通过直接开单</option>
        </select>
      </label>
      <label>
        并发上限
        <input type="number" min={1} value={config.maxWorkers} onChange={e => setConfig({ ...config, maxWorkers: Number(e.target.value) })} />
      </label>
      <p className="muted">策略版本：{version}</p>
      <button type="submit">保存</button>
      {saved && <span className="ok">已保存</span>}
    </form>
  )
}

function SourcesView(): JSX.Element {
  const [data, setData] = useState<{
    chats: { chat: string; mode: string; repo: string; branch: string; allowed?: string[] }[]
    directMessages: boolean
    allowed: string[]
  } | null>(null)
  const [status, setStatus] = useState<{ backend: string; tickets: { open: number }; stage: string } | null>(null)

  useEffect(() => {
    void getJson<typeof data>('/api/sources/feishu/chats').then(setData)
    void getJson<typeof status>('/api/status').then(setStatus)
  }, [])

  return (
    <div className="panel">
      <h2>来源</h2>
      <h3>飞书</h3>
      <dl>
        <dt>监控群</dt>
        <dd>
          {data?.chats.map(chat => `${chat.chat}（${chat.mode === 'mention' ? '仅@' : '全部消息'}${chat.repo ? ` → ${chat.repo}@${chat.branch || '?'}` : ''}${chat.allowed && chat.allowed.length > 0 ? ` · 限${chat.allowed.length}人` : ''}）`).join('，') || '—'}
        </dd>
        <dt>私聊</dt><dd>{data?.directMessages ? '接收' : '关闭'}</dd>
        <dt>许可名单</dt><dd>{data?.allowed.join(', ') || '—'}</dd>
      </dl>
      <h3>运行时</h3>
      <dl>
        <dt>服务</dt><dd>{status?.stage ?? '—'}</dd>
        <dt>Worker 后端</dt><dd>{status?.backend ?? '—'}</dd>
        <dt>开放工单</dt><dd>{status?.tickets.open ?? 0}</dd>
      </dl>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
