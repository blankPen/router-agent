/**
 * 自动化会话编排：一条会话建一条任务，能改、能恢复。
 *
 * 状态机（§5.2）：
 *   idle → parsing → clarifying（缺项回问，一次一项） → previewing → confirmed
 *
 * 会话与任务一一绑定：任务里存 `conversationId`，
 * 点任务卡片的「恢复会话」用同一个 `sessionKey` 再开一轮对话，历史自然接上。
 */
import type {
  Automation,
  AutomationConversation,
  AutomationConversationMessage,
  AutomationConversationPreview,
  AutomationConversationMissing,
} from '#core/automation.js'
import type { EventCatalog } from '#event/port.js'
import type { ChatClient } from '#infra/chat.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { ProjectConfig } from '../config.js'
import type { Store } from '../store/db.js'
import { parseAutomationIntent, type AutomationTaskDraft } from './parse.js'

/**
 * 预览卡：确认前的参数一览。
 *
 * 与核心层的 `AutomationConversationPreview` 同形 —— 面板要渲染它，
 * 存库也要存它，两边共用一份定义免得走样。
 */
export type AutomationPreview = AutomationConversationPreview

/**
 * 会话消息的对外形状。
 *
 * 面板只关心这几项：`conversationId` 与 `createdAt` 是存库用的，
 * 不往外发。
 */
export type AutomationConversationWire = Omit<
  AutomationConversationMessage,
  'conversationId' | 'createdAt'
>

export interface AutomationSessionDeps {
  store: Store
  config: () => { projects: ProjectConfig[]; tasks?: Automation[] }
  /** 模型客户端；没配模型时返回 unavailable。 */
  client: () => ChatClient | null
  /** 事件目录。 */
  catalogs: () => EventCatalog[]
  /** 参数探活（可选）：校验订阅参数指向的资源真的存在。 */
  probeParams?: (source: string, params: Record<string, string>) => Promise<string | null>
  /**
   * 逐段回调助手的话（可选）。
   *
 * 给了就边解析边说话，用户看得到助手的思考过程（决策 A10）。
   */
  onDelta?: (conversationId: string, text: string) => void
  /** 当前时间。 */
  clock: () => string
  logger?: Logger
  /** 落库任务（宿主注入：写配置文件）。 */
  saveTask?: (task: Automation) => void
}

/** 一轮的结果。 */
export interface SessionTurn {
  /** 助手这一轮说的话。 */
  text: string
  /** 会话当前状态。 */
  conversation: AutomationConversation
  /** 参数齐了时的预览卡。 */
  preview?: AutomationPreview
  /** 这一步在做什么。 */
  step: AutomationConversation['step']
  /** 缺项清单。 */
  missing: string[]
  /** 本轮结束。 */
  done: boolean
  /** 落库了任务时给出任务 id。 */
  taskId?: string
}

/** 自动化会话编排器。 */
export class AutomationSessionService {
  private deps: AutomationSessionDeps
  private logger: Logger

  constructor(deps: AutomationSessionDeps) {
    this.deps = deps
    this.logger = deps.logger ?? noopLogger
  }

