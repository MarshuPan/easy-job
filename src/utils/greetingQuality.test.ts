import { describe, expect, it } from 'vitest'

import type {
  GreetingDraft,
  GreetingFilteringContext,
  SelectedGreetingFact,
} from '@/types/aiGreeting'

import { validateGreetingDraft } from './greetingQuality'

const selectedFact: SelectedGreetingFact = {
  id: 'fact-agent-content',
  action: '负责',
  object: 'Agent 内容工作流',
  ownership: 'owned',
  domains: ['内容生产'],
  skills: ['Agent'],
  evidenceType: 'direct_fact',
  allowedClaimVerbs: ['负责', '参与'],
  confidence: 'high',
}

const filtering: GreetingFilteringContext = {
  matchPercent: 78,
  level: 'good',
  reason: '相邻经验',
  selectedFactIds: [selectedFact.id],
  claimMode: 'direct',
}

const validDraft: GreetingDraft = {
  messages: [
    '王老师您好，我是林小舟。关注到贵司正在招聘AI产品经理，岗位方向与我持续关注的AI产品场景很接近。',
    '曾负责Agent内容工作流，围绕内容生成、自动发布和数据监控推进产品迭代，也积累了相邻场景下的实践经验。',
    '相关方法能够支持需求拆解、方案设计和持续迭代，希望进一步了解岗位当前阶段、核心目标以及团队协作方式。',
  ],
  usedFactIds: [selectedFact.id],
  claimMode: 'direct',
  openingPattern: 'jd-hook',
}

const validArgs = {
  candidateName: '林小舟',
  draft: validDraft,
  filtering,
  selectedFacts: [selectedFact],
  claimPolicy: {
    adjacentOnly: ['Data Agent'],
    forbiddenClaims: ['主导模型训练'],
  },
}

