/**
 * 事件决策：一次判定产出「要不要做 / 优先级 / 类型 / 归属项目 / 执行方式 / 要不要人审」。
 *
 * 判定依据是**命中的订阅**：订阅里已经写清了归属项目、处理方式与处理模式，
 * 模型只补「这件事值不值得做、有多急」这类需要判断的部分。
 *
 * 模型输出必须落在闭集内（项目清单、skill 清单），选不中就降级转人工，不凭空造。
 */
import type { EventDecisionConfig, EventSourceConfig, ProjectConfig } from '../config.js'
import type { EventPriority, EventRecord, EventVerdict } from '#core/event.js'
import { normalizeEventPriority } from '#core/event.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import { DEFAULT_EVENT_SKILL, findEventSkill } from './skills.js'
import type { ResolvedSubscription } from './subscriptions.js'

/** 决策输入：事件 + 命中的订阅 + 候选闭集 + 判定依据。 */
export interface EventDecisionInput {
  event: EventRecord
  source: EventSourceConfig
  /** 命中的订阅；没有订阅时不调用判定服务。 */
  subscription?: ResolvedSubscription
  /** 候选项目（闭集）：模型只能从中选。 */
  projects: ProjectConfig[]
  decision: EventDecisionConfig
}

/** 决策端口的输出；字段缺省表示「这一项模型没给」。 */
export interface EventDecisionOutput {
  actionable?: boolean
  priority?: EventPriority
  eventType?: string
  project?: string
  skill?: string
  needsReview?: boolean
  reason?: string
  confidence?: number
}

/** 判定端口：规则端口与模型端口共用一个形状。 */
export interface EventDecisionPort {
  readonly name: string
  decide(input: EventDecisionInput): Promise<EventDecisionOutput | null>
}

/** 判定结论 + 审计信息。 */
export interface EventDecisionResult {
  verdict: EventVerdict
  /** 判定依据：命中的规则名或模型名。 */
  basis: string
}

export interface EventDecisionServiceDeps {
  /** 支持直接给配置或 getter：面板热改 provider / 阈值后立即生效。 */
  decision: EventDecisionConfig | (() => EventDecisionConfig)
  /** 模型端口：provider 为 jev / llm 时才用。 */
  model?: EventDecisionPort
  logger?: Logger
}

/** 事件决策服务：订阅给结论、模型补判断、闭集校验、降级兜底。 */
export class EventDecisionService {
  private decision: EventDecisionConfig | (() => EventDecisionConfig)
  private model?: EventDecisionPort
  private logger: Logger

  constructor(deps: EventDecisionServiceDeps) {
    this.decision = deps.decision
    this.model = deps.model
    this.logger = deps.logger ?? noopLogger
  }

  async decide(input: EventDecisionInput): Promise<EventDecisionResult> {
    const current = this.decisionOf()
    // 订阅已经写清了归属项目、处理方式与处理模式；模型只补需要判断的部分。
    const subscription = input.subscription
    let output: EventDecisionOutput = {
      actionable: true,
      ...(subscription?.project ? { project: subscription.project } : {}),
      ...(subscription?.skill ? { skill: subscription.skill } : {}),
      confidence: 1,
    }
    let basis = 'subscription'
    // 判定是否完成：模型失败时为 false，事件留在队列里等下一轮，不能派工。
    let decided = true

    if (this.model && current.provider !== 'rule') {
      try {
        const model = await this.model.decide(input)
        if (model) {
          output = mergeOutput(output, model)
          basis = `subscription+${this.model.name}`
        } else {
          this.logger.warn('event:decision-no-output', { eventId: input.event.id, provider: this.model.name })
        }
      } catch (error) {
        // 模型失败不丢事件：降级成待审核，人来定。
        // 401 / 403 / 451 这类永久错误重试也不会变好，直接转人工，不浪费 5 次重试。
        const permanent = isPermanentDecisionError(error)
        this.logger.error('event:decision-failed', {
          eventId: input.event.id,
          provider: this.model.name,
          permanent,
          message: errorMessage(error),
        })
        // 判定没完成：模型失败时不存在可信结论，不能拿去派工。
        // 兜底策略 pending 表示事件留在队列里等下一轮重判，而不是转人工。
        output = {
          ...output,
          needsReview: permanent || current.fallback !== 'pending',
          reason: `判定模型失败：${errorMessage(error)}`,
        }
        decided = permanent
        basis = `${basis}+failed`
      }
    }

    const verdict = this.validate(input, output, current)
    verdict.decided = decided
    verdict.basis = basis
    return { verdict, basis }
  }

