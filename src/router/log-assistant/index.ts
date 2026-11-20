/**
 * 排查助手的组装入口。
 *
 * Web 面板的智能问题排查助手。
 *
 * 排障的第一入口是日志，但日志本身只说「发生了什么」，不说「这意味着什么」。
 * 这里做两件事：
 *
 * 1. **挑证据**：从最近的服务日志里按用户问题挑出相关条目（错误 / 警告优先）；
 * 2. **给结论**：优先让配置的模型总结；模型没配或调用失败时，退回内置的
 *    「事件名 → 症状」知识库做规则式判断，保证助手永远有话说。
 *
 * 规则式降级不是摆设：现场机器经常还没配好模型，但日志事件名是固定的，
 * 靠知识库照样能指出「消息被 allowed 规则丢掉了」这类结论。
 *
 * 结论面向普通用户，所以输出是**结构化**的（结论 / 引导动作 / 补充细节），
 * 由前端渲染：原始日志与专业术语都放进折叠的补充信息里，
 * 主交互语句只留「发生了什么」与「现在该做什么」。
 */
import { preview } from '#core/events.js'
import { noopLogger, errorMessage } from '#infra/logger.js'
import { createChatClient, type ChatClient } from '#infra/chat.js'
import { readLogTail, type LogEntry } from '../log-tail.js'
import { filterByWindow, logWindow, type LogWindow } from '../log-window.js'
import {
  MAX_QUESTION_CHARS,
  READ_LIMIT,
} from './types.js'
import type {
  LogAssistant,
  LogAssistantOptions,
  LogAssistantOverview,
  LogAssistantQuestion,
  LogDiagnosis,
} from './types.js'
import { filterEntries, selectEvidence } from './evidence.js'
import { ensureEvidence, matchSymptoms, ruleDiagnosis } from './symptoms.js'
import { askModel } from './model.js'
import { distinctIssues } from './overview.js'

export function createLogAssistant(opts: LogAssistantOptions): LogAssistant {
  const logger = opts.logger ?? noopLogger
  const model = opts.model ?? null
  const llmReady = Boolean(model && model.baseUrl && model.apiKey && model.model)

  let client: ChatClient | null = null
  if (llmReady && model) {
    client = createChatClient(model, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    })
  }

  // 串行化：面板并发点「分析」时排队，避免一次风暴把模型打爆。
  let queue: Promise<unknown> = Promise.resolve()

  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    // 队列本身吞掉异常，避免一次失败卡住后面的请求。
    queue = next.catch(() => undefined)
    return next
  }

  const now = opts.now ?? (() => new Date().toISOString())
  // 没传版本号时不按版本过滤：拿一个猜不到的版本去比，只会把日志全滤光。
  const version = opts.version ?? ''

  /** 当前排查窗口：最近 3 小时 + 当前版本。 */
  const currentWindow = (): LogWindow => logWindow({ version, now: now() })

  /** 读日志并按窗口收敛：窗口外与旧版本的日志一律不纳入排查。 */
  const scopedEntries = (): LogEntry[] => {
    const entries = readLogTail(opts.logPath, { lines: READ_LIMIT })
    return filterByWindow(entries, currentWindow())
  }

  /** 上一次的概览计数：只在变化时记日志，避免面板每次打开都刷一条。 */
  let lastOverview = ''

  return {
    llmConfigured(): boolean {
      return llmReady
    },

    overview(): LogAssistantOverview {
      const window = currentWindow()
      const entries = scopedEntries()
      const errors = entries.filter(entry => entry.level === 'error')
      const warns = entries.filter(entry => entry.level === 'warn')
      // 同一个问题重复报了很多次时只列一条：用户要的是「有哪几类问题」，不是日志条数。
      const issues = distinctIssues(errors)
      const configIssues = (opts.configChecks?.() ?? [])
        .filter(check => check.status !== 'ok')
        .map(check => ({
          name: check.name,
          detail: check.detail,
          ...(check.hint ? { hint: check.hint } : {}),
          ...(check.section ? { section: check.section } : {}),
          ...(check.items ? { items: check.items } : {}),
        }))
      // 高频路径降噪：同一组计数只记一次，变化时才再记一条。
      const fingerprint = `${errors.length}/${warns.length}/${configIssues.length}/${window.version}`
      if (fingerprint !== lastOverview) {
        lastOverview = fingerprint
        logger.info('logs:assistant-overview', {
          errors: errors.length,
          warns: warns.length,
          configIssues: configIssues.length,
          since: window.since,
          version: window.version,
        })
      }
      return {
        errorCount: errors.length,
        warnCount: warns.length,
        issues,
        configIssues,
        window: { since: window.since, version: window.version },
      }
    },

    diagnose(question: LogAssistantQuestion): Promise<LogDiagnosis> {
      return run(async () => {
        const text = question.question.trim().slice(0, MAX_QUESTION_CHARS)
        // 只看窗口内的日志：3 小时前或旧版本报的错不算「现在的问题」。
        const entries = scopedEntries()
        // 助手与日志页共用同一套过滤：用户看到的范围就是排查范围。
        const scoped = filterEntries(entries, {
          ...(question.level ? { level: question.level } : {}),
          ...(question.keyword ? { keyword: question.keyword } : {}),
        })
        const hits = matchSymptoms(scoped)
        const evidence = selectEvidence(scoped, { question: text })
        // 结论里提到的事件必须在证据里看得见，否则用户无法自行核对。
        const withEvidence = ensureEvidence(evidence, scoped, hits.flatMap(hit => hit.events))

        if (client) {
          try {
            const answer = await askModel(client, text, withEvidence, opts.tools ?? [])
            logger.info('logs:assistant-answered', {
              question: preview(text, 120),
              evidence: withEvidence.length,
              source: 'llm',
              errors: withEvidence.filter(item => item.level === 'error').length,
              ...(answer.toolsUsed?.length ? { tools: answer.toolsUsed.join(',') } : {}),
            })
            return answer
          } catch (error) {
            const reason = errorMessage(error)
            logger.warn('logs:assistant-model-failed', {
              question: preview(text, 120),
              detail: preview(reason, 200),
            })
            return {
              ...ruleDiagnosis(text, withEvidence, hits),
              degraded: `模型总结失败，已退回规则排查：${reason}`,
            }
          }
        }

        const diagnosis = ruleDiagnosis(text, withEvidence, hits)
        logger.info('logs:assistant-answered', {
          question: preview(text, 120),
          evidence: withEvidence.length,
          source: 'rules',
          errors: withEvidence.filter(item => item.level === 'error').length,
        })
        return diagnosis
      })
    },
  }
}
