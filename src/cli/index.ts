import { appendFileSync, closeSync, mkdirSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Command, CommanderError } from 'commander'
import { ensureHome, loadConfig, policyOf, projectsForRuntime, replyAlwaysChatsOf, setConfigValue, writeConfig, type AppConfig, type PolicyResolution } from '../config.js'
import { Store, type SessionMigrationState } from '../store/db.js'
import { Engine } from '../core/engine.js'
import { shouldAcknowledge } from '../core/policy.js'
import { createRuntimes } from '../worker/registry.js'
import { AcpRuntimeAdmin } from '../worker/runtimes/acp/admin.js'
import { readDetectionSnapshot } from '../worker/runtimes/acp/detect.js'
import { WORKER_RUNTIME_IDS, normalizeRuntimeId } from '../worker/runtimes/catalog.js'
import { GitHubTracker } from '../sources/github.js'
import { GitLabTracker } from '../sources/gitlab.js'
import { ForgeTracker } from '../sources/forge-tracker.js'
import { createFeishuChannel, createFeishuDocumenter } from '../channels/feishu/index.js'
import { ChannelIngress } from '../channels/ingress.js'
import { ChannelRegistry } from '../channels/registry.js'
import { ChannelRouter } from '../channels/router.js'
import { ChatDirectory } from '../sources/feishu-directory.js'
import { resolveRuntimeIdentity, detailText, type IdentityCache, type IdentityStatusView, type RuntimeIdentity } from '../sources/feishu-identity.js'
import { createLarkRunner, larkEnv } from '../sources/lark.js'
import { parseMessageThreadIds } from '../sources/feishu.js'
import { createVisionTranscriber, type ImageTranscriber } from '../infra/vision.js'
import { runInitWizard } from './init.js'
import { formatChecks, runDoctor } from './doctor.js'
import { cmdRuntimeCheck, cmdRuntimeInstall, cmdRuntimeList, cmdRuntimeLogin, cmdRuntimeUninstall } from './runtime.js'
import { PACKAGE_NAME, PACKAGE_VERSION, UpdateService, runNpmUpgrade } from '../update/index.js'
import { simulate } from './simulate.js'
import { runReport, readContentArg, type ReportOptions } from './report.js'
import type { Prompter } from './prompts.js'
import { realRunner, type CommandRunner } from '../infra/process.js'
import { errorMessage } from '../infra/logger.js'
import { resolveImageModelConfig, resolvePiModelConfig, type PiModelConfig } from '../router/model-config.js'
import { createDecisionEngine } from '../router/engine-factory.js'
import type { DecisionAudit } from '../router/decision-engine.js'
import type { WorkerStateFile } from '../worker/report-poller.js'
import { RouterService, type Logger } from '../service.js'
import { EffectsProcessor } from '../core/effects.js'
import { createApiServer, emptyIdentityStatus, type IdentityPort } from '../router/api.js'
import { ProjectSetup } from '../router/project-setup.js'

// 版本号以 package.json 为唯一来源（见 src/update/index.ts），`ra -v` 与更新检查共用同一个值。
export const VERSION: string = PACKAGE_VERSION

