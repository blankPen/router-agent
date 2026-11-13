import { describe, expect, it } from 'vitest'
import {
  NEEDS_FOLLOWUP_THRESHOLD,
  confidenceOf,
  guardedKind,
  kindFromScore,
  routeVerdict,
  validateAnswers,
  type DecisionAnswers,
} from '#core/decision.js'

const high = (kindScore: number): DecisionAnswers => ({ needsFollowup: 0.9, kindScore, urgency: 0.7 })

describe('validateAnswers', () => {
  it('rejects_out_of_range_probabilities', () => {
    expect(validateAnswers({ needsFollowup: 1.2, kindScore: 0.5, urgency: 0.5 })).toContain('needsFollowup')
    expect(validateAnswers({ needsFollowup: 0.5, kindScore: -0.1, urgency: 0.5 })).toContain('kindScore')
    expect(validateAnswers({ needsFollowup: 0.5, kindScore: 0.5, urgency: NaN })).toContain('urgency')
  })

  it('accepts_valid_answers', () => {
    expect(validateAnswers({ needsFollowup: 0.5, kindScore: 0.5, urgency: 0.5 })).toBeNull()
  })
})

describe('kindFromScore', () => {
  it('maps_three_bands_to_chat_question_issue', () => {
    expect(kindFromScore(0.1)).toBe('chat')
    expect(kindFromScore(0.5)).toBe('question')
    expect(kindFromScore(0.9)).toBe('issue')
  })
})

describe('guardedKind', () => {
  it('moves_ambiguous_edge_scores_to_more_conservative_kind', () => {
    expect(guardedKind(0.3)).toBe('question') // chat 上沿 → question
    expect(guardedKind(0.6)).toBe('issue') // question 上沿 → issue
    expect(guardedKind(0.5)).toBe('question') // 中段不受影响
  })
})

describe('confidenceOf', () => {
  it('takes_the_minimum_of_components', () => {
    // needsFollowup 0.9 → 0.9；kindScore 0.85 距 1 边界 0.15 / 0.34 ≈ 0.441；urgency 0.7
    expect(confidenceOf({ needsFollowup: 0.9, kindScore: 0.85, urgency: 0.7 })).toBeCloseTo(0.441, 3)
  })

  it('kind_edge_margin_binds_confidence', () => {
    // kindScore 0.9 距 1 边界 0.1 / 0.34 ≈ 0.294，低于 followupConf 0.8 与 urgency 0.9
    expect(confidenceOf({ needsFollowup: 0.2, kindScore: 0.9, urgency: 0.9 })).toBeCloseTo(0.294, 3)
  })
})

describe('routeVerdict', () => {
  it('below_threshold_is_ignored_regardless_of_kind', () => {
    const verdict = routeVerdict({ needsFollowup: 0.3, kindScore: 0.9, urgency: 0.5 }, 'member-analysis-read')
    expect(verdict.action).toBe('ignore')
    expect(verdict.needsFollowup).toBe(false)
    expect(verdict.toolScope).toBe('member-analysis-read')
  })

  it('issue_kind_routes_to_analysis', () => {
    const verdict = routeVerdict(high(0.8), 'member-analysis-read')
    expect(verdict.kind).toBe('issue')
    expect(verdict.action).toBe('analysis')
  })

  it('question_kind_routes_to_reply', () => {
    const verdict = routeVerdict(high(0.5), 'member-analysis-read')
    expect(verdict.kind).toBe('question')
    expect(verdict.action).toBe('reply')
  })

  it('chat_kind_routes_to_reply', () => {
    const verdict = routeVerdict(high(0.1), 'member-analysis-read')
    expect(verdict.kind).toBe('chat')
    expect(verdict.action).toBe('reply')
  })

  it('threshold_value_is_hand_computed_literal', () => {
    expect(NEEDS_FOLLOWUP_THRESHOLD).toBe(0.4)
    expect(routeVerdict({ needsFollowup: 0.4, kindScore: 0.9, urgency: 0.6 }, 'member-analysis-read').needsFollowup).toBe(true)
    expect(routeVerdict({ needsFollowup: 0.39, kindScore: 0.9, urgency: 0.6 }, 'member-analysis-read').needsFollowup).toBe(false)
  })
})
