import { describe, expect, it } from 'vitest'

import type { GreetingDraft, SelectedGreetingFact } from '@/types/aiGreeting'

import { STYLE_ISSUE_CODES, validateGreetingDraft } from './greetingQuality'

const selectedFact: SelectedGreetingFact = {
  id: 'fact-agent-content',
  action: '负责',
  object: 'Agent 内容工作流',
  evidenceType: 'direct_fact',
  allowedClaimVerbs: ['负责', '参与'],
}

const validDraft: GreetingDraft = {
  anchor: { need: 'AI 产品从需求到迭代', jdQuote: 'AI产品经理' },
  messages: [
    '王老师您好，我是林小舟。关注到贵司正在招聘AI产品经理，岗位方向与我持续关注的AI产品场景很接近。',
    '曾负责Agent内容工作流，围绕内容生成、自动发布和数据监控推进产品迭代，也积累了相邻场景下的实践经验。',
    '相关方法能够支持需求拆解、方案设计和持续迭代，希望进一步了解岗位当前阶段、核心目标以及团队协作方式。',
  ],
  usedFactIds: [selectedFact.id],
  segmentFactIds: [[selectedFact.id], [], []],
}

const validArgs = {
  candidateName: '林小舟',
  draft: validDraft,
  selectedFacts: [selectedFact],
  claimPolicy: {
    adjacentOnly: ['Data Agent'],
    forbiddenClaims: ['主导模型训练'],
  },
}

describe('greeting quality validation', () => {
  /**
   * 真机日志（2026-08-05）里 10 个岗位有 3 个卡在 CLAIM_MODE_MISMATCH：匹配阶段选出
   * direct 与 adjacent 混合的事实，招呼语只引用了其中一部分，自报的声明和匹配阶段对不上
   * 就被判失败，白白消耗投递额度。现在草稿里没有声明这一项，措辞按实际引用的事实检查。
   */
  it('accepts a draft that cites only a subset of the selected facts', () => {
    const adjacentFact: SelectedGreetingFact = {
      ...selectedFact,
      id: 'fact-derived-capability',
      evidenceType: 'derived_capability',
    }
    const issues = validateGreetingDraft({
      ...validArgs,
      selectedFacts: [selectedFact, adjacentFact],
      draft: { ...validDraft, usedFactIds: [selectedFact.id] },
    })
    expect(issues).toEqual([])
  })

  it('accepts a valid greeting draft', () => {
    expect(validateGreetingDraft(validArgs)).toEqual([])
  })

  it('accepts every valid cited fact and per-segment mapping without a fixed count cap', () => {
    const facts = Array.from({ length: 4 }, (_, index) => ({
      ...selectedFact,
      id: `fact-${index}`,
    }))
    const usedFactIds = facts.map((fact) => fact.id)
    const args = {
      ...validArgs,
      selectedFacts: facts,
      draft: { ...validDraft, usedFactIds, segmentFactIds: [usedFactIds, [], []] },
    }
    expect(validateGreetingDraft(args)).toEqual([])
    expect(
      validateGreetingDraft({
        ...args,
        draft: { ...args.draft, segmentFactIds: [usedFactIds.slice(0, 3), [], []] },
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SEGMENT_FACT_MAPPING' })]))
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
    // 字数只是软目标，偏短、偏长、单条偏长都不产生任何问题，也就不会触发重写。
    for (const messages of [
      ['简短开场。', '简短经历。', '简短收束。'],
      ['x'.repeat(76), 'y'.repeat(30), 'z'.repeat(20)],
      ['x'.repeat(120), 'y'.repeat(120), 'z'.repeat(120)],
    ]) {
      expect(validateGreetingDraft({ ...validArgs, draft: { ...validDraft, messages } })).toEqual(
        [],
      )
    }
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
        segmentFactIds: [[selectedFact.id], []],
      },
    })

    expect(issues).toEqual([])
  })

  it('rejects facts outside filtering boundaries', () => {
    expect(
      validateGreetingDraft({
        ...validArgs,
        draft: { ...validDraft, usedFactIds: ['unknown'] },
      })[0].code,
    ).toBe('FACT_NOT_ALLOWED')
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
        messages: ['您好。', '我负责过Data Agent相关工作。', '希望进一步沟通。'],
      },
    })

    expect(issues.some((issue) => issue.code === 'FORBIDDEN_CLAIM')).toBe(true)
  })

  it('allows a JD topic and my own ownership claim in different clauses', () => {
    // 新提示词要求第一句点出 JD 核心职责再用事实回应，JD 里的相邻主题和自己事实里的
    // 「负责过」经常在同一条消息里。分句不同，说的就是两件事。
    const issues = validateGreetingDraft({
      ...validArgs,
      draft: {
        ...validDraft,
        messages: [
          '您好。',
          '看到岗位在做 Data Agent，我负责过Agent内容工作流。',
          '想了解团队现状。',
        ],
      },
    })

    expect(issues).toEqual([])
  })

  it('marks style problems separately from fact-boundary problems', () => {
    const codes = (draft: Partial<GreetingDraft>, extra: object = {}) =>
      validateGreetingDraft({
        ...validArgs,
        draft: { ...validDraft, ...draft },
        jobText: '招聘AI产品经理，负责Agent内容工作流的设计与迭代',
        ...extra,
      }).map((item) => item.code)

    expect(codes({})).toEqual([])
    expect(codes({ anchor: { need: '内容工作流', jdQuote: '负责内容平台的搭建' } })).toEqual([
      'JD_QUOTE_NOT_FOUND',
    ])
    // JD 还没取到时不核对摘录。
    expect(
      codes({ anchor: { need: '内容工作流', jdQuote: '负责内容平台的搭建' } }, { jobText: '' }),
    ).toEqual([])
    expect(
      codes({ messages: ['王老师您好。', '我负责过Agent内容工作流。', '我的经历主要在软件侧。'] }),
    ).toEqual(['SELF_DEPRECATION'])
    expect(
      codes({ messages: ['王老师您好。', '我负责过Agent内容工作流。', '我希望进一步沟通。'] }),
    ).toEqual(['STOCK_PHRASE'])
    expect(
      codes(
        {
          messages: [
            '王老师您好。',
            '我负责过Agent内容工作流，日均产出约500条内容。',
            '期待沟通。',
          ],
        },
        { avoidPhrases: ['日均产出约500条内容'] },
      ),
    ).toEqual(['REUSED_PHRASE'])
    expect(
      codes(
        {},
        { recentMessages: [validDraft.messages.map((message) => message.replace('王', '李'))] },
      ),
    ).toEqual(['TOO_SIMILAR'])
    for (const code of [
      'JD_QUOTE_NOT_FOUND',
      'SELF_DEPRECATION',
      'STOCK_PHRASE',
      'REUSED_PHRASE',
      'TOO_SIMILAR',
    ]) {
      expect(STYLE_ISSUE_CODES.has(code as never)).toBe(true)
    }
    expect(STYLE_ISSUE_CODES.has('FORBIDDEN_CLAIM')).toBe(false)
  })
})
