

import { sortEvidence, toEvidence } from './evidence.js'

import type { LogEntry } from '../log-tail.js'
import type { LogCause, LogDiagnosis, LogEvidence, LogNextStep } from './types.js'
import { MAX_ASSISTANT_EVIDENCE } from './types.js'

export const SYMPTOMS: Array<{
  id: string
  title: string
  /**
   * 一句话结论：面向普通用户说明「现在是什么情况」。
   * 不带事件名与字段名——专业术语属于折叠的补充细节。
   */
  conclusion: string
  /**
   * 处置方向：config = 引导去改配置；defect = 缺陷 / 体验问题，适合一键上报 issue。
   */
  kind: 'config' | 'defect'
  /**
   * kind=config 时的引导目标：配置页的分组 id（见 `src/web/client/fields.ts` 的 CONFIG_GROUPS）。
   * 留空表示只跳到配置页。
   */
  section?: string
  /** kind=config 时给用户的按钮文案。 */
  fixLabel?: string
  events: string[]
  keywords: string[]
  /**
   * 用户该做的事：说清「改哪一项、去哪改」。
   * 是主界面上的行动指引，不是技术细节。
   */
  steps: string[]
  /**
   * 技术细节：事件名、字段名、排查手法。
   * 只作为折叠的补充信息出现，不当主交互语句。
   */
  advice: string[]
}> = [
  {
    id: 'message-ignored',
    title: '消息进来了但被过滤 / 机器人没反应',
    conclusion: '消息收到了，但没通过「谁可以让机器人干活」这一关，所以机器人一直没回你。',
    kind: 'config',
    section: 'channels',
    fixLabel: '去改「允许名单」',
    events: [
      'trigger:dropped', 'trigger:duplicate', 'feishu:bot-identity-failed',
      'feishu:allowlist-empty', 'feishu:chat-allowlist-empty', 'identity:resolve-failed',
      'identity:refresh-failed', 'identity:retry-exhausted', 'identity:retry-deferred',
      'config:identity-invalid', 'feishu:consumer-start-failed', 'feishu:reconnecting',
    ],
    keywords: ['没反应', '不理我', '不回', '没收到', '消息丢了', '不响应'],
    steps: [
      '打开面板「配置 → 渠道配置 → 飞书 → 接收范围」，确认你的账号在「允许名单」里。',
      '名单里填邮箱最省事：填上邮箱保存后，系统会自动认出这是谁。',
      '群聊里需要 @ 机器人：如果连群里的消息也收不到，检查机器人是否在这个群里。',
    ],
    advice: [
      '看 trigger:dropped 的 reason 字段：allowed 规则挡掉、身份没识别、还是消息类型不支持。',
      '确认允许名单里的邮箱 / open_id 都能解析成 open_id（identity:resolve-failed / identity:retry-exhausted 表示有人没解析出来）。',
      '群聊需要 @ 机器人时，检查 feishu:bot-identity-failed：机器人身份没识别出来会丢掉整群消息。',
      'trigger:duplicate 是去重命中，不是消息丢失。',
    ],
  },
  {
    id: 'config-not-effective',
    title: '配置改了不生效',
    conclusion: '你改的配置没有真正生效：要么没写进配置文件，要么这类改动要重启服务后才生效。',
    kind: 'config',
    fixLabel: '去「配置」页逐项核对',
    events: [
      'config:parse-failed', 'config:patch-rejected', 'config:write-failed',
      'config:legacy-backend', 'config:invalid-security-override',
      'identity:refresh-failed', 'config:identity-invalid',
    ],
    keywords: ['不生效', '没生效', '配置', '保存', '重启'],
    steps: [
      '在「配置」页改完后点「保存并重启服务」，大多数设置要重启才生效。',
      '只有「接单方式」「允许名单」这类是保存即生效，不用重启。',
      '如果保存时报错，按面板上给出的原因改掉再保存——保存失败等于没改。',
    ],
    advice: [
      '看 api:config 的 restartRequired：策略类配置立即生效，其余要重启服务（daemon 热重启）后才生效。',
      'config:parse-failed 说明 config.yaml 解析失败，服务已降级用默认配置启动，配置等于没加载。',
      'config:patch-rejected / config:write-failed 是保存被拒或落盘失败，面板上的「保存成功」不代表写进去了。',
      '允许名单类改动看 identity:refresh-failed：保存成功但重新解析失败，新名单暂未生效。',
    ],
  },
  {
    id: 'ticket-not-created',
    title: '消息没有变成工单 / 没派工',
    conclusion: '消息收到了，但没有开工单——多半是「接单方式」设成了只观察，或者这条消息还被当成闲聊。',
    kind: 'config',
    section: 'admission',
    fixLabel: '去改「接单方式」',
    events: [
      'decision:engine-failed', 'chat:reply-failed',
    ],
    keywords: ['工单', '派工', '没开始', '没建', '没派'],
    steps: [
      '打开面板「配置 → 消息准入 → 接单方式」，确认不是「只记录」或「只研判」。',
      '要让它自动开工单，把接单方式改成「直接接单」。',
      '如果只是想看看它怎么判断，先保持「只研判」，在「工单」页确认判断是否合理。',
    ],
    advice: [
      '先确认 trigger:ingested 出现过：没有这条说明消息根本没进系统，问题在接入层不在研判层。',
      'router:decision 的 decision 字段说明研判结论；ask 之外的决定都要在工单页复核。',
      'decision:engine-failed 表示研判模型调用失败，这一轮按不可用处理。',
      'chat:reply-failed 只是回复生成失败退回固定话术，不影响已经建好的工单。',
    ],
  },
  {
    id: 'worker-stuck',
    title: 'Worker 卡住 / 执行失败',
    conclusion: '正在干活的那个执行进程出问题了，这一轮没做完——这是系统侧的问题，需要我们修。',
    kind: 'defect',
    events: [
      'worker:status-failed', 'codex:turn-failed', 'codex:process-exit', 'codex:resume-failed',
      'codex:launch-failed', 'effect:failed', 'worker:event-log-failed',
      'idle:stale', 'codex:error',
    ],
    keywords: ['卡住', '不动', 'worker', '超时', '没进展', '执行失败'],
    steps: [
      '点下面的「上报 GitHub issue」，把这次的日志和结论一起发给我们。',
      '同时可以在「工单」页停止这张工单，重新发一次同样的话让它重来。',
    ],
    advice: [
      'worker:status-failed 是活性查询失败，先按「状态未知」处理，别当成 worker 死了。',
      'codex:turn-failed 表示这一轮执行失败，会转人工；detail 里有失败原因。',
      'codex:process-exit 是 app-server 子进程退出，通常伴随 codex:turn-failed 一起出现。',
      'effect:failed 说明派工 / 停止 / 清理这类内部动作没执行成功，error 字段是原因。',
    ],
  },
  {
    id: 'service-error',
    title: '服务自身报错 / 面板打不开',
    conclusion: '服务自己报错了，不是你的配置问题——需要我们修。',
    kind: 'defect',
    events: [
      'api:request-failed', 'config:parse-failed', 'session:migration-required',
      'session:migration-incomplete', 'feishu:consumer-start-failed', 'update:upgrade-failed',
      'update:service-stop-failed', 'config:invalid-security-override',
      'loop:trigger-failed', 'loop:error',
    ],
    keywords: ['服务', '启动不了', '报错', '500', '打不开', '崩溃'],
    steps: [
      '点下面的「上报 GitHub issue」，把这次的日志和结论一起发给我们。',
      '如果连面板都打不开，在终端运行 ra logs 看最后几行，把输出一起贴给我们。',
    ],
    advice: [
      'api:request-failed 带 method / path / detail，先定位是哪个接口挂的。',
      'session:migration-required 表示还有没迁移的历史 sessionKey，服务会拒绝启动，按提示执行迁移。',
      'config:parse-failed 会让服务带着默认配置启动，先修 config.yaml 的 YAML 语法。',
      'feishu:consumer-start-failed 是飞书事件消费者没起来，机器人会完全收不到消息。',
      'loop:trigger-failed 是单条消息处理时抛了未预期异常，detail 里有真实原因。',
    ],
  },
  {
    id: 'reply-not-sent',
    title: '回复 / 通知没发出去',
    conclusion: '活已经干完了，但结果没发回飞书——投递这一步出了问题，需要我们修。',
    kind: 'defect',
    events: [
      'outbox:failed', 'channel:not-registered', 'feishu:card-fallback',
      'chat:reply-failed', 'channel:ack-failed',
    ],
    keywords: ['没发出去', '没回复', '发送失败', '通知'],
    steps: [
      '点下面的「上报 GitHub issue」，把这次的日志和结论一起发给我们。',
      '临时想看结果，可以直接看「工单」页里的进展记录。',
    ],
    advice: [
      'outbox:failed 带 error 字段，是对外投递失败的最终结果。',
      'channel:not-registered 表示 Outbox 里的通道没注册（历史脏数据），不会卡住队列。',
      'feishu:card-fallback 是互动卡片发不出去降级成富文本，消息仍然送达。',
      'progress:dedup 只是进展内容重复被跳过，不是丢消息。',
    ],
  },
  {
    id: 'pr-tracking',
    title: 'PR / MR 状态查不到',
    conclusion: '关联的代码改动查不到状态——多半是没关联上仓库或凭据失效了。',
    kind: 'defect',
    events: [
      'pr:track-failed', 'pr:inspect-failed', 'pr:repo-slug-failed',
      'report:evidence-missing', 'report:evidence-unverified', 'report:ingest-failed',
    ],
    keywords: ['pr', 'mr', '合并', '状态', '证据'],
    steps: [
      '先确认工单关联的仓库地址写对了：面板「配置 → 项目清单」里的仓库路径。',
      '然后点下面的「上报 GitHub issue」，把这次的日志和结论一起发给我们。',
    ],
    advice: [
      'pr:inspect-failed / pr:repo-slug-failed 是取 PR 线索失败，服务会等 gh 兜底。',
      'report:evidence-missing 说明 UI 改动没交 Before / After 证据，enforce 档会被打回。',
      'report:ingest-failed 表示上报没被兜底通道正常吞下，看 message 字段。',
    ],
  },
]

