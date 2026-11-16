import { describe, expect, it } from 'vitest'
import {
  GITHUB_EVENT_KINDS,
  GITHUB_EVENT_TYPES,
  githubEventLabel,
  isGithubEventType,
} from '../src/github-events.js'

describe('GitHub 订阅事件类型', () => {
  it('事件类型目录覆盖 Issue、PR、Action 三类', () => {
    expect(GITHUB_EVENT_KINDS).toEqual(['issues', 'pull_request', 'workflow_run'])
    for (const kind of GITHUB_EVENT_KINDS) {
      expect(GITHUB_EVENT_TYPES.filter(type => type.kind === kind).length).toBeGreaterThan(0)
    }
  })

  it('事件类型 id 是「类别.动作」形式', () => {
    for (const type of GITHUB_EVENT_TYPES) {
      expect(type.id).toBe(`${type.kind}.${type.action}`)
    }
  })

  it('只认目录里的事件类型', () => {
    expect(isGithubEventType('issues.opened')).toBe(true)
    expect(isGithubEventType('issues.exploded')).toBe(false)
    expect(isGithubEventType('')).toBe(false)
  })

  it('每个事件类型都有人话标签', () => {
    for (const type of GITHUB_EVENT_TYPES) {
      expect(githubEventLabel(type.id)).not.toBe('')
    }
  })
})
