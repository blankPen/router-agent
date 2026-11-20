/**
 * 自动化内置工具集。
 *
 * 一份定义，AI 自动化与脚本自动化共用：工具以统一协议暴露
 * （名称、入参 schema、描述、handler），执行管线只负责注入，不各写一套。
 *
 * 权限边界：每个 handler 都被「本自动化任务所属项目范围」限定，
 * 越界访问返回 `scope:denied`；凭据不落进任务定义或脚本正文，
 * 需要凭据的动作由 handler 内部复用现有配置去取。
 */
import type { AutomationTool, AutomationToolScope, AutomationToolRegistry } from '#core/automation.js'
import type { Store } from '../store/db.js'
import type { Engine } from '../core/engine.js'

/** 工具调用限流：同一自动化任务在时间窗内最多调用多少次。 */
export interface AutomationRateLimit {
  /** 时间窗（毫秒）。 */
  windowMs: number
  /** 窗口内允许的调用次数。 */
  max: number
}

/** 默认限流：每个任务每分钟 30 次工具调用。 */
export const DEFAULT_TOOL_RATE_LIMIT: AutomationRateLimit = { windowMs: 60_000, max: 30 }

/**
 * 工具调用限流器。
 *
 * 按自动化任务维度计数：无人值守的自动化不会因为模型跑飞就无限调用写工具。
 */
export class AutomationRateLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(private readonly limit: AutomationRateLimit = DEFAULT_TOOL_RATE_LIMIT) {}

  /** 记一次调用；超限返回 false。 */
  allow(key: string, nowMs = Date.now()): boolean {
    const windowStart = nowMs - this.limit.windowMs
    const recent = (this.hits.get(key) ?? []).filter(at => at > windowStart)
    if (recent.length >= this.limit.max) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(nowMs)
    this.hits.set(key, recent)
    return true
  }
}

/** 工具需要的宿主能力；由服务层注入，测试可用假实现。 */
export interface AutomationToolDeps {
  store: Store
  engine: Engine
  /** 事件入队端口：工具写的事件要进收件箱，走现有事件判定链路。 */
  ingestEvent?: (input: { title: string; body: string; eventType: string; project: string; repo: string; automationId: string }) => string | null
  /** 限流器；缺省用默认限流。 */
  limiter?: AutomationRateLimiter
  /** 时钟；测试可注入固定时间。 */
  now?: () => number
}

/** 统一的入参 schema 构件：省得每条工具手写 JSON。 */
const stringProp = (description: string) => ({ type: 'string', description })

/** 统一的错误返回形状：工具出错不当异常抛，模型能读懂。 */
function failed(reason: string, hint?: string): { error: string; hint?: string } {
  return hint ? { error: reason, hint } : { error: reason }
}

/**
 * 判断目标工单是否在本自动化任务的项目范围内。
 *
 * 范围按仓库路径判定：自动化任务绑定一个项目（一个仓库路径），
 * 工单必须挂在同一个仓库下才算范围内。
 */
function inScope(scope: AutomationToolScope, repo: string): boolean {
  if (!scope.repo) return false
  return repo === scope.repo
}

/**
 * 事件是否属于本任务范围。
 *
 * 事件判定前通常还没有 `repo`：这时按「本任务自己写入的事件」或来源上下文里的仓库判定，
 * 不能因为缺字段就把整个收件箱暴露给所有自动化。
 */
function eventInScope(scope: AutomationToolScope, event: { sourceId: string; project?: string; repo?: string; context?: Record<string, string> }): boolean {
  if (event.sourceId === `automation:${scope.automationId}`) return true
  if (event.project === scope.project) return true
  if (event.repo) return inScope(scope, event.repo)
  const contextRepo = event.context?.repo
  return contextRepo ? inScope(scope, contextRepo) : false
}