/**
 * 不依赖模型的结论：靠事件名命中已知问题模式。
 *
 * 排序兼顾「与问题的相关度」与「命中的事件数量」：用户问的是哪一类，
 * 就先把那一类放前面；日志里同时存在的其它已知模式只作为补充。
 */
export function ruleDiagnosis(question: string, evidence: LogEvidence[], hits: SymptomHit[]): LogDiagnosis {
  const ranked = [...hits].sort((a, b) => hitScore(question, b) - hitScore(question, a))
  const primary = ranked[0]
  const shown = ranked.slice(0, 3)

  const causes: LogCause[] = shown.map(item => ({
    title: item.symptom.title,
    detail: `日志里出现了 ${item.events.join('、')}。`,
    events: item.events,
  }))

  // 行动指引只取「用户该做的事」：技术细节（advice）另作折叠的补充信息。
  // 最可能那类的问题给完整步骤，其余每类只给一条——主区不是清单仓库。
  const actions: string[] = []
  for (const [index, item] of shown.entries()) {
    const steps = index === 0 ? item.symptom.steps : item.symptom.steps.slice(0, 1)
    for (const step of steps) {
      if (!actions.includes(step)) actions.push(step)
    }
  }

  // 问题描述命中的模式即使日志里没有对应事件，也给一条「该往哪看」的方向。
  for (const symptom of SYMPTOMS) {
    if (hits.some(item => item.symptom.id === symptom.id)) continue
    if (!symptom.keywords.some(keyword => question.includes(keyword))) continue
    const step = `你描述的现象属于「${symptom.title}」，但当前日志里没有对应记录；先按下面这条排查：${symptom.steps[0] ?? ''}`
    if (!actions.includes(step)) actions.push(step)
  }

  const others = ranked.length > 1 ? `另外还有 ${ranked.length - 1} 个问题，展开下面的补充细节能看到。` : ''
  const summary = !primary
    ? evidence.length > 0
      ? `最近 ${evidence.length} 条日志里没有找到已知的问题模式，暂时看不出明显故障。`
      : '最近这段时间的日志里没有可用记录，暂时看不出明显故障。'
    : primary.symptom.conclusion + others

  return {
    summary,
    causes,
    // 行动指引最多 5 条：最可能那类的问题的步骤排在前面。
    actions: actions.slice(0, 5),
    evidence,
    source: 'rules',
    next: nextStepsFor(ranked, question),
  }
}

