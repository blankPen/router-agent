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
import { DEFAULT_RULE_RISK_LABELS, type EventRule } from './rules.js'

/** 命中这些标签的事件直接转人工：安全、生产、付费、对外发布。 */
export const RISK_LABELS = DEFAULT_RULE_RISK_LABELS

/** 决策输入：事件 + 订阅配置 + 候选闭集 + 判定依据。 */
export interface EventDecisionInput {
  event: EventRecord
  source: EventSourceConfig
  /** 命中的规则；没有规则时不调用判定服务。 */
  rule?: EventRule
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
  /** 支持直接给配置或 getter：面板热改 provider / 阈值后立即生效。 */
  decision: EventDecisionConfig | (() => EventDecisionConfig)
  /** 规则端口：永远先跑。 */
  rule: EventDecisionPort
  /** 模型端口：provider 为 jev / llm 时才用。 */
  model?: EventDecisionPort
  logger?: Logger
}

/** 事件决策服务：规则先判、模型兜底、闭集校验、降级兜底。 */
export class EventDecisionService {
  private decision: EventDecisionConfig | (() => EventDecisionConfig)
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
    const current = this.decisionOf()
    const rule = await this.rule.decide(input)
    let output: EventDecisionOutput = rule ?? {}
    let basis = this.rule.name
    // 判定是否完成：模型失败时为 false，事件留在队列里等下一轮，不能派工。
    let decided = true

    // 规则没把关键项定全时才调模型：省 token，也避免模型在明确事实上乱改。
    if (this.model && current.provider !== 'rule') {
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
          needsReview: current.fallback !== 'pending',
          reason: `判定模型失败：${errorMessage(error)}`,
        }
        decided = false
        basis = `${basis}+failed`
      }
    }

    const verdict = this.validate(input, output, current)
    verdict.decided = decided
    return { verdict, promptVersion: input.promptVersion, basis }
  }

  /**
   * 闭集校验与兜底：项目 / skill 选不中、置信度不够，一律转人工。
   * 这是「prompt 是自然语言，但输出必须可控」的落地点。
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
    // 模型没判出归属时，用订阅的仓库名兜底：
    // 事件有归属才能留在队列里等下一轮重判，而不是只能转人工。
    if (!project) {
      const byRepo = matchProjectByRepo(input.projects, input.source.repo ?? '')
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
    const threshold = input.rule && input.rule.id !== 'legacy-prompt'
      ? input.rule.thresholds.isValid
      : decision.confidenceThreshold
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

/**
 * 模型输出覆盖规则输出，但空值不覆盖。
 *
 * `needsReview` 与 `priority` 都是护栏：规则判定要人审、提到 P0 时，
 * 模型说了不算 —— 安全护栏不能被模型解开或降级。
 */
function mergeOutput(rule: EventDecisionOutput, model: EventDecisionOutput): EventDecisionOutput {
  const merged: EventDecisionOutput = { ...rule }
  for (const [key, value] of Object.entries(model)) {
    if (value === undefined || value === null || value === '') continue
    if (key === 'needsReview' && rule.needsReview === true) continue
    // 模型不能把规则强制的 P0 降级：低峰窗口只放行 P2/P3，降级等于绕过闸门。
    if (key === 'priority' && rule.priority === 'P0' && normalizeEventPriority(value) !== 'P0') continue
    ;(merged as Record<string, unknown>)[key] = value
  }
  return merged
}

/**
 * 规则端口：完全确定性的判定，不调模型、不花钱。
 *
 * 规则只给「事实」：风险标签必须人审。
 * 其余（优先级、项目、skill）留给模型或人工。
 */
export const ruleDecisionPort: EventDecisionPort = {
  name: 'rule',
  async decide(input: EventDecisionInput): Promise<EventDecisionOutput | null> {
    const labels = labelsOf(input.event)
    const riskLabels = input.rule?.guardrails.riskLabels ?? RISK_LABELS
    const risky = labels.some(label => riskLabels.includes(label))
    const eventType = input.event.eventType || defaultTypeOf(input.event.sourceKind)
    const output: EventDecisionOutput = {
      actionable: true,
      // 订阅里不写优先级：规则只认风险标签提 P0，其余按中性档位，
      // 真正的优先级由决策模型按 prompt 判定。
      priority: risky ? 'P0' : 'P3',
      eventType,
      ...(risky ? { needsReview: true, reason: '命中风险标签，需要人工确认' } : {}),
      confidence: 1,
    }
    return output
  },
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
 * 事件上的标签。
 *
 * 真实 GitHub 载荷里标签在 `payload.issue.labels`，不在顶层 `issue.labels`；
 * 两个位置都读，护栏才不会因为路径写错而失效。
 */
function labelsOf(event: EventRecord): string[] {
  const raw = event.raw
  if (!raw || typeof raw !== 'object') return []
  const row = raw as Record<string, unknown>
  const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : null
  const issue = payload?.issue && typeof payload.issue === 'object'
    ? payload.issue as Record<string, unknown>
    : (row.issue && typeof row.issue === 'object' ? row.issue as Record<string, unknown> : null)
  const source = issue && Array.isArray(issue.labels) ? issue.labels : (Array.isArray(row.labels) ? row.labels : [])
  return source
    .map(label => String(typeof label === 'object' && label ? (label as Record<string, unknown>).name ?? '' : label))
    .map(label => label.trim().toLowerCase())
    .filter(Boolean)
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
