import type { Decision, Strength, Trigger } from '#core/model.js'
import type { ToolScope } from '#core/tool-scope.js'
import type { SessionKeyParts } from './session-registry.js'

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
  /**
   * 需求要先讨论几轮再开单。
   *
   * 管理员的需求分级用：信息充分走 accept 直接开单，模糊或复杂走 clarify，
   * 由 Router 先与用户把需求讨论清楚，再落成工单。
   */
  clarify?: boolean
}

/** 一次研判的输入。system/user prompt 由 AgentLoop 统一构造。 */
export interface DecisionRequest {
  trigger: Trigger
  strength: Strength
  systemPrompt: string
  userPrompt: string
  /**
   * 是否允许调用写工具（关单 / 回收 workspace）。
   * 由 AgentLoop 按 Gate 的准入结果给出：发送人在名单内，且是 @ 或私聊。
   * 缺省为 false，保证嵌入用法不会意外获得写权限。
   */
  canMutate?: boolean
  /** 会话复用：本轮落在哪个 session；不传则保持旧的「一次一建」行为。 */
  session?: SessionKeyParts
  /**
   * 发送人的工具范围（权限与工具白名单的硬边界）。
   * 由 AgentLoop 按发送人身份计算：管理员 admin-full，名单外普通成员 member-analysis-read。
   * 缺省按 admin-full 处理（保持既有调用方行为），AgentLoop 始终显式声明。
   */
  toolScope?: ToolScope
}

/** 一次礼貌回复的输入。 */
export interface ReplyRequest {
  systemPrompt: string
  userPrompt: string
  /** 会话复用：本轮落在哪个 session；不传则保持旧的「一次一建」行为。 */
  session?: SessionKeyParts
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
  /**
   * unavailable 的来源，决定 Router 怎么回复用户。
   *
   * - `engine`：模型调用本身失败（没额度 / 限流 / 超时 / 鉴权失败……），要把原因告诉用户。
   * - `model`：模型成功返回了 `unavailable` 决定（判断不了就不猜），按礼貌追问处理。
   *
   * 缺省按 `engine` 处理：模型层报出来的失败绝大多数是调用失败。
   */
  unavailableSource?: 'engine' | 'model'
  /**
   * 研判过程中直接面向用户的一句话。
   * 查询/清理类工具执行完后，Pi 的最终 assistant 文本放在这里，AgentLoop 原样发出去，
   * 不再额外消耗一次回复模型调用。
   */
  reply?: string
  audit: DecisionAudit
}

export interface DecisionEngine {
  /** 对一个 Trigger 做研判。 */
  assess(req: DecisionRequest): Promise<DecisionEngineResult>
  /** 生成一句礼貌回复（普通消息）。失败抛错，由调用方按真实原因回话。 */
  reply(req: ReplyRequest): Promise<string>
  /** /new：只重置这个会话；旧 session 文件交给清理任务。 */
  resetSession?(session: SessionKeyParts, by: string): Promise<void>
  /** 确定性回复写进会话（不调用模型），供下一轮模型看到。 */
  recordTranscript?(session: SessionKeyParts, text: string, systemPrompt: string): Promise<void>
  /** 空闲 session 回收（只释放内存，文件保留）。 */
  evictIdleSessions?(now?: number): Promise<number>
  /** 服务停止时释放所有内存 session。 */
  disposeAllSessions?(): Promise<void>
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
      // JSON 兜底路径也要认 clarify：模型没走工具时同样能表达「先讨论再开单」。
      ...(json.clarify === true ? { clarify: true } : {}),
    },
  }
}
