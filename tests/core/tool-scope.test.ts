import { describe, expect, it } from 'vitest'
import { allowedTools, toolScopeFor, type ToolAuthz } from '#core/tool-scope.js'

const TOOLS: ToolAuthz[] = [
  { name: 'router_read', requires: 'all' },
  { name: 'router_ticket_progress', requires: 'member' },
  { name: 'router_ticket_list', requires: 'admin' },
  { name: 'router_ticket_close', requires: 'admin' },
  { name: 'router_decide', requires: 'admin' },
]

describe('toolScopeFor', () => {
  it('admin_maps_to_admin_full', () => {
    expect(toolScopeFor(true)).toBe('admin-full')
  })

  it('member_maps_to_member_analysis_read', () => {
    expect(toolScopeFor(false)).toBe('member-analysis-read')
  })
})

describe('allowedTools', () => {
  it('admin_full_keeps_every_tool', () => {
    expect(allowedTools('admin-full', TOOLS)).toEqual([
      'router_read',
      'router_ticket_progress',
      'router_ticket_list',
      'router_ticket_close',
      'router_decide',
    ])
  })

  it('member_analysis_read_keeps_only_all_and_member_tools', () => {
    expect(allowedTools('member-analysis-read', TOOLS)).toEqual(['router_read', 'router_ticket_progress'])
  })
})
