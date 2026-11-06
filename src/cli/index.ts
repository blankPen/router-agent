import { appendFileSync, closeSync, mkdirSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Command, CommanderError } from 'commander'
import { ensureHome, loadConfig, policyOf, replyAlwaysChatsOf, setConfigValue, writeConfig } from '../config.js'
import { Store } from '../store/db.js'
import { Engine } from '../core/engine.js'
import { OrcaAdapter } from '../worker/orca/index.js'
import { GitHubTracker } from '../sources/github.js'
import { FeishuConsumer, FeishuSender, attachQuotedMessage, normalizeFeishuEventDetailed } from '../sources/feishu.js'
import { backfillChats } from '../sources/feishu-backfill.js'
import { ChatDirectory } from '../sources/feishu-directory.js'
import { createLarkRunner, larkEnv, parseAppId } from '../sources/lark.js'
import { runInitWizard } from './init.js'
import { formatChecks, runDoctor } from './doctor.js'
import { simulate } from './simulate.js'
import { runReport, readContentArg, type ReportOptions } from './report.js'
import type { Prompter } from './prompts.js'
import { realRunner, type CommandRunner } from '../infra/process.js'
import { resolvePiModelConfig } from '../router/model-config.js'
import { createDecisionEngine } from '../router/engine-factory.js'
import type { DecisionAudit } from '../router/decision-engine.js'
import { RouterService, createEffectsSender, type Logger } from '../service.js'
import { EffectsProcessor } from '../core/effects.js'
import { createApiServer } from '../router/api.js'
import { agentSpecDocument } from '../worker/spec/index.js'

export const VERSION = '0.1.0'

