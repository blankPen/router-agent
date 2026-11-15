/**
 * 事件决策：一次判定产出「要不要做 / 优先级 / 类型 / 归属项目 / 执行方式 / 要不要人审」。
 *
 * 判定顺序：规则先判、模型兜底。
 * 规则能定案的不调模型；模型只在灰区调一次，判定依据是面板上可配置的决策 prompt。
 * 模型输出必须落在闭集内（项目清单、skill 清单），选不中就降级转人工，不凭空造。
 */
import type { EventDecisionConfig, EventSourceConfig, ProjectConfig } from '../config.js'
import type { EventPriority, EventRecord, EventVerdict } from '#core/event.js'
import { normalizeEventPriority } from '#core/event.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import { DEFAULT_EVENT_SKILL, findEventSkill, type EventSkill } from './skills.js'

/** 命中这些标签的事件直接转人工：安全、生产、付费、对外发布。 */
export const RISK_LABELS = ['security', 'prod', 'production', 'incident', 'payment', 'release']

/** 决策输入：事件 + 订阅配置 + 候选闭集 + 判定依据。 */
export interface EventDecisionInput {
  event: EventRecord
  source: EventSourceConfig
  /** 候选项目（闭集）：模型只能从中选。 */
  projects: ProjectConfig[]
  /** 候选 skill（闭集）。 */
  skills: readonly EventSkill[]
  decision: EventDecisionConfig
  /** 当前决策 prompt 正文。 */
  prompt: string
  /** prompt 版本号，随判定结果一起回填。 */
  promptVersion: number
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
  promptVersion: number
  /** 判定依据：命中的规则名或模型名。 */
  basis: string
}

export interface EventDecisionServiceDeps {
  decision: EventDecisionConfig
  /** 规则端口：永远先跑。 */
  rule: EventDecisionPort
  /** 模型端口：provider 为 jev / llm 时才用。 */
  model?: EventDecisionPort
  logger?: Logger
}

/** 事件决策服务：规则先判、模型兜底、闭集校验、降级兜底。 */
export class EventDecisionService {
  private decision: EventDecisionConfig
  private rule: EventDecisionPort
  private model?: EventDecisionPort
  private logger: Logger

  constructor(deps: EventDecisionServiceDeps) {
    this.decision = deps.decision
    this.rule = deps.rule
    this.model = deps.model
    this.logger = deps.logger ?? noopLogger
  }

  async decide(input: EventDecisionInput): Promise<EventDecisionResult> {
    const rule = await this.rule.decide(input)
    let output: EventDecisionOutput = rule ?? {}
    let basis = this.rule.name
    // 判定是否完成：模型失败时为 false，事件留在队列里等下一轮，不能派工。
    let decided = true

    // 规则没把关键项定全时才调模型：省 token，也避免模型在明确事实上乱改。
    if (this.model && this.decision.provider !== 'rule' && this.needsModel(rule)) {
      try {
        const model = await this.model.decide(input)
        if (model) {
          output = mergeOutput(rule ?? {}, model)
          basis = `${this.rule.name}+${this.model.name}`
        } else {
          this.logger.warn('event:decision-no-output', { eventId: input.event.id, provider: this.model.name })
        }
      } catch (error) {
        // 模型失败不丢事件：降级成待审核，人来定。
        this.logger.error('event:decision-failed', {
          eventId: input.event.id,
          provider: this.model.name,
          message: errorMessage(error),
        })
        // 判定没完成：模型失败时不存在可信结论，不能拿去派工。
        // 兜底策略 pending 表示事件留在队列里等下一轮重判，而不是转人工。
        output = {
          ...output,
          needsReview: this.decision.fallback !== 'pending',
          reason: `判定模型失败：${errorMessage(error)}`,
        }
        decided = false
        basis = `${basis}+failed`
      }
    }

    const verdict = this.validate(input, output)
    verdict.decided = decided
    return { verdict, promptVersion: input.promptVersion, basis }
  }

  /** 规则已经定全（项目、优先级、类型、处理方式都有）时不必再问模型。 */
  private needsModel(rule: EventDecisionOutput | null): boolean {
    if (!rule) return true
    if (!rule.project) return true
    if (!rule.priority) return true
    return false
  }

