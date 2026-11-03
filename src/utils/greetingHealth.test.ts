import { describe, expect, it } from 'vitest'

import { buildGreetingHealth } from './greetingHealth'

const repeated = '约200家门店单季带来约5万笔复购订单'

describe('greeting health report', () => {
  it('returns nothing to report when no AI greeting was sent', () => {
    expect(buildGreetingHealth([])).toBeNull()
  })

  it('shows uneven fact use, repeated sentences and template phrasing across a batch', () => {
    const batch = [
      ['我搭建过会员积分体系', 'fact-a'],
      ['我重做过会员等级权益，我希望继续做会员', 'fact-a'],
      ['我设计过储值卡活动', 'fact-a'],
      ['我做过社群团购，经历主要在线上侧', 'fact-b'],
    ].map(([text, fact], index) => ({
      sentAt: index,
      messages: ['老师您好，我做了6年会员运营。', `${text}，${repeated}。`],
      usedFactIds: [fact!],
    }))

    const health = buildGreetingHealth(batch)!

    expect(health.count).toBe(4)
    expect(health.facts.distinct).toBe(2)
    expect(health.facts.top[0]).toEqual({ id: 'fact-a', greetings: 3, share: 75 })
    expect(health.repeatedPhrases.map((item) => item.phrase)).toContain(repeated)
    expect(health.stockPhraseRate).toBe(25)
    expect(health.selfDeprecationRate).toBe(25)
    // 第 4 条发出时，fact-a 在它之前已用了 3 次，但它用的是 fact-b。
    expect(health.facts.overusedRate).toBe(0)
    // 没有复核结果的旧招呼语不计入复核类比例。
    expect(health.reviewed).toBe(0)
    expect(health.jdQuoteFoundRate).toBe(0)
  })

  it('counts which checks caused rewrites and which issues were still sent', () => {
    const health = buildGreetingHealth([
      {
        sentAt: 1,
        messages: ['老师您好。', '我搭建过会员积分体系。'],
        usedFactIds: ['fact-a'],
        review: {
          jdQuoteFound: true,
          styleIssues: [],
          attempts: 2,
          rewriteReasons: ['REUSED_PHRASE', 'TOO_SIMILAR'],
        },
      },
      {
        sentAt: 2,
        messages: ['老师您好。', '我做过社群团购。'],
        usedFactIds: ['fact-b'],
        review: {
          jdQuoteFound: false,
          styleIssues: ['TOO_SIMILAR'],
          attempts: 2,
          rewriteReasons: ['TOO_SIMILAR'],
        },
      },
    ])!
    expect(health.rewriteReasons).toEqual({ REUSED_PHRASE: 1, TOO_SIMILAR: 2 })
    expect(health.styleIssues).toEqual({ TOO_SIMILAR: 1 })
    expect(health.jdQuoteFoundRate).toBe(50)
    expect(health.rewrittenRate).toBe(100)
  })

  it('reports the three-party audit coverage separately from style review', () => {
    const baseAudit = {
      matchEnabled: true,
      matchPercent: 85,
      matchSelectedFactIds: ['fact-a'],
      matchSelectedFactIdsValid: true,
      greetingUsedFactIds: ['fact-a'],
      greetingUsedFactIdsValid: true,
      greetingFactIdsInMatch: ['fact-a'],
      maxFacts: 2,
      factCountWithinLimit: true,
      segmentFactMappingComplete: true,
      segmentAudits: [],
      jdQuoteFound: true,
      claimMode: 'direct' as const,
      claimBoundaryValid: true,
      claimIssueCodes: [],
      qualityIssueCodes: [],
      resumeEvidenceMatches: true,
    }
    const health = buildGreetingHealth([
      {
        sentAt: 1,
        messages: ['老师您好。', '我做过平台产品。'],
        usedFactIds: ['fact-a'],
        audit: baseAudit,
      },
      {
        sentAt: 2,
        messages: ['老师您好。', '我做过平台产品。'],
        usedFactIds: ['fact-a'],
        audit: { ...baseAudit, jdQuoteFound: false, claimBoundaryValid: false },
      },
    ])!
    expect(health.audited).toBe(2)
    expect(health.triadCompleteRate).toBe(50)
    expect(health.jdAnchorHitRate).toBe(50)
    expect(health.factMappingCompleteRate).toBe(100)
    expect(health.evidenceVersionMatchRate).toBe(100)
    expect(health.claimBoundaryPassRate).toBe(50)
  })
})
