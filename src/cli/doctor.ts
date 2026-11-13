import { existsSync } from 'node:fs'
import type { AppConfig } from '../config.js'
import { projectsForRuntime } from '../config.js'
import type { CommandRunner } from '#infra/process.js'
import { checkMemberPayload, resolveBotIdentity } from '@router-agent/channel-feishu'
import type { WorkerRuntime } from '#runtime/port.js'
import type { RuntimeChoice } from '@router-agent/runtime-acp'
import {
  parseAuthUser,
  parseBotAvailable,
  parseEventPrecheck,
  parseLarkChats,
  parseLarkMembers,
  parseOrcaStatus,
} from '@router-agent/channel-feishu'
import { projectRepoPath } from '#runtime/runtimes/repo-path.js'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface DoctorCheck {
  name: string
  status: CheckStatus
  detail: string
  hint?: string
  /**
   * 面板配置页的分组 id（`sec-<id>`）；排查助手据此把用户直接带到该改的地方。
   */
  section?: string
  /**
   * 缺的具体配置项（点路径）；面板把它显示成「该改哪项」。
   */
  items?: string[]
}

/** 配置页的分组 id；与 `src/web/client/fields.ts` 的 CONFIG_GROUPS 对齐。 */
export const CONFIG_SECTIONS = {
  llm: 'llm',
  decision: 'decision',
  runtime: 'runtime',
  channels: 'channels',
  projects: 'projects',
  admission: 'admission',
  ops: 'ops',
} as const

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
  /** ACP 探测结果；逐项展示，默认运行时的不可用会判 fail。 */
  runtimeChoices?: RuntimeChoice[]
}