  /** 建一条会话。 */
  create(input: { source: string; requester: string; chatId?: string; threadId?: string }): AutomationConversation {
    const now = this.deps.clock()
    const id = `acv_${crypto.randomUUID().slice(0, 8)}`
    const conversation: AutomationConversation = {
      id,
      source: input.source,
      requester: input.requester,
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      // session 键绑到 conversationId：卡片点「恢复会话」时用同一个键就能接上历史。
      sessionKey: `automation:${id}`,
      text: '',
      missing: [],
      step: 'parse',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    this.deps.store.insertAutomationConversation(conversation)
    this.logger.info('automation:session-created', { conversationId: id, source: input.source })
    return conversation
  }

  /** 取一条会话。 */
  get(id: string): AutomationConversation | undefined {
    return this.deps.store.getAutomationConversation(id)
  }

  /** 列出会话。 */
  list(status?: AutomationConversation['status']): AutomationConversation[] {
    return this.deps.store.listAutomationConversations(status)
  }

  /** 取会话的消息流；after 之后的不返回（断线重连补齐用）。 */
  messages(id: string, after = 0): AutomationConversationWire[] {
    return this.deps.store.listAutomationConversationMessages(id, after).map(wireOf)
  }

  /**
   * 跑一轮：解析用户这句话，必要时回问，参数齐了出预览。
   *
   * 已确认的会话（恢复会话改任务）走同一条路径，只是落库时更新原任务而不是新建。
   */
  async turn(conversationId: string, text: string, onDelta?: (text: string) => void): Promise<SessionTurn> {
    const conversation = this.deps.store.getAutomationConversation(conversationId)
    if (!conversation) throw new Error(`automation:conversation-not-found: ${conversationId}`)
    this.push(conversationId, { role: 'user', text })

    const history = this.deps.store.listAutomationConversationMessages(conversationId)
    const context = history
      .filter(item => item.role === 'user')
      .map(item => item.text)
      .join('\n')

    const parsed = await parseAutomationIntent(context, {
      client: this.deps.client(),
      catalogs: this.deps.catalogs(),
      projects: this.deps.config().projects,
      ...(this.deps.probeParams ? { probeParams: this.deps.probeParams } : {}),
      ...(onDelta
        ? { onDelta: (chunk: string) => onDelta(chunk) }
        : this.deps.onDelta
          ? { onDelta: (chunk: string) => this.deps.onDelta?.(conversationId, chunk) }
          : {}),
      logger: this.logger,
    })

    const now = this.deps.clock()
    if (parsed.kind === 'none') {
      this.logger.info('automation:session-step', { conversationId, step: 'parse', missing: [] })
      const reply = parsed.speech || '这句我没看出是要建自动化任务，换个说法？'
      this.push(conversationId, { role: 'assistant', text: reply })
      return {
        text: reply,
        conversation,
        step: 'parse',
        missing: [],
        done: true,
      }
    }
    if (parsed.kind === 'unavailable') {
      const reply = '自动化助手还没配置模型，先在面板「自动化」里手动新建一条吧。'
      this.push(conversationId, { role: 'assistant', text: reply })
      return { text: reply, conversation, step: 'parse', missing: [], done: true }
    }
    if (parsed.kind === 'clarify') {
      const missing: AutomationConversationMissing[] = parsed.missing.map(field => ({
        field,
        question: parsed.question,
      }))
      const updated: AutomationConversation = {
        ...conversation,
        text: context.slice(-500),
        missing,
        step: 'clarify',
        updatedAt: now,
      }
      this.deps.store.updateAutomationConversation(updated)
      this.logger.info('automation:session-step', { conversationId, step: 'clarify', missing: parsed.missing })
      this.push(conversationId, { role: 'assistant', text: parsed.question, step: 'clarify', ...(parsed.speech ? { speech: parsed.speech } : {}) })
      return {
        text: parsed.question,
        conversation: updated,
        step: 'clarify',
        missing: parsed.missing,
        done: false,
      }
    }

    // 参数齐了：出预览卡。
    const task = this.taskOf(conversation, parsed.task)
    const preview = previewOf(parsed.task, task)
    const updated: AutomationConversation = {
      ...conversation,
      text: context.slice(-500),
      draft: task,
      missing: [],
      step: 'preview',
      updatedAt: now,
    }
    this.deps.store.updateAutomationConversation(updated)
    this.logger.info('automation:session-step', { conversationId, step: 'preview', missing: [] })
    this.push(conversationId, {
      role: 'assistant',
      text: '参数齐了，确认一下就建。',
      step: 'preview',
      preview,
      ...(parsed.speech ? { speech: parsed.speech } : {}),
    })
    return {
      text: '参数齐了，确认一下就建。',
      conversation: updated,
      preview,
      step: 'preview',
      missing: [],
      done: false,
    }
  }

  /**
   * 确认：把草稿落成正式任务。
   *
   * 已有任务（恢复会话）就更新它，不新建 —— 任务列表里始终是那一条（§12.2 V9）。
   */
  confirm(conversationId: string): SessionTurn {
    const conversation = this.deps.store.getAutomationConversation(conversationId)
    if (!conversation) throw new Error(`automation:conversation-not-found: ${conversationId}`)
    if (!conversation.draft) throw new Error(`automation:conversation-no-draft: ${conversationId}`)
    if (!this.deps.saveTask) throw new Error('automation:task-save-unavailable')

    const now = this.deps.clock()
    // 旧值要在落库前取：落库是原地覆盖，落完就比不出差异了。
    const previous = conversation.taskId ? this.savedTaskOf(conversation.taskId) : undefined
    const task: Automation = {
      ...conversation.draft,
      ...(conversation.taskId ? { id: conversation.taskId } : {}),
      updatedAt: now,
    }
    this.deps.saveTask(task)
    const updated: AutomationConversation = {
      ...conversation,
      taskId: task.id,
      draft: task,
      step: 'create',
      status: 'confirmed',
      updatedAt: now,
    }
    this.deps.store.updateAutomationConversation(updated)
    // 已有任务（恢复会话后改稿）记 task-updated，新建的记 task-created：
    // 面板与日志据此分清「新建了一条」和「改的是原来那条」（§12.2 V9）。
    if (conversation.taskId) {
      this.logger.info('automation:task-updated', {
        conversationId,
        taskId: task.id,
        changed: changedOf(previous, task),
      })
    } else {
      this.logger.info('automation:task-created', {
        conversationId,
        taskId: task.id,
        source: task.trigger.kind === 'event' ? task.trigger.source : 'schedule',
        types: task.trigger.kind === 'event' ? task.trigger.types : [],
        mode: task.trigger.kind === 'event' ? task.trigger.mode : '',
      })
    }
    this.push(conversationId, { role: 'assistant', text: `已建好「${task.name}」，点任务卡片的「恢复会话」可以继续改。` })
    return {
      text: `已建好「${task.name}」。`,
      conversation: updated,
      step: 'create',
      missing: [],
      done: true,
      taskId: task.id,
    }
  }

  /** 把草稿组装成完整的任务定义。 */
  private taskOf(conversation: AutomationConversation, draft: AutomationTaskDraft): Automation {
    const project = this.deps.config().projects.find(item => item.name === draft.project)
    const now = this.deps.clock()
    const trigger = draft.subscription
      ? {
          kind: 'event' as const,
          source: draft.subscription.source,
          types: draft.subscription.types,
          params: draft.subscription.params,
          filter: draft.subscription.filter,
          mode: draft.subscription.mode,
        }
      : { kind: 'schedule' as const, schedule: draft.schedule ?? { kind: 'daily' as const, at: '09:00' } }
    return {
      id: conversation.taskId ?? `auto_${crypto.randomUUID().slice(0, 8)}`,
      name: draft.name,
      description: draft.description,
      type: draft.type,
      prompt: draft.prompt,
      trigger,
      skill: draft.skill,
      notifyTo: draft.notifyTo,
      conversationId: conversation.id,
      runtimeId: '',
      project: draft.project,
      repo: project?.repo ?? '',
      branch: project?.defaultBranch ?? '',
      enabled: true,
      createdBy: 'conversation',
      createdAt: conversation.createdAt || now,
      updatedAt: now,
    }
  }

  /**
 * 已落库的那条任务。
   *
 * 用来算「这次改了哪些字段」——会话里的草稿每轮都会被覆盖，
 * 拿它当旧值永远比不出差异。
   */
  private savedTaskOf(taskId: string): Automation | undefined {
    return this.deps.config().tasks?.find(item => item.id === taskId)
  }

  /** 追加一条消息。 */
  private push(
    conversationId: string,
    message: Omit<AutomationConversationMessage, 'seq' | 'conversationId' | 'createdAt'>,
  ): void {
    const seq = this.deps.store.lastAutomationConversationSeq(conversationId) + 1
    this.deps.store.insertAutomationConversationMessage({
      ...message,
      seq,
      conversationId,
      createdAt: this.deps.clock(),
    })
  }
}

/** 消息 → 对外形状（去掉存库用的字段）。 */
function wireOf(message: AutomationConversationMessage): AutomationConversationWire {
  const { conversationId: _conversationId, createdAt: _createdAt, ...wire } = message
  return wire
}

/** 预览卡：把解析结果整理成人能看懂的参数一览。 */
export function previewOf(draft: AutomationTaskDraft, task: Automation): AutomationPreview {
  const subscription = draft.subscription
  return {
    name: draft.name,
    source: subscription?.source ?? '',
    types: subscription?.types ?? [],
    params: subscription?.params ?? {},
    keywords: subscription?.filter.keywords ?? [],
    semantic: subscription?.filter.semantic ?? '',
    mode: subscription?.mode ?? 'auto',
    project: draft.project,
    skill: draft.skill,
    runtimeId: task.runtimeId,
    prompt: draft.prompt,
    trigger: subscription ? '事件触发（无定时）' : `定时触发（${draft.schedule?.kind ?? 'daily'}）`,
  }
}

/**
 * 这次改动动了哪些字段。
 *
 * 只比用户看得见的几项：名字、提示词、订阅类型、过滤条件、处理方式、项目。
 * 内部字段（时间戳、id）不算改动 —— 否则每次确认都会报「改了 updatedAt」。
 */
export function changedOf(before: Automation | undefined, after: Automation): string[] {
  if (!before) return []
  const changed: string[] = []
  if (before.name !== after.name) changed.push('name')
  if (before.prompt !== after.prompt) changed.push('prompt')
  if (before.project !== after.project) changed.push('project')
  if (before.skill !== after.skill) changed.push('skill')
  if (before.enabled !== after.enabled) changed.push('enabled')
  if (JSON.stringify(before.trigger) !== JSON.stringify(after.trigger)) changed.push('trigger')
  return changed
}
