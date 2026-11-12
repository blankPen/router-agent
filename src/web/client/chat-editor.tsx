/**
 * 群列表编辑器：监控哪些群、收全部消息还是只收 @、绑定到哪个项目。
 *
 * 渠道专属表单复用它（飞书渠道的「接收范围」），所以独立成模块。
 */
import { Icon } from './icons.js'
import type { ChatDraft, ProjectDraft } from './config-shared.js'

export function ChatsEditor({ chats, projects, error, onChange }: {
  chats: ChatDraft[]
  projects: ProjectDraft[]
  error?: string
  onChange: (value: ChatDraft[]) => void
}): JSX.Element {
  const projectOf = (name: string): ProjectDraft | undefined => projects.find(project => project.name === name)
  const update = (index: number, patch: Partial<ChatDraft>): void => {
    onChange(chats.map((chat, i) => (i === index ? { ...chat, ...patch } : chat)))
  }
  return (
    <div className="editor">
      {chats.length === 0 && <p className="editor-empty">还没有监控群。至少添加一个群，机器人才能收到消息。</p>}
      {chats.length > 0 && (
        <div className="editor-head chat-head">
          <span>chat_id</span>
          <span>接收</span>
          <span>绑定项目</span>
          <span>本群名单（推荐邮箱）</span>
          <span />
        </div>
      )}
      {chats.map((chat, index) => (
        <div key={index} className="editor-row chat-row">
          <input value={chat.chat} placeholder="oc_xxx" onChange={event => update(index, { chat: event.target.value })} />
          <span className="select-wrap compact">
            <select value={chat.mode} onChange={event => update(index, { mode: event.target.value })}>
              <option value="all">全部消息</option>
              <option value="mention">仅 @</option>
            </select>
            <Icon name="chevron" size={12} className="select-chevron" />
          </span>
          <span className="select-wrap compact">
            <select
              value={chat.repo}
              onChange={event => {
                const name = event.target.value
                update(index, { repo: name, branch: projectOf(name)?.defaultBranch ?? '' })
              }}
            >
              <option value="">不绑定（开工前追问）</option>
              {projects.map(project => <option key={project.name} value={project.name}>{project.name}</option>)}
              {chat.repo && !projectOf(chat.repo) && <option value={chat.repo}>{chat.repo}（不在当前清单）</option>}
            </select>
            <Icon name="chevron" size={12} className="select-chevron" />
          </span>
          <input
            value={chat.allowed.join(', ')}
            placeholder="可空，沿用全局；推荐填邮箱"
            onChange={event => update(index, { allowed: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })}
          />
          <button className="icon-btn danger" title="删除群" onClick={() => onChange(chats.filter((_, i) => i !== index))}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      {error && <p className="field-error">{error}</p>}
      <button className="btn add" onClick={() => onChange([...chats, { chat: '', mode: 'all', repo: '', branch: '', allowed: [] }])}>
        <Icon name="plus" size={13} />添加群
      </button>
    </div>
  )
}
