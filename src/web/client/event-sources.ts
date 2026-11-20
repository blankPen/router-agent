/**
 * 事件来源的字段映射：服务端声明的来源字段 → 配置页的字段描述。
 *
 * 单独放在 .ts 里，方便直接测映射规则，不必拉起整棵 React 树。
 */
import type { FieldDef, FieldKind } from './fields.js'

export interface SourceFieldMeta {
  key: string
  label: string
  kind: string
  hint?: string
  options?: string[]
}

export interface SourceMeta {
  id: string
  kind: string
  enabled: boolean
  builtin: boolean
  /** 占位来源：开关能开但还不产出事件。 */
  placeholder?: boolean
  status: string
  message?: string
  lastPolledAt?: string
  /** 自定义来源插件的 npm 包名或本地路径。 */
  package?: string
  fields: SourceFieldMeta[]
}

/** GitHub 来源在配置页收成一张卡片后的摘要。 */
export interface GithubSourceSummary {
  /** 已添加的仓库数；每个仓库对应配置里的一条 GitHub 来源。 */
  repos: number
  /** 至少一个仓库开着时，整张 GitHub 卡片算启用。 */
  enabled: boolean
}

/** 把多条 GitHub 仓库来源聚合为一张卡片的状态。 */
export function githubSourceSummary(sources: Array<{ kind?: string; enabled: boolean }>): GithubSourceSummary {
  const github = sources.filter(source => source.kind === 'github')
  return {
    repos: github.length,
    enabled: github.some(source => source.enabled),
  }
}

/** 来源字段的声明类型 → 配置页字段类型。 */
function fieldKindOf(meta: SourceFieldMeta): FieldKind {
  if (meta.kind === 'number') return 'number'
  if (meta.kind === 'select') return 'select'
  if (meta.kind === 'textarea') return 'textarea'
  if (meta.kind === 'list') return 'list'
  if (meta.kind === 'boolean') return 'switch'
  // 验签密钥不能明文显示在页面上。
  if (meta.key === 'secret') return 'password'
  return 'text'
}

/** 来源字段声明 → 配置页字段描述（路径写回 events.sources.<id>.<key>）。 */
export function sourceFieldDefs(sourceId: string, meta: SourceFieldMeta[]): FieldDef[] {
  return meta.map(field => {
    const kind = fieldKindOf(field)
    const def: FieldDef = {
      path: `events.sources.${sourceId}.${field.key}`,
      label: field.label,
      kind,
      ...(field.hint ? { hint: field.hint } : {}),
    }
    if (kind === 'select') {
      return { ...def, options: (field.options ?? []).map(option => ({ value: option, label: option })) }
    }
    if (kind === 'number') {
      return { ...def, min: 0 }
    }
    return def
  })
}

/** 事件来源涉及的全部配置路径：启用开关 + 各来源声明的字段。 */
export function eventSourcePaths(sources: SourceMeta[]): string[] {
  return sources.flatMap(source => [
    `events.sources.${source.id}.enabled`,
    ...sourceFieldDefs(source.id, source.fields).map(field => field.path),
  ])
}

/** 事件来源的字段描述集合，用于配置页的本地校验。 */
export function eventSourceFields(sources: SourceMeta[]): FieldDef[] {
  return sources.flatMap(source => sourceFieldDefs(source.id, source.fields))
}

/**
 * 配置草稿里涉及的事件来源路径。
 *
 * 除了服务端已登记的来源，还要算上草稿里刚加的（插件来源装完还没保存时，
 * 服务端还不认识它），否则改了却不会进保存补丁。
 */
export function eventSourcePathsIn(sources: SourceMeta[], draftSources: Record<string, unknown>): string[] {
  const paths = new Set<string>()
  for (const source of sources) {
    // 整条来源的路径：面板新增或删除仓库订阅时走它。
    paths.add(`events.sources.${source.id}`)
    paths.add(`events.sources.${source.id}.enabled`)
    for (const field of sourceFieldDefs(source.id, source.fields)) paths.add(field.path)
  }
  for (const id of Object.keys(draftSources)) {
    paths.add(`events.sources.${id}`)
    paths.add(`events.sources.${id}.enabled`)
    paths.add(`events.sources.${id}.plugin`)
  }
  return [...paths]
}