describe('greeting quality validation', () => {
  /**
   * 真机日志（2026-08-05）里 10 个岗位有 3 个卡在 CLAIM_MODE_MISMATCH：匹配阶段选出
   * direct 与 adjacent 混合的事实、claimMode 记为 adjacent，招呼语只引用了其中的
   * direct 事实、声明 direct——两者不相等就被判失败，且重试两次都失败，最终「已建立
   * 沟通但招呼语发不出去」，白白消耗投递额度。用子集写作只会让声明更保守，不该被拒。
   */
  it('accepts a draft that only cites the direct subset of mixed selected facts', () => {
    const adjacentFact: SelectedGreetingFact = {
      ...selectedFact,
      id: 'fact-derived-capability',
      evidenceType: 'derived_capability',
    }
    const issues = validateGreetingDraft({
      ...validArgs,
      selectedFacts: [selectedFact, adjacentFact],
      filtering: {
        ...filtering,
        selectedFactIds: [selectedFact.id, adjacentFact.id],
        // 匹配阶段对「全部选中事实」推导，混合即为 adjacent。
        claimMode: 'adjacent',
      },
      // 招呼语只用了 direct 的那个事实，因此自身声明 direct 是准确的。
      draft: { ...validDraft, usedFactIds: [selectedFact.id], claimMode: 'direct' },
    })
    expect(issues.map((item) => item.code)).not.toContain('CLAIM_MODE_MISMATCH')
  })

  it('still rejects a draft that overstates its own facts', () => {
    // 安全边界不变：用了 adjacent 事实却声明 direct 属于夸大，必须拦截。
    const adjacentFact: SelectedGreetingFact = {
      ...selectedFact,
      id: 'fact-derived-capability',
      evidenceType: 'derived_capability',
    }
    const issues = validateGreetingDraft({
      ...validArgs,
      selectedFacts: [selectedFact, adjacentFact],
      filtering: {
        ...filtering,
        selectedFactIds: [selectedFact.id, adjacentFact.id],
        claimMode: 'adjacent',
      },
      draft: { ...validDraft, usedFactIds: [adjacentFact.id], claimMode: 'direct' },
    })
    expect(issues.map((item) => item.code)).toContain('CLAIM_MODE_MISMATCH')
  })

  it('accepts a valid greeting draft', () => {
    expect(validateGreetingDraft(validArgs)).toEqual([])
  })

  it('reports schema, count, and empty message issues', () => {
    expect(validateGreetingDraft({ ...validArgs, draft: null as never })[0].code).toBe(
      'SCHEMA_INVALID',
    )
    expect(
      validateGreetingDraft({
        ...validArgs,
        draft: { ...validDraft, messages: ['一', '二'] as never },
      })[0].code,
    ).toBe('MESSAGE_COUNT')
    expect(
      validateGreetingDraft({
        ...validArgs,
        draft: { ...validDraft, messages: ['一', ' ', '三'] },
      })[0].code,
    ).toBe('MESSAGE_EMPTY')
  })

  it('treats the configured total length as guidance without triggering regeneration', () => {
    expect(
      validateGreetingDraft({
        ...validArgs,
        draft: { ...validDraft, messages: ['简短开场。', '简短经历。', '简短收束。'] },
      }).some((issue) => issue.code === 'TOTAL_TOO_SHORT'),
    ).toBe(false)
    expect(
      validateGreetingDraft({
        ...validArgs,
        draft: { ...validDraft, messages: ['x'.repeat(76), 'y'.repeat(30), 'z'.repeat(20)] },
      }).some((issue) => issue.code === 'MESSAGE_TOO_LONG'),
    ).toBe(false)
    expect(
      validateGreetingDraft({
        ...validArgs,
        draft: { ...validDraft, messages: ['x'.repeat(63), 'y'.repeat(63), 'z'.repeat(63)] },
      }).some((issue) => issue.code === 'TOTAL_TOO_LONG'),
    ).toBe(false)
    expect(
      validateGreetingDraft({
        ...validArgs,
        draft: { ...validDraft, messages: ['x'.repeat(60), 'y'.repeat(60), 'z'.repeat(63)] },
      }),
    ).toEqual([])
    expect(
      validateGreetingDraft({
        ...validArgs,
        draft: { ...validDraft, messages: ['x'.repeat(120), 'y'.repeat(120), 'z'.repeat(120)] },
      }).some((issue) => issue.code === 'TOTAL_TOO_LONG'),
    ).toBe(false)
  })

  it('allows the supporting messages to omit first-person wording', () => {
    const issues = validateGreetingDraft({
      ...validArgs,
      draft: {
        ...validDraft,
        messages: [
          '王老师您好，我是林小舟。关注到贵司正在招聘AI产品经理，岗位方向与我持续关注的AI产品场景很接近。',
          '曾负责Agent内容工作流，围绕内容生成、自动发布和数据监控推进产品迭代，也积累了相邻场景下的实践经验。',
          '相关方法能够支持需求拆解、方案设计和持续迭代，希望进一步了解岗位当前阶段、核心目标以及团队协作方式。',
        ],
      },
    })

    expect(issues).toEqual([])
  })

  it('derives a conservative claim mode from facts when filtering is disabled', () => {
    const directIssues = validateGreetingDraft({
      ...validArgs,
      filtering: undefined,
      draft: { ...validDraft, claimMode: 'direct' },
    })
    expect(directIssues.some((issue) => issue.code === 'CLAIM_MODE_MISMATCH')).toBe(false)

    const adjacentFact: SelectedGreetingFact = {
      ...selectedFact,
      id: 'fact-adjacent',
      evidenceType: 'adjacent_only',
    }
    const adjacentIssues = validateGreetingDraft({
      ...validArgs,
      filtering: undefined,
      selectedFacts: [adjacentFact],
      draft: {
        ...validDraft,
        usedFactIds: [adjacentFact.id],
        claimMode: 'direct',
      },
    })
    expect(adjacentIssues.some((issue) => issue.code === 'CLAIM_MODE_MISMATCH')).toBe(true)

    const emptyFilteringIssues = validateGreetingDraft({
      ...validArgs,
      filtering: { ...filtering, selectedFactIds: [] },
      selectedFacts: [adjacentFact],
      draft: {
        ...validDraft,
        usedFactIds: [adjacentFact.id],
        claimMode: 'adjacent',
      },
    })
    expect(emptyFilteringIssues.some((issue) => issue.code === 'CLAIM_MODE_MISMATCH')).toBe(false)
  })

  it('reports one claim-mode issue when filtering and draft are both inconsistent', () => {
    const issues = validateGreetingDraft({
      ...validArgs,
      filtering: { ...filtering, claimMode: 'adjacent' },
      draft: { ...validDraft, claimMode: 'adjacent' },
    })

    expect(issues.filter((issue) => issue.code === 'CLAIM_MODE_MISMATCH')).toHaveLength(1)
  })

  it('rejects explicit third-person self-description without requiring every sentence to say 我', () => {
    const issues = validateGreetingDraft({
      ...validArgs,
      draft: {
        ...validDraft,
        messages: [
          '王老师您好，该候选人是林小舟。',
          '我曾负责Agent内容工作流，具备相邻场景经验。',
          '我可以把相关方法迁移到产品持续迭代。',
        ],
      },
    })

    expect(issues.some((issue) => issue.code === 'THIRD_PERSON_SELF_REFERENCE')).toBe(true)
  })

  it('uses the configured message count and total character range', () => {
    const issues = validateGreetingDraft({
      ...validArgs,
      length: { messageCount: 2, minTotalCharacters: 20, maxTotalCharacters: 80 },
      draft: {
        ...validDraft,
        messages: ['王老师您好，我是候选人。关注到岗位方向。', '相关经验和岗位要求能够形成衔接。'],
      },
    })

    expect(issues.map((issue) => issue.code)).not.toContain('MESSAGE_COUNT')
    expect(issues.map((issue) => issue.code)).not.toContain('TOTAL_TOO_SHORT')
    expect(issues.map((issue) => issue.code)).not.toContain('TOTAL_TOO_LONG')
  })

  it('rejects facts and claim modes outside filtering boundaries', () => {
    expect(
      validateGreetingDraft({
        ...validArgs,
        draft: { ...validDraft, usedFactIds: ['unknown'] },
      })[0].code,
    ).toBe('FACT_NOT_ALLOWED')
    expect(
      validateGreetingDraft({
        ...validArgs,
        draft: { ...validDraft, claimMode: 'adjacent' },
      })[0].code,
    ).toBe('CLAIM_MODE_MISMATCH')
  })

  it('rejects policy phrases and unsupported controlled claim verbs', () => {
    const forbiddenPhrase = validateGreetingDraft({
      ...validArgs,
      draft: {
        ...validDraft,
        messages: ['您好。', '我曾主导模型训练。', '希望进一步沟通。'],
      },
    })
    expect(forbiddenPhrase.some((issue) => issue.code === 'FORBIDDEN_CLAIM')).toBe(true)

    const unsupportedVerb = validateGreetingDraft({
      ...validArgs,
      selectedFacts: [{ ...selectedFact, allowedClaimVerbs: ['参与'] }],
    })
    expect(unsupportedVerb.some((issue) => issue.code === 'FORBIDDEN_CLAIM')).toBe(true)

    const unsupportedDidVerb = validateGreetingDraft({
      ...validArgs,
      selectedFacts: [{ ...selectedFact, allowedClaimVerbs: ['参与'] }],
      draft: {
        ...validDraft,
        messages: ['您好。', '我做过Agent内容工作流。', '希望进一步沟通。'],
      },
    })
    expect(unsupportedDidVerb.some((issue) => issue.code === 'FORBIDDEN_CLAIM')).toBe(true)
  })

  it('rejects direct ownership language for adjacent-only phrases', () => {
    const issues = validateGreetingDraft({
      ...validArgs,
      draft: {
        ...validDraft,
        claimMode: 'adjacent',
        messages: ['您好。', '我负责过Data Agent相关工作。', '希望进一步沟通。'],
      },
    })

    expect(issues.some((issue) => issue.code === 'FORBIDDEN_CLAIM')).toBe(true)
  })
})
