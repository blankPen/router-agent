import { describe, expect, it } from 'vitest'
import {
  NEEDS_FOLLOWUP_THRESHOLD,
  PROJECT_RELATED_THRESHOLD,
  confidenceOf,
  fallbackVerdict,
  guardedMsgType,
  msgTypeFromScore,
  routeVerdict,
  validateAnswers,
  type DecisionAnswers,
} from '#core/decision.js'

const base = (over: Partial<DecisionAnswers> = {}): DecisionAnswers => ({
  needsFollowup: 0.9,
  msgTypeScore: 0.8, // feedback
  projectRelated: 0.9,
  urgency: 0.7,
  ...over,
})

describe('validateAnswers', () => {
  it('rejects_out_of_range_probabilities', () => {
    expect(validateAnswers(base({ needsFollowup: 1.2 }))).toContain('needsFollowup')
    expect(validateAnswers(base({ msgTypeScore: -0.1 }))).toContain('msgTypeScore')
    expect(validateAnswers(base({ projectRelated: NaN }))).toContain('projectRelated')
    expect(validateAnswers(base({ urgency: 2 }))).toContain('urgency')
  })

  it('accepts_valid_answers', () => {
    expect(validateAnswers(base())).toBeNull()
  })
})

describe('msgTypeFromScore', () => {
  it('maps_four_bands_to_msg_types', () => {
    expect(msgTypeFromScore(0.1)).toBe('chitchat')
    expect(msgTypeFromScore(0.3)).toBe('grumble')
    expect(msgTypeFromScore(0.6)).toBe('consult')
    expect(msgTypeFromScore(0.9)).toBe('feedback')
  })
})

describe('guardedMsgType', () => {
  it('moves_ambiguous_edge_scores_to_more_processed_type', () => {
    expect(guardedMsgType(0.18)).toBe('grumble') // chitchat 上沿 → grumble
    expect(guardedMsgType(0.42)).toBe('consult') // grumble 上沿 → consult
    expect(guardedMsgType(0.68)).toBe('feedback') // consult 上沿 → feedback
    expect(guardedMsgType(0.5)).toBe('consult') // 中段不受影响
  })
})

describe('confidenceOf', () => {
  it('takes_the_minimum_of_components', () => {
    // needsFollowup 0.9 → 0.9；msgType 0.85 距 0.75 边界 0.1 / 0.25 = 0.4；projectRelated 0.9；urgency 0.7
    expect(confidenceOf(base({ msgTypeScore: 0.85, urgency: 0.7 }))).toBeCloseTo(0.4, 3)
  })

  it('followup_edge_binds_confidence', () => {
    // needsFollowup 0.55 → 1-0.55=0.45；msgType 0.8 距 0.75 边界 0.05 / 0.25 = 0.2 更低
    expect(confidenceOf(base({ needsFollowup: 0.55 }))).toBeCloseTo(0.2, 3)
  })
})

describe('routeVerdict', () => {
  it('below_followup_threshold_is_ignored_regardless_of_type', () => {
    const verdict = routeVerdict(base({ needsFollowup: 0.3 }), 'member-analysis-read')
    expect(verdict.action).toBe('ignore')
    expect(verdict.needsFollowup).toBe(false)
    expect(verdict.toolScope).toBe('member-analysis-read')
  })

  it('chitchat_is_ignored', () => {
    expect(routeVerdict(base({ msgTypeScore: 0.1 }), 'member-analysis-read').action).toBe('ignore')
  })

  it('grumble_routes_to_observe', () => {
    const verdict = routeVerdict(base({ msgTypeScore: 0.3 }), 'member-analysis-read')
    expect(verdict.msgType).toBe('grumble')
    expect(verdict.action).toBe('observe')
  })

  it('consult_routes_to_reply', () => {
    const verdict = routeVerdict(base({ msgTypeScore: 0.6 }), 'member-analysis-read')
    expect(verdict.msgType).toBe('consult')
    expect(verdict.action).toBe('reply')
  })

  it('feedback_without_project_relation_is_ignored', () => {
    const verdict = routeVerdict(base({ projectRelated: 0.2 }), 'member-analysis-read')
    expect(verdict.msgType).toBe('feedback')
    expect(verdict.action).toBe('ignore')
  })

  it('feedback_with_project_relation_routes_to_analysis', () => {
    const verdict = routeVerdict(base(), 'member-analysis-read')
    expect(verdict.msgType).toBe('feedback')
    expect(verdict.action).toBe('analysis')
  })

  it('thresholds_are_hand_computed_literals', () => {
    expect(NEEDS_FOLLOWUP_THRESHOLD).toBe(0.6)
    expect(PROJECT_RELATED_THRESHOLD).toBe(0.5)
    expect(routeVerdict(base({ needsFollowup: 0.6 }), 'member-analysis-read').needsFollowup).toBe(true)
    expect(routeVerdict(base({ needsFollowup: 0.59 }), 'member-analysis-read').needsFollowup).toBe(false)
    expect(routeVerdict(base({ projectRelated: 0.5 }), 'member-analysis-read').action).toBe('analysis')
    expect(routeVerdict(base({ projectRelated: 0.49 }), 'member-analysis-read').action).toBe('ignore')
  })
})

describe('fallbackVerdict', () => {
  it('falls_back_to_analysis_with_degraded_flag', () => {
    const verdict = fallbackVerdict('member-analysis-read')
    expect(verdict.action).toBe('analysis')
    expect(verdict.msgType).toBe('feedback')
    expect(verdict.needsFollowup).toBe(true)
    expect(verdict.degraded).toBe(true)
    expect(verdict.confidence).toBe(0)
  })
})
