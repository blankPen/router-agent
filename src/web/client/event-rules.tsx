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

  const openAdd = () => {
    const id = nextRuleId(firstType)
    const rule = blankRule(id, firstType)
    setEditing(rule)
    setIsNew(true)
  }

  const openEdit = (rule: EventRule) => {
    setEditing(structuredClone(rule))
    setIsNew(false)
  }

  const save = () => {
    if (!editing) return
    const checked = saveRuleDraft({
      ...editing,
      version: isNew ? 1 : editing.version + 1,
      workflowPrompt: editing.workflowPrompt.trim() || editing.intent.trim(),
    })
    if (checked.error) {
      onNotice?.({ kind: 'error', text: checked.error })
      return
    }
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
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSave={save}
          onNotice={onNotice}
        />
      )}
    </>
  )
}

function RuleEditor({ rule, groups, onChange, onClose, onSave, onNotice }: {
  rule: EventRule
  groups: ReturnType<typeof eventTypeOptions>
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
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="决策规则">
        <header className="modal-head">
          <div>
            <h2>决策规则</h2>
            <p>{rule.eventType} · v{rule.version}</p>
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="modal-body">
          <label className="modal-field">
            <span>事件类型</span>
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
          </label>

          <label className="modal-field">
            <span>你的意图</span>
            <textarea
              rows={4}
              value={rule.intent}
              placeholder="例如：所有 GitHub Action 失败都处理并自动执行；先分析报错原因，再修复并提交 PR"
              onChange={event => onChange({ ...rule, intent: event.target.value })}
            />
            <p className="modal-hint">规则保存的是判定方法；这段原文只用于生成草稿和回看。</p>
          </label>
          <div className="source-card-actions">
            <button className="btn tiny" onClick={() => void compile()} disabled={compiling}>
              <Icon name="zap" size={12} />{compiling ? '解析中…' : '解析成判定规则'}
            </button>
          </div>

          <label className="modal-field">
            <span>有效性判定（is_valid / noul）</span>
            <textarea
              rows={3}
              value={rule.questions.is_valid.instructions}
              onChange={event => setQuestion('is_valid', { instructions: event.target.value })}
            />
          </label>
          <label className="modal-field">
            <span>自动执行判定（autorun / choice）</span>
            <textarea
              rows={2}
              value={rule.questions.autorun.instructions}
              onChange={event => setQuestion('autorun', { instructions: event.target.value })}
            />
          </label>
          <div className="settings-rows">
            <label className="modal-field">
              <span>auto 选项说明</span>
              <textarea
                rows={2}
                value={String(autoCriteria.auto ?? '')}
                onChange={event => setQuestion('autorun', {
                  criteria: { ...autoCriteria, auto: event.target.value, review: String(autoCriteria.review ?? '') },
                })}
              />
            </label>
            <label className="modal-field">
              <span>review 选项说明</span>
              <textarea
                rows={2}
                value={String(autoCriteria.review ?? '')}
                onChange={event => setQuestion('autorun', {
                  criteria: { auto: String(autoCriteria.auto ?? ''), review: event.target.value },
                })}
              />
            </label>
          </div>
          <label className="modal-field">
            <span>优先级判定（priority / score）</span>
            <textarea
              rows={2}
              value={rule.questions.priority.instructions}
              onChange={event => setQuestion('priority', { instructions: event.target.value })}
            />
            <textarea
              rows={4}
              value={priorityCriteria}
              onChange={event => setQuestion('priority', {
                criteria: event.target.value.split('\n').map(item => item.trim()).filter(Boolean),
              })}
            />
            <p className="modal-hint">一行一个档位，从低到高。</p>
          </label>
          <label className="modal-field">
            <span>项目归属判定（project / choice）</span>
            <textarea
              rows={2}
              value={rule.questions.project.instructions}
              onChange={event => setQuestion('project', { instructions: event.target.value })}
            />
            <p className="modal-hint">候选项目在判定时按当前项目清单注入，规则里不固化仓库。</p>
          </label>

          <label className="modal-field">
            <span>执行流程（拼给 Worker）</span>
            <textarea
              rows={4}
              value={rule.workflowPrompt}
              placeholder="根据事件上下文分析原因、执行修复并提交 PR"
              onChange={event => onChange({ ...rule, workflowPrompt: event.target.value })}
            />
            <p className="modal-hint">这里只能描述做事流程；宿主的安全护栏始终保留，不能被覆盖。</p>
          </label>

          <div className="settings-rows">
            <label className="modal-field">
              <span>is_valid 阈值</span>
              <input
                type="number" min={0} max={1} step={0.05}
                value={rule.thresholds.isValid}
                onChange={event => onChange({ ...rule, thresholds: { ...rule.thresholds, isValid: Number(event.target.value) } })}
              />
            </label>
            <label className="modal-field">
              <span>autoRun 阈值</span>
              <input
                type="number" min={0} max={1} step={0.05}
                value={rule.thresholds.autoRun}
                onChange={event => onChange({ ...rule, thresholds: { ...rule.thresholds, autoRun: Number(event.target.value) } })}
              />
            </label>
            <label className="modal-field">
              <span>projectPick 阈值</span>
              <input
                type="number" min={0} max={1} step={0.05}
                value={rule.thresholds.projectPick}
                onChange={event => onChange({ ...rule, thresholds: { ...rule.thresholds, projectPick: Number(event.target.value) } })}
              />
            </label>
          </div>
          <label className="modal-field">
            <span>强制人审的风险标签</span>
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
          </label>
        </div>
        <footer className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={onSave}>保存规则</button>
        </footer>
      </div>
    </div>
  )
}