/**
 * 由命中的问题模式推导处置建议。
 *
 * 动作按**最可能的那一类**排在前面：用户要的是一个判断——配置类去改配置，
 * 缺陷 / 体验类去上报 issue。
 *
 * 但两类都命中时**两个入口都给**：日志里同时出现「配置没生效」和「Worker 卡住」，
 * 只给配置按钮的话，缺陷就永远报不上去——上报 issue 的入口必须是可达的。
 */
export function nextStepsFor(hits: SymptomHit[], question: string): LogNextStep[] {
  const primary = hits[0]
  if (primary) {
    if (primary.symptom.kind === 'config') {
      const steps: LogNextStep[] = [{
        kind: 'config',
        label: primary.symptom.fixLabel ?? `去「配置」页检查与「${primary.symptom.title}」相关的设置`,
        ...(primary.symptom.section ? { section: primary.symptom.section } : {}),
      }]
      const defect = hits.find(item => item.symptom.kind === 'defect')
      if (defect) steps.push(issueStepOf(defect))
      return steps
    }
    return [issueStepOf(primary)]
  }
  // 日志里没有命中事件，但问题描述点名了配置类现象：给一条配置引导。
  for (const symptom of SYMPTOMS) {
    if (symptom.kind !== 'config') continue
    if (!symptom.keywords.some(keyword => question.includes(keyword))) continue
    return [{
      kind: 'config',
      label: symptom.fixLabel ?? `去「配置」页检查与「${symptom.title}」相关的设置`,
      ...(symptom.section ? { section: symptom.section } : {}),
    }]
  }
  return []
}