/** 工具定义清单。 */
function buildTools(deps: AutomationToolDeps): AutomationTool[] {
  return [
    {
      name: 'automation_list_tickets',
      description: '查询本自动化任务所属项目下的工单列表，可按状态与关键词过滤。',
      mutates: false,
      parameters: {
        type: 'object',
        properties: {
          stage: stringProp('工单阶段：todo / running / review / blocked / done'),
          keyword: stringProp('标题或工单 ID 关键词'),
          limit: { type: 'number', description: '最多返回条数，默认 20' },
        },
      },
      handler(args, scope) {
        const keyword = String(args.keyword ?? '').trim().toLowerCase()
        const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 50)
        const stage = typeof args.stage === 'string' && args.stage ? args.stage as never : undefined
        const tickets = deps.store.listTickets({ ...(stage ? { stage } : {}), limit: 500 })
          // 只暴露本项目范围内的工单：越权数据连返回都不给。
          .filter(ticket => inScope(scope, ticket.repo))
          .filter(ticket => keyword
            ? ticket.id.toLowerCase().includes(keyword) || ticket.title.toLowerCase().includes(keyword)
            : true)
          .slice(0, limit)
          .map(ticket => ({
            id: ticket.id,
            title: ticket.title,
            stage: ticket.stage,
            repo: ticket.repo,
            prUrl: ticket.prUrl,
            updatedAt: ticket.updatedAt,
          }))
        return { count: tickets.length, tickets }
      },
    },
    {
      name: 'automation_get_ticket',
      description: '按工单 ID 读取一张工单的详情与最近进展。',
      mutates: false,
      parameters: {
        type: 'object',
        properties: { ticket_id: stringProp('工单 ID，例如 tk-8') },
        required: ['ticket_id'],
      },
      handler(args, scope) {
        const ticketId = String(args.ticket_id ?? '').trim()
        if (!ticketId) return failed('automation_get_ticket:missing-ticket_id')
        const ticket = deps.store.getTicket(ticketId)
        if (!ticket) return failed('ticket:not-found')
        if (!inScope(scope, ticket.repo)) return failed('scope:denied', '该工单不在本自动化任务的项目范围内')
        const reports = deps.store.listReports(ticket.id, 5)
        return {
          ticket: {
            id: ticket.id,
            title: ticket.title,
            stage: ticket.stage,
            repo: ticket.repo,
            branch: ticket.branch,
            prUrl: ticket.prUrl,
            createdAt: ticket.createdAt,
            updatedAt: ticket.updatedAt,
          },
          reports: reports.map(report => ({
            turn: report.turn,
            state: report.state,
            summary: report.summary,
            at: report.at,
          })),
        }
      },
    },
    {
      name: 'automation_create_ticket',
      description: '在本自动化任务所属项目下创建一张工单，用于把自动化发现的问题交给人工跟进。',
      mutates: true,
      parameters: {
        type: 'object',
        properties: {
          title: stringProp('工单标题，一句话说清要做什么'),
          detail: stringProp('工单正文：要处理的问题、已经查到的事实、下一步建议'),
        },
        required: ['title', 'detail'],
      },
      handler(args, scope) {
        const title = String(args.title ?? '').trim()
        const detail = String(args.detail ?? '').trim()
        if (!title) return failed('automation_create_ticket:missing-title')
        if (!detail) return failed('automation_create_ticket:missing-detail')
        if (!scope.repo) return failed('scope:denied', '本自动化任务没有绑定项目，无法创建工单')
        // 建单走现有 Engine 链路：Trigger → decide → 工单，审计与阶段口径不变。
        const triggerId = deps.engine.ingestSyntheticTrigger({
          source: `automation:${scope.automationId}`,
          title,
          text: detail,
          chatId: `automation:${scope.automationId}`,
          chatName: `自动化 ${scope.automationId}`,
          actorId: `automation:${scope.automationId}`,
          actorName: `自动化 ${scope.automationId}`,
        })
        const outcome = deps.engine.decide({
          triggerId,
          decision: 'accept',
          strength: 'inferred',
          reason: `自动化任务 ${scope.automationId} 创建`,
          title,
          scope: `按自动化任务 ${scope.automationId} 的要求处理：${detail}`,
          request: detail,
          requestActorName: `自动化 ${scope.automationId}`,
          repo: scope.repo,
          branch: scope.branch ?? '',
        })
        if (!outcome.ticket) return failed('ticket:create-failed')
        return { ticketId: outcome.ticket.id, title: outcome.ticket.title }
      },
    },
    {
      name: 'automation_list_events',
      description: '查询收件箱里的事件，可按状态过滤；只返回本自动化任务项目范围内的事件。',
      mutates: false,
      parameters: {
        type: 'object',
        properties: {
          status: stringProp('事件状态：undecided / pending / review / done / invalid'),
          limit: { type: 'number', description: '最多返回条数，默认 20' },
        },
      },
      handler(args, scope) {
        const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 50)
        const status = typeof args.status === 'string' && args.status ? args.status as never : undefined
        const events = deps.store.listEvents({ ...(status ? { status } : {}), limit: 500 })
          .filter(event => eventInScope(scope, event))
          .slice(0, limit)
          .map(event => ({
            id: event.id,
            title: event.title,
            status: event.status,
            priority: event.priority,
            eventType: event.eventType,
            project: event.project,
            ticketId: event.ticketId,
            receivedAt: event.receivedAt,
          }))
        return { count: events.length, events }
      },
    },
    {
      name: 'automation_create_event',
      description: '往收件箱写一条事件，用于把外部观察记录进事件队列，交由现有判定链路处理。',
      mutates: true,
      parameters: {
        type: 'object',
        properties: {
          title: stringProp('事件标题，一句话说清发生了什么'),
          body: stringProp('事件正文：细节、上下文与已采取的动作'),
          event_type: stringProp('事件类型，必须带来源前缀，例如 automation.issue.found'),
        },
        required: ['title', 'body', 'event_type'],
      },
      handler(args, scope) {
        const title = String(args.title ?? '').trim()
        const body = String(args.body ?? '').trim()
        const eventType = String(args.event_type ?? '').trim()
        if (!title) return failed('automation_create_event:missing-title')
        if (!body) return failed('automation_create_event:missing-body')
        if (!eventType) return failed('automation_create_event:missing-event_type')
        if (!deps.ingestEvent) return failed('operator:unavailable', '当前服务没有开放事件写入能力')
        const eventId = deps.ingestEvent({
          title,
          body,
          eventType,
          project: scope.project,
          repo: scope.repo,
          automationId: scope.automationId,
        })
        if (!eventId) return failed('event:ingest-failed')
        return { eventId }
      },
    },
  ]
}

