/**
 * GitHub 事件目录：声明「有哪些 GitHub 事件可订阅」。
 *
 * 目录只回答这一个问题：事件类型清单 + 连接参数。
 * 拉取逻辑（游标、翻页、窗口裁剪）在 watcher 里，不在目录里。
 */
import type { EventCatalog, EventTypeDescriptor } from '#event/port.js'
import { GITHUB_EVENT_PREFIX, GITHUB_EVENT_TYPES, withGithubPrefix } from '#core/github-events.js'

const GROUP_LABELS: Record<string, string> = {
  issues: 'Issue',
  pull_request: 'Pull Request',
  workflow_run: 'Action',
}

/** GitHub 的事件类型目录。 */
export const githubCatalog: EventCatalog = {
  id: 'github',
  kind: 'github',
  name: 'GitHub',
  types: (): EventTypeDescriptor[] =>
    GITHUB_EVENT_TYPES.map(type => ({
      id: withGithubPrefix(type.id),
      label: type.label,
      group: GROUP_LABELS[type.kind] ?? type.kind,
    })),
  params: () => [
    { key: 'repo', label: '仓库', kind: 'text', hint: 'owner/repo' },
  ],
}

/** 目录 id 到来源前缀的映射，供宿主拼事件类型时用。 */
export const GITHUB_CATALOG_ID = 'github'
export const GITHUB_TYPES_PREFIX = GITHUB_EVENT_PREFIX
