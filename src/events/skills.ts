/**
 * 候选 skill（处理方式）清单。
 *
 * 这一层是**闭集**：决策模型只能从清单里点名字，不能凭空造一个 skill。
 * skill 本身不在面板上配置 —— 执行环境默认在 worker 里，
 * 这里只声明「有哪些处理方式、各自是干什么的」，供决策规则与判定提示词引用。
 */

export interface EventSkill {
  id: string
  name: string
  /** 一句话说明这个处理方式怎么做事。 */
  hint: string
}

/** 内置 skill 清单。 */
export const EVENT_SKILLS: readonly EventSkill[] = [
  { id: 'bug-triage', name: '缺陷排查', hint: '先复现再出根因，不直接改代码' },
  { id: 'clarify-intake', name: '需求澄清', hint: '信息不足先补齐，补齐后再出方案' },
  { id: 'ci-fix', name: 'CI 修复', hint: '定位失败步骤并给出修复方案' },
  { id: 'daily-digest', name: '汇总播报', hint: '只汇总记录，不执行改动' },
  { id: 'question-answer', name: '咨询答复', hint: '给出结论与依据，不改代码' },
]

/** 没命中任何 skill 时用的兜底处理方式。 */
export const DEFAULT_EVENT_SKILL = 'clarify-intake'

/** 按 id 找 skill；找不到返回 undefined。 */
export function findEventSkill(id: string): EventSkill | undefined {
  const want = id.trim()
  return EVENT_SKILLS.find(skill => skill.id === want)
}

/** skill 清单的中文说明文本，供判定提示词使用。 */
export function skillCatalogText(skills: readonly EventSkill[] = EVENT_SKILLS): string {
  return skills.map(skill => `- ${skill.id}（${skill.name}）：${skill.hint}`).join('\n')
}