/** 缺陷类症状对应的「上报 issue」入口。 */
function issueStepOf(hit: SymptomHit): LogNextStep {
  return {
    kind: 'issue',
    label: '上报 GitHub issue',
    issueTitle: `[排查助手] ${hit.symptom.title}`,
  }
}

/**
 * 命中的排序分：问题点名的关键词越多越靠前，其次看命中的事件数量。
 *
 * 按命中的关键词个数而不是「有没有命中」计分：用户问「工单里的 worker 卡住了」
 * 同时点了两类症状，worker 类命中「worker」「卡住」两个词才不会被工单类抢走。
 */
function hitScore(question: string, hit: SymptomHit): number {
  const keywords = hit.symptom.keywords.filter(keyword => question.includes(keyword)).length
  return keywords * 10 + hit.events.length
}

/** 命中的问题模式。 */
export interface SymptomHit {
  symptom: (typeof SYMPTOMS)[number]
  /** 命中的日志事件名。 */
  events: string[]
}

/** 按事件名匹配已知问题模式；命中的事件越多越可能是根因。 */
export function matchSymptoms(entries: LogEntry[]): SymptomHit[] {
  const seen = new Set<string>()
  for (const entry of entries) seen.add(entry.message)
  return SYMPTOMS
    .map(symptom => ({ symptom, events: symptom.events.filter(event => seen.has(event)) }))
    .filter(item => item.events.length > 0)
    .sort((a, b) => b.events.length - a.events.length)
}

/**
 * 把命中事件的原始条目补进证据。
 *
 * 结论里引用的事件名如果不在证据列表里，用户就没法自己核对，
 * 这里保证「结论提到的 = 证据里看得见的」。
 */
export function ensureEvidence(evidence: LogEvidence[], entries: LogEntry[], events: string[]): LogEvidence[] {
  const missing = new Set(events)
  for (const item of evidence) missing.delete(item.message)
  if (missing.size === 0) return evidence

  const merged = [...evidence]
  for (const entry of entries) {
    if (!missing.has(entry.message)) continue
    missing.delete(entry.message)
    merged.push(toEvidence(entry))
    if (merged.length >= MAX_ASSISTANT_EVIDENCE) break
  }
  return sortEvidence(merged)
}
