import type { AppConfig } from '../config.js'
import type { CommandRunner } from '../infra/process.js'
import type { WorkerRuntime } from '../worker/port.js'
import {
  parseAuthUser,
  parseBotAvailable,
  parseEventPrecheck,
  parseLarkChats,
  parseLarkMembers,
  parseOrcaRepos,
  parseOrcaStatus,
} from '../sources/lark.js'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface DoctorCheck {
  name: string
  status: CheckStatus
  detail: string
  hint?: string
}

export interface DoctorDeps {
  config: AppConfig
  orca: CommandRunner
  lark: CommandRunner
  /** 模型配置是否可解析（不做网络请求）。 */
  llm: () => { ok: boolean; detail: string }
  portFree: () => Promise<boolean>
  servicePid: number | null
  /** 当前默认运行时；有 doctor() 时追加其运行时自检。 */
  runtime?: WorkerRuntime
}

/** 启动前自检：把“配好了吗、能不能收到消息、能不能派工”一次性查清。 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const { config } = deps
  const checks: DoctorCheck[] = []

  const missing: string[] = []
  const projectCount = config.projects.length
  if (projectCount === 0) missing.push('projects')
  if (config.feishu.chats.length === 0) missing.push('feishu.chats')
  if (config.feishu.allowed.length === 0) missing.push('feishu.allowed')
  if (config.feishu.botOpenIds.length === 0) missing.push('feishu.botOpenIds')
  checks.push({
    name: '配置必填项',
    status: missing.length === 0 ? 'ok' : 'fail',
    detail: missing.length === 0
      ? `${projectCount} 个项目（${config.projects.map(project => project.name).join('、')}），群 ${config.feishu.chats.length} 个（绑定 ${config.feishu.chats.filter(chat => chat.repo).length} 个）`
      : `缺少 ${missing.join(' / ')}`,
    ...(missing.length > 0 ? { hint: 'ra config set project.<名称> "<repo>@<分支>"，或重新运行 ra init' } : {}),
  })

  checks.push({
    name: 'accept mode',
    status: 'ok',
    detail: `${config.policy.acceptMode}${config.policy.acceptMode === 'auto' ? '（研判通过会直接开工）' : ''}`,
    ...(config.policy.acceptMode === 'auto' ? { hint: '首次验收建议 ra config set policy.acceptMode observe' } : {}),
  })

  if (config.runtime.default === 'orca') {
    checks.push(await check('Orca runtime', async () => {
      const res = await deps.orca.run(['status'])
      const parsed = parseOrcaStatus(res.stdout)
      const ready = res.code === 0 && parsed.runtimeReachable === 'true'
      return { status: ready ? 'ok' : 'fail', detail: ready ? `runtimeState=${parsed.runtimeState ?? 'unknown'}` : (res.stderr || res.stdout).trim().slice(0, 160), ...(ready ? {} : { hint: '打开 Orca 应用或运行 orca open' }) }
    }))

    checks.push(await check('Orca 仓库', async () => {
      const res = await deps.orca.run(['repo', 'list', '--json'])
      const repos = res.code === 0 ? parseOrcaRepos(res.stdout) : []
      const wanted = config.projects.map(project => project.repo)
      if (wanted.length === 0) return { status: 'fail', detail: '未配置任何项目', hint: 'ra config set project.<name> <repo>@<分支>' }
      const missingRepos = wanted.filter(repo => {
        const name = repo.replace(/^(id|name|path):/, '')
        return !repos.some(item => item.name === name || item.path === name)
      })
      return missingRepos.length === 0
        ? { status: 'ok', detail: wanted.join(', ') }
        : { status: 'fail', detail: `未找到仓库 ${missingRepos.join(', ')}`, hint: 'orca repo list 查看可选项，或 orca repo add --path <dir>' }
    }))
  }

  checks.push(await check('飞书机器人身份', async () => {
    const res = await deps.lark.run(['auth', 'status'])
    const bot = parseBotAvailable(res.stdout)
    const user = parseAuthUser(res.stdout)
    if (!bot) return { status: 'fail', detail: '机器人身份不可用', hint: '检查 lark-cli config show 与 App Secret' }
    return { status: 'ok', detail: `bot ready${user.available ? '，用户身份可用' : '，用户身份未授权（可选）'}` }
  }))

  checks.push(await check('事件订阅预检', async () => {
    const res = await deps.lark.run(['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--dry-run'])
    const pre = parseEventPrecheck(res.stdout)
    return pre.ready
      ? { status: 'ok', detail: pre.detail }
      : { status: 'fail', detail: pre.detail, hint: '飞书开放平台需开启 im.message.receive_v1 事件与对应权限' }
  }))

  checks.push(await check('监控群可见性', async () => {
    const res = await deps.lark.run(['im', '+chat-list', '--as', 'bot', '--format', 'json'])
    const chats = res.code === 0 ? parseLarkChats(res.stdout) : []
    const ids = new Set(chats.map(chat => chat.chatId))
    const configured = config.feishu.chats.map(chat => chat.chat)
    const missingChats = configured.filter(id => !ids.has(id))
    if (configured.length === 0) return { status: 'warn', detail: '没有配置任何群' }
    return missingChats.length === 0
      ? { status: 'ok', detail: `${configured.length} 个群对机器人可见` }
      : { status: 'fail', detail: `不可见：${missingChats.join(', ')}`, hint: '把机器人拉进群，或检查 chat_id 是否正确' }
  }))

  checks.push(await check('机器人在群内', async () => {
    const chatId = config.feishu.chats[0]?.chat
    if (!chatId) return { status: 'warn', detail: '没有配置群' }
    const res = await deps.lark.run(['im', '+chat-members-list', '--chat-id', chatId, '--as', 'bot', '--format', 'json'])
    const members = res.code === 0 ? parseLarkMembers(res.stdout) : []
    const bots = members.filter(member => member.type === 'bot')
    const matched = bots.some(bot => config.feishu.botOpenIds.includes(bot.openId) || (bot.appId ? config.feishu.botOpenIds.includes(bot.appId) : false))
    return matched
      ? { status: 'ok', detail: `${bots.length} 个机器人成员，已匹配配置` }
      : { status: 'fail', detail: `群 ${chatId} 里没找到配置的机器人身份`, hint: 'ra config set feishu.botOpenIds ou_xxx,cli_xxx' }
  }))

  checks.push(await check('模型配置', async () => {
    const result = deps.llm()
    return result.ok ? { status: 'ok', detail: result.detail } : { status: 'fail', detail: result.detail, hint: '检查 ~/.trove/config.json 或 ra config set llm.*' }
  }))

  checks.push(await check('服务端口', async () => {
    if (deps.servicePid && alive(deps.servicePid)) return { status: 'ok', detail: `服务运行中 (pid ${deps.servicePid})` }
    const free = await deps.portFree()
    return free
      ? { status: 'ok', detail: `端口 ${config.server.port} 空闲` }
      : { status: 'fail', detail: `端口 ${config.server.port} 被占用`, hint: 'ra config set server.port <新端口>' }
  }))

  checks.push({
    name: '运行状态',
    status: deps.servicePid && alive(deps.servicePid) ? 'ok' : 'warn',
    detail: deps.servicePid && alive(deps.servicePid) ? `运行中 (pid ${deps.servicePid})` : '未运行',
    ...(deps.servicePid && alive(deps.servicePid) ? {} : { hint: 'ra start' }),
  })

  if (deps.runtime?.doctor) {
    checks.push(await check(`Worker runtime (${deps.runtime.id})`, async () => {
      const result = await deps.runtime!.doctor!()
      const failed = result.find(item => item.status === 'fail')
      const warned = result.find(item => item.status === 'warn')
      return {
        status: failed ? 'fail' : warned ? 'warn' : 'ok',
        detail: result.map(item => `${item.name}: ${item.detail}`).join('；') || 'ok',
        ...(failed?.hint ? { hint: failed.hint } : {}),
      }
    }))
  }

  return checks
}

async function check(name: string, probe: () => Promise<Omit<DoctorCheck, 'name'>>): Promise<DoctorCheck> {
  try {
    return { name, ...(await probe()) }
  } catch (error) {
    return { name, status: 'fail', detail: error instanceof Error ? error.message : String(error) }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function formatChecks(checks: DoctorCheck[]): string[] {
  const icon: Record<CheckStatus, string> = { ok: '✅', warn: '⚠️', fail: '❌' }
  return checks.map(item => {
    const line = `${icon[item.status]} ${item.name}：${item.detail}`
    return item.hint && item.status !== 'ok' ? `${line}\n   → ${item.hint}` : line
  })
}