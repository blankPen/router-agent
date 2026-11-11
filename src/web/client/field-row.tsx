/**
 * 设置项行控件：配置页与运行时设置弹窗共用。
 *
 * 只负责「标签 + 提示 + 控件」的展示，值由调用方提供并回写。
 */
import { Icon } from './icons.js'
import {
  fromInputValue,
  humanizeMs,
  toInputValue,
  type FieldDef,
} from './fields.js'

export function FieldRow({ field, value, defaultValue, error, onChange }: {
  field: FieldDef
  value: unknown
  defaultValue: unknown
  error?: string
  onChange: (value: unknown) => void
}): JSX.Element {
  const changedFromDefault = defaultValue !== undefined && JSON.stringify(value) !== JSON.stringify(defaultValue)
  const hint = error
    ? <span className="field-error">{error}</span>
    : <>
        {field.hint && <span>{field.hint}</span>}
        {field.ms && <span>{humanizeMs(value)}</span>}
      </>

  return (
    <div className={`setting ${error ? 'has-error' : ''}`}>
      <div className="setting-info">
        <div className="setting-label">
          <span>{field.label}</span>
          {changedFromDefault && (
            <button
              className="reset-link"
              title={`恢复默认值：${JSON.stringify(defaultValue)}`}
              onClick={() => onChange(defaultValue)}
            >
              恢复默认
            </button>
          )}
        </div>
        {(field.hint || field.ms || error) && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{fieldControl(field, value, onChange)}</div>
    </div>
  )
}

export function fieldControl(field: FieldDef, value: unknown, onChange: (value: unknown) => void): JSX.Element {
  if (field.kind === 'switch') {
    const on = value === true
    return (
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`toggle ${on ? 'on' : ''}`}
        onClick={() => onChange(!on)}
      >
        <span className="toggle-track"><span className="toggle-knob" /></span>
        <span className="toggle-label">{on ? '开启' : '关闭'}</span>
      </button>
    )
  }
  if (field.kind === 'password') {
    return (
      <input
        className="text-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={toInputValue(value, 'text')}
        onChange={event => onChange(event.target.value)}
        placeholder={field.placeholder}
      />
    )
  }
  if (field.kind === 'select') {
    return (
      <span className="select-wrap">
        <select value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
          {field.options?.map(option => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              title={option.reason ?? option.hint}
            >
              {option.label}
            </option>
          ))}
        </select>
        <Icon name="chevron" size={13} className="select-chevron" />
      </span>
    )
  }
  if (field.kind === 'number') {
    return (
      <span className="input-box">
        <input
          type="number"
          min={field.min}
          max={field.max}
          value={typeof value === 'number' ? value : ''}
          onChange={event => onChange(fromInputValue(event.target.value, 'number'))}
        />
        {field.unit && <span className="input-unit">{field.unit}</span>}
      </span>
    )
  }
  return (
    <input
      className="text-input"
      value={toInputValue(value, field.kind)}
      onChange={event => onChange(fromInputValue(event.target.value, field.kind))}
      placeholder={field.placeholder}
    />
  )
}
