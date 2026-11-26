/**
 * 事件源目录卡：只读展示「有什么可订阅」。
 *
 * 这一页**不再管订阅**：没有「勾选事件类型」的多选框（那正是要删掉的旧弹窗）。
 * 每条事件类型只显示两件事：自己是什么、有没有被任务订阅。
 */
import { Icon } from './icons.js'
import {
  availabilityTag,
  catalogRows,
  catalogStats,
  type CatalogView,
} from './event-catalog-model.js'

/** 目录卡。 */
export function EventCatalogCard({ catalog, subscribers, onShowSubscribers }: {
  catalog: CatalogView
  /** 事件类型 id → 订阅它的任务名。 */
  subscribers: Map<string, string[]>
  /** 点「查看订阅它的任务」时回调。 */
  onShowSubscribers?: (typeId: string, names: string[]) => void
}): JSX.Element {
  const stats = catalogStats(catalog)
  const groups = catalogRows(catalog, subscribers)
  const needsConsole = stats.needsConsole

  return (
    <article className="source-card on catalog-card">
      <div className="source-card-top">
        <span className="source-logo"><SourceLogoFor kind={catalog.kind} /></span>
        <div className="source-card-title">
          <strong>{catalog.name}</strong>
          <span>
            {stats.total} 种可订阅事件类型
            {stats.ready > 0 && ` · ${stats.ready} 种开箱可用`}
            {needsConsole > 0 && ` · ${needsConsole} 种需后台订阅`}
          </span>
        </div>
      </div>

      {catalog.params.length > 0 && (
        <p className="source-card-status">
          连接参数：{catalog.params.map(param => param.label).join('、')}
        </p>
      )}

      <div className="catalog-list">
        {groups.map(group => (
          <div key={group.name || '_'}>
            {group.name && <div className="catalog-group">{group.name}</div>}
            {group.rows.map(row => {
              const tag = availabilityTag(row.type)
              return (
                <div key={row.type.id} className="catalog-item">
                  <span className="mono">{row.type.id}</span>
                  <span className="catalog-label">{row.type.label}</span>
                  {tag && <span className={`tag ${tag.tone}`}>{tag.text}</span>}
                  {row.subscribers > 0 ? (
                    <button
                      className="count link"
                      title={row.subscriberNames.join('、')}
                      onClick={() => onShowSubscribers?.(row.type.id, row.subscriberNames)}
                    >
                      被 {row.subscribers} 个任务订阅
                    </button>
                  ) : (
                    <span className="count">尚未订阅</span>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {needsConsole > 0 && (
        <p className="modal-hint">
          <Icon name="alert" size={12} />
          标了「需后台订阅」的类型要先在飞书开放平台勾选事件类型，建了任务才会有事件。
        </p>
      )}
    </article>
  )
}

/** 来源图标：内置两种走专用 logo，其它用通用图标。 */
function SourceLogoFor({ kind }: { kind: string }): JSX.Element {
  if (kind === 'github') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 19c-4 1.5-4-2-5-2m10 4v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.6 1.3a12.3 12.3 0 0 0-6.4 0C4.8 2.5 3.7 2.8 3.7 2.8A4.2 4.2 0 0 0 3.6 6a4.6 4.6 0 0 0-1.3 3.2c0 4.6 2.7 5.7 5.5 6-.5.5-.6 1-.6 2V21" />
      </svg>
    )
  }
  if (kind === 'feishu') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 12a4 4 0 1 1-4-4 4 4 0 0 1 4 4Zm6 0a4 4 0 1 1-4-4 4 4 0 0 1 4 4Zm-3 8a4 4 0 1 1-4-4 4 4 0 0 1 4 4Z" />
      </svg>
    )
  }
  return <Icon name="radio" size={16} />
}
