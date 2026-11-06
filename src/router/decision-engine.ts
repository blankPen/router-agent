import type { Decision, Strength, Trigger } from '../core/model.js'

/**
 * 研判层的扩展端口。
 *
 * 设计要点（见《用 Pi 替换 LLM 研判层》方案）：
 * - 替换的是「provider + loop」整层，而不是 LlmClient；
 * - 实现方只产出 DecisionProposal，不写库；
 * - 真正的 Engine.decide() 由 AgentLoop 统一调用，保证审计与回放。
 */
export type DecisionEngineKind = 'custom' | 'pi'

/** 研判层给出的决定草稿。写库前还要经过派工解析与 Engine。 */
export interface DecisionProposal {
  triggerId: string
  decision: Decision
  reason: string
  title?: string
  scope?: string
  repo?: string
  branch?: string
  rules: string[]
  strength: Strength
}

/** 一次研判调用的输入。system/user prompt 由 AgentLoop 统一构造，两个引擎看到同一份输入。 */
export interface DecisionRequest {
  trigger: Trigger
  strength: Strength
  systemPrompt: string
  userPrompt: string
}

/** 工具调用审计：只记录名字、参数摘要与成败，不记录工具返回值全文。 */
export interface DecisionToolCall {
  name: string
  args: string
  ok: boolean
  error?: string
}

export interface DecisionTokens {
  input: number
  output: number
  total: number
}

/** 每次研判的审计记录。CLI 会把它落到 ~/.router-agent/logs/decisions.jsonl。 */
export interface DecisionAudit {
  engine: DecisionEngineKind
  triggerId: string
  durationMs: number
  toolCalls: DecisionToolCall[]
  tokens: DecisionTokens
  promptChars: { system: number; user: number }
  provider?: string
  model?: string
  /** 完整 prompt 只进审计文件，日志只留长度。 */
  systemPrompt?: string
  userPrompt?: string
  proposal?: DecisionProposal
  unavailableReason?: string
}

export interface DecisionEngineResult {
  proposal?: DecisionProposal
  unavailableReason?: string
  audit: DecisionAudit
}

export interface DecisionEngine {
  readonly kind: DecisionEngineKind
  /** 对一个 Trigger 做研判。实现内部可以自研 loop，也可以用 Pi session。 */
  assess(req: DecisionRequest): Promise<DecisionEngineResult>
}

export type ProposalParseResult =
  | { kind: 'proposal'; proposal: DecisionProposal }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; reason: string }

const DECISIONS: Decision[] = ['accept', 'stop', 'ignore', 'unavailable']

/**
 * 把自由文本里的 JSON 决定解析成 proposal。
 * 保留 extractJsonObject 兜底：Pi 没调用工具时也能拿到决定。
 */
export function proposalFromJson(json: Record<string, unknown>, triggerId: string, strength: Strength): ProposalParseResult {
  const decision = String(json.decision ?? '')
  if (!DECISIONS.includes(decision as Decision)) {
    return { kind: 'error', reason: `非法决定：${decision || '(空)'}` }
  }
  if (decision === 'unavailable') {
    return { kind: 'unavailable', reason: String(json.reason ?? '模型判定未完成') }
  }
  return {
    kind: 'proposal',
    proposal: {
      triggerId,
      decision: decision as Decision,
      strength,
      reason: String(json.reason ?? ''),
      rules: Array.isArray(json.rules) ? json.rules.map(String) : [],
      ...(json.title === undefined ? {} : { title: String(json.title) }),
      ...(json.scope === undefined ? {} : { scope: String(json.scope) }),
      ...(json.repo === undefined ? {} : { repo: String(json.repo).trim() }),
      ...(json.branch === undefined ? {} : { branch: String(json.branch).trim() }),
    },
  }
}

/** 影子模式的一次对照记录。 */
export interface ShadowSide {
  engine: DecisionEngineKind
  outcome: 'accept' | 'ignore' | 'unavailable' | 'error'
  decision?: Decision
  title?: string
  repo?: string
  branch?: string
  latencyMs: number
  tokens: number
  toolCalls: number
  reason?: string
}

export interface ShadowComparison {
  id: string
  triggerId: string
  primary: ShadowSide
  shadow: ShadowSide
  /** 主/影子在「是否接单 + 派工目标」上是否一致。标题差异只进 diff，不算分歧。 */
  agree: boolean
  diff: string[]
  createdAt: string
}

function sideOf(result: DecisionEngineResult): ShadowSide {
  const audit = result.audit
  const proposal = result.proposal
  if (!proposal) {
    return {
      engine: audit.engine,
      outcome: 'unavailable',
      latencyMs: audit.durationMs,
      tokens: audit.tokens.total,
      toolCalls: audit.toolCalls.length,
      ...(result.unavailableReason ? { reason: result.unavailableReason } : {}),
    }
  }
  return {
    engine: audit.engine,
    outcome: proposal.decision === 'accept' ? 'accept' : proposal.decision === 'unavailable' ? 'unavailable' : 'ignore',
    decision: proposal.decision,
    latencyMs: audit.durationMs,
    tokens: audit.tokens.total,
    toolCalls: audit.toolCalls.length,
    ...(proposal.title ? { title: proposal.title } : {}),
    ...(proposal.repo ? { repo: proposal.repo } : {}),
    ...(proposal.branch ? { branch: proposal.branch } : {}),
    ...(proposal.reason ? { reason: proposal.reason } : {}),
  }
}

/** 比较主引擎与影子引擎：接单与否、派工目标是否一致。 */
export function compareShadow(
  triggerId: string,
  primary: DecisionEngineResult,
  shadow: DecisionEngineResult,
  createdAt: string,
  id: string,
): ShadowComparison {
  const left = sideOf(primary)
  const right = sideOf(shadow)
  const diff: string[] = []
  if (left.outcome !== right.outcome) diff.push('outcome')
  if ((left.decision ?? '') !== (right.decision ?? '')) diff.push('decision')
  if ((left.title ?? '') !== (right.title ?? '')) diff.push('title')
  if ((left.repo ?? '') !== (right.repo ?? '')) diff.push('repo')
  if ((left.branch ?? '') !== (right.branch ?? '')) diff.push('branch')
  const agree = left.outcome === right.outcome
    && (left.outcome !== 'accept' || ((left.repo ?? '') === (right.repo ?? '') && (left.branch ?? '') === (right.branch ?? '')))
  return { id, triggerId, primary: left, shadow: right, agree, diff, createdAt }
}