/** 启动前自检：把“配好了吗、能不能收到消息、能不能派工”一次性查清。 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const { config } = deps
  const checks: DoctorCheck[] = []
  /** 手填了机器人身份就按手填的匹配；留空则按 feishu.appId 自动识别（与启动装配同一规则）。 */
  const manualBot = config.feishu.botOpenIds.length > 0 || config.feishu.botNames.length > 0
  /** 只有 mode=mention 的群靠 @ 机器人判定收不收消息，也只有它们需要识别机器人身份。 */
  const mentionChatIds = config.feishu.chats.filter(chat => chat.mode === 'mention').map(chat => chat.chat)
  const projects = projectsForRuntime(config)
  const projectCount = projects.length
  checks.push(configRequiredCheck(config, projectCount))
  // 决策层是否真的装上：这是「配了却在用兜底」最容易漏掉的一处。
  checks.push(decisionLayerCheck(config))

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
  }

  // 项目路径统一是本地仓库绝对路径：所有 runtime 都按本地目录检查。
  // Orca 侧是否已登记不用查：派工时 ra 会自动 orca repo add 登记。
  const missingPaths = projects.filter(project => !existsSync(projectRepoPath(project.repo)))
  checks.push({
    name: '本地项目路径',
    status: projects.length === 0
      ? 'fail'
      : missingPaths.length === 0 ? 'ok' : 'fail',
    detail: projects.length === 0
      ? '未配置任何项目'
      : projects
        .map(project => `${project.name} → ${project.repo}`)
        .join('，'),
    ...(missingPaths.length > 0
      ? { hint: `repo 必须是存在的本地仓库绝对路径（${missingPaths.map(item => item.name).join('、')}）；在面板「配置 → 项目清单」或 ra config set project.<名称> 中修正` }
      : {}),
  })

  // ACP Agent 逐项展示；非默认运行时的不可用只提示，不影响 doctor 退出码。
  for (const choice of deps.runtimeChoices ?? []) {
    if (!choice.id.startsWith('acp-')) continue
    const isDefault = choice.id === config.runtime.default
    const status: CheckStatus = choice.status === 'ready'
      ? 'ok'
      : choice.status === 'unverified' || !isDefault ? 'warn' : 'fail'
    const detail = [
      choice.status === 'ready' ? '可用' : choice.status,
      choice.version ? `版本 ${choice.version}` : '',
      choice.source ? `来源 ${choice.source}` : '',
      choice.reason ? choice.reason : '',
    ].filter(Boolean).join('，')
    checks.push({
      name: `ACP ${choice.id}`,
      status,
      detail,
      ...(choice.installHint || choice.loginHint ? { hint: choice.loginHint ?? choice.installHint } : {}),
    })
  }

  checks.push(await check('飞书机器人身份', async () => {
    const res = await deps.lark.run(['auth', 'status', '--json'])
    const bot = parseBotAvailable(res.stdout)
    const user = parseAuthUser(res.stdout)
    if (!bot) return { status: 'fail', detail: '机器人身份不可用', hint: '在 Web 配置页写入 App ID / App Secret' }
    return {
      status: 'ok',
      detail: `bot ready${user.available ? '，用户身份可用' : '，用户身份未授权（可选）'}`,
      ...(user.available ? {} : { hint: '如需按名字搜索群/成员，在 Web 配置页完成飞书授权' }),
    }
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

  // 机器人身份：默认自动识别（按 appId 匹配群成员里的 bot），手填了才用手填的（逃生口）。
  checks.push(await check('机器人身份自动识别', async () => {
    if (manualBot) {
      return { status: 'ok', detail: '手动填写了机器人身份，不自动识别', hint: '留空 feishu.botOpenIds / feishu.botNames 可改为自动识别' }
    }
    if (mentionChatIds.length === 0) {
      // 没有 @ 模式的群就不需要识别；这与 resolveBotIdentity 的 resolved 语义一致（无需识别不是失败）。
      return { status: 'ok', detail: '没有 mode=mention 的群，无需识别机器人身份' }
    }
    const identity = await resolveBotIdentity({ appId: config.feishu.appId, chatIds: mentionChatIds, lark: deps.lark })
    return identity.resolved
      ? { status: 'ok', detail: identity.detail }
      : { status: 'fail', detail: identity.detail, hint: '确认机器人已在这些群里，且 feishu.appId 是机器人所属应用；也可手动填写 feishu.botOpenIds' }
  }))

  checks.push(await check('机器人在群内', async () => {
    // @ 模式的群最要紧：识别不到机器人就会整群丢消息。没有 @ 群时退回检查配置里的第一个群。
    const chatIds = mentionChatIds.length > 0 ? mentionChatIds : config.feishu.chats.slice(0, 1).map(chat => chat.chat)
    if (chatIds.length === 0) return { status: 'warn', detail: '没有配置群' }
    const missing: string[] = []
    const failures: string[] = []
    let botCount = 0
    for (const chatId of chatIds) {
      const res = await deps.lark.run(['im', '+chat-members-list', '--chat-id', chatId, '--as', 'bot', '--format', 'json'])
      if (res.code !== 0) {
        failures.push(`群 ${chatId} 读取成员失败（code=${res.code}）`)
        continue
      }
      // 退出码 0 也可能是错误信封：接口异常不能当成「群里没有机器人」，否则排查方向会被带偏。
      const payload = checkMemberPayload(res.stdout)
      if (!payload.ok) {
        failures.push(`群 ${chatId} ${payload.detail}`)
        continue
      }
      const bots = parseLarkMembers(res.stdout).filter(member => member.type === 'bot')
      botCount += bots.length
      const matched = manualBot
        ? bots.some(bot => config.feishu.botOpenIds.includes(bot.openId) || (bot.appId ? config.feishu.botOpenIds.includes(bot.appId) : false))
        : bots.some(bot => Boolean(bot.appId) && bot.appId === config.feishu.appId)
      if (!matched) missing.push(chatId)
    }
    if (failures.length > 0) {
      return { status: 'fail', detail: `读取群成员接口异常：${failures.join('；')}`, hint: '检查 lark-cli 与机器人权限后重试；接口异常时无法判断机器人是否在群' }
    }
    if (missing.length > 0) {
      return {
        status: 'fail',
        detail: manualBot
          ? `群 ${missing.join('、')} 里没找到配置的机器人身份`
          : `群 ${missing.join('、')} 里没找到 feishu.appId=${config.feishu.appId || '（未配置）'} 的机器人`,
        hint: manualBot ? 'ra config set feishu.botOpenIds ou_xxx,cli_xxx' : '确认 feishu.appId 与机器人所属应用一致，并把机器人拉进群',
      }
    }
    return { status: 'ok', detail: `${chatIds.length} 个群共 ${botCount} 个机器人成员，已匹配${manualBot ? '手动配置' : 'feishu.appId'}` }
  }))

  checks.push(await check('模型配置', async () => {
    const result = deps.llm()
    return result.ok ? { status: 'ok', detail: result.detail } : { status: 'fail', detail: result.detail, hint: 'ra config set llm.baseUrl/llm.model/llm.apiKey，或写 config.yaml 的 llm 段' }
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

/**
 * 配置必填项检查：缺什么、缺了会导致什么。
 *
 * 单独拆出来是因为排查助手要复用它：面板打开时不需要跑完整个 doctor
 * （那要连飞书、Orca 的网络），只需要知道「配置缺了什么」。
 */
export function configRequiredCheck(config: AppConfig, projectCount = projectsForRuntime(config).length): DoctorCheck {
  const missing: string[] = []
  if (projectCount === 0) missing.push('projects')
  if (config.feishu.chats.length === 0) missing.push('feishu.chats')
  if (config.feishu.allowed.length === 0) missing.push('feishu.allowed')
  // 缺什么用大白话说：面板上直接展示这句，用户要知道自己该补什么。
  const missingItems: Record<string, string> = {
    projects: '还没有登记任何项目，机器人不知道要把活派给哪个仓库',
    'feishu.chats': '还没有配置要监听的群，机器人收不到消息',
    'feishu.allowed': '还没有配置允许名单，名单外的人发消息一律不理',
  }
  // 每一项缺的东西要去哪个分组改，面板按这个跳。
  const missingSections: Record<string, string> = {
    projects: CONFIG_SECTIONS.projects,
    'feishu.chats': CONFIG_SECTIONS.channels,
    'feishu.allowed': CONFIG_SECTIONS.channels,
  }
  // 机器人身份不再要求手填：留空时启动会自动按 feishu.appId 识别（见「机器人身份自动识别」检查）。
  return {
    name: '配置必填项',
    status: missing.length === 0 ? 'ok' : 'fail',
    detail: missing.length === 0
      ? `${config.runtime.default} 运行时 ${projectCount} 个项目（${projectsForRuntime(config).map(project => project.name).join('、')}），群 ${config.feishu.chats.length} 个（绑定 ${config.feishu.chats.filter(chat => chat.repo).length} 个）`
      : `缺少 ${missing.join(' / ')}`,
    ...(missing.length > 0
      ? {
        hint: 'ra config set project.<名称> "<repo>@<分支>"，或重新运行 ra init',
        // 引导到第一项缺失所在的分组；多项缺失时用户补完第一项再点一次即可。
        section: missingSections[missing[0]!] ?? CONFIG_SECTIONS.channels,
        // 面板用的大白话：说清缺的是什么、去哪补。CLI 仍看 detail 里的配置路径。
        items: missing.map(item => `${missingItems[item] ?? `缺少 ${item}`}（去「${missingSections[item] === CONFIG_SECTIONS.projects ? '配置 → 项目清单' : '配置 → 渠道配置'}」补）`),
      }
      : {}),
  }
}

/**
 * 只跑不联网的配置自检：面板打开时用这个。
 *
 * 完整 doctor 要连飞书与 Orca，面板打开时等它跑完太慢；
 * 而「配置缺了什么、模型配了没」才是面板要先回答的问题。
 * 网络层面的问题由日志（飞书身份失败等）与服务日志里的事件体现。
 */
export function runConfigDoctor(deps: { config: AppConfig; llm: () => { ok: boolean; detail: string } }): DoctorCheck[] {
  const { config } = deps
  const checks: DoctorCheck[] = [configRequiredCheck(config)]
  checks.push(decisionLayerCheck(config))
  const llm = deps.llm()
  checks.push({
    name: '模型配置',
    status: llm.ok ? 'ok' : 'fail',
    detail: llm.ok ? llm.detail : '还没有配置模型，助手只能按内置规则判断，结论不如模型贴合',
    ...(llm.ok ? {} : { hint: '在面板「配置 → LLM Provider」填 Base URL / 模型 / API Key', section: CONFIG_SECTIONS.llm }),
  })
  if (config.runtime.default !== 'orca') {
    const projects = projectsForRuntime(config)
    const missing = projects.filter(project => !existsSync(project.repo.replace(/^path:/, '')))
    checks.push({
      name: '本地项目路径',
      status: projects.length === 0 ? 'fail' : missing.length === 0 ? 'ok' : 'fail',
      detail: projects.length === 0
        ? '未配置任何项目'
        : projects.map(project => `${project.name} → ${project.repo.replace(/^path:/, '')}`).join('，'),
      ...(missing.length > 0
        ? { hint: 'repo 必须是本地仓库绝对路径；在面板「配置 → 项目清单」或 ra config set project.<名称> 中修正', section: CONFIG_SECTIONS.projects }
        : {}),
    })
  }
  return checks
}

/**
 * 决策层检查：是否启用、Provider 是谁、Jev 连接信息是否齐全。
 *
 * apiKey 与 model 两项都要有才真的走 Jev——只给密钥时服务会退回 LLM 兜底，
 * 这里必须说清楚，否则「配了却在用 LLM」会很难排查。
 */
function decisionLayerCheck(config: AppConfig): DoctorCheck {
  const decision = config.decision
  if (!decision.enabled) {
    return {
      name: '决策层',
      status: 'ok',
      detail: '未启用：普通成员消息仍走原来的 LLM 初筛（需要时在面板「配置 → 决策层」打开）',
    }
  }
  const jev = decision.jev
  if (decision.provider !== 'jev') {
    return {
      name: '决策层',
      status: 'ok',
      detail: '已启用，Provider llm（用同一份决策契约模拟）',
    }
  }
  const missing = [!jev.apiKey ? 'API Key' : '', !jev.model ? '模型名' : ''].filter(Boolean)
  if (missing.length > 0) {
    return {
      name: '决策层',
      status: 'fail',
      detail: `已启用，但 Jev 连接信息缺${missing.join('、')}：会退回 LLM 兜底，不会真的走 Jev`,
      hint: '在面板「配置 → 决策层」把模型名与 API Key 都填上（两项都要有）',
      section: CONFIG_SECTIONS.decision,
    }
  }
  return {
    name: '决策层',
    status: 'ok',
    detail: `已启用，Provider jev（${jev.model}）`,
  }
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