  /**
   * 闭集校验与兜底：项目 / skill 选不中、置信度不够，一律转人工。
   * 这是「prompt 是自然语言，但输出必须可控」的落地点。
   */
  private validate(input: EventDecisionInput, output: EventDecisionOutput): EventVerdict {
    const reasons: string[] = []
    const actionable = output.actionable !== false
    const priority = actionable ? normalizeEventPriority(output.priority) : 'P4'
    const eventType = (output.eventType ?? '').trim() || 'event'

    let project = this.matchProject(input.projects, output.project ?? '')
    if (output.project && !project) {
      reasons.push(`项目「${output.project}」不在候选清单里`)
    }
    // 没有模型可用（provider=rule）时，订阅配置里人工写明的项目就是结论；
    // 有模型时它只是线索，归属项目交给模型按 prompt 判定。
    if (!project && this.decision.provider === 'rule' && input.source.project) {
      project = this.matchProject(input.projects, input.source.project)
      if (project) reasons.unshift(`按订阅配置归入项目「${project.name}」`)
    }
    // 兜底策略是 pending 时，模型没判出项目就用订阅线索顶上：
    // 事件有归属才能留在队列里等下一轮重判，而不是只能转人工。
    if (!project && this.decision.fallback === 'pending' && input.source.project) {
      project = this.matchProject(input.projects, input.source.project)
      if (project) reasons.unshift(`按订阅配置归入项目「${project.name}」`)
    }

    const skillId = (output.skill ?? '').trim()
    const skill = skillId ? findEventSkill(skillId) : undefined
    if (skillId && !skill) {
      reasons.push(`处理方式「${skillId}」不在候选清单里`)
    }

    const confidence = typeof output.confidence === 'number' && Number.isFinite(output.confidence)
      ? Math.min(1, Math.max(0, output.confidence))
      : this.decision.provider === 'rule' ? 1 : 0

    let needsReview = output.needsReview === true
    if (confidence < this.decision.confidenceThreshold) {
      reasons.push(`置信度 ${confidence.toFixed(2)} 低于阈值 ${this.decision.confidenceThreshold}`)
      // 兜底策略：pending 表示留在队列里等下一轮重判，不占用人工。
      needsReview = this.decision.fallback !== 'pending'
    }
    // 没有归属项目就没法开单（工单必须绑定项目），只能转人工。
    if (actionable && !project) {
      needsReview = true
      reasons.push('没有判定出归属项目')
    }
    // 模型给的理由与校验给的理由都要保留：面板上要能看到「为什么转人工」。
    if (output.reason?.trim()) reasons.push(output.reason.trim())

    const projectConfig = project
    const branch = input.source.branch?.trim() || projectConfig?.defaultBranch || ''

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

/**
 * 模型输出覆盖规则输出，但空值不覆盖。
 *
 * `needsReview` 只允许从「要人审」变成「不要人审」的相反方向：
 * 规则判定要人审时（风险标签命中），模型说了不算 —— 安全护栏不能被模型解开。
 */
function mergeOutput(rule: EventDecisionOutput, model: EventDecisionOutput): EventDecisionOutput {
  const merged: EventDecisionOutput = { ...rule }
  for (const [key, value] of Object.entries(model)) {
    if (value === undefined || value === null || value === '') continue
    if (key === 'needsReview' && rule.needsReview === true) continue
    ;(merged as Record<string, unknown>)[key] = value
  }
  return merged
}

/**
 * 规则端口：完全确定性的判定，不调模型、不花钱。
 *
 * 规则只给「事实」：来源默认优先级与类型、风险标签必须人审、
 * 定时任务固定走汇总播报。其余（项目、skill）留给模型或人工。
 */
export const ruleDecisionPort: EventDecisionPort = {
  name: 'rule',
  async decide(input: EventDecisionInput): Promise<EventDecisionOutput | null> {
    const source = input.source
    const labels = (source.labels ?? []).map(label => label.trim().toLowerCase()).filter(Boolean)
    const risky = labels.some(label => RISK_LABELS.includes(label))
    const eventType = (source.defaultType ?? '').trim() || defaultTypeOf(input.event.sourceKind)
    const skill = input.event.sourceKind === 'schedule' ? 'daily-digest' : ''
    const output: EventDecisionOutput = {
      actionable: true,
      priority: risky ? 'P0' : normalizeEventPriority(source.defaultPriority),
      eventType,
      ...(skill ? { skill } : {}),
      ...(risky ? { needsReview: true, reason: '命中风险标签，需要人工确认' } : {}),
      confidence: 1,
    }
    // 来源自己写明了项目时，这只是线索：仍然交给模型结合 prompt 判定。
    if (!risky && !source.project) return output
    return output
  },
}

/** 按来源种类给一个默认事件类型。 */
function defaultTypeOf(sourceKind: string): string {
  if (sourceKind === 'schedule') return 'digest'
  if (sourceKind === 'github') return 'issue'
  return 'event'
}
