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
  status: string
  message?: string
  lastPolledAt?: string
  fields: SourceFieldMeta[]
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
