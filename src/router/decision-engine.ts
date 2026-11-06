import type { Decision, Strength, Trigger } from '../core/model.js'

/**
 * 研判层端口。
 *
 * 设计要点（见《用 Pi 替换 LLM 研判层》方案）：
 * - 替换的是「provider + loop」整层，而不是单次 HTTP 调用；
 * - 实现方只产出 DecisionProposal，不写库；
 * - 真正的 Engine.decide() 由 AgentLoop 统一调用，保证审计与回放；
 * - 寒暄 / 追问的礼貌回复也走同一个引擎，保证全链路只有一条模型通道。
 */
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

/** 一次研判的输入。system/user prompt 由 AgentLoop 统一构造。 */
export interface DecisionRequest {
  trigger: Trigger
  strength: Strength
  systemPrompt: string
  userPrompt: string
}

/** 一次礼貌回复的输入。 */
export interface ReplyRequest {
  systemPrompt: string
  userPrompt: string
}

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
  engine: 'pi'
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
  /** 对一个 Trigger 做研判。 */
  assess(req: DecisionRequest): Promise<DecisionEngineResult>
  /** 生成一句礼貌回复（普通消息）。失败抛错，由调用方退回固定话术。 */
  reply(req: ReplyRequest): Promise<string>
}

export type ProposalParseResult =
  | { kind: 'proposal'; proposal: DecisionProposal }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; reason: string }

const DECISIONS: Decision[] = ['accept', 'stop', 'ignore', 'unavailable']

/**
 * 把自由文本里的 JSON 决定解析成 proposal。
 * 保留 JSON 兜底：Pi 没调用工具时也能拿到决定。
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