/** 面板内联 SVG 图标；不引外部资源。 */

export type IconName =
  | 'inbox' | 'sliders' | 'radio' | 'search' | 'refresh' | 'copy' | 'external'
  | 'stop' | 'alert' | 'plus' | 'trash' | 'branch' | 'terminal' | 'clock' | 'check' | 'chevron' | 'close'
  | 'folder' | 'git' | 'file-text'
  | 'zap' | 'play'

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }): JSX.Element {
  const paths: Record<IconName, JSX.Element> = {
    inbox: (
      <>
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
      </>
    ),
    sliders: (
      <>
        <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
        <path d="M1 14h6M9 8h6M17 16h6" />
      </>
    ),
    radio: (
      <>
        <circle cx="12" cy="12" r="2" />
        <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </>
    ),
    refresh: (
      <>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </>
    ),
    copy: (
      <>
        <rect x="9" y="9" width="12" height="12" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
    external: (
      <>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <path d="M15 3h6v6M10 14 21 3" />
      </>
    ),
    stop: <rect x="6" y="6" width="12" height="12" rx="2.5" />,
    alert: (
      <>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    trash: (
      <>
        <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
      </>
    ),
    branch: (
      <>
        <path d="M6 3v12" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </>
    ),
    folder: (
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    ),
    git: (
      <>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="6" cy="18" r="2.5" />
        <circle cx="18" cy="12" r="2.5" />
        <path d="M6 8.5v7M8.5 6h4a3 3 0 0 1 3 3v1M8.5 18h4a3 3 0 0 0 3-3v-1" />
      </>
    ),
    terminal: (
      <>
        <path d="m4 17 6-6-6-6" />
        <path d="M12 19h8" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    check: <path d="m4 12 5 5L20 6" />,
    chevron: <path d="m9 6 6 6-6 6" />,
    close: <path d="M18 6 6 18M6 6l12 12" />,
    zap: <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />,
    play: <path d="M7 4l13 8-13 8V4Z" />,
    'file-text': (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6M9 13h6M9 17h6" />
      </>
    ),
  }
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

// 品牌标识：与 docs/assets/router-agent-logo.svg 保持一致的矢量图形。
export function LogoMark({ size = 34 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 720 720" fill="none" aria-hidden="true">
      <rect width="720" height="720" fill="#000000" />
      <g stroke="#FFFFFF" strokeWidth="16">
        <path d="M360 168V289.5" />
        <path d="M359 553L360 428.5" />
        <path d="M154 357.5L290.5 358.4" />
        <path d="M565 357.5L429.5 358.4" />
        <path d="M217 494L309 406.7" />
        <path d="M502 494L409.9 406.9" />
      </g>
      <g fill="#FFFFFF">
        <circle cx="360" cy="359" r="61.5" />
        <circle cx="360" cy="168" r="36" />
        <circle cx="359" cy="553" r="36" />
        <circle cx="154" cy="357.5" r="36" />
        <circle cx="565" cy="357.5" r="36" />
        <circle cx="217" cy="494" r="36" />
        <circle cx="502" cy="494" r="36" />
      </g>
    </svg>
  )
}