export interface CliIo {
  stdout(line: string): void
  stderr(line: string): void
  env: Record<string, string | undefined>
  /** 交互式初始化用；不存在时退化为非交互。 */
  prompts?: Prompter
  /** 测试注入点；默认用真实 orca / claude / git / lark-cli。 */
  orca?: CommandRunner
  claude?: CommandRunner
  git?: CommandRunner
  /** 已绑定固定 lark-cli profile 的 runner（测试注入点）。 */
  lark?: CommandRunner
  /** npm 命令（测试注入点）；默认用系统 npm。 */
  npm?: CommandRunner
  /** 交互式接管终端的 lark-cli 命令（新建应用、用户授权）。 */
  stream?: (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>
  /** 打开浏览器（测试注入点）；返回是否成功发起，默认按平台调用 open / xdg-open / start。 */
  openUrl?: (url: string) => boolean
}

export async function runCli(argv: string[], output: CliIo): Promise<number> {
  let code = 0
  const program = buildProgram(output, next => { code = next })
  if (argv.length === 0) {
    output.stderr(program.helpInformation())
    return 2
  }
  try {
    await program.parseAsync(argv, { from: 'user' })
    return code
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return 0
      return error.exitCode || 1
    }
    output.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function buildProgram(output: CliIo, setCode: (code: number) => void): Command {
  const program = new Command('ra')
  program
    .description('router-agent：飞书消息 → Router 研判 → Orca worktree 执行 → PR 闭环')
    .version(VERSION, '-v, --version', '显示版本')
    .exitOverride()
    .showHelpAfterError('（运行 ra --help 查看全部命令）')
    .configureOutput({
      writeOut: text => output.stdout(text.replace(/\n$/, '')),
      writeErr: text => output.stderr(text.replace(/\n$/, '')),
    })
    .addHelpText('after', `
示例:
  ra init
  ra tickets --stage blocked
  ra config set policy.acceptMode observe
  ra config set project.router-agent "name:dsh/router-agent@main"
  ra config set chatBinding.oc_xxx "router-agent@main"
  ra config --edit`)

  withHome(program.command('init').description('交互式初始化：仓库 → 飞书凭据 → 群 → 授权成员'))
    .option('--yes', '跳过提问，只写默认配置')
    .action(async (opts: { home?: string; yes?: boolean }) => {
      setCode(await cmdInit(homeOf(opts, output), opts, output))
    })

  withHome(program.command('doctor').description('启动前自检：配置 / Orca / 飞书 / 模型 / 端口'))
    .option('--json', '以 JSON 输出')
    .action(async (opts: { home?: string; json?: boolean }) => {
      setCode(await cmdDoctor(homeOf(opts, output), opts, output))
    })

  withHome(program.command('runtime [action] [id]')
    .description('Worker 运行时：list / check / install / uninstall / login（含 ACP 与 codex-app）'))
    .option('--json', 'list / check 以 JSON 输出')
    .option('--version <version>', 'install 指定版本（默认用目录里 pinned 的版本）')
    .action(async (action: string | undefined, id: string | undefined, opts: { home?: string; json?: boolean; version?: string }) => {
      const home = homeOf(opts, output)
      ensureHome(home)
      const io = { stdout: output.stdout, stderr: output.stderr, env: output.env }
      switch (action ?? 'list') {
        case 'list':
          setCode(await cmdRuntimeList(home, opts, io))
          return
        case 'check':
          if (!id) {
            output.stderr('用法：ra runtime check <id>')
            setCode(2)
            return
          }
          setCode(await cmdRuntimeCheck(home, id, io))
          return
        case 'install':
          if (!id) {
            output.stderr('用法：ra runtime install <id> [--version <v>]')
            setCode(2)
            return
          }
          setCode(await cmdRuntimeInstall(home, id, opts, io))
          return
        case 'uninstall':
          if (!id) {
            output.stderr('用法：ra runtime uninstall <id>')
            setCode(2)
            return
          }
          setCode(await cmdRuntimeUninstall(home, id, io))
          return
        case 'login':
          if (!id) {
            output.stderr('用法：ra runtime login <id>')
            setCode(2)
            return
          }
          setCode(await cmdRuntimeLogin(home, id, io))
          return
        default:
          output.stderr(`未知操作 runtime ${action}；可用：list / check / install / uninstall / login`)
          setCode(2)
      }
    })

  withHome(program.command('update')
    .description('检查并升级到 npm 最新版（默认升级后自动重启服务）'))
    .option('--check', '只检查是否有新版本，不安装')
    .option('--json', '以 JSON 输出检查 / 升级结果')
    .option('--no-restart', '升级成功后不自动重启服务')
    .option('--registry <url>', 'npm registry（默认读 RA_NPM_REGISTRY / npm_config_registry）')
    .option('--force', '源码 / 本地 link 运行时仍执行 npm 全局安装')
    .action(async (opts: { home?: string; check?: boolean; json?: boolean; restart?: boolean; registry?: string; force?: boolean }) => {
      setCode(await cmdUpdate(homeOf(opts, output), opts, output))
    })

  withHome(program.command('simulate').description('本地模拟一条消息，验证 Gate + 研判（不派工）'))
    .requiredOption('--text <text>', '消息内容')
    .option('--chat <chatId>', '指定群 chat_id（默认取配置里的第一个群）')
    .option('--actor <openId>', '指定发送人（默认取 allowed 里的第一个人）')
    .option('--infer', '按未 @ 的推断候选处理（会走 LLM 研判）')
    .option('--dry-run', '不写数据库')
    .action(async (opts: { home?: string; text: string; chat?: string; actor?: string; infer?: boolean; dryRun?: boolean }) => {
      setCode(await cmdSimulate(homeOf(opts, output), opts, output))
    })

  withHome(program.command('report').description('Worker 上报状态与回复：POST 给本地 Router，服务不可用时落回 state.json'))
    .requiredOption('--ticket <id>', '工单 ID')
    .requiredOption('--state <state>', 'progress | waiting | ready | blocked | failed | dropped')
    .requiredOption('--summary <text>', '一句话摘要（给日志和列表用）')
    .option('--assignment <id>', '派工 ID（默认取该工单最新派工）')
    .option('--turn <n>', '轮次（默认由 Router 自增）')
    .option('--human-action <text>', 'blocked 时要人做的事')
    .option('--pr-number <n>', 'PR 编号')
    .option('--pr-url <url>', 'PR 链接')
    .option('--ui-change [value]', '声明本次改动是否涉及 UI（true / false）；不传由 Router 按改动文件推断')
    .option('--reply <text>', '要发给发起人的完整回复：字面量 / @文件 / - 读 stdin')
    .option('--ack <id>', '确认已读的输入 ID，可重复', collect, [])
    .option('--port <n>', 'Router 端口（默认读 config/server.port 或 RA_PORT）')
    .action(async (opts: ReportOptions & { home?: string; port?: string }) => {
      setCode(await cmdReport(homeOf(opts, output), opts, output))
    })

  withHome(program.command('doc').description('创建飞书文档并输出链接（worker 沉淀长结论用，链接写进 --reply）'))
    .requiredOption('--title <title>', '文档标题')
    .option('--content <text>', '正文：字面量 / @文件 / - 读 stdin')
    .action(async (opts: { home?: string; title: string; content?: string }) => {
      setCode(await cmdDoc(homeOf(opts, output), opts, output))
    })

  withHome(program.command('migrate [action]')
    .description('数据迁移：migrate sessions | threads --dry-run | --apply | --verify（人工手动执行）')
    .option('--dry-run', '只读检查，不写库（默认行为）')
    .option('--apply', '执行迁移；默认要求交互确认，非交互环境需 --yes')
    .option('--verify', '迁移后校验')
    .option('--yes', '跳过交互确认'))
    .action(async (action: string | undefined, opts: { home?: string; dryRun?: boolean; apply?: boolean; verify?: boolean; yes?: boolean }) => {
      setCode(await cmdMigrate(homeOf(opts, output), action, opts, output))
    })

  withHome(program.command('start').description('启动常驻 Router 服务（默认后台），就绪后自动打开 Web 初始化页'))
    .option('--foreground', '前台运行，便于调试')
    .option('--no-open', '不自动打开浏览器，只打印 Web 面板地址')
    .action(async (opts: { home?: string; foreground?: boolean; open?: boolean }) => {
      setCode(await cmdStart(homeOf(opts, output), opts, output))
    })

  withHome(program.command('stop').description('停止服务'))
    .action((opts: { home?: string }) => setCode(cmdStop(homeOf(opts, output), output)))

  withHome(program.command('status').description('服务状态与工单概览'))
    .action((opts: { home?: string }) => setCode(cmdStatus(homeOf(opts, output), output)))

  withHome(program.command('web').description('打开 Web 面板'))
    .action((opts: { home?: string }) => setCode(cmdWeb(homeOf(opts, output), output)))

  withHome(program.command('tickets').description('按阶段列出工单'))
    .option('--stage <stage>', '按阶段过滤：todo/running/review/blocked/done')
    .option('--limit <n>', '返回条数', '200')
    .action((opts: { home?: string; stage?: string; limit?: string }) => {
      setCode(cmdTickets(homeOf(opts, output), opts, output))
    })

  withHome(program.command('ticket <id>').description('查看工单详情；--stop 停止该工单'))
    .option('--stop', '停止这张工单（服务在运行时会一并关闭 worker 终端）')
    .action(async (id: string, opts: { home?: string; stop?: boolean }) => {
      setCode(opts.stop ? await cmdTicketStop(homeOf(opts, output), id, output) : cmdTicket(homeOf(opts, output), id, output))
    })

  withHome(program.command('logs').description('查看最近 50 行服务日志'))
    .option('--follow', '持续跟踪（需前台终端）')
    .action(async (opts: { home?: string; follow?: boolean }) => setCode(await cmdLogs(homeOf(opts, output), opts, output)))

  withHome(program.command('config [action] [key] [value]').description('查看配置；config set <key> <value> 修改；config edit 编辑'))
    .addHelpText('after', `
示例:
  ra config                      查看全部配置
  ra config set policy.acceptMode observe
  ra config set project.router-agent "name:dsh/router-agent@main"
  ra config set chatBinding.oc_xxx "router-agent@main"
  ra config edit                 用 $EDITOR 打开`)
    .action(async (action: string | undefined, key: string | undefined, value: string | undefined, opts: { home?: string }) => {
      const home = homeOf(opts, output)
      if (action === 'set') {
        if (!key || value === undefined) {
          output.stderr('用法: ra config set <key> <value>')
          setCode(2)
          return
        }
        setCode(cmdConfigSet(home, key, value, output))
        return
      }
      if (action === 'edit') {
        setCode(await cmdConfigEdit(home, output))
        return
      }
      if (action) {
        output.stderr(`未知的 config 子命令: ${action}（可用 set / edit）`)
        setCode(2)
        return
      }
      setCode(cmdConfig(home, output))
    })

  withHome(program.command('serve', { hidden: true }).description('前台运行（start 内部调用）'))
    .action(async (opts: { home?: string }) => setCode(await cmdServe(homeOf(opts, output), output)))

  return program
}

function withHome(command: Command): Command {
  return command.option('--home <dir>', '状态目录（默认 ~/.router-agent 或 RA_HOME）')
}

function homeOf(opts: { home?: string }, output: CliIo): string {
  return resolve(opts.home ?? output.env.RA_HOME ?? join(output.env.HOME ?? homedir(), '.router-agent'))
}

async function cmdDoctor(home: string, opts: { json?: boolean }, output: CliIo): Promise<number> {
  ensureHome(home)
  const config = loadConfig(home, output.env as NodeJS.ProcessEnv)
  const lark = output.lark ?? createLarkRunner()
  let runtime: import('../worker/port.js').WorkerRuntime | undefined
  let runtimeError: string | undefined
  try {
    runtime = createRuntimes(config, {
      home,
      workersDir: join(home, 'workers'),
      orca: output.orca ?? realRunner('orca'),
      claude: output.claude ?? realRunner('claude'),
      git: output.git ?? realRunner('git'),
      logger: createLogger(home, output, false),
    }).default()
  } catch (error) {
    // 未注册/拼错的 runtime 由配置检查单独报错，不让 doctor 直接崩溃。
    runtimeError = error instanceof Error ? error.message : String(error)
  }
  const admin = new AcpRuntimeAdmin({ home, env: output.env as NodeJS.ProcessEnv, config })
  const snapshot = await admin.detect().catch(() => admin.snapshot())
  const checks = await runDoctor({
    config,
    orca: output.orca ?? realRunner('orca'),
    lark,
    ...(runtime ? { runtime } : {}),
    ...(snapshot ? { runtimeChoices: snapshot.choices } : {}),
    llm: () => {
      try {
        const resolved = resolvePiModelConfig({ configPath: join(home, 'config.yaml') })
        return { ok: true, detail: `${resolved.model} @ ${resolved.baseUrl}` }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    },
    portFree: () => isPortFree(config.server.port),
    servicePid: readPid(home),
  })
  if (!runtime) {
    checks.unshift({
      name: 'Worker runtime',
      status: 'fail' as const,
      detail: runtimeError ?? `未注册 runtime: ${config.runtime.default}`,
      hint: `ra config set runtime.default ${WORKER_RUNTIME_IDS.join('|')}`,
    })
  }
  if (opts.json) {
    output.stdout(JSON.stringify(checks, null, 2))
  } else {
    for (const line of formatChecks(checks)) output.stdout(line)
    const failed = checks.filter(check => check.status === 'fail').length
    output.stdout('')
    output.stdout(failed === 0 ? '自检通过，可以 ra start。' : `有 ${failed} 项未通过，按上面的建议修一下。`)
  }
  return checks.some(check => check.status === 'fail') ? 1 : 0
}

async function cmdReport(home: string, opts: ReportOptions & { port?: string; uiChange?: boolean | string }, output: CliIo): Promise<number> {
  const config = loadConfig(home)
  const envPort = Number(output.env.RA_PORT)
  const port = Number(opts.port) > 0 ? Number(opts.port) : (Number.isFinite(envPort) && envPort > 0 ? envPort : config.server.port)
  const { uiChange: rawUiChange, ...rest } = opts
  const uiChange = parseUiChange(rawUiChange)
  if (uiChange === null) {
    output.stderr('--ui-change 只接受 true / false')
    return 2
  }
  return runReport(
    { home, port, stdout: output.stdout, stderr: output.stderr },
    { ...rest, ...(uiChange !== undefined ? { uiChange } : {}) },
  )
}

/** `--ui-change` 不带值视为 true；带值时只认 true/false（含 yes/no/1/0）。 */
function parseUiChange(value: boolean | string | undefined): boolean | undefined | null {
  if (value === undefined) return undefined
  if (value === true || value === false) return value
  const text = String(value).trim().toLowerCase()
  if (text === 'true' || text === 'yes' || text === '1') return true
  if (text === 'false' || text === 'no' || text === '0') return false
  return null
}

async function cmdDoc(_home: string, opts: { title: string; content?: string }, output: CliIo): Promise<number> {
  const content = readContentArg({}, opts.content).trim()
  if (!content) {
    output.stderr('--content 不能为空（可用 @文件 或 - 从 stdin 读）')
    return 2
  }
  const documenter = createFeishuDocumenter({ runner: output.lark ?? createLarkRunner() })
  try {
    const url = await documenter.createDocument(opts.title, content)
    output.stdout(url)
    return 0
  } catch (error) {
    output.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

async function cmdSimulate(
  home: string,
  opts: { text: string; chat?: string; actor?: string; infer?: boolean; dryRun?: boolean },
  output: CliIo,
): Promise<number> {
  ensureHome(home)
  const config = loadConfig(home, output.env as NodeJS.ProcessEnv)
  let model
  try {
    model = resolvePiModelConfig({ configPath: join(home, 'config.yaml') })
  } catch (error) {
    output.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
  const decisionEngine = (store: Store, engine: Engine) => createDecisionEngine({ config, store, model, engine })

  // 名单是邮箱时必须先解析成 open_id，否则模拟出来的准入判断与线上不一致。
  const identity = await resolveIdentityForCli(home, config, output.lark ?? createLarkRunner(), createLogger(home, output, false))

  const result = await simulate(
    { home, config, decisionEngine, ...(identity ? { identity: policyResolutionOf(identity) } : {}) },
    {
      text: opts.text,
      ...(opts.chat ? { chatId: opts.chat } : {}),
      ...(opts.actor ? { actorId: opts.actor } : {}),
      ...(opts.infer ? { addressed: 'none' as const } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
    },
  )

  output.stdout(`模拟消息: ${result.trigger.id}  (addressed=${result.trigger.addressed}, actor=${result.trigger.actorId})`)
  for (const audit of result.audits) {
    output.stdout(`研判: ${audit.engine}  ${audit.durationMs}ms  tokens=${audit.tokens.total}  tools=${audit.toolCalls.length}${audit.unavailableReason ? `  unavailable=${audit.unavailableReason}` : ''}`)
  }
  if (!result.decision) {
    output.stdout('没有产生决定（消息被 Source 过滤或仍在等待）')
    return 0
  }
  output.stdout(`决定: ${result.decision.decision}  (${result.decision.strength})${result.decision.wouldAccept ? '  ← observe 模式下本应接单' : ''}`)
  output.stdout(`理由: ${result.decision.reason}`)
  if (result.ticket) {
    output.stdout(`工单: ${result.ticket.id}`)
    output.stdout(`标题: ${result.ticket.title}`)
    output.stdout(`派工: ${result.ticket.repo || '(未指定)'} @ ${result.ticket.branch || '(未指定分支)'}`)
  }
  if (result.replies.length > 0) {
    output.stdout('会发出的回复:')
    for (const reply of result.replies) output.stdout(`  - ${reply}`)
  }
  output.stdout('下一步: ra tickets 查看；ra start 让它真正派工')
  return 0
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const server = createServer()
    server.once('error', () => resolvePromise(false))
    server.once('listening', () => server.close(() => resolvePromise(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function cmdInit(home: string, opts: { yes?: boolean }, output: CliIo): Promise<number> {
  ensureHome(home)
  await runInitWizard({
    home,
    env: output.env,
    stdout: line => output.stdout(line),
    ...(opts.yes || !output.prompts ? {} : { prompts: output.prompts }),
    orca: output.orca ?? realRunner('orca'),
    lark: output.lark ?? createLarkRunner(),
    ...(output.stream ? { stream: output.stream } : {}),
  })

  output.stdout('')
  output.stdout(`状态目录: ${home}`)
  return 0
}

function openStore(home: string): Store {
  ensureHome(home)
  return new Store(join(home, 'state.db'))
}

/**
 * 历史 sessionKey 迁移：只由人手动执行，不在服务启动时自动写库。
 *
 * 迁移只把 `chat:...` 前缀改成 `channel:feishu:chat:...`，会话文件不动；
 * 异常 key 不猜、不改，列出来交给人确认。
 */
async function cmdMigrate(
  home: string,
  action: string | undefined,
  opts: { dryRun?: boolean; apply?: boolean; verify?: boolean; yes?: boolean },
  output: CliIo,
): Promise<number> {
  if (action === 'threads') return cmdMigrateThreads(home, opts, output)
  if (action !== 'sessions') {
    output.stderr('用法：ra migrate <sessions|threads> [--dry-run | --apply | --verify]')
    return 2
  }
  const store = openStore(home)
  const logger = createLogger(home, output)
  try {
    if (opts.apply) {
      const state = store.sessionMigrationState()
      if (state.applied && state.pendingSessions === 0) {
        output.stdout('该迁移已执行过，无需重复执行。')
        return 0
      }
      if (state.applied && state.pendingSessions > 0) {
        output.stderr(`迁移记录已存在，但仍有 ${state.pendingSessions} 条旧格式 key，请人工检查后再处理。`)
        return 1
      }
      printSessionMigrationState(state, output)
      if (state.anomalies.length > 0) {
        output.stdout(`注意：${state.anomalies.length} 条异常 key 不会被迁移，请人工确认后再单独处理。`)
      }
      if (!opts.yes) {
        const confirmed = output.prompts
          ? await output.prompts.confirm({
            message: `确认迁移 ${state.pendingSessions} 条会话记录、${state.pendingResets} 条重置记录？`,
            default: false,
          })
          : false
        if (!confirmed) {
          output.stderr('已取消，未写入任何数据。非交互环境请显式传 --yes。')
          return 1
        }
      }
      const result = (() => {
        try {
          return store.applySessionKeyMigration(new Date().toISOString())
        } catch (error) {
          logger.error('session:migration-failed', { message: errorMessage(error) })
          output.stderr(`迁移失败，事务已回滚：${errorMessage(error)}`)
          return null
        }
      })()
      if (!result) return 1
      logger.info('session:migrated', { sessions: result.sessions, resets: result.resets })
      output.stdout(`迁移完成：会话 ${result.sessions} 条，重置记录 ${result.resets} 条。`)
      const verify = store.verifySessionKeyMigration()
      if (!verify.ok) {
        output.stderr(`迁移后校验未通过：待迁移 ${verify.pendingSessions}，异常 ${verify.anomalies}。`)
        logger.error('session:migration-verify-failed', { ...verify })
        return 1
      }
      output.stdout('校验通过：全部 sessionKey 已为新格式。')
      return 0
    }

    if (opts.verify) {
      const verify = store.verifySessionKeyMigration()
      output.stdout(`迁移记录：${verify.applied ? '已执行' : '未执行'}`)
      output.stdout(`会话总数：${verify.totalSessions}`)
      output.stdout(`待迁移：${verify.pendingSessions}`)
      output.stdout(`待迁移重置记录：${verify.pendingResets}`)
      output.stdout(`异常 key：${verify.anomalies}`)
      if (verify.ok) {
        output.stdout('校验通过。')
        return 0
      }
      logger.warn('session:migration-incomplete', { ...verify })
      output.stderr('校验未通过，请按上面的计数处理后再试。')
      return 1
    }

    // 默认与 --dry-run 都是只读。
    printSessionMigrationState(store.sessionMigrationState(), output)
    output.stdout('未写入任何数据。确认后执行：ra migrate sessions --apply')
    return 0
  } finally {
    store.close()
  }
}

/** `+messages-mget` 单次最多查 50 条消息。 */
const MGET_BATCH = 50

/**
 * 线程别名回填：给存量线程补上话题 ID（omt_）。
 *
 * 老线程用根消息 ID（om_）当线程 ID；飞书在话题面板里直接发言时事件只带话题 ID，
 * 不回填的话这类消息仍然匹配不上已有工单。只由人手动执行，默认 dry-run 不写库。
 */
async function cmdMigrateThreads(
  home: string,
  opts: { dryRun?: boolean; apply?: boolean; verify?: boolean; yes?: boolean },
  output: CliIo,
): Promise<number> {
  const store = openStore(home)
  const logger = createLogger(home, output)
  try {
    const total = store.listThreads('feishu').length
    const backlog = store.threadAliasBacklog('feishu')

    if (opts.verify) {
      output.stdout(`飞书线程总数：${total}`)
      output.stdout(`待回填话题 ID：${backlog.length}`)
      if (backlog.length === 0) {
        output.stdout('校验通过：所有线程都已登记话题 ID 别名。')
        return 0
      }
      logger.warn('thread:backfill-incomplete', { total, pending: backlog.length })
      output.stderr('仍有线程缺少话题 ID 别名，请执行：ra migrate threads --apply')
      return 1
    }

    output.stdout(`飞书线程总数：${total}`)
    output.stdout(`待回填话题 ID：${backlog.length}`)
    if (backlog.length === 0) {
      output.stdout('没有需要回填的线程。')
      return 0
    }
    for (const thread of backlog.slice(0, 5)) output.stdout(`  ${thread.id}（根 ${thread.rootId}）`)
    if (backlog.length > 5) output.stdout(`  ... 另有 ${backlog.length - 5} 条`)

    if (!opts.apply) {
      output.stdout('未写入任何数据。确认后执行：ra migrate threads --apply')
      return 0
    }
    if (!opts.yes) {
      const confirmed = output.prompts
        ? await output.prompts.confirm({ message: `确认回填 ${backlog.length} 条线程的话题 ID 别名？`, default: false })
        : false
      if (!confirmed) {
        output.stderr('已取消，未写入任何数据。非交互环境请显式传 --yes。')
        return 1
      }
    }

    // 先把每个线程的根消息 ID 登记为自身别名，保证老消息按根 ID 也能命中；INSERT OR IGNORE 幂等。
    for (const thread of store.listThreads('feishu')) {
      store.registerThreadAlias({ source: 'feishu', alias: thread.rootId, threadId: thread.id, createdAt: thread.createdAt })
    }

    const lark = output.lark ?? createLarkRunner()
    const roots = backlog.map(thread => thread.rootId)
    let filled = 0
    let failed = 0
    for (let i = 0; i < roots.length; i += MGET_BATCH) {
      const batch = roots.slice(i, i + MGET_BATCH)
      const res = await lark.run(['im', '+messages-mget', '--message-ids', batch.join(','), '--as', 'bot', '--format', 'json'])
      if (res.code !== 0) {
        failed += batch.length
        logger.warn('thread:backfill-failed', { batch: batch.length, code: res.code, message: res.stderr.slice(0, 200) })
        continue
      }
      const topicIds = parseMessageThreadIds(res.stdout)
      for (const thread of backlog.filter(item => batch.includes(item.rootId))) {
        const topicId = topicIds.get(thread.rootId)
        if (!topicId) {
          failed += 1
          continue
        }
        store.registerThreadAlias({ source: 'feishu', alias: topicId, threadId: thread.id, createdAt: thread.createdAt })
        filled += 1
      }
    }

    logger.info('thread:backfilled', { filled, failed })
    output.stdout(`回填完成：${filled} 条，失败 ${failed} 条。`)
    if (failed > 0) {
      output.stderr('部分线程没有查到话题 ID（消息可能已删除或无权限），这些线程仍只能按根消息 ID 归并。')
      return 1
    }
    return 0
  } finally {
    store.close()
  }
}

function printSessionMigrationState(state: SessionMigrationState, output: CliIo): void {
  output.stdout(`迁移记录：${state.applied ? '已执行' : '未执行'}`)
  output.stdout(`会话记录：共 ${state.totalSessions} 条，待迁移 ${state.pendingSessions} 条，已迁移 ${state.migratedSessions} 条`)
  output.stdout(`重置记录：共 ${state.totalResets} 条，待迁移 ${state.pendingResets} 条`)
  if (state.anomalies.length > 0) {
    output.stdout(`异常 key：${state.anomalies.length} 条（不会自动修改）`)
    for (const item of state.anomalies.slice(0, 3)) {
      output.stdout(`  [${item.table}] ${item.sessionKey}`)
    }
    if (state.anomalies.length > 3) output.stdout('  ...')
  }
}

function cmdTickets(home: string, opts: { stage?: string; limit?: string }, output: CliIo): number {
  const store = openStore(home)
  try {
    const limit = Number(opts.limit ?? 200)
    const tickets = store.listTickets({ ...(opts.stage ? { stage: opts.stage as never } : {}), limit: Number.isFinite(limit) ? limit : 200 })
    if (tickets.length === 0) {
      output.stdout(opts.stage ? `暂无工单（stage=${opts.stage}）` : '暂无工单')
      return 0
    }
    output.stdout('ID\t阶段\t标题\tPR')
    for (const t of tickets) output.stdout(`${t.id}\t${t.stage}\t${t.title}\t${t.prUrl || '-'}`)
    return 0
  } finally {
    store.close()
  }
}

function cmdTicket(home: string, ticketId: string, output: CliIo): number {
  const store = openStore(home)
  try {
    const ticket = store.getTicket(ticketId)
    if (!ticket) {
      output.stderr(`未找到工单: ${ticketId}`)
      return 1
    }
    const mandate = store.getMandate(ticket.mandateId)
    const assignment = store.latestAssignment(ticket.id)
    const reports = store.listReports(ticket.id, 5)
    const inputs = store.listInputs(ticket.id)
    output.stdout(`工单: ${ticket.id}`)
    output.stdout(`标题: ${ticket.title}`)
    output.stdout(`阶段: ${ticket.stage}`)
    output.stdout(`仓库: ${ticket.repo || '(未指定)'} @ ${ticket.branch || '(未指定分支)'}`)
    output.stdout(`会话: ${ticket.threadId}`)
    output.stdout(`PR: ${ticket.prUrl || '-'} (${ticket.prState})`)
    if (mandate) {
      output.stdout(`授权强度: ${mandate.strength}`)
      output.stdout(`授权范围: ${mandate.scope}`)
      output.stdout(`策略版本: ${mandate.policyVersion}`)
    }
    if (assignment) {
      output.stdout(`派工: ${assignment.id} handle=${assignment.handle || '-'} status=${assignment.status}`)
      output.stdout(`目录: ${assignment.workdir || '-'}`)
    }
    if (reports.length > 0) {
      output.stdout('最近上报:')
      for (const r of reports) {
        output.stdout(`  [${r.state}] turn=${r.turn} ${r.summary}`)
        if (r.reply) {
          const lines = r.reply.split('\n')
          output.stdout(`    回复: ${r.reply.length} 字`)
          for (const line of lines.slice(0, 40)) output.stdout(`    | ${line}`)
          if (lines.length > 40) output.stdout(`    | …（共 ${lines.length} 行，完整内容见 state.json / web 面板）`)
        }
      }
    }
    if (inputs.length > 0) {
      output.stdout('输入:')
      for (const i of inputs) output.stdout(`  #${i.seq} ${i.status} ${i.text}`)
    }
    return 0
  } finally {
    store.close()
  }
}

async function cmdTicketStop(home: string, ticketId: string, output: CliIo): Promise<number> {
  const config = loadConfig(home)
  try {
    const res = await fetch(`http://127.0.0.1:${config.server.port}/api/tickets/${ticketId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'ra ticket --stop' }),
    })
    if (res.ok) {
      output.stdout(`已停止 ${ticketId}（worker 终端与 workspace 正在回收）`)
      return 0
    }
    output.stderr(`服务返回 ${res.status}，改为直接写库停止`)
  } catch {
    output.stderr('服务未运行，直接写库停止（worker 终端可能仍在，需手动关闭）')
  }

  const store = openStore(home)
  try {
    const ticket = store.getTicket(ticketId)
    if (!ticket) {
      output.stderr(`未找到工单: ${ticketId}`)
      return 1
    }
    if (ticket.stage === 'done') {
      output.stdout(`工单已关闭: ${ticketId}`)
      return 0
    }
    // 这里只用 Engine 关工单，stopTicket 不看允许名单：不解析身份，
    // 免得「停工单」这种应急操作还要先连通讯录、卡在超时上。
    const engine = new Engine({ store, policy: policyOf(config) })
    const stopped = engine.stopTicket(ticketId, 'ra ticket --stop')
    // 服务未运行时先把回收任务落到 effects 队列，下次启动会按同一套逻辑删 worktree。
    const now = new Date().toISOString()
    const suffix = (stopped.closedAt ?? now).replace(/[^0-9a-zA-Z]/g, '')
    store.enqueueEffect({
      id: `ef_cleanup_${ticketId}_${suffix}`,
      key: `cleanup-workspace:${ticketId}:${stopped.closedAt ?? now}`,
      kind: 'cleanup-workspace',
      payload: { ticketId },
      now,
    })
    output.stdout(`已停止 ${ticketId}；workspace 回收已排队，服务启动后执行`)
    return 0
  } finally {
    store.close()
  }
}

function cmdStatus(home: string, output: CliIo): number {
  const pid = readPid(home)
  output.stdout(`版本：v${PACKAGE_VERSION}`)
  output.stdout(!pid || !alive(pid) ? 'Router 服务：未运行' : `Router 服务：运行中 (pid ${pid})`)
  const store = openStore(home)
  try {
    const tickets = store.listTickets({ limit: 500 })
    const open = tickets.filter(t => t.stage !== 'done').length
    output.stdout(`工单：开工 ${open} / 总计 ${tickets.length}`)
    for (const t of tickets.filter(t => t.stage !== 'done').slice(0, 10)) {
      output.stdout(`  - [${t.stage}] ${t.title}`)
    }
    const config = loadConfig(home)
    output.stdout(`accept mode: ${config.policy.acceptMode}，并发上限: ${config.policy.maxWorkers}，运行时: ${config.runtime.default}`)
    output.stdout(
      config.retention.enabled
        ? `闲置治理: 开启（${config.retention.idleHours}h 无进展提醒，${config.retention.closeGraceHours}h 未回复自动关闭）`
        : '闲置治理: 关闭',
    )
    output.stdout(
      config.workspace.enabled
        ? `工作区回收: 开启（关单后保留 ${config.workspace.keepHours}h，由定时任务回收）`
        : '工作区回收: 关闭（只能手动回收）',
    )
    return 0
  } finally {
    store.close()
  }
}

function cmdConfig(home: string, output: CliIo): number {
  ensureHome(home)
  const path = join(home, 'config.yaml')
  output.stdout(`配置文件: ${path}`)
  output.stdout(readFileSync(path, 'utf8'))
  output.stdout('修改单项: ra config set <key> <value>；编辑全文: ra config edit')
  return 0
}

function cmdConfigSet(home: string, key: string, value: string, output: CliIo): number {
  ensureHome(home)
  const path = join(home, 'config.yaml')
  const config = loadConfig(home, output.env as NodeJS.ProcessEnv)
  if (!setConfigValue(config, key, value)) {
    output.stderr(`未知配置项或非法值: ${key} = ${value}`)
    output.stderr('示例: ra config set policy.acceptMode observe')
    return 1
  }
  writeConfig(home, config)
  // 密钥类字段不回显明文，避免进 shell 历史 / 日志。
  output.stdout(key === 'llm.apiKey' ? `${key} = ******` : `${key} = ${value}`)
  output.stdout(`已写入 ${path}`)
  return 0
}

async function cmdConfigEdit(home: string, output: CliIo): Promise<number> {
  ensureHome(home)
  const editor = output.env.EDITOR ?? output.env.VISUAL ?? 'vi'
  const child = spawn(editor, [join(home, 'config.yaml')], { stdio: 'inherit' })
  return new Promise<number>(resolvePromise => child.on('close', code => resolvePromise(code ?? 0)))
}

async function cmdLogs(home: string, opts: { follow?: boolean }, output: CliIo): Promise<number> {
  const path = join(home, 'logs', 'router-agent.log')
  if (!existsSync(path)) {
    output.stdout('暂无日志')
    return 0
  }
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
  for (const line of lines.slice(-50)) output.stdout(line)
  if (!opts.follow) return 0

  // --follow：从当前文件末尾持续输出新行，Ctrl-C 退出。
  output.stdout('（跟踪中，Ctrl-C 退出）')
  const stop = followFile(path, line => output.stdout(line))
  return new Promise<number>(resolvePromise => {
    const end = (): void => {
      stop()
      process.off('SIGINT', end)
      process.off('SIGTERM', end)
      resolvePromise(0)
    }
    process.on('SIGINT', end)
    process.on('SIGTERM', end)
  })
}

/**
 * 从文件当前末尾持续读新行。返回 stop()。
 * 刻意返回可清除的 timer 而不 unref：调用方负责保持进程存活。
 */
export function followFile(path: string, output: (line: string) => void, intervalMs = 400): () => void {
  let offset = statSync(path).size
  const timer = setInterval(() => {
    try {
      const size = statSync(path).size
      if (size <= offset) return
      const fd = openSync(path, 'r')
      const buffer = Buffer.alloc(size - offset)
      readSync(fd, buffer, 0, buffer.length, offset)
      closeSync(fd)
      offset = size
      for (const line of buffer.toString('utf8').split('\n')) {
        if (line.trim()) output(line)
      }
    } catch {
      // 文件轮转时忽略本轮
    }
  }, intervalMs)
  return () => clearInterval(timer)
}

async function cmdUpdate(
  home: string,
  opts: { check?: boolean; json?: boolean; restart?: boolean; registry?: string; force?: boolean },
  output: CliIo,
): Promise<number> {
  ensureHome(home)
  // --json 时日志只落文件：stdout 必须只留一行可解析的 JSON。
  const logger = createLogger(home, output, !opts.json)
  const service = new UpdateService({
    current: PACKAGE_VERSION,
    registry: opts.registry,
    logger,
    runUpgrade: ({ version }) => runNpmUpgrade({
      version,
      runner: output.npm,
      env: { ...process.env, ...output.env },
    }),
  })

  const snapshot = opts.check ? await service.check(true) : await service.upgrade({ force: opts.force })

  if (opts.json) {
    output.stdout(JSON.stringify(snapshot))
    return snapshot.phase === 'failed' || snapshot.error === 'check-failed' ? 1 : 0
  }

  if (snapshot.error === 'check-failed') {
    output.stderr(snapshot.message ?? '检查更新失败')
    return 1
  }

  output.stdout(`当前版本：v${snapshot.current}`)
  if (opts.check) {
    if (!snapshot.latest) {
      output.stderr('未能获取 npm 上的最新版本')
      return 1
    }
    output.stdout(`最新版本：v${snapshot.latest}`)
    if (snapshot.hasUpdate) {
      output.stdout(`发现新版本 v${snapshot.latest}；运行 ra update 升级（npm install -g ${PACKAGE_NAME}@latest + 自动重启）`)
    } else {
      output.stdout('已是最新版本')
    }
    return 0
  }

  if (snapshot.phase === 'failed') {
    output.stderr(snapshot.message ?? '更新失败')
    return 1
  }
  if (snapshot.phase !== 'updated') {
    output.stdout(snapshot.message ?? '已是最新版本')
    return 0
  }

  output.stdout(snapshot.message ?? `已更新到 v${snapshot.installedVersion}`)
  const pid = readPid(home)
  if (opts.restart === false) {
    output.stdout('已按 --no-restart 跳过重启；新版本在下次 ra start 后生效。')
    return 0
  }
  if (!pid || !alive(pid)) {
    output.stdout('服务未运行，无需重启；下次启动即为新版本。')
    return 0
  }

  output.stdout(`正在重启服务 (pid ${pid})…`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    // 进程可能刚好退出：继续等待 / 拉起流程即可，但把原因留在日志里。
    logger.warn('update:service-stop-failed', { pid, message: errorMessage(error) })
  }
  const exited = await waitForExit(pid, 10_000)
  if (!exited) {
    logger.error('update:restart-failed', { pid, reason: 'stop-timeout' })
    output.stderr(`服务未在 10 秒内退出，请手动执行 ra stop && ra start`)
    return 1
  }
  // 旧进程正常退出时会清 pid / 锁；兜底再清一次，避免新进程被判「已在运行」。
  cleanupPid(home)
  try {
    const entry = fileURLToPath(new URL('./main.js', import.meta.url))
    // 全局安装后路径不变，新进程从磁盘加载的就是刚装好的版本。
    const child = spawn(process.execPath, [entry, 'serve', '--home', home], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, RA_HOME: home },
    })
    child.unref()
    writeFileSync(join(home, 'router-agent.pid'), String(child.pid ?? ''), 'utf8')
    logger.info('update:service-restarted', { pid: child.pid })
    output.stdout(`服务已重启 (pid ${child.pid})`)
    return 0
  } catch (error) {
    const message = errorMessage(error)
    logger.error('update:restart-failed', { pid, message })
    output.stderr(`服务重启失败：${message}；请手动执行 ra start`)
    return 1
  }
}

/** 等旧服务退出；每 100ms 探一次，超时返回 false。 */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  return !alive(pid)
}

function cmdWeb(home: string, output: CliIo): number {
  const config = loadConfig(home)
  const url = `http://127.0.0.1:${config.server.port}/`
  output.stdout(`Web 面板: ${url}`)
  openPanel(url, output)
  return 0
}

async function cmdStart(home: string, opts: { foreground?: boolean; open?: boolean }, output: CliIo): Promise<number> {
  ensureHome(home)
  const config = loadConfig(home, output.env as NodeJS.ProcessEnv)
  // 直接落到「初始化」页：ra start 之后要配的运行时 / 项目 / 飞书 / 群都在这里。
  const panelUrl = `http://127.0.0.1:${config.server.port}/#setup`
  const shouldOpen = opts.open !== false
  const pid = readPid(home)
  if (pid && alive(pid)) {
    output.stdout(`服务已在运行 (pid ${pid})`)
    output.stdout(`Web 面板: ${panelUrl}`)
    if (shouldOpen) await openPanelWhenReady(panelUrl, output)
    return 0
  }
  // 默认 ACP 运行时不可用时给个提示，但不阻止启动：用户需要进 Web 面板安装。
  const defaultId = normalizeRuntimeId(config.runtime.default)
  if (defaultId.startsWith('acp-')) {
    let snapshot = readDetectionSnapshot(home)
    if (!snapshot) {
      snapshot = await new AcpRuntimeAdmin({ home, env: output.env as NodeJS.ProcessEnv, config }).detect().catch(() => null)
    }
    const choice = snapshot?.choices.find(item => item.id === defaultId)
    if (choice && choice.status !== 'ready' && choice.status !== 'unverified') {
      output.stdout(`默认运行时 ${defaultId} 当前不可用：${choice.reason ?? choice.status}`)
      if (choice.installHint) output.stdout(`安装：${choice.installHint}`)
      output.stdout('服务仍会启动；可在 Web 面板安装后重启。')
    }
  }
  if (opts.foreground) {
    // 前台模式会一直阻塞到退出，就绪探测并行跑，不拖慢启动。
    if (shouldOpen) void openPanelWhenReady(panelUrl, output)
    return cmdServe(home, output)
  }

  const entry = fileURLToPath(new URL('./main.js', import.meta.url))
  const child = spawn(process.execPath, [entry, 'serve', '--home', home], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, RA_HOME: home },
  })
  child.unref()
  writeFileSync(join(home, 'router-agent.pid'), String(child.pid ?? ''), 'utf8')
  output.stdout(`Router 服务已启动 (pid ${child.pid})`)
  output.stdout(`日志: ${join(home, 'logs', 'router-agent.log')}`)
  output.stdout(`Web 面板: ${panelUrl}`)
  if (shouldOpen) await openPanelWhenReady(panelUrl, output)
  return 0
}

/** 服务就绪探测与浏览器打开：给服务 10 秒，避免刚启动时开出 404 白页。 */
const PANEL_READY_TIMEOUT_MS = 10_000

async function panelReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL('api/status', url), { signal: AbortSignal.timeout(1_000) })
    return res.ok
  } catch {
    return false
  }
}

async function openPanelWhenReady(url: string, output: CliIo, timeoutMs = PANEL_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await panelReady(url)) {
      openPanel(url, output)
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
  }
  output.stdout(`Web 面板暂未就绪，请稍后手动打开: ${url}`)
  output.stdout('启动失败时用 ra logs 查看原因。')
}

/** 用默认浏览器打开 URL；打不开时保留地址让人手动访问。 */
function openPanel(url: string, output: CliIo): void {
  const open = output.openUrl ?? openInBrowser
  if (open(url)) output.stdout('已在浏览器打开 Web 面板')
  else output.stdout(`未能自动打开浏览器，请手动访问: ${url}`)
}

function openInBrowser(url: string): boolean {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const result = spawnSync(command, args, { stdio: 'ignore', timeout: 5_000 })
    return !result.error && result.status === 0
  } catch {
    return false
  }
}

function cmdStop(home: string, output: CliIo): number {
  const pid = readPid(home)
  if (!pid || !alive(pid)) {
    output.stdout('Router 服务未运行')
    cleanupPid(home)
    return 0
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // 进程可能刚退出
  }
  cleanupPid(home)
  output.stdout(`已停止 (pid ${pid})`)
  return 0
}

async function cmdServe(home: string, output: CliIo): Promise<number> {
  // 先建 logger 再读配置：配置解析失败、首次生成默认配置都要能落进日志。
  const logger = createLogger(home, output)
  const config = loadConfig(home, process.env, { logger })
  ensureHome(home)
  // 运行时探测在后台跑：先读缓存，API 立即可用，探测完成后刷新。
  const runtimeAdmin = new AcpRuntimeAdmin({ home, env: process.env, config })
  // 版本检查也放后台：启动不被 registry 网络拖慢，面板打开时读缓存。
  const updateService = new UpdateService({ current: PACKAGE_VERSION, logger })
  // 重启函数在 service / consumer 就绪后才赋值；更新工具只把重启排进 timer，
  // 等本轮研判结束、回复进入 outbox 后再真正重启。
  let requestRestart: (() => Promise<void>) | null = null
  let updateRestartTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleUpdateRestart = (delayMs = 2_000): void => {
    if (updateRestartTimer) return
    logger.info('update:restart-scheduled', { delayMs })
    updateRestartTimer = setTimeout(() => {
      updateRestartTimer = null
      void requestRestart?.()
    }, delayMs)
    updateRestartTimer.unref()
  }
  // 单实例锁：目录创建是原子的，避免两个 ra serve 同时跑循环。
  const lockDir = join(home, 'router-agent.lock')
  const acquireLock = (): boolean => {
    try {
      mkdirSync(lockDir)
      return true
    } catch {
      return false
    }
  }
  if (!acquireLock()) {
    const pid = readPid(home)
    // pid 文件可能是父进程拉起本进程时先写下的自身 pid：不能据此判「已在运行」。
    if (pid && pid !== process.pid && alive(pid)) {
      output.stderr(`Router 已在运行 (pid ${pid})，无需重复启动。`)
      return 1
    }
    // 旧进程已经不在：清掉残留锁后重试一次。
    rmSync(lockDir, { recursive: true, force: true })
    if (!acquireLock()) {
      output.stderr('Router 正在启动中，请稍后重试。')
      return 1
    }
  }
  writeFileSync(join(home, 'router-agent.pid'), String(process.pid), 'utf8')
  void runtimeAdmin.detect()
    .then(snapshot => {
      logger.info('runtime:detected', {
        ready: snapshot.choices.filter(choice => choice.status === 'ready').map(choice => choice.id),
        unavailable: snapshot.choices
          .filter(choice => choice.status !== 'ready')
          .map(choice => `${choice.id}:${choice.status}`),
      })
    })
    .catch(error => logger.warn('runtime:detect-failed', { message: error instanceof Error ? error.message : String(error) }))
  const sink = (event: { event: string; [key: string]: unknown }): void => {
    const { event: name, ...extra } = event
    logger.info(name, extra)
  }
  logger.info('serve:starting', {
    home,
    projects: projectsForRuntime(config).map(project => `${project.name}@${project.defaultBranch || '(未设默认分支)'}`),
    runtime: config.runtime.default,
    chats: config.feishu.chats.map(chat => `${chat.chat}:${chat.mode}${chat.repo ? `→${chat.repo}@${chat.branch || '?'}` : ''}`),
    decisionEngine: 'pi',
    timeoutMs: config.router.timeoutMs,
    tokenBudget: config.router.tokenBudget,
  })

  const store = new Store(join(home, 'state.db'))
  // 历史 sessionKey 未迁移时拒绝启动：直接跑会用新 key 找不到旧会话，静默丢失上下文。
  const legacySessions = store.legacySessionKeyCount()
  if (legacySessions > 0) {
    logger.error('session:migration-required', { pending: legacySessions })
    output.stderr(`检测到 ${legacySessions} 条未迁移的历史会话 key，直接启动会丢失上下文。`)
    output.stderr('请先执行：')
    output.stderr('  ra migrate sessions --dry-run')
    output.stderr('  ra migrate sessions --apply')
    store.close()
    rmSync(lockDir, { recursive: true, force: true })
    try { unlinkSync(join(home, 'router-agent.pid')) } catch { /* 文件可能不存在 */ }
    return 1
  }
  const replyAlwaysChats = new Set(replyAlwaysChatsOf(config))
  const repaired = store.repairOutbox()
  if (repaired > 0) logger.warn('outbox:repaired', { count: repaired })
  const orcaRunner = realRunner('orca')
  const claudeRunner = output.claude ?? realRunner('claude')
  const gitRunner = output.git ?? realRunner('git')
  const larkRunner = output.lark ?? createLarkRunner()
  const ghRunner = realRunner('gh')
  const glabRunner = realRunner('glab')
  // 群名目录要先建好：身份装配失败时要在日志里写清是哪个群。
  const directory = new ChatDirectory(join(home, 'chats.json'), logger)
  // 身份装配：把允许名单里的邮箱解析成 open_id，并自动识别机器人自身身份。
  // 解析只发生在这里，消息入站链路不再查通讯录。
  const identity = await resolveRuntimeIdentitySafely({ config, lark: larkRunner, cache: identityCacheOf(store), logger, directory })
  // 通道侧必须用装配后的配置：mention 判定读的就是 botOpenIds / botNames。
  // 这里刻意持有同一份数组 / Map 引用：面板保存后重新解析，原地改一遍就生效，不用重建通道。
  const botOpenIds = [...(identity?.bot.botOpenIds ?? config.feishu.botOpenIds)]
  const botNames = [...(identity?.bot.botNames ?? config.feishu.botNames)]
  const actorNames = new Map(identity?.names ?? [])
  const feishuConfig = {
    ...config.feishu,
    botOpenIds,
    botNames,
    actorNames,
  }
  const engine = new Engine({
    store,
    // 装配失败时退回原始配置：宁可按用户填的原始条目跑，也不要凭空把名单清空。
    policy: policyOf(config, identity ? policyResolutionOf(identity) : undefined),
    onEvent: sink,
  })
  // 身份端口：面板保存允许名单后由 API 层调用，立即重解析并让新名单生效。
  const identityPort = createIdentityPort({
    config,
    lark: larkRunner,
    cache: identityCacheOf(store),
    logger,
    chatNames: (chatId: string) => directory.nameOf(chatId),
    channel: { botOpenIds, botNames, actorNames },
    initial: identity,
  })
  // 启动时还有「待重试」条目或机器人识别失败：后台退避重试，成功后同步策略。
  // 否则通讯录权限恢复后没人会去重启或重新保存，群会一直静默全拒。
  if (identity) {
    scheduleIdentityRetry({
      initial: identity.status,
      logger,
      refresh: () => identityPort.refresh(),
      apply: () => { engine.updatePolicy(policyOf(config, identityPort.policyIds?.())) },
    })
  }
  const runtimes = createRuntimes(config, {
    home,
    workersDir: join(home, 'workers'),
    orca: orcaRunner,
    claude: claudeRunner,
    git: gitRunner,
    logger,
  })
  const runtime = runtimes.default()
  const prTracker = new ForgeTracker({
    github: new GitHubTracker(ghRunner),
    gitlab: new GitLabTracker(glabRunner),
    git: gitRunner,
  })
  let model: PiModelConfig | null = null
  try {
    model = resolvePiModelConfig({ configPath: join(home, 'config.yaml') })
  } catch (error) {
    // 初始化阶段 LLM 本来就可能没配：不能让 Web 也起不来，否则用户没有入口去填。
    // 这里降级为「只跑 Web 配置面板」，配好保存并重启后再接管消息。
    logger.warn('serve:llm-unconfigured', { reason: errorMessage(error), mode: 'web-only' })
    output.stdout('LLM 未配置：本次只启动 Web 配置面板，Router 不接收消息。')
    output.stdout('在面板「LLM Provider」填好 baseUrl / model / apiKey 并保存后，点「重启服务」即可。')
  }
  // 图片转文本：默认复用研判模型；主模型不支持多模态时可在 llm.imageModel 单独指定。
  // 配置解析失败不阻塞启动，图片退回「纯附件」处理。
  let imageTranscriber: ImageTranscriber | null = null
  if (model && config.feishu.images.enabled) {
    try {
      imageTranscriber = createVisionTranscriber(
        resolveImageModelConfig({ configPath: join(home, 'config.yaml') }),
        { timeoutMs: config.feishu.images.timeoutMs, maxChars: config.feishu.images.maxChars },
      )
    } catch (error) {
      logger.warn('feishu:image-vision-disabled', { message: error instanceof Error ? error.message : String(error) })
    }
  }
  // 没有模型配置时不装配研判引擎，RouterService 整体跳过，只保留 Web / 配置 API。
  const decisionEngine = model
    ? createDecisionEngine({
        config,
        store,
        model,
        engine,
        updater: updateService,
        scheduleRestart: scheduleUpdateRestart,
      })
    : null
  const auditPath = join(home, 'logs', 'decisions.jsonl')
  const onDecisionAudit = (audit: DecisionAudit): void => {
    try {
      appendFileSync(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...audit })}\n`, 'utf8')
    } catch (error) {
      logger.warn('decision:audit-write-failed', { message: error instanceof Error ? error.message : String(error) })
    }
    logger.info('decision:audit', {
      engine: audit.engine,
      triggerId: audit.triggerId,
      durationMs: audit.durationMs,
      tokens: audit.tokens.total,
      toolCalls: audit.toolCalls.length,
      ...(audit.proposal ? { decision: audit.proposal.decision, title: audit.proposal.title } : {}),
      ...(audit.unavailableReason ? { unavailable: audit.unavailableReason } : {}),
    })
  }
  // 通道适配器：飞书的消费、归一化、富化、渲染、回执、文档与凭据全部收口到这里。
  const feishuChannel = createFeishuChannel({
    config: feishuConfig,
    reaction: config.feishu.reaction,
    runner: larkRunner,
    directory,
    transcriber: imageTranscriber,
    logger,
    env: larkEnv(),
    hooks: {
      onReady: () => logger.info('feishu:ready', {}),
      onReconnect: ({ attempt, delayMs }) => logger.warn('feishu:reconnecting', { attempt, delayMs }),
      onError: error => {
        if (/another event bus/i.test(error.message)) {
          logger.warn('feishu:bus-conflict', {
            message: '同一机器人只能有一个事件总线；请停止其它消费者，或改用专属机器人（ra init 选项 2/3）',
          })
          return
        }
        logger.warn('feishu:error', { message: error.message })
      },
    },
  })
  const channels = new ChannelRegistry(logger)
  channels.register(feishuChannel)

  const clearReaction = async (messageId: string): Promise<void> => {
    const saved = store.getReaction(messageId)
    if (!saved) return
    try {
      await feishuChannel.clearAck(messageId, saved.reactionId)
    } finally {
      store.clearReaction(messageId)
    }
  }

  const feishuOutbox = new ChannelRouter(channels, logger)
  const effects = new EffectsProcessor({
    store,
    sender: {
      async send(item) {
        await feishuOutbox.send(item)
        // 回复已经发出，撤销「收到」表情。
        if (item.originMessageId) {
          try {
            await clearReaction(item.originMessageId)
          } catch (error) {
            logger.warn('feishu:unreact-failed', { message: error instanceof Error ? error.message : String(error) })
          }
        }
      },
    },
    handlers: {},
    onEvent: sink,
  })
  const service = decisionEngine
    ? new RouterService({
      config,
      store,
      engine,
      runtime,
      runtimes,
      prTracker,
      git: gitRunner,
      logger,
      effects,
      sender: feishuOutbox,
      decisionEngine,
      onDecisionAudit,
    })
    : null

  const webRoot = fileURLToPath(new URL('../web', import.meta.url))
  // onRestart 需要在 api 创建时注入，真正的重启函数在 service/consumer 就绪后再赋值。
  const api = await createApiServer({
    engine,
    store,
    config,
    runtimeAdmin,
    update: updateService,
    feishuBot: feishuChannel.admin,
    identity: identityPort,
    projectSetup: new ProjectSetup({ home, git: gitRunner, orca: orcaRunner }),
    // Web-only 模式没有 RouterService，工作区清理端点按「不支持」返回。
    ...(service
      ? {
          workspaceAdmin: {
            list: async () => service.listWorkspaces(),
            cleanup: (request: Parameters<RouterService['cleanupWorkspaces']>[0]) => service.cleanupWorkspaces(request),
          },
          // 面板「停止」由服务层关单并排 workspace 回收，避免只停进程、目录留在磁盘上。
          onStopTicket: (ticketId: string, reason: string) => service.stopTicket(ticketId, reason),
        }
      : {}),
    port: config.server.port,
    webRoot: existsSync(webRoot) ? webRoot : undefined,
    logger,
    onEvent: sink,
    ...(service
      ? {
          onReport: (state: WorkerStateFile) => service.ingestWorkerState(state),
          resumeHint: (ticketId: string) => service.resumeHint(ticketId),
        }
      : {}),
    onRestart: () => { void requestRestart?.() },
    onPolicyChange: updated => {
      logger.info('policy:updated', { version: engine.policy().version, acceptMode: updated.policy.acceptMode })
    },
    onConfigChange: (_updated, changed) => {
      logger.info('config:updated', { changed })
    },
  })
  logger.info('api:listening', { port: config.server.port })
  // 首查走后台，失败只进日志；之后每 6 小时刷新一次，面板读到的是缓存结果。
  void updateService.check(true)
  const updateTimer = setInterval(() => { void updateService.check(true) }, 6 * 60 * 60 * 1_000)
  updateTimer.unref()

  const consumer = service && config.feishu.chats.length > 0
    ? new ChannelIngress({
      adapter: feishuChannel,
      engine,
      store,
      logger,
      // 只对「会被处理」的消息加回执：@ / 私聊 / 全量接收群，且没被准入拦截。
      shouldReply: trigger => shouldAcknowledge(trigger, engine.policy(), replyAlwaysChats),
      onAck: (messageId, handle) => store.saveReaction(messageId, handle, new Date().toISOString()),
    })
    : null
  if (consumer) {
    void feishuChannel.start(raw => consumer.handleRaw(raw))
      .then(() => logger.info('feishu:consumer-started', { chats: config.feishu.chats.length }))
      .catch(error => logger.warn('feishu:consumer-start-failed', { message: errorMessage(error) }))
  }
  // Web-only 模式下不刷新群目录、也不启动消费循环，等配好 LLM 重启后再跑。
  const refreshChats = (): void => {
    void directory.refresh(larkRunner)
      .then(count => logger.info('chats:refreshed', { count }))
      .catch(error => logger.warn('chats:refresh-failed', { message: errorMessage(error) }))
  }
  const chatTimer = service ? setInterval(refreshChats, 600_000) : null
  chatTimer?.unref()
  if (service) {
    refreshChats()
    await service.start()
    output.stdout(`Router 服务运行中：http://127.0.0.1:${config.server.port}/`)
  } else {
    output.stdout(`Web 配置服务运行中：http://127.0.0.1:${config.server.port}/（LLM 未配置，Router 未启动）`)
  }

  const stopRuntime = (): void => {
    feishuChannel.stop()
    if (chatTimer) clearInterval(chatTimer)
    clearInterval(updateTimer)
    if (updateRestartTimer) {
      // 手动 ra stop 时不留下「服务已停但几秒后又被拉起」的隐患。
      clearTimeout(updateRestartTimer)
      updateRestartTimer = null
    }
    service?.stop()
    store.close()
  }

  /** 释放 pid 文件与单实例锁；重启时新进程要能重新接管。 */
  const releaseHost = (): void => {
    cleanupPid(home)
    rmSync(lockDir, { recursive: true, force: true })
  }

  requestRestart = async (): Promise<void> => {
    logger.info('serve:restarting', { pid: process.pid })
    stopRuntime()
    // 先让出端口，再拉起新进程，否则会撞 EADDRINUSE。
    await api.close()
    releaseHost()
    const entry = fileURLToPath(new URL('./main.js', import.meta.url))
    try {
      const child = spawn(process.execPath, [entry, 'serve', '--home', home], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, RA_HOME: home },
      })
      await new Promise<void>((resolvePromise, reject) => {
        child.once('spawn', () => resolvePromise())
        child.once('error', reject)
      })
      child.unref()
      writeFileSync(join(home, 'router-agent.pid'), String(child.pid ?? ''), 'utf8')
      logger.info('serve:restarted', { pid: child.pid })
      process.exit(0)
    } catch (error) {
      logger.error('serve:restart-failed', { message: error instanceof Error ? error.message : String(error) })
      process.exit(1)
    }
  }

  const shutdown = (): void => {
    logger.info('serve:stopping', {})
    stopRuntime()
    void api.close()
    releaseHost()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  return new Promise<number>(() => {
    // 常驻直到收到信号
  })
}

/**
 * 装配运行时身份（允许名单 + 机器人身份）。
 *
 * 装配失败不能挡住服务启动：这里降级成 null，调用方按原始配置继续跑，
 * 并留下一条 error 说明原因——静默启动成功、但消息全被丢掉才是这次要消灭的故障形态。
 */
async function resolveRuntimeIdentitySafely(opts: {
  config: AppConfig
  lark: CommandRunner
  cache: IdentityCache
  logger: Logger
  directory: ChatDirectory
}): Promise<RuntimeIdentity | null> {
  try {
    return await resolveRuntimeIdentity({
      config: opts.config,
      lark: opts.lark,
      cache: opts.cache,
      logger: opts.logger,
      chatNames: (chatId: string) => opts.directory.nameOf(chatId),
    })
  } catch (error) {
    opts.logger.error('config:identity-resolve-failed', { detail: errorMessage(error) })
    return null
  }
}

/** 身份解析缓存：读写 state.db 的 identity_aliases（键带 app_id，换应用自然失效）。 */
function identityCacheOf(store: Store): IdentityCache {
  return {
    get: (appId, kind, value) => {
      const row = store.getIdentityAlias(appId, kind, value)
      return row ? { openId: row.openId, name: row.name } : null
    },
    set: (appId, kind, value, openId, name) => store.setIdentityAlias(appId, kind, value, openId, name),
  }
}

/** 没有缓存可用时用这个：既不读也不写。 */
const NO_IDENTITY_CACHE: IdentityCache = { get: () => null, set: () => {} }

/**
 * 命令行场景的身份装配。
 *
 * 只读缓存、且不新建 state.db：模拟命令不该往库里写东西（dry run 的承诺），
 * 也不该凭空多出一个库文件。库不存在时就没有缓存可用，直接查通讯录。
 */
async function resolveIdentityForCli(
  home: string,
  config: AppConfig,
  lark: CommandRunner,
  logger: Logger,
): Promise<RuntimeIdentity | null> {
  const directory = new ChatDirectory(join(home, 'chats.json'), logger)
  const dbPath = join(home, 'state.db')
  if (!existsSync(dbPath)) {
    return resolveRuntimeIdentitySafely({ config, lark, cache: NO_IDENTITY_CACHE, logger, directory })
  }
  const store = openStore(home)
  try {
    return await resolveRuntimeIdentitySafely({
      config,
      lark,
      cache: {
        get: (appId, kind, value) => {
          const row = store.getIdentityAlias(appId, kind, value)
          return row ? { openId: row.openId, name: row.name } : null
        },
        set: () => { /* 只读缓存：模拟命令不往 state.db 里写 */ },
      },
      logger,
      directory,
    })
  } finally {
    store.close()
  }
}

/**
 * 把解析结果折算成策略层要注入的形态。
 *
 * 全局名单一个都没解析出来时不注入空集合：空集合等于断言「谁都不许」，
 * 而实际可能只是通讯录暂时查不通（原因见 `feishu:allowlist-empty` 事件）。
 */
function policyResolutionOf(identity: RuntimeIdentity): PolicyResolution {
  return {
    ...(identity.allowedOpenIds.length > 0 ? { allowedOpenIds: identity.allowedOpenIds } : {}),
    allowedByChatOpenIds: identity.allowedByChatOpenIds,
    names: Object.fromEntries(identity.names),
  }
}

/**
 * 身份端口：面板保存允许名单后立即重解析。
 *
 * - `refresh()` 重新解析，并把结果原地同步到通道侧（机器人身份与显示名）；
 * - `snapshot()` 返回最近一次解析状态，供面板只读展示；
 * - `policyIds()` 返回解析出的 open_id，供 API 层重建策略。
 *
 * 策略重建由 API 层统一做（它手里才有 engine），这里只管解析结果与通道侧同步。
 */
export function createIdentityPort(opts: {
  config: AppConfig
  lark: CommandRunner
  cache: IdentityCache
  logger: Logger
  /** 群 id → 群名；只用于日志里写清是哪个群。 */
  chatNames?: (chatId: string) => string
  /** 通道侧的运行时快照：机器人身份与显示名要原地同步过去。 */
  channel: { botOpenIds: string[]; botNames: string[]; actorNames: Map<string, string> }
  /** 启动时已经解析好的身份；缺省视为还没解析过。 */
  initial?: RuntimeIdentity | null
}): IdentityPort {
  let current = opts.initial ?? null
  return {
    async refresh() {
      let resolved: RuntimeIdentity
      try {
        resolved = await resolveRuntimeIdentity({
          config: opts.config,
          lark: opts.lark,
          cache: opts.cache,
          logger: opts.logger,
          ...(opts.chatNames ? { chatNames: opts.chatNames } : {}),
        })
      } catch (error) {
        // 失败交给调用方记日志：保存不能被解析失败挡住，名单先按上一次的结果继续用。
        // 详情里的邮箱先掩码：这条错误会进日志。
        throw new Error(`允许名单重解析失败：${detailText(errorMessage(error))}`)
      }
      current = resolved
      syncIdentitySnapshot(opts.channel, resolved)
      return resolved.status
    },
    snapshot: () => current?.status ?? emptyIdentityStatus(),
    policyIds: () => (current ? policyResolutionOf(current) : {}),
  }
}

/**
 * 后台重试身份解析（启动时存在「待重试」条目或机器人识别失败才启动）。
 *
 * 只告警不重试的话，通讯录权限恢复后没人会去重启或重新保存，群就会一直静默全拒；
 * 但也不能无限空转，所以按有限次数退避重试，成功后同步通道与策略。
 */
export function scheduleIdentityRetry(opts: {
  /** 首次解析状态；有待重试项或机器人识别失败时才启动。 */
  initial: IdentityStatusView
  logger: Logger
  /** 重新解析并同步通道，返回最近一次解析状态。 */
  refresh: () => Promise<IdentityStatusView>
  /** 重试成功后重建策略（名单已可用）。 */
  apply: () => void
  /** 重试间隔（毫秒），次数等于数组长度；测试里可以传 0。 */
  delays?: readonly number[]
}): void {
  const initial = opts.initial
  if (initial.pendingCount === 0 && initial.bot.resolved) return
  const delays = opts.delays ?? [60_000, 300_000, 900_000]
  if (delays.length === 0) return
  let round = 0
  const tick = async (): Promise<void> => {
    try {
      const status = await opts.refresh()
      if (status.pendingCount === 0 && status.bot.resolved) {
        opts.apply()
        opts.logger.info('identity:retry-resolved', { round: round + 1, pending: status.pendingCount })
        return
      }
      opts.logger.warn('identity:retry-deferred', { round: round + 1, pending: status.pendingCount, bot: status.bot.resolved })
    } catch (error) {
      // 重试失败不影响服务：下一轮再试，错误原因进日志。
      opts.logger.warn('identity:retry-failed', { round: round + 1, detail: errorMessage(error) })
    }
    round += 1
    if (round >= delays.length) {
      opts.logger.warn('identity:retry-exhausted', { attempts: round })
      return
    }
    const next = setTimeout(() => { void tick() }, delays[round])
    next.unref?.()
  }
  const first = setTimeout(() => { void tick() }, delays[0])
  first.unref?.()
}

/**
 * 把最新的身份解析结果原地同步到通道侧的快照。
 *
 * 通道持有的是同一份数组 / Map 引用，改完立刻生效，不用重建通道。
 */
function syncIdentitySnapshot(
  target: { botOpenIds: string[]; botNames: string[]; actorNames: Map<string, string> },
  identity: RuntimeIdentity,
): void {
  target.botOpenIds.splice(0, target.botOpenIds.length, ...identity.bot.botOpenIds)
  target.botNames.splice(0, target.botNames.length, ...identity.bot.botNames)
  target.actorNames.clear()
  for (const [openId, name] of identity.names) target.actorNames.set(openId, name)
}

function createLogger(home: string, output: CliIo, echo = true): Logger {
  const path = join(home, 'logs', 'router-agent.log')
  const write = (level: string, message: string, extra?: Record<string, unknown>): void => {
    // message 永远是事件名；业务字段里的 message 改写成 detail，避免把事件名冲掉。
    const { message: detail, ...rest } = extra ?? {}
    const line = JSON.stringify({
      at: new Date().toISOString(),
      level,
      message,
      ...(detail === undefined ? {} : { detail }),
      ...rest,
    })
    try {
      writeFileSync(path, `${line}\n`, { flag: 'a' })
    } catch {
      // 日志失败不影响主流程
    }
    if (echo) output.stdout(line)
  }
  return {
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
  }
}

function readPid(home: string): number | null {
  const path = join(home, 'router-agent.pid')
  if (!existsSync(path)) return null
  const value = Number(readFileSync(path, 'utf8').trim())
  return Number.isFinite(value) && value > 0 ? value : null
}

function cleanupPid(home: string): void {
  const path = join(home, 'router-agent.pid')
  if (existsSync(path)) {
    try { unlinkSync(path) } catch { /* ignore */ }
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