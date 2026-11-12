import { join } from 'node:path'
import { chatEntry, loadConfig, projectNameOf, projectsForRuntime, setProjectsForRuntime, writeConfig, type AppConfig, type ProjectConfig } from '../config.js'
import { ORCA_RUNTIME_ID, normalizeRuntimeId } from '#runtime/runtimes/catalog.js'
import type { CommandRunner } from '#infra/process.js'
import { FeishuBotAdmin, feishuAuthScopeArgs } from '@router-agent/channel-feishu'
import {
  larkEnv,
  parseAppId,
  parseAuthUser,
  parseLarkChats,
  parseLarkMembers,
  parseOrcaRepos,
  parseSelfOpenId,
  type LarkChat,
  type LarkMember,
} from '@router-agent/channel-feishu'
import type { Prompter } from './prompts.js'

export interface InitDeps {
  home: string
  env: NodeJS.ProcessEnv
  stdout(line: string): void
  /** 存在即进入交互引导；不存在时写默认配置。 */
  prompts?: Prompter
  orca: CommandRunner
  /** 已绑定固定 lark-cli profile 的 runner。 */
  lark: CommandRunner
  /** 需要交互式接管终端的 lark-cli 命令（新建应用、用户授权）。 */
  stream?: (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>
}

/**
 * `ra init` 的交互引导：只问必填项（仓库、机器人、群、授权成员），
 * 其余可选参数留给 `ra config set`。
 */
export async function runInitWizard(deps: InitDeps): Promise<AppConfig> {
  const config = loadConfig(deps.home, deps.env)
  const out = deps.stdout
  const prompts = deps.prompts

  if (!prompts) {
    writeConfig(deps.home, config)
    out(`已写入默认配置：${join(deps.home, 'config.yaml')}`)
    out('必填项可用 `ra config set` 补齐：project.<名称> / feishu.chats / feishu.allowed / feishu.botOpenIds')
    out('其余参数（acceptMode、maxWorkers、port 等）同样用 `ra config set` 调整。')
    return config
  }

  out('=== router-agent 初始化 ===')
  await pickRepo(deps, config, prompts, out)

  out('')
  const source = await prompts.select<'existing' | 'new' | 'skip'>({
    message: '飞书机器人（固定使用 ~/.router-agent-lark profile）',
    choices: [
      { name: '已有 App ID / App Secret，现在写入', value: 'existing' },
      { name: '现在新建飞书应用（浏览器完成）', value: 'new' },
      { name: '跳过，稍后在 Web 配置页填写', value: 'skip' },
    ],
    default: config.feishu.appId ? 'existing' : 'skip',
  })

  if (source !== 'skip') {
    await setupDedicatedApp(deps, config, source === 'new', prompts, out)
    await ensureUserAuth(deps, prompts, out)
  }

  const chats = await safeChats(deps.lark)
  if (chats.length === 0) {
    out('')
    out('⚠ 读不到群列表，跳过群/成员选择。')
    out('   请先在 Web 配置页写入 App ID / App Secret，并完成飞书授权。')
  } else {
    out('')
    const selected = await prompts.checkbox<string>({
      message: '选择要监控的群（默认接收全部消息）',
      choices: chats.map(chat => ({
        name: `${chat.name || chat.chatId}  ${chat.chatId}`,
        value: chat.chatId,
        checked: config.feishu.chats.some(item => item.chat === chat.chatId),
      })),
      required: true,
    })
    const existing = new Map(config.feishu.chats.map(item => [item.chat, item]))
    config.feishu.chats = selected.map(chatId => existing.get(chatId) ?? chatEntry(chatId))

    const firstChat = config.feishu.chats[0]?.chat
    if (firstChat) await pickPeople(deps, config, firstChat, prompts, out)
    await bindChats(config, prompts, out)
  }
  if (config.feishu.chats.length === 0) {
    out('⚠ 还没有监控群：ra config set feishu.chats oc_xxx,oc_yyy')
  }

  writeConfig(deps.home, config)
  out('')
  out(`配置已写入：${join(deps.home, 'config.yaml')}`)
  out(summarize(config))
  const missing = missingRequired(config)
  if (missing.length > 0) {
    out(`⚠ 仍缺少必填项：${missing.join(' / ')}`)
    out('   用 `ra config set` 补齐，然后 `ra start`。')
  } else {
    out('下一步：ra start（启动后会打开 Web 初始化页；想先观察可 ra config set policy.acceptMode observe）')
  }
  return config
}

async function pickRepo(
  deps: InitDeps,
  config: AppConfig,
  prompts: Prompter,
  out: (line: string) => void,
): Promise<void> {
  const existingRepo = projectsForRuntime(config)[0]?.repo ?? ''
  // 非 Orca 运行时（claude-code / acp-*）都用 git worktree，需要本地仓库绝对路径。
  if (normalizeRuntimeId(config.runtime.default) !== ORCA_RUNTIME_ID) {
    const repo = await prompts.input({
      message: '本地仓库绝对路径（例如 /Users/me/project）',
      default: existingRepo,
    })
    await registerProject(config, repo, prompts, out)
    return
  }

  let repos: { name: string; path: string }[] = []
  try {
    const res = await deps.orca.run(['repo', 'list', '--json'])
    if (res.code === 0) repos = parseOrcaRepos(res.stdout)
  } catch {
    // orca 不可用时退回手输
  }

  if (repos.length === 0) {
    const repo = await prompts.input({
      message: 'Orca 仓库名（orca repo list 里的 displayName）',
      default: existingRepo,
    })
    await registerProject(config, repo, prompts, out)
    return
  }

  out('')
  const choice = await prompts.select<string>({
    message: '选择 Orca 仓库（用于创建 worktree，只列 git 类型）',
    choices: [
      ...repos.map(repo => ({ name: `${repo.name}  ${repo.path}`, value: repo.name })),
      { name: '稍后设置', value: '' },
    ],
    default: existingRepo || repos[0]!.name,
  })
  await registerProject(config, choice, prompts, out)
}

/** 把仓库登记成一个项目，并问清默认起始分支。 */
async function registerProject(config: AppConfig, repo: string, prompts: Prompter, out: (line: string) => void): Promise<void> {
  if (!repo) return
  const name = projectNameOf(repo)
  const projects = projectsForRuntime(config)
  const existing = projects.find(project => project.name === name)
  const defaultBranch = await prompts.input({
    message: `项目「${name}」的默认起始分支（工单没指定时使用；留空则每次开工前问你）`,
    default: existing?.defaultBranch || '',
  })
  const project: ProjectConfig = {
    name,
    repo,
    defaultBranch: defaultBranch.trim(),
  }
  const index = projects.findIndex(item => item.name === name)
  if (index >= 0) projects[index] = project
  else projects.push(project)
  setProjectsForRuntime(config, config.runtime.default, projects)
  out(`  项目已登记：${project.name}（默认分支 ${project.defaultBranch || '未设置'}，运行时 ${config.runtime.default}）`)
}

/** 群级绑定：选定群固定用某个项目 / 分支，Router 之后不再追问。 */
async function bindChats(config: AppConfig, prompts: Prompter, out: (line: string) => void): Promise<void> {
  const projects = projectsForRuntime(config)
  if (projects.length === 0) return
  const unbound = config.feishu.chats.filter(chat => !chat.repo)
  if (unbound.length === 0) return
  out('')
  const choice = await prompts.select<string>({
    message: '要给监控群绑定固定的项目 / 分支吗？（绑定后 Router 开工不再追问）',
    choices: [
      ...projects.map(project => ({
        name: `${project.name}${project.defaultBranch ? `  @ ${project.defaultBranch}` : ''}`,
        value: project.name,
      })),
      { name: '不绑定（每次开工前确认项目与分支）', value: '' },
    ],
    default: '',
  })
  if (!choice) return
  const project = projects.find(item => item.name === choice)
  if (!project) return
  if (!project.defaultBranch) {
    out(`  项目「${project.name}」没有默认分支；群绑定后开工时仍会追问分支`)
  }
  for (const chat of unbound) {
    chat.repo = project.name
    // 群绑定不单独设置分支，永远跟随项目清单的默认分支。
    chat.branch = project.defaultBranch
  }
  out(`  已绑定 ${unbound.length} 个群 → ${project.name}${project.defaultBranch ? ` @ ${project.defaultBranch}` : '（分支待定）'}`)
}

async function setupDedicatedApp(
  deps: InitDeps,
  config: AppConfig,
  createNew: boolean,
  prompts: Prompter,
  out: (line: string) => void,
): Promise<void> {
  const lark = deps.lark

  if (createNew) {
    out('即将调用 lark-cli config init --new，请在浏览器里完成应用创建。')
    if (!deps.stream) {
      out('请手动执行：HOME=~/.router-agent-lark lark-cli config init --new')
      return
    }
    const code = await deps.stream(['config', 'init', '--new'], larkEnv())
    if (code !== 0) {
      out('⚠ 新建应用未完成，稍后可重新运行 ra init。')
      return
    }
    const appId = parseAppId((await lark.run(['config', 'show'])).stdout)
    if (appId) config.feishu.appId = appId
    out(`专属机器人已配置：${appId || '(未读取到 appId)'}`)
    return
  }

  const appId = await prompts.input({
    message: 'App ID（飞书开放平台 → 凭证与基础信息）',
    default: config.feishu.appId,
    validate: value => (value.trim() ? true : 'App ID 不能为空'),
  })
  if (!appId.trim()) {
    out('⚠ 没有 App ID，跳过专属机器人配置；稍后可重新运行 ra init。')
    return
  }
  config.feishu.appId = appId.trim()

  const secret = await prompts.password({
    message: 'App Secret（只写入 lark-cli 加密存储，不会写进 config.yaml）',
  })
  if (!secret.trim()) {
    out('未填写 App Secret：若该应用已在此目录配置过可以继续，否则稍后重新运行 ra init。')
    return
  }

  // Secret 通过 stdin 传入，不出现在进程参数里。
  const result = await new FeishuBotAdmin({ lark }).configure(config.feishu.appId, secret)
  if (!result.ok) {
    out(`⚠ ${result.message}`)
    out('   请检查 App Secret 是否属于这个 App ID，然后重新运行 ra init。')
    return
  }
  out(result.message)
}

async function ensureUserAuth(
  deps: InitDeps,
  prompts: Prompter,
  out: (line: string) => void,
): Promise<void> {
  const lark = deps.lark
  let status
  try {
    status = await lark.run(['auth', 'status', '--json'])
  } catch {
    return
  }
  if (status.code !== 0) return
  const user = parseAuthUser(status.stdout)
  if (user.available) return

  out('')
  out('当前还没有飞书用户授权（机器人身份已可用；用户授权用于按名字搜索群/成员）。')
  const yes = await prompts.confirm({ message: '现在完成用户授权？', default: false })
  if (!yes) {
    out('稍后可执行：HOME=~/.router-agent-lark lark-cli auth login')
    return
  }
  if (!deps.stream) {
    out('请手动执行：HOME=~/.router-agent-lark lark-cli auth login')
    return
  }
  const code = await deps.stream(['auth', 'login', ...feishuAuthScopeArgs()], larkEnv())
  out(code === 0 ? '用户授权完成。' : '⚠ 用户授权未完成，可稍后重试。')
}

async function pickPeople(
  deps: InitDeps,
  config: AppConfig,
  chatId: string,
  prompts: Prompter,
  out: (line: string) => void,
): Promise<void> {
  let members: LarkMember[] = []
  try {
    const res = await deps.lark.run(['im', '+chat-members-list', '--chat-id', chatId, '--as', 'bot', '--format', 'json'])
    if (res.code === 0) members = parseLarkMembers(res.stdout)
  } catch {
    members = []
  }

  const users = members.filter(member => member.type === 'user')
  const bots = members.filter(member => member.type === 'bot')

  if (users.length > 0) {
    out('')
    const selfId = await readSelfOpenId(deps.lark)
    config.feishu.allowed = await prompts.checkbox<string>({
      message: '允许谁发起工作（名单内 @机器人 = 显式接单）',
      choices: users.map(user => ({
        name: `${user.name || user.openId}  ${user.openId}`,
        value: user.openId,
        checked: config.feishu.allowed.includes(user.openId) || user.openId === selfId,
      })),
      required: true,
    })
  }

  if (bots.length === 0) {
    if (config.feishu.botOpenIds.length === 0) {
      out('⚠ 未能自动识别机器人身份，请稍后执行：ra config set feishu.botOpenIds ou_xxx,cli_xxx')
    }
    return
  }

  const appId = await readAppId(deps.lark)
  let chosen = bots.find(bot => bot.appId && bot.appId === appId) ?? (bots.length === 1 ? bots[0] : undefined)
  if (!chosen) {
    out('')
    const answer = await prompts.select<number>({
      message: '群里有多个机器人，选择 router-agent 使用的那个',
      choices: bots.map((bot, index) => ({ name: `${bot.name || bot.openId}  ${bot.openId}`, value: index })),
      default: 0,
    })
    chosen = bots[answer] ?? bots[0]
  }
  if (chosen) {
    config.feishu.botOpenIds = unique([chosen.openId, chosen.appId ?? ''])
    if (chosen.name) config.feishu.botNames = [chosen.name]
    out(`机器人身份：${chosen.name || chosen.openId}（${chosen.appId ?? '未知 appId'}）`)
  }
}

async function safeChats(lark: CommandRunner): Promise<LarkChat[]> {
  try {
    const res = await lark.run(['im', '+chat-list', '--as', 'bot', '--format', 'json'])
    return res.code === 0 ? parseLarkChats(res.stdout) : []
  } catch {
    return []
  }
}

async function readSelfOpenId(lark: CommandRunner): Promise<string> {
  try {
    const res = await lark.run(['auth', 'status', '--json'])
    return res.code === 0 ? parseSelfOpenId(res.stdout) : ''
  } catch {
    return ''
  }
}

async function readAppId(lark: CommandRunner): Promise<string> {
  try {
    const res = await lark.run(['config', 'show'])
    return res.code === 0 ? parseAppId(res.stdout) : ''
  } catch {
    return ''
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function summarize(config: AppConfig): string {
  const projects = projectsForRuntime(config).map(project => `${project.name}${project.defaultBranch ? ` @ ${project.defaultBranch}` : ''}`)
  const chats = config.feishu.chats.map(chat => `${chat.chat}:${chat.mode}${chat.repo ? `→${chat.repo}@${chat.branch || '?'}` : ''}`)
  return [
    '当前配置：',
    `  运行时: ${config.runtime.default}`,
    `  项目: ${projects.join('，') || '(未设置)'}`,
    `  监控群: ${chats.join('，') || '(未设置)'}`,
    `  机器人 profile: ~/.router-agent-lark（固定）`,
    `  appId: ${config.feishu.appId || '(未设置)'}`,
    `  授权成员: ${config.feishu.allowed.join(', ') || '(未设置)'}`,
    `  机器人身份: ${config.feishu.botOpenIds.join(', ') || '(未设置)'}`,
  ].join('\n')
}

function missingRequired(config: AppConfig): string[] {
  const missing: string[] = []
  if (projectsForRuntime(config).length === 0) missing.push('projects')
  if (config.feishu.chats.length === 0) missing.push('feishu.chats')
  if (config.feishu.allowed.length === 0) missing.push('feishu.allowed')
  if (config.feishu.botOpenIds.length === 0) missing.push('feishu.botOpenIds')
  return missing
}
