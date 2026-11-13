/**
 * 日志页的维度下拉：域 / 动作 / 追踪。
 *
 * 闭合态是面板同款 chip（26px、中性灰、同一行基线），展开态是一张薄列表：
 * 值在左、计数在右（等宽数字），选中项打勾。控件本身不上色，颜色只留给数据。
 */
import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons.js'
import { ALL_FILTER } from './log-filters.js'

export interface FilterMenuOption {
  value: string
  /** 展示用的名字（群名、发起人名字）；没有就显示 value。 */
  label?: string
  count: number
}

export interface FilterMenuProps {
  /** 维度名（域 / 动作 / 追踪），以浅色显示在值前面。 */
  label: string
  /** 当前选中的值；`all` 表示不限。 */
  value: string
  /** 候选值与命中条数。 */
  options: FilterMenuOption[]
  onChange: (value: string) => void
}

export function FilterMenu({ label, value, options, onChange }: FilterMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selected = options.find(option => option.value === value)

  // 点外面或按 Esc 收起：下拉是浮层，不该挡住下面的日志。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const choose = (next: string): void => {
    onChange(next)
    setOpen(false)
  }

  return (
    <div className="log-menu" ref={rootRef}>
      <button
        type="button"
        className={`log-chip log-menu-trigger ${selected ? 'active' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}：${selected ? (selected.label ?? selected.value) : '全部'}`}
        onClick={() => setOpen(prev => !prev)}
      >
        <span className="log-menu-label">{label}</span>
        <span className="log-menu-value">{selected ? (selected.label ?? selected.value) : '全部'}</span>
        {selected && <span className="log-chip-count">{selected.count}</span>}
        <Icon name="chevron" size={11} className="log-menu-chevron" />
      </button>
      {open && (
        <ul className="log-menu-list" role="listbox" aria-label={`${label}候选`}>
          <li>
            <button
              type="button"
              role="option"
              aria-selected={!selected}
              className="log-menu-item log-menu-all"
              onClick={() => choose(ALL_FILTER)}
            >
              <span className="log-menu-check">{!selected && <Icon name="check" size={12} />}</span>
              <span className="log-menu-item-value">全部</span>
            </button>
          </li>
          {options.map(option => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className="log-menu-item"
                onClick={() => choose(option.value)}
              >
                <span className="log-menu-check">{option.value === value && <Icon name="check" size={12} />}</span>
                <span className="log-menu-item-value">{option.label ?? option.value}</span>
                <span className="log-menu-count">{option.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