/** 工具注册表：按名字取工具；两条执行管线共用这一份。 */
export class BuiltinAutomationTools implements AutomationToolRegistry {
  private readonly tools: Map<string, AutomationTool>

  constructor(deps: AutomationToolDeps) {
    this.tools = new Map(buildTools(deps).map(tool => [tool.name, tool]))
  }

  get(name: string): AutomationTool | undefined {
    return this.tools.get(name)
  }

  list(): AutomationTool[] {
    return [...this.tools.values()]
  }
}

/**
 * 把工具集绑定到某个自动化任务的项目范围。
 *
 * 绑定后返回的工具仍是同一份定义，handler 只是多了范围约束；
 * 工具正文与凭据都不进任务定义或脚本。
 */
export function scopedTools(
  registry: AutomationToolRegistry,
  scope: AutomationToolScope,
  limits: { limiter?: AutomationRateLimiter; now?: () => number } = {},
): AutomationTool[] {
  const limiter = limits.limiter
  const now = limits.now ?? (() => Date.now())
  return registry.list().map(tool => ({
    ...tool,
    handler: (args: Record<string, unknown>) => {
      if (limiter && !limiter.allow(scope.automationId, now())) {
        return failed('rate:limited', '工具调用超出限流，请稍后再试')
      }
      return tool.handler(args, scope)
    },
  }))
}
