/**
 * 配置页的决策规则编辑区。
 *
 * 规则列表是主入口；自然语言只用于生成可编辑草稿，保存的是结构化问题与阈值。
 */
import { useMemo, useState } from 'react'
import type { ConfigDoc } from './api.js'
import { sendJson } from './api.js'
import { Icon } from './icons.js'
import {
  blankRule,
  eventTypeOptions,
  nextRuleId,
  removeRule,
  ruleSummary,
  saveRuleDraft,
  upsertRule,
} from './event-rules-model.js'
import type { EventRule } from '../../events/rules.js'
import { getByPath } from './fields.js'

interface Notice {
  kind: 'ok' | 'warn' | 'error'
  text: string
}

/** 决策规则列表与编辑弹窗。 */
export function EventRulesConfig({ draft, setField, onNotice }: {
  draft: ConfigDoc | null
  setField: (path: string, value: unknown) => void
  onNotice?: (notice: Notice) => void
}): JSX.Element {
  const rules = useMemo(() => {
    const value = getByPath(draft, 'events.rules')
    return Array.isArray(value) ? value as EventRule[] : []
  }, [draft])
  const eventTypes = useMemo(() => eventTypeOptions(draft), [draft])
  const firstType = eventTypes[0]?.options[0]?.value ?? 'github.issues.opened'
  const [editing, setEditing] = useState<EventRule | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const openAdd = () => {
    const id = nextRuleId(firstType)
    const rule = blankRule(id, firstType)
    setEditing(rule)
    setIsNew(true)
    setSaveError(null)
  }

  const openEdit = (rule: EventRule) => {
    setEditing(structuredClone(rule))
    setIsNew(false)
    setSaveError(null)
  }

  const save = () => {
    if (!editing) return
    const checked = saveRuleDraft({
      ...editing,
      version: isNew ? 1 : editing.version + 1,
      workflowPrompt: editing.workflowPrompt.trim() || editing.intent.trim(),
    })
    if (checked.error) {
      setSaveError(checked.error)
      onNotice?.({ kind: 'error', text: checked.error })
      return
    }
    setSaveError(null)
    setField('events.rules', upsertRule(rules, checked.value))
    onNotice?.({ kind: 'ok', text: `规则「${checked.value.id}」已写入草稿，点保存配置后生效。` })
    setEditing(null)
  }

  return (
    <>
      <div className="source-cards-head">
        <p className="editor-hint">
          事件按 <strong>eventType</strong> 精确匹配；没有匹配规则的事件只收集，不判定、不调用模型。
        </p>
        <button className="btn tiny" onClick={openAdd}>
          <Icon name="plus" size={12} />添加规则
        </button>
      </div>

      {rules.length === 0 ? (
        <div className="empty-state">
          <p>还没有决策规则。</p>
          <p className="muted">新装默认不判定；添加规则后，同类事件才会进入决策链。</p>
        </div>
      ) : (
        <div className="source-cards">
          {rules.map(rule => (
            <article key={rule.id} className="source-card on">
              <div className="source-card-top">
                <span className="source-logo"><Icon name="zap" size={16} /></span>
                <div className="source-card-title">
                  <strong>{rule.eventType}</strong>
                  <span>{rule.id} · v{rule.version}</span>
                </div>
              </div>
              <p className="source-card-status">{ruleSummary(rule)}</p>
              <p className="source-card-package" title={rule.intent}>{rule.intent || '未填写自然语言意图'}</p>
              <div className="source-card-actions">
                <button className="btn tiny" onClick={() => openEdit(rule)}>编辑</button>
                <button
                  className="btn tiny ghost"
                  onClick={() => {
                    setField('events.rules', removeRule(rules, rule.id))
                    onNotice?.({ kind: 'warn', text: `已从草稿删除规则「${rule.id}」；已开工单不受影响。` })
                  }}
                >
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {editing && (
        <RuleEditor
          rule={editing}
          groups={eventTypes}
          title={isNew ? '添加决策规则' : '编辑决策规则'}
          error={saveError}
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSave={save}
          onNotice={onNotice}
        />
      )}
    </>
  )
}

/** 规则编辑弹窗；导出以便测试断言「保存失败时错误就在弹窗里」。 */
export function RuleEditor({ rule, groups, title, error, onChange, onClose, onSave, onNotice }: {
  rule: EventRule
  groups: ReturnType<typeof eventTypeOptions>
  title: string
  error: string | null
  onChange: (rule: EventRule) => void
  onClose: () => void
  onSave: () => void
  onNotice?: (notice: Notice) => void
}): JSX.Element {
  const [compiling, setCompiling] = useState(false)
  const autopilot = rule.questions.autorun.criteria
  const autoCriteria = autopilot && !Array.isArray(autopilot) ? autopilot : {}
  const priorityCriteria = Array.isArray(rule.questions.priority.criteria)
    ? rule.questions.priority.criteria.join('\n')
    : ''

  const compile = async () => {
    if (!rule.intent.trim()) {
      onNotice?.({ kind: 'warn', text: '先写一段自然语言意图，再点解析。' })
      return
    }
    setCompiling(true)
    try {
      const data = await sendJson<{ rule: EventRule }>('/api/events/rules/compile', 'POST', {
        id: rule.id,
        eventType: rule.eventType,
        intent: rule.intent,
        workflowPrompt: rule.workflowPrompt,
      })
      onChange(data.rule)
      onNotice?.({ kind: 'ok', text: '已生成可编辑草稿；确认无误后再保存规则。' })
    } catch (error) {
      onNotice?.({ kind: 'warn', text: `解析失败，保留原文和内置模板：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setCompiling(false)
    }
  }

  const setQuestion = (id: 'is_valid' | 'autorun' | 'priority' | 'project' | 'skill', patch: Record<string, unknown>) => {
    onChange({
      ...rule,
      questions: {
        ...rule.questions,
        [id]: { ...rule.questions[id], ...patch } as EventRule['questions']['is_valid'],
      },
    })
  }

  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="modal modal-wide rule-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head rule-modal-head">
          <div>
            <h2>{title}</h2>
            <p className="rule-modal-sub">
              <span className="mono">{rule.eventType}</span>
              <span className="rule-modal-dot">·</span>
              <span>v{rule.version}</span>
            </p>
          </div>
          <button className="icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="modal-body rule-modal-body">
          <section className="rule-section">
            <header className="rule-section-head">
              <h3><span className="rule-step">1</span>规则范围</h3>
              <p>这条规则只对选中的事件类型生效；同一个事件类型只允许一条规则。</p>
            </header>
            <label className="modal-field">
              <span>事件类型</span>
              <span className="select-wrap">
                <select
                  value={rule.eventType}
                  onChange={event => onChange({ ...rule, eventType: event.target.value })}
                >
                  {groups.map(group => (
                    <optgroup key={group.group} label={group.group}>
                      {group.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </optgroup>
                  ))}
                </select>
                <Icon name="chevron" size={12} className="select-chevron" />
              </span>
            </label>
          </section>

          <section className="rule-section">
            <header className="rule-section-head">
              <h3><span className="rule-step">2</span>你的意图</h3>
              <p>规则保存的是判定方法；这段原文只用来生成草稿和回看。</p>
            </header>
            <label className="modal-field">
              <span className="rule-field-label">用一句话说清这类事件要怎么处理</span>
              <textarea
                className="rule-textarea"
                rows={3}
                value={rule.intent}
                placeholder="例如：所有 GitHub Action 失败都处理并自动执行；先分析报错原因，再修复并提交 PR"
                onChange={event => onChange({ ...rule, intent: event.target.value })}
              />
            </label>
            <div className="rule-section-actions">
              <button className="btn" onClick={() => void compile()} disabled={compiling}>
                <Icon name="zap" size={13} />{compiling ? '解析中…' : '解析成判定规则'}
              </button>
              <span className="rule-hint">解析会按上面的原文补全下面的四问与执行流程，结果仍可手改。</span>
            </div>
          </section>

          <section className="rule-section">
            <header className="rule-section-head">
              <h3><span className="rule-step">3</span>四个判定问题</h3>
              <p>问题本身固定，写的是判定标准。回答越具体，判定越准。</p>
            </header>
            <label className="modal-field">
              <span className="rule-field-label">有效性判定<span className="rule-field-key">is_valid / noul</span></span>
              <textarea
                className="rule-textarea"
                rows={3}
                value={rule.questions.is_valid.instructions}
                onChange={event => setQuestion('is_valid', { instructions: event.target.value })}
              />
              <p className="modal-hint">低于阈值的判为无效，只留记录，不派工。</p>
            </label>
            <label className="modal-field">
              <span className="rule-field-label">自动执行判定<span className="rule-field-key">autorun / choice</span></span>
              <textarea
                className="rule-textarea"
                rows={2}
                value={rule.questions.autorun.instructions}
                onChange={event => setQuestion('autorun', { instructions: event.target.value })}
              />
            </label>
            <div className="rule-criteria-grid">
              <label className="modal-field">
                <span className="rule-field-label">auto 选项说明<span className="rule-field-key">可自动执行</span></span>
                <textarea
                  className="rule-textarea"
                  rows={2}
                  value={String(autoCriteria.auto ?? '')}
                  onChange={event => setQuestion('autorun', {
                    criteria: { ...autoCriteria, auto: event.target.value, review: String(autoCriteria.review ?? '') },
                  })}
                />
              </label>
              <label className="modal-field">
                <span className="rule-field-label">review 选项说明<span className="rule-field-key">需人工确认</span></span>
                <textarea
                  className="rule-textarea"
                  rows={2}
                  value={String(autoCriteria.review ?? '')}
                  onChange={event => setQuestion('autorun', {
                    criteria: { auto: String(autoCriteria.auto ?? ''), review: event.target.value },
                  })}
                />
              </label>
            </div>
            <label className="modal-field">
              <span className="rule-field-label">优先级判定<span className="rule-field-key">priority / score</span></span>
              <span className="rule-sublabel">判定说明<span className="rule-field-key">这一问怎么打分</span></span>
              <textarea
                className="rule-textarea"
                rows={2}
                value={rule.questions.priority.instructions}
                onChange={event => setQuestion('priority', { instructions: event.target.value })}
              />
              <span className="rule-sublabel">档位<span className="rule-field-key">一行一个，从低到高</span></span>
              <textarea
                className="rule-textarea rule-textarea-criteria"
                rows={4}
                value={priorityCriteria}
                onChange={event => setQuestion('priority', {
                  criteria: event.target.value.split('\n').map(item => item.trim()).filter(Boolean),
                })}
              />
            </label>
            <label className="modal-field">
              <span className="rule-field-label">项目归属判定<span className="rule-field-key">project / choice</span></span>
              <textarea
                className="rule-textarea"
                rows={2}
                value={rule.questions.project.instructions}
                onChange={event => setQuestion('project', { instructions: event.target.value })}
              />
              <p className="modal-hint">候选项目在判定时按当前项目清单注入，规则里不固化仓库。</p>
            </label>
          </section>

          <section className="rule-section">
            <header className="rule-section-head">
              <h3><span className="rule-step">4</span>执行流程</h3>
              <p>这段话会拼给 Worker，作为它动手时的授权范围。</p>
            </header>
            <label className="modal-field">
              <span className="rule-field-label">拼给 Worker 的流程</span>
              <textarea
                className="rule-textarea"
                rows={4}
                value={rule.workflowPrompt}
                placeholder="根据事件上下文分析原因、执行修复并提交 PR"
                onChange={event => onChange({ ...rule, workflowPrompt: event.target.value })}
              />
              <p className="modal-hint">这里只能描述做事流程；宿主的安全护栏始终保留，不能被覆盖。</p>
            </label>
          </section>

          <section className="rule-section">
            <header className="rule-section-head">
              <h3><span className="rule-step">5</span>阈值与护栏</h3>
              <p>阈值决定判定多严；风险标签命中即强制人审并提到 P0。</p>
            </header>
            <div className="rule-threshold-grid">
              <label className="modal-field">
                <span className="rule-field-label">有效性阈值<span className="rule-field-key">isValid</span></span>
                <input
                  type="number" min={0} max={1} step={0.05}
                  value={rule.thresholds.isValid}
                  onChange={event => onChange({ ...rule, thresholds: { ...rule.thresholds, isValid: Number(event.target.value) } })}
                />
                <p className="modal-hint">有效性得分低于它就不派工。</p>
              </label>
              <label className="modal-field">
                <span className="rule-field-label">项目归属阈值<span className="rule-field-key">projectPick</span></span>
                <input
                  type="number" min={0} max={1} step={0.05}
                  value={rule.thresholds.projectPick}
                  onChange={event => onChange({ ...rule, thresholds: { ...rule.thresholds, projectPick: Number(event.target.value) } })}
                />
                <p className="modal-hint">判不出归属项目时的兜底置信度。</p>
              </label>
              <label className="modal-field">
                <span className="rule-field-label">自动执行阈值<span className="rule-field-key">autoRun</span></span>
                <input
                  type="number" min={0} max={1} step={0.05}
                  value={rule.thresholds.autoRun}
                  onChange={event => onChange({ ...rule, thresholds: { ...rule.thresholds, autoRun: Number(event.target.value) } })}
                />
                <p className="modal-hint">自动执行判定的把握下限。</p>
              </label>
            </div>
            <label className="modal-field">
              <span className="rule-field-label">强制人审的风险标签<span className="rule-field-key">逗号分隔</span></span>
              <input
                value={rule.guardrails.riskLabels.join(', ')}
                onChange={event => onChange({
                  ...rule,
                  guardrails: {
                    ...rule.guardrails,
                    riskLabels: event.target.value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean),
                  },
                })}
              />
              <p className="modal-hint">事件带上这些标签时一律转人工，不自动执行。</p>
            </label>
          </section>
        </div>
        <footer className="modal-foot rule-modal-foot">
          {error && (
            <p className="rule-modal-error" role="alert">
              <Icon name="alert" size={13} />
              <span>{error}</span>
            </p>
          )}
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={onSave}>保存规则</button>
        </footer>
      </div>
    </div>
  )
}
