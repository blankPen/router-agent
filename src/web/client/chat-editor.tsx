/**
 * 群列表编辑器：监控哪些群、收全部消息还是只收 @、绑定到哪个项目。
 *
 * 渠道专属表单复用它（飞书渠道的「接收范围」），所以独立成模块。
 */
import { useState } from 'react'
import { Icon } from './icons.js'
import type { ChatDraft, ProjectDraft } from './config-shared.js'
import {
  DEFAULT_CHAT_MEMBERS,
  MAX_MEMBER_QUESTIONS,
  chatMembersIssue,
  normalizeChatMembers,
  type ChatMembersDraft,
} from './chat-members.js'

export function ChatsEditor({ chats, projects, error, onChange }: {
  chats: ChatDraft[]
  projects: ProjectDraft[]
  error?: string
  onChange: (value: ChatDraft[]) => void
}): JSX.Element {
  const [membersIndex, setMembersIndex] = useState<number | null>(null)
  const projectOf = (name: string): ProjectDraft | undefined => projects.find(project => project.name === name)
  const update = (index: number, patch: Partial<ChatDraft>): void => {
    onChange(chats.map((chat, i) => (i === index ? { ...chat, ...patch } : chat)))
  }
  const membersChat = membersIndex === null ? undefined : chats[membersIndex]
  return (
    <div className="editor">
      {chats.length === 0 && <p className="editor-empty">还没有监控群。至少添加一个群，机器人才能收到消息。</p>}
      {chats.length > 0 && (
        <div className="editor-head chat-head">
          <span>chat_id</span>
          <span>接收</span>
          <span>绑定项目</span>
          <span>本群名单（推荐邮箱）</span>
          <span>普通成员消息</span>
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
          <button
            className={`btn tiny ${chat.members?.enabled ? 'primary' : 'ghost'}`}
            title="配置是否处理普通成员的消息"
            onClick={() => setMembersIndex(index)}
          >
            {chat.members?.enabled ? '已开启' : '处理普通成员消息'}
          </button>
          <button className="icon-btn danger" title="删除群" onClick={() => onChange(chats.filter((_, i) => i !== index))}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      {error && <p className="field-error">{error}</p>}
      <button className="btn add" onClick={() => onChange([...chats, { chat: '', mode: 'all', repo: '', branch: '', allowed: [] }])}>
        <Icon name="plus" size={13} />添加群
      </button>
      {membersChat && (
        <MemberSettingsModal
          chat={membersChat}
          onClose={() => setMembersIndex(null)}
          onSave={value => {
            update(membersIndex as number, { members: value })
            setMembersIndex(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * 群级「处理普通成员消息」配置弹窗。
 *
 * 开关、轮数、终审管理员、是否读代码都跟着群走：多群互不影响，
 * 改完随群配置一起保存（保存后重启服务生效）。
 */
function MemberSettingsModal({ chat, onClose, onSave }: {
  chat: ChatDraft
  onClose: () => void
  onSave: (value: ChatMembersDraft) => void
}): JSX.Element {
  const current = chat.members ?? DEFAULT_CHAT_MEMBERS
  const [enabled, setEnabled] = useState(current.enabled)
  const [maxQuestions, setMaxQuestions] = useState(String(current.maxQuestions))
  const [approvers, setApprovers] = useState(current.approvers.join(', '))
  const [codeAccess, setCodeAccess] = useState(current.codeAccess)
  const rounds = Number(maxQuestions)
  const issue = chatMembersIssue({ ...current, maxQuestions: rounds })
  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="处理普通成员消息">
        <header className="modal-head">
          <div>
            <h3>处理普通成员消息</h3>
            <p>
              群 {chat.chat || '（未填写 chat_id）'}：打开后，非管理员的消息先由决策层判断要不要跟进；要跟进的会进入多轮澄清，整理成结构化需求单后必须经管理员终审才派单。关闭时本群只处理管理员的消息。
            </p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="modal-body">
          <button type="button" role="switch" aria-checked={enabled} className={`toggle ${enabled ? 'on' : ''}`} onClick={() => setEnabled(!enabled)}>
            <span className="toggle-track"><span className="toggle-knob" /></span>
            <span className="toggle-label">{enabled ? '已开启' : '已关闭'}</span>
          </button>
          <label className="modal-field">
            <span>最大对话轮次</span>
            <span className="input-box">
              <input
                type="number"
                min={0}
                max={MAX_MEMBER_QUESTIONS}
                value={maxQuestions}
                onChange={event => setMaxQuestions(event.target.value)}
              />
              <span className="input-unit">轮</span>
            </span>
            <small>最多追问几轮；默认 {DEFAULT_CHAT_MEMBERS.maxQuestions} 轮，到顶后按现有信息整理成需求单。</small>
          </label>
          <label className="modal-field">
            <span>终审管理员（推荐填邮箱，逗号分隔）</span>
            <input
              value={approvers}
              placeholder="admin@example.com, ou_xxx"
              onChange={event => setApprovers(event.target.value)}
            />
            <small>只有这些管理员能确认派单或驳回；留空则沿用全局允许名单。邮箱会在启动时解析成对应的人。</small>
          </label>
          <button type="button" role="switch" aria-checked={codeAccess} className={`toggle ${codeAccess ? 'on' : ''}`} onClick={() => setCodeAccess(!codeAccess)}>
            <span className="toggle-track"><span className="toggle-knob" /></span>
            <span className="toggle-label">{codeAccess ? '允许只读项目代码' : '不读项目代码'}</span>
          </button>
          <p className="modal-hint">
            <Icon name="alert" size={13} />
            关闭「允许只读项目代码」后，普通成员的分析只依据对话与通用业务知识，不会读取本群绑定项目的任何文件。
          </p>
          {issue && <p className="modal-error">{issue}</p>}
        </div>
        <footer className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={Boolean(issue)}
            onClick={() => onSave(normalizeChatMembers({
              enabled,
              maxQuestions: rounds,
              approvers: approvers.split(','),
              codeAccess,
            }))}
          >
            保存
          </button>
        </footer>
      </div>
    </div>
  )
}
