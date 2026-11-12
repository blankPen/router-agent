import { mkdirSync } from 'node:fs'
import type { CommandRunner } from '#infra/process.js'
import {
  LARK_PROFILE_HOME,
  parseAuthStatus,
  parseDeviceLogin,
  type LarkAuthStatus,
} from './lark.js'

export interface FeishuBotAdminOptions {
  lark: CommandRunner
  /** 仅用于展示与确保目录存在；运行命令的 HOME 由 runner 自己绑定。 */
  profileHome?: string
}

/**
 * router-agent 实际用到的飞书业务域。
 *
 * 不要用默认的「全部域」授权：router-agent 只需要 IM（消息/群/成员）、
 * 云文档、云空间与通讯录，避免用户被要求授予日历、邮箱、审批等无关权限。
 */
export const FEISHU_AUTH_DOMAINS = ['im', 'docs', 'drive', 'contact'] as const

/**
 * 业务域之外必须显式申请的 scope。
 *
 * lark-cli 的 `contact` 域只映射到 `contact:user.basic_profile:readonly` 与
 * `contact:user:search`，**不含** `contact:user.id:readonly`。而 router-agent 要用
 * `contact/v3/users/batch_get_id` 把允许名单里的邮箱解析成 open_id，这个接口要的正是
 * `contact:user.id:readonly`：域映射不覆盖它 → 用户授权成功、token 里却没有这个权限，
 * 表现成「用户已经授权好飞书，但没有该权限」。
 *
 * lark-cli 的 `--scope` 与 `--domain` 是叠加关系，所以在这里补一个显式 scope：
 * 用户在授权页会看到这一项，授权后应用侧也一并开通。
 */
export const FEISHU_AUTH_SCOPES = ['contact:user.id:readonly'] as const

/** 授权参数：业务域 + 显式 scope（lark-cli 两者叠加）。 */
export function feishuAuthScopeArgs(): string[] {
  return ['--domain', FEISHU_AUTH_DOMAINS.join(','), '--scope', FEISHU_AUTH_SCOPES.join(',')]
}

export interface FeishuBotActionResult {
  ok: boolean
  message: string
}

export interface FeishuDeviceLogin {
  deviceCode: string
  verificationUrl: string
  userCode: string
}

/**
 * 飞书机器人凭据与授权管理。
 *
 * 所有命令都通过已绑定固定 profile 的 lark-cli runner 执行：
 * - App Secret 只走 stdin，不写 config.yaml，也不进 argv / 日志；
 * - 授权走 Device Flow，先拿 verification_url，再由用户确认后完成轮询。
 */
export class FeishuBotAdmin {
  private readonly lark: CommandRunner
  readonly profileHome: string

  constructor(opts: FeishuBotAdminOptions) {
    this.lark = opts.lark
    this.profileHome = opts.profileHome ?? LARK_PROFILE_HOME
  }

  /** 把 App ID / App Secret 写入 lark-cli 的加密存储并校验。 */
  async configure(appId: string, appSecret: string): Promise<FeishuBotActionResult> {
    const id = appId.trim()
    const secret = appSecret.trim()
    if (!id) return { ok: false, message: 'App ID 不能为空' }
    if (!secret) return { ok: false, message: 'App Secret 不能为空' }

    try {
      mkdirSync(this.profileHome, { recursive: true })
    } catch (error) {
      return { ok: false, message: `无法创建 lark-cli profile 目录：${errorMessage(error)}` }
    }

    const res = await this.lark.run(
      ['config', 'init', '--app-id', id, '--app-secret-stdin'],
      { input: `${secret}\n`, timeoutMs: 30_000 },
    )
    const detail = redact(`${res.stdout}\n${res.stderr}`, secret)
    if (res.code !== 0) {
      return { ok: false, message: detail || `lark-cli 退出码 ${res.code}` }
    }
    if (!/configuration saved|配置已保存/i.test(res.stdout)) {
      return { ok: false, message: detail || 'lark-cli 未确认配置已保存' }
    }
    return { ok: true, message: 'App Secret 已写入 lark-cli 加密存储' }
  }

  /** 读取机器人身份与用户授权状态。 */
  async status(): Promise<LarkAuthStatus> {
    try {
      const res = await this.lark.run(['auth', 'status', '--json'])
      if (res.code !== 0) return this.emptyStatus(redact(`${res.stdout}\n${res.stderr}`))
      return parseAuthStatus(res.stdout)
    } catch (error) {
      return this.emptyStatus(errorMessage(error))
    }
  }

  /** 发起 Device Flow 授权，返回验证链接与 device code。 */
  async startLogin(): Promise<FeishuDeviceLogin> {
    const res = await this.lark.run(
      ['auth', 'login', '--no-wait', '--json', ...feishuAuthScopeArgs()],
      { timeoutMs: 30_000 },
    )
    if (res.code !== 0) {
      throw new Error(redact(`${res.stdout}\n${res.stderr}`) || `lark-cli 退出码 ${res.code}`)
    }
    const parsed = parseDeviceLogin(res.stdout, res.stderr)
    if (!parsed.deviceCode) {
      throw new Error(`lark-cli 未返回 device code：${redact(`${res.stdout}\n${res.stderr}`) || '无输出'}`)
    }
    if (!parsed.verificationUrl) {
      throw new Error(`lark-cli 未返回验证链接：${redact(`${res.stdout}\n${res.stderr}`) || '无输出'}`)
    }
    return parsed
  }

  /** 完成授权轮询；最长等待 3 分钟。 */
  async completeLogin(deviceCode: string): Promise<LarkAuthStatus> {
    const code = deviceCode.trim()
    if (!code) throw new Error('device code 不能为空')
    const res = await this.lark.run(
      ['auth', 'login', '--device-code', code, '--json'],
      { timeoutMs: 180_000 },
    )
    if (res.code !== 0) {
      throw new Error(redact(`${res.stdout}\n${res.stderr}`) || `lark-cli 退出码 ${res.code}`)
    }
    return this.status()
  }

  private emptyStatus(message: string): LarkAuthStatus {
    return {
      appId: '',
      bot: { available: false, status: '', message },
      user: { available: false, status: '', message: '', openId: '', userName: '' },
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 截断并去掉可能的敏感值，避免错误响应里回显 App Secret。 */
function redact(text: string, secret = ''): string {
  const cleaned = secret ? text.split(secret).join('***') : text
  return cleaned.trim().slice(0, 240)
}