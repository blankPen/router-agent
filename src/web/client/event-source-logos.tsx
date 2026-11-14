/**
 * 事件来源的标识图形。
 *
 * 统一 24×24 线性图标，配色交给外层（currentColor），不同来源只换形状不换风格，
 * 免得卡片区看起来像拼贴。
 */
export function SourceLogo({ kind, size = 20 }: { kind: string; size?: number }): JSX.Element {
  const glyph = ((): JSX.Element => {
    if (kind === 'github') {
      return (
        <>
          <path d="M9 19c-4 1.5-4-2-5-2m10 4v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.6 1.3a12.3 12.3 0 0 0-6.4 0C4.8 2.5 3.7 2.8 3.7 2.8A4.2 4.2 0 0 0 3.6 6a4.6 4.6 0 0 0-1.3 3.2c0 4.6 2.7 5.7 5.5 6-.5.5-.6 1-.6 2V21" />
        </>
      )
    }
    if (kind === 'http') {
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
        </>
      )
    }
    if (kind === 'schedule') {
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      )
    }
    if (kind === 'feishu') {
      return (
        <>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M8 9h8M8 13h5" />
        </>
      )
    }
    return (
      <>
        <path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
      </>
    )
  })()
  return (
    <svg
      className="source-logo-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  )
}
