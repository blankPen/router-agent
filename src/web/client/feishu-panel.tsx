import { useEffect, useState } from 'react'
import { getJson, sendJson, type ConfigDoc } from './api.js'
import { Icon } from './icons.js'

export interface FeishuBotStatus {
  profileHome: string
  configAppId: string
  appId: string
  bot: { available: boolean; status: string; message: string }
  user: { available: boolean; status: string; message: string; openId: string; userName: string }
}

interface Notice {
  kind: 'ok' | 'warn' | 'error'
  text: string
}

interface DeviceLogin {
  deviceCode: string
  verificationUrl: string
  userCode: string
}

/**
 * 飞书机器人凭据与授权面板。
 *
 * 初始化页和配置页共用：App ID 由父级的普通配置字段维护，这里只负责
 * App Secret 写入 lark-cli 加密存储，以及检查/引导用户完成飞书授权。
 */
export function FeishuBotPanel({ appId, onConfigSaved, onStatus }: {
  appId: string
  onConfigSaved?: (config: ConfigDoc) => void
  onStatus?: (ready: boolean) => void
}): JSX.Element {
  const [status, setStatus] = useState<FeishuBotStatus | null>(null)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState<'status' | 'secret' | 'login' | 'complete' | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [login, setLogin] = useState<DeviceLogin | null>(null)

  const refresh = async (): Promise<FeishuBotStatus | null> => {
    setBusy('status')
    try {
      const next = await getJson<FeishuBotStatus>('/api/feishu/status')
      setStatus(next)
      onStatus?.(Boolean(next.bot.available))
      return next
    } catch (error) {
      setNotice({ kind: 'error', text: `读取授权状态失败：${errorText(error)}` })
      return null
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    void refresh()
    // 只在挂载时拉一次状态；后续由按钮触发刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveSecret = async (): Promise<void> => {
    if (!appId.trim()) {
      setNotice({ kind: 'error', text: '请先在上方填写 App ID' })
      return
    }
    if (!secret.trim()) {
      setNotice({ kind: 'error', text: '请填写 App Secret' })
      return
    }
    setBusy('secret')
    setNotice(null)
    try {
      const result = await sendJson<{ ok: boolean; message?: string; config: ConfigDoc }>(
        '/api/feishu/credentials',
        'POST',
        { appId: appId.trim(), appSecret: secret },
      )
      setSecret('')
      setNotice({ kind: 'ok', text: `${result.message ?? 'App Secret 已写入 lark-cli'}；重启服务后生效。` })
      if (result.config) onConfigSaved?.(result.config)
      await refresh()
    } catch (error) {
      setNotice({ kind: 'error', text: `写入 App Secret 失败：${errorText(error)}` })
    } finally {
      setBusy(null)
    }
  }

  const startLogin = async (): Promise<void> => {
    setBusy('login')
    setNotice(null)
    try {
      const result = await sendJson<DeviceLogin>('/api/feishu/auth/login', 'POST', {})
      setLogin(result)
      setNotice({ kind: 'warn', text: '已生成授权链接：请在浏览器完成授权，然后点「我已完成授权」。' })
    } catch (error) {
      setNotice({ kind: 'error', text: `发起授权失败：${errorText(error)}` })
    } finally {
      setBusy(null)
    }
  }

  const completeLogin = async (): Promise<void> => {
    if (!login?.deviceCode) return
    setBusy('complete')
    setNotice({ kind: 'warn', text: '等待飞书确认授权…' })
    try {
      await sendJson<{ ok: boolean }>('/api/feishu/auth/complete', 'POST', { deviceCode: login.deviceCode })
      setLogin(null)
      const next = await refresh()
      setNotice({
        kind: next?.user.available ? 'ok' : 'warn',
        text: next?.user.available ? '飞书用户授权完成。' : '授权流程已结束，但用户身份仍不可用，可重新发起授权。',
      })
    } catch (error) {
      setNotice({ kind: 'error', text: `完成授权失败：${errorText(error)}` })
    } finally {
      setBusy(null)
    }
  }

  const botReady = Boolean(status?.bot.available)
  const userReady = Boolean(status?.user.available)
  const appMismatch = Boolean(appId.trim() && status?.appId && appId.trim() !== status.appId)

  return (
    <div>
      <div className="settings-rows">
        <div className="setting">
          <div className="setting-info">
            <div className="setting-label"><span>App Secret</span></div>
            <div className="setting-hint">
              <span>只写入 lark-cli 加密存储，不落 config.yaml；留空表示保持已配置的密钥。</span>
            </div>
          </div>
          <div className="setting-control" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <input
              className="text-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              placeholder="App Secret"
              onChange={event => setSecret(event.target.value)}
            />
            <button
              className="btn tiny"
              style={{ alignSelf: 'flex-end' }}
              disabled={busy !== null || !secret.trim() || !appId.trim()}
              onClick={() => void saveSecret()}
            >
              {busy === 'secret' ? '写入中…' : '写入 App Secret'}
            </button>
          </div>
        </div>

        <div className="setting">
          <div className="setting-info">
            <div className="setting-label"><span>机器人状态</span></div>
            <div className="setting-hint">
              <span className="status-line">
                <span className={`status-dot ${status ? (botReady ? 'ok' : 'bad') : ''}`} />
                <span className="status-value">{status ? (botReady ? '机器人可用' : '机器人不可用') : '检查中…'}</span>
              </span>
              <span>当前 appId：{status?.appId || '(未配置)'}</span>
              {!botReady && status?.bot.message && <span>{status.bot.message}</span>}
            </div>
          </div>
          <div className="setting-control" style={{ gap: 8 }}>
            <button className="btn tiny" disabled={busy !== null} onClick={() => void refresh()}>
              <Icon name="refresh" size={12} className={busy === 'status' ? 'spin' : undefined} />
              {busy === 'status' ? '刷新中…' : '刷新'}
            </button>
          </div>
        </div>

        <div className="setting">
          <div className="setting-info">
            <div className="setting-label"><span>授权状态</span></div>
            <div className="setting-hint">
              <span className="status-line">
                <span className={`status-dot ${status ? (userReady ? 'ok' : 'bad') : ''}`} />
                <span className="status-value">{status ? (userReady ? '已授权' : '未授权 / 授权异常') : '检查中…'}</span>
              </span>
              <span>{userReady
                ? `${status?.user.userName || status?.user.openId || '已授权'}${status?.user.status ? `（${status.user.status}）` : ''}`
                : (status?.user.message || '完成授权后可按名字搜索群 / 成员、创建文档等。')}</span>
            </div>
          </div>
          <div className="setting-control" style={{ gap: 8 }}>
            <button className="btn tiny" disabled={busy !== null} onClick={() => void startLogin()}>
              {busy === 'login' ? '生成中…' : '重新授权'}
            </button>
            {login && (
              <button className="btn tiny" disabled={busy !== null} onClick={() => void completeLogin()}>
                {busy === 'complete' ? '等待确认…' : '我已完成授权'}
              </button>
            )}
          </div>
        </div>
      </div>
      <div style={{ padding: "0 24px" }}>
        {login && (
          <div className="banner warn compact" style={{ marginTop: 0 }}>
            <span>
              授权链接：
              <a href={login.verificationUrl} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>{login.verificationUrl}</a>
              {login.userCode ? `（验证码 ${login.userCode}）` : ''}
            </span>
          </div>
        )}
        {appMismatch && (
          <div className="banner warn compact">
            <span>配置里的 App ID 与 lark-cli 当前 profile 不一致；写入 App Secret 后会同步到新应用。</span>
          </div>
        )}
        {notice && (
          <div className={`banner ${notice.kind === 'error' ? 'danger' : notice.kind === 'warn' ? 'warn' : ''} compact`}>
            <span>{notice.text}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}