  /**
   * 闭集校验与兜底：项目 / skill 选不中、置信度不够，一律转人工。
   * 这是「判定依据是自然语言，但输出必须可控」的落地点。
   */
  private validate(input: EventDecisionInput, output: EventDecisionOutput, decision: EventDecisionConfig): EventVerdict {
    const reasons: string[] = []
    const actionable = output.actionable !== false
    const priority = actionable ? normalizeEventPriority(output.priority) : 'P4'
    const eventType = this.eventTypeOf(input, output)

    let project = this.matchProject(input.projects, output.project ?? '')
    if (output.project && !project) {
      reasons.push(`项目「${output.project}」不在候选清单里`)
    }
    // 模型没给归属时，用订阅的仓库参数兜底：
    // 事件有归属才能留在队列里等下一轮重判，而不是只能转人工。
    // 模型给了但不在清单里时不兜底 —— 那说明模型在编造，不该被悄悄修正。
    if (!project && !output.project) {
      const byRepo = matchProjectByRepo(input.projects, input.source.repo ?? input.subscription?.params.repo ?? '')
      if (byRepo) {
        project = byRepo
        reasons.unshift(`按订阅仓库归入项目「${byRepo.name}」`)
      }
    }

    const skillId = (output.skill ?? '').trim()
    const skill = skillId ? findEventSkill(skillId) : undefined
    if (skillId && !skill) {
      reasons.push(`处理方式「${skillId}」不在候选清单里`)
    }

    const confidence = typeof output.confidence === 'number' && Number.isFinite(output.confidence)
      ? Math.min(1, Math.max(0, output.confidence))
      : decision.provider === 'rule' ? 1 : 0

    let needsReview = output.needsReview === true
    // 订阅的处理方式是「待人审」时，命中即进待审核队列 —— 这是任务属性，不是模型判断。
    if (input.subscription?.mode === 'review') needsReview = true
    const threshold = decision.confidenceThreshold
    if (confidence < threshold) {
      reasons.push(`置信度 ${confidence.toFixed(2)} 低于阈值 ${threshold}`)
      // 兜底策略：pending 表示留在队列里等下一轮重判，不占用人工。
      needsReview = decision.fallback !== 'pending'
    }
    // 没有归属项目就没法开单（工单必须绑定项目），只能转人工。
    if (actionable && !project) {
      needsReview = true
      reasons.push('没有判定出归属项目')
    }
    // 模型给的理由与校验给的理由都要保留：面板上要能看到「为什么转人工」。
    if (output.reason?.trim()) reasons.push(output.reason.trim())

    const projectConfig = project
    const branch = projectConfig?.defaultBranch || ''

    return {
      actionable,
      priority,
      eventType,
      project: projectConfig?.name ?? '',
      skill: skill?.id ?? (actionable ? DEFAULT_EVENT_SKILL : ''),
      repo: projectConfig?.repo ?? '',
      branch,
      needsReview,
      decided: true,
      reason: reasons.join('；'),
      confidence,
      basis: '',
    }
  }

  private decisionOf(): EventDecisionConfig {
    return typeof this.decision === 'function' ? this.decision() : this.decision
  }

  /**
   * 事件类型：模型给的是分类，来源前缀由宿主补。
   *
   * 前缀是「来自哪个来源」的事实，模型不该也不需要决定：
   * 模型只补分类部分（bug / question …），宿主按事件原有的前缀拼回去。
   */
  private eventTypeOf(input: EventDecisionInput, output: EventDecisionOutput): string {
    const current = input.event.eventType || defaultTypeOf(input.event.sourceKind)
    const classified = (output.eventType ?? '').trim()
    if (!classified) return current
    // 模型自己带了前缀就照用（它可能知道更细的来源口径）。
    if (classified.includes('.')) return classified
    // 前缀按来源种类取，不从原类型里切 —— 原类型可能本身就不带前缀。
    const prefix = input.event.sourceKind || 'event'
    return `${prefix}.${classified}`
  }

  /** 在候选项目里按项目名或仓库匹配。 */
  private matchProject(projects: ProjectConfig[], value: string): ProjectConfig | undefined {
    const want = value.trim().toLowerCase()
    if (!want) return undefined
    return projects.find(project =>
      project.name.trim().toLowerCase() === want
      || project.repo.trim().toLowerCase() === want
      || project.repo.trim().toLowerCase().endsWith(`/${want}`),
    )
  }

}

/** 判定模型的永久错误：重试不会成功，直接转人工。 */
function isPermanentDecisionError(error: unknown): boolean {
  return /jev:http-(401|403|451)\b/.test(errorMessage(error))
}

/**
 * 模型输出覆盖规则输出，但空值不覆盖。
 *
 * 订阅给出的结论（归属项目、处理方式）是**确定性事实**，模型不能改：
 * 模型说「这个事件属于别的项目」时，以订阅为准 —— 用户在会话里说的是哪个项目，
 * 就归哪个项目。
 */
function mergeOutput(base: EventDecisionOutput, model: EventDecisionOutput): EventDecisionOutput {
  const merged: EventDecisionOutput = { ...base }
  for (const [key, value] of Object.entries(model)) {
    if (value === undefined || value === null || value === '') continue
    // 订阅定下的项目与处理方式，模型改不了。
    if (key === 'project' && base.project) continue
    if (key === 'skill' && base.skill) continue
    ;(merged as Record<string, unknown>)[key] = value
  }
  return merged
}

/**
 * 按订阅的 GitHub 仓库名匹配项目。
 *
 * 项目清单里存的是本地仓库路径，GitHub 订阅里是 `owner/repo`；
 * 仓库名与项目名或路径末段一致就算命中。
 */
export function matchProjectByRepo(projects: ProjectConfig[], repo: string): ProjectConfig | undefined {
  const name = repo.trim().toLowerCase().split('/').pop() ?? ''
  if (!name) return undefined
  return projects.find(project =>
    project.name.trim().toLowerCase() === name
    || project.repo.trim().toLowerCase().split('/').pop() === name,
  )
}

/**
 * 按来源种类给一个默认事件类型。
 *
 * 带来源前缀，与来源自己产出的事件类型保持同一套写法：
 * 不同来源的事件在队列里一眼能分清。
 */
function defaultTypeOf(sourceKind: string): string {
  if (sourceKind === 'github') return 'github.issue'
  return 'event'
}
