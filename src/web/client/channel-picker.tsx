/**
 * 渠道选择器：配置页与初始化页共用。
 *
 * 只负责「列出渠道 + 显示接入状态」，选中后各页面自己渲染渠道的配置表单。
 */
import type { ConfigDoc } from './api.js'
import type { ChannelDescriptor } from './channels.js'
import type { IdentityStatusView } from './identity-status.js'
import { Icon } from './icons.js'

export function ChannelPicker({ channels, activeId, onSelect, draft, identity, label = '消息渠道' }: {
  channels: ChannelDescriptor[]
  /** 当前选中的渠道 id。 */
  activeId?: string
  onSelect: (id: string) => void
  draft: ConfigDoc
  identity?: IdentityStatusView
  label?: string
}): JSX.Element {
  return (
    <div className="channel-picker">
      <span className="channel-picker-label">{label}</span>
      <div className="channel-picker-list">
        {channels.map(channel => {
          const status = channel.status(draft, identity)
          const selected = channel.id === activeId
          return (
            <button
              key={channel.id}
              type="button"
              className={`channel-card ${selected ? 'active' : ''}`}
              aria-pressed={selected}
              onClick={() => onSelect(channel.id)}
            >
              <span className="channel-icon"><Icon name={channel.icon} size={16} /></span>
              <span className="channel-card-text">
                <strong>{channel.label}</strong>
                <small>{channel.summary}</small>
              </span>
              <span className={`channel-status ${status.tone}`}>{status.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
