/**
 * 允许名单与机器人身份的解析状态提示。
 *
 * 解析失败**不阻断保存**，所以这里只说明「这些人的消息收不到」，
 * 不能写成「保存失败」的口气。
 *
 * `scope` 决定显示哪一部分：名单解析（allowlist）与机器人身份（bot）分属
 * 配置页的不同位置，全放一处会重复刷屏。
 */
import { Icon } from './icons.js'
import { describeEntry, problemEntries, summarizeBot, summarizeIdentity, type IdentityStatusView } from './identity-status.js'

export function IdentityNotices({ identity, stale, scope = 'all' }: {
  identity?: IdentityStatusView
  stale?: boolean
  scope?: 'all' | 'allowlist' | 'bot'
}): JSX.Element | null {
  if (!identity) return null
  const summary = summarizeIdentity(identity)
  const bot = summarizeBot(identity)
  const problems = problemEntries(identity)
  const showAllowlist = scope === 'all' || scope === 'allowlist'
  const showBot = scope === 'all' || scope === 'bot'
  return (
    <>
      {showAllowlist && stale && (
        <div className="banner warn compact">
          <Icon name="alert" size={13} />
          <span>允许名单有未保存的修改，下面的解析状态还是上一次保存后的结果。</span>
        </div>
      )}
      {/* 正常状态不占一条横幅：只在确实有问题（解析失败 / 待重试）时提示。 */}
      {showAllowlist && summary.kind !== 'ok' && (
        <div className={`banner ${summary.kind === 'error' ? 'danger' : 'warn'} compact`}>
          <Icon name="alert" size={13} />
          <span>{summary.text}</span>
        </div>
      )}
      {showBot && bot.kind !== 'ok' && (
        <div className={`banner ${bot.kind === 'error' ? 'danger' : 'warn'} compact`}>
          <Icon name="alert" size={13} />
          <span>{bot.text}</span>
        </div>
      )}
      {showAllowlist && problems.length > 0 && (
        <ul className="identity-entries">
          {problems.map((entry, index) => (
            <li key={`${entry.entry}-${index}`}>{describeEntry(entry)}</li>
          ))}
        </ul>
      )}
      {showAllowlist && summary.kind === 'error' && (
        <p className="editor-hint identity-hint">
          名单条目没解析到就等于没有这个人：他们的消息收不到；如果某个群的名单配了却解析不到，该群会直接拒绝所有人（不会退回全局名单）。
        </p>
      )}
    </>
  )
}