export interface CliIo {
  stdout(line: string): void
  stderr(line: string): void
  env: Record<string, string | undefined>
  /** 交互式初始化用；不存在时退化为非交互。 */
  prompts?: Prompter
  /** 测试注入点；默认用真实 orca / lark-cli。 */
  orca?: CommandRunner
  larkFor?: (home?: string) => CommandRunner
  /** 交互式接管终端的 lark-cli 命令（新建应用、用户授权）。 */
  stream?: (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>
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
  ra tickets --stage person
  ra config set policy.acceptMode observe
  ra config set project.router-agent "name:dsh/router-agent@main"
  ra config set chatBinding.oc_xxx "router-agent@main"
  ra config --edit`)

  withHome(program.command('init').description('交互式初始化：仓库 → 机器人 → 群 → 授权成员'))
    .option('--yes', '跳过提问，只写默认配置')
    .option('--agents-dir <dir>', 'worker 全局规范目录', join(homedir(), '.claude', 'agents'))
    .action(async (opts: { home?: string; yes?: boolean; agentsDir?: string }) => {
      setCode(await cmdInit(homeOf(opts, output), opts, output))
    })

  withHome(program.command('doctor').description('启动前自检：配置 / Orca / 飞书 / 模型 / 端口'))
    .option('--json', '以 JSON 输出')
    .action(async (opts: { home?: string; json?: boolean }) => {
      setCode(await cmdDoctor(homeOf(opts, output), opts, output))
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
    .option('--reply <text>', '要发给发起人的完整回复：字面量 / @文件 / - 读 stdin')
    .option('--ack <id>', '确认已读的输入 ID，可重复', collect, [])
    .action(async (opts: ReportOptions & { home?: string }) => {
      setCode(await cmdReport(homeOf(opts, output), opts, output))
    })

  withHome(program.command('doc').description('创建飞书文档并输出链接（worker 沉淀长结论用，链接写进 --reply）'))
    .requiredOption('--title <title>', '文档标题')
    .option('--content <text>', '正文：字面量 / @文件 / - 读 stdin')
    .action(async (opts: { home?: string; title: string; content?: string }) => {
      setCode(await cmdDoc(homeOf(opts, output), opts, output))
    })

  withHome(program.command('start').description('启动常驻 Router 服务（默认后台）'))
    .option('--foreground', '前台运行，便于调试')
    .action(async (opts: { home?: string; foreground?: boolean }) => {
      setCode(await cmdStart(homeOf(opts, output), opts, output))
    })

  withHome(program.command('stop').description('停止服务'))
    .action((opts: { home?: string }) => setCode(cmdStop(homeOf(opts, output), output)))

  withHome(program.command('status').description('服务状态与工单概览'))
    .action((opts: { home?: string }) => setCode(cmdStatus(homeOf(opts, output), output)))

  withHome(program.command('web').description('打开 Web 面板'))
    .action((opts: { home?: string }) => setCode(cmdWeb(homeOf(opts, output), output)))

  withHome(program.command('tickets').description('按阶段列出工单'))
    .option('--stage <stage>', '按阶段过滤：draft/accepted/assigned/running/review/person/idle/closed')
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
  const lark = output.larkFor ?? (larkHome => createLarkRunner({ home: larkHome }))
  const checks = await runDoctor({
    config,
    orca: output.orca ?? realRunner('orca'),
    lark: lark(config.feishu.larkHome),
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

async function cmdReport(home: string, opts: ReportOptions, output: CliIo): Promise<number> {
  const config = loadConfig(home)
  return runReport(
    { home, port: config.server.port, stdout: output.stdout, stderr: output.stderr },
    opts,
  )
}

async function cmdDoc(home: string, opts: { title: string; content?: string }, output: CliIo): Promise<number> {
  const config = loadConfig(home)
  const content = readContentArg({}, opts.content).trim()
  if (!content) {
    output.stderr('--content 不能为空（可用 @文件 或 - 从 stdin 读）')
    return 2
  }
  const sender = new FeishuSender(createLarkRunner({ home: config.feishu.larkHome }))
  try {
    const url = await sender.createDocument(opts.title, content)
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
  const decisionEngine = (store: Store) => createDecisionEngine({ config, store, model })

  const result = await simulate(
    { home, config, decisionEngine },
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

async function cmdInit(home: string, opts: { yes?: boolean; agentsDir?: string }, output: CliIo): Promise<number> {
  ensureHome(home)
  await runInitWizard({
    home,
    env: output.env,
    stdout: line => output.stdout(line),
    ...(opts.yes || !output.prompts ? {} : { prompts: output.prompts }),
    orca: output.orca ?? realRunner('orca'),
    lark: output.larkFor ?? (larkHome => createLarkRunner({ home: larkHome })),
    ...(output.stream ? { stream: output.stream } : {}),
  })

  const agentsDir = opts.agentsDir ?? join(homedir(), '.claude', 'agents')
  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(join(agentsDir, 'router-agent-worker.md'), agentSpecDocument(), 'utf8')
  output.stdout('')
  output.stdout(`状态目录: ${home}`)
  output.stdout(`worker 全局规范: ${join(agentsDir, 'router-agent-worker.md')}`)
  return 0
}

function openStore(home: string): Store {
  ensureHome(home)
  return new Store(join(home, 'state.db'))
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
      output.stdout(`已停止 ${ticketId}（服务已关闭 worker 终端）`)
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
    if (ticket.stage === 'closed') {
      output.stdout(`工单已关闭: ${ticketId}`)
      return 0
    }
    const engine = new Engine({ store, policy: policyOf(config) })
    engine.stopTicket(ticketId, 'ra ticket --stop')
    output.stdout(`已停止 ${ticketId}`)
    return 0
  } finally {
    store.close()
  }
}

function cmdStatus(home: string, output: CliIo): number {
  const pid = readPid(home)
  output.stdout(!pid || !alive(pid) ? 'Router 服务：未运行' : `Router 服务：运行中 (pid ${pid})`)
  const store = openStore(home)
  try {
    const tickets = store.listTickets({ limit: 500 })
    const open = tickets.filter(t => t.stage !== 'closed').length
    output.stdout(`工单：开工 ${open} / 总计 ${tickets.length}`)
    for (const t of tickets.filter(t => t.stage !== 'closed').slice(0, 10)) {
      output.stdout(`  - [${t.stage}] ${t.title}`)
    }
    const config = loadConfig(home)
    output.stdout(`accept mode: ${config.policy.acceptMode}，并发上限: ${config.policy.maxWorkers}，后端: ${config.backend.default}`)
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
  output.stdout(`${key} = ${value}`)
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

function cmdWeb(home: string, output: CliIo): number {
  const config = loadConfig(home)
  const url = `http://127.0.0.1:${config.server.port}/`
  output.stdout(`Web 面板: ${url}`)
  if (process.platform === 'darwin') {
    try {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } catch {
      // 打不开浏览器不影响打印地址
    }
  }
  return 0
}

async function cmdStart(home: string, opts: { foreground?: boolean }, output: CliIo): Promise<number> {
  ensureHome(home)
  const pid = readPid(home)
  if (pid && alive(pid)) {
    output.stdout(`服务已在运行 (pid ${pid})`)
    return 0
  }
  if (opts.foreground) return cmdServe(home, output)

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
  return 0
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
  const config = loadConfig(home)
  ensureHome(home)
  writeFileSync(join(home, 'router-agent.pid'), String(process.pid), 'utf8')
  const logger = createLogger(home, output)
  const sink = (event: { event: string; [key: string]: unknown }): void => {
    const { event: name, ...extra } = event
    logger.info(name, extra)
  }
  logger.info('serve:starting', {
    home,
    projects: config.projects.map(project => `${project.name}@${project.defaultBranch || '(未设默认分支)'}`),
    chats: config.feishu.chats.map(chat => `${chat.chat}:${chat.mode}${chat.repo ? `→${chat.repo}@${chat.branch || '?'}` : ''}`),
    decisionEngine: 'pi',
    timeoutMs: config.router.timeoutMs,
    tokenBudget: config.router.tokenBudget,
  })

  const store = new Store(join(home, 'state.db'))
  const replyAlwaysChats = new Set(replyAlwaysChatsOf(config))
  const repaired = store.repairOutbox()
  if (repaired > 0) logger.warn('outbox:repaired', { count: repaired })
  const engine = new Engine({ store, policy: policyOf(config), onEvent: sink })
  const orcaRunner = realRunner('orca')
  const larkRunner = createLarkRunner({ home: config.feishu.larkHome })
  const ghRunner = realRunner('gh')
  const backend = new OrcaAdapter({
    runner: orcaRunner,
    workersDir: join(home, 'workers'),
    spec: config.workerSpec.mode,
  })
  const sender = new FeishuSender(larkRunner)
  const prTracker = new GitHubTracker(ghRunner)
  const model = resolvePiModelConfig({ configPath: join(home, 'config.yaml') })
  const decisionEngine = createDecisionEngine({ config, store, model })
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
  const directory = new ChatDirectory(join(home, 'chats.json'))

  const reactTo = async (messageId: string): Promise<void> => {
    const reactionId = await sender.react(messageId, config.feishu.reaction)
    if (reactionId) store.saveReaction(messageId, reactionId, new Date().toISOString())
  }
  const clearReaction = async (messageId: string): Promise<void> => {
    const saved = store.getReaction(messageId)
    if (!saved) return
    try {
      await sender.unreact(messageId, saved.reactionId)
    } finally {
      store.clearReaction(messageId)
    }
  }

  const feishuOutbox = createEffectsSender(sender)
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
  const service = new RouterService({
    config,
    store,
    engine,
    backend,
    prTracker,
    logger,
    effects,
    sender: feishuOutbox,
    decisionEngine,
    onDecisionAudit,
    backfill: async () => {
      const result = await backfillChats({
        runner: larkRunner,
        chats: config.feishu.chats.filter(chat => chat.sync).map(chat => chat.chat),
        cfg: config.feishu,
        cursors: {
          get: key => store.getCursor(key),
          set: (key, value) => store.setCursor(key, value, new Date().toISOString()),
        },
      })
      if (result.baselined.length > 0) logger.info('backfill:baseline', { chats: result.baselined })
      // 补拉同样要带上被引用消息的正文，否则引用消息进研判时只剩一句空 @。
      return Promise.all(
        result.triggers.map(async t => attachQuotedMessage({ ...t, chatName: directory.nameOf(t.chatId) }, larkRunner)),
      )
    },
  })

  const webRoot = fileURLToPath(new URL('../web', import.meta.url))
  const api = await createApiServer({
    engine,
    store,
    config,
    port: config.server.port,
    webRoot: existsSync(webRoot) ? webRoot : undefined,
    onEvent: sink,
    onReport: state => service.onWorkerState(state),
    onPolicyChange: updated => {
      logger.info('policy:updated', { version: engine.policy().version, acceptMode: updated.policy.acceptMode })
    },
  })
  logger.info('api:listening', { port: config.server.port })

  if (config.feishu.appId) {
    const shown = await larkRunner.run(['config', 'show'])
    const actual = shown.code === 0 ? parseAppId(shown.stdout) : ''
    if (actual && actual !== config.feishu.appId) {
      logger.warn('feishu:app-id-mismatch', { configured: config.feishu.appId, actual })
    }
  }

  const consumer = config.feishu.chats.length > 0
    ? new FeishuConsumer({
      env: larkEnv(config.feishu.larkHome),
      onEvent: raw => {
        const result = normalizeFeishuEventDetailed(raw, config.feishu, directory.nameOf(String(raw.chat_id ?? '')))
        if (!result.trigger) {
          // 收到了但被过滤：把原因写进日志，否则用户只会看到「没反应」。
          logger.info('trigger:dropped', {
            reason: result.dropped,
            chat: result.chatId,
            name: directory.nameOf(String(result.chatId ?? '')),
            actor: result.actorId,
          })
          return
        }
        // 引用消息要先回查被引用正文，异步补齐后再入库。
        void (async () => {
          const trigger = await attachQuotedMessage(result.trigger!, larkRunner)
          const stored = engine.ingest(trigger)
          if (!stored) return
          const quoted = Boolean((trigger.raw as Record<string, unknown> | undefined)?.quote)
          logger.info('trigger:ingested', { id: trigger.id, chat: trigger.chatId, addressed: trigger.addressed, quoted })
          // 只对「会被回复」的消息加回执表情：@、私聊，或 mode=all 的全量接收群。
          const willReply = trigger.addressed !== 'none' || replyAlwaysChats.has(trigger.chatId)
          if (config.feishu.reaction && willReply) {
            void reactTo(trigger.externalId)
              .catch(error => logger.warn('feishu:reaction-failed', { message: error instanceof Error ? error.message : String(error) }))
          }
        })().catch(error => logger.warn('trigger:ingest-failed', { message: error instanceof Error ? error.message : String(error) }))
      },
      onReady: () => logger.info('feishu:ready', {}),
      onError: error => {
        if (/another event bus/i.test(error.message)) {
          logger.warn('feishu:bus-conflict', {
            message: '同一机器人只能有一个事件总线；请停止其它消费者，或改用专属机器人（ra init 选项 2/3）',
          })
          return
        }
        logger.warn('feishu:error', { message: error.message })
      },
    })
    : null
  consumer?.start()
  if (consumer) logger.info('feishu:consumer-started', { chats: config.feishu.chats.length })
  void directory.refresh(larkRunner).then(count => logger.info('chats:refreshed', { count }))
  const chatTimer = setInterval(() => { void directory.refresh(larkRunner) }, 600_000)
  chatTimer.unref()

  await service.start()
  output.stdout(`Router 服务运行中：http://127.0.0.1:${config.server.port}/`)

  const shutdown = (): void => {
    logger.info('serve:stopping', {})
    consumer?.stop()
    clearInterval(chatTimer)
    service.stop()
    store.close()
    void api.close()
    cleanupPid(home)
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  return new Promise<number>(() => {
    // 常驻直到收到信号
  })
}

function createLogger(home: string, output: CliIo): Logger {
  const path = join(home, 'logs', 'router-agent.log')
  const write = (level: string, message: string, extra?: Record<string, unknown>): void => {
    const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...(extra ?? {}) })
    try {
      writeFileSync(path, `${line}\n`, { flag: 'a' })
    } catch {
      // 日志失败不影响主流程
    }
    output.stdout(line)
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