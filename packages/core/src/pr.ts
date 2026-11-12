/** PR / MR 的中立视图；Router 跟踪与 UI 证据门禁共用。 */
export interface PrInfo {
  number: number
  url: string
  state: 'open' | 'merged' | 'closed'
  title: string
  branch: string
  /** PR 描述正文；UI 证据门禁用它检查 Before / After。列表查询不返回时为 undefined。 */
  body?: string
}
