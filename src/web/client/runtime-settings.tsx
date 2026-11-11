/**
 * 运行时设置弹窗：按运行时声明的选项渲染表单。
 *
 * 面板不关心具体是哪个运行时 —— 有声明就显示「设置」按钮，
 * 字段、默认值与校验全部来自 `runtimeOptionFields`。
 */
import { useMemo, useState } from 'react'
import {
  fieldError,
  fieldValue,
  getByPath,
  runtimeOptionFields,
  type RuntimeChoiceView,
} from './fields.js'
import { FieldRow } from './field-row.js'
import { Icon } from './icons.js'
import { runtimeDisplayName } from './runtime-model.js'

export interface RuntimeSettingsProps {
  choice: RuntimeChoiceView
  /** 当前配置草稿（整份 config），按字段路径取值。 */
  draft: unknown
  /** 默认值快照，用于「恢复默认」。 */
  defaults: unknown
  onChange: (path: string, value: unknown) => void
  onClose: () => void
}

export function RuntimeSettingsDialog({ choice, draft, defaults, onChange, onClose }: RuntimeSettingsProps): JSX.Element | null {
  const fields = useMemo(() => runtimeOptionFields(choice.id), [choice.id])
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  if (fields.length === 0) return null

  const errors = fields
    .map(field => ({ path: field.path, message: fieldError(field, fieldValue(draft, field.path)) }))
    .filter((item): item is { path: string; message: string } => Boolean(item.message))
  const hasError = errors.length > 0
  const name = runtimeDisplayName(choice)

  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="modal runtime-settings" role="dialog" aria-modal="true" aria-label={`${name} 设置`}>
        <header className="modal-head">
          <div>
            <h3>{name} 设置</h3>
            <p>只影响新工单；改完保存页面配置并重启服务后生效。</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="modal-body">
          {fields.map(field => (
            <FieldRow
              key={field.path}
              field={field}
              value={fieldValue(draft, field.path)}
              defaultValue={getByPath(defaults, field.path)}
              error={touched[field.path] ? errors.find(item => item.path === field.path)?.message : undefined}
              onChange={value => {
                setTouched(current => ({ ...current, [field.path]: true }))
                onChange(field.path, value)
              }}
            />
          ))}
          <p className="modal-hint">
            <Icon name="alert" size={13} />
            这些选项属于 <code>runtime.options.{choice.id}</code>；留空表示不覆盖，跟随运行时自己的默认。
          </p>
        </div>
        <footer className="modal-foot">
          <button
            className="btn primary"
            disabled={hasError}
            title={hasError ? errors[0]?.message : undefined}
            onClick={onClose}
          >
            完成
          </button>
        </footer>
      </div>
    </div>
  )
}
