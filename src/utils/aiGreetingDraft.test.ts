import { describe, expect, it } from 'vitest'

import {
  deriveClaimModeFromFacts,
  parseFilteringDecisionContent,
  parseGreetingDraft,
} from './aiGreetingDraft'

describe('AI greeting domain parsing', () => {
  it('derives claim mode from selected evidence rather than score', () => {
    expect(deriveClaimModeFromFacts([{ evidenceType: 'direct_fact' }])).toBe('direct')
    expect(
      deriveClaimModeFromFacts([
        { evidenceType: 'direct_fact' },
        { evidenceType: 'adjacent_only' },
      ]),
    ).toBe('adjacent')
    expect(deriveClaimModeFromFacts([{ evidenceType: 'self_claim' }])).toBe('adjacent')
  })

  it('parses exactly three messages and generation metadata', () => {
    expect(
      parseGreetingDraft(
        JSON.stringify({
          messages: ['第一条', '第二条', '第三条'],
          usedFactIds: ['fact-agent-content'],
          claimMode: 'direct',
          openingPattern: 'jd-hook',
        }),
      ),
    ).toEqual({
      messages: ['第一条', '第二条', '第三条'],
      usedFactIds: ['fact-agent-content'],
      claimMode: 'direct',
      openingPattern: 'jd-hook',
    })
  })

  it('accepts the configured message count', () => {
    expect(
      parseGreetingDraft(
        JSON.stringify({
          messages: ['第一条', '第二条'],
          usedFactIds: ['fact-agent-content'],
          claimMode: 'direct',
          openingPattern: 'jd-hook',
        }),
        2,
      ).messages,
    ).toEqual(['第一条', '第二条'])
  })

  it('rejects missing metadata and non-three-message output', () => {
    expect(() => parseGreetingDraft(JSON.stringify({ messages: ['第一条', '第二条'] }))).toThrow(
      'AI招呼语必须包含3条消息',
    )
    expect(() =>
      parseGreetingDraft(
        JSON.stringify({
          messages: ['第一条', '第二条', '第三条'],
          usedFactIds: [],
          claimMode: 'direct',
          openingPattern: '',
        }),
      ),
    ).toThrow('AI招呼语元数据不完整')
  })

  it('parses a bounded filtering decision', () => {
    expect(
      parseFilteringDecisionContent(
        JSON.stringify({
          matchPercent: 78,
          level: 'good',
          reason: '相邻经验',
          selectedFactIds: ['fact-agent-content'],
        }),
        70,
      ),
    ).toEqual({
      passed: true,
      decision: {
        matchPercent: 78,
        level: 'good',
        reason: '相邻经验',
        selectedFactIds: ['fact-agent-content'],
      },
      modelPass: undefined,
    })
  })

  it('uses the caller threshold without a hidden global minimum', () => {
    const parseScore = (matchPercent: number) =>
      parseFilteringDecisionContent(
        JSON.stringify({
          matchPercent,
          level: 'good',
          reason: '岗位方向相关',
          selectedFactIds: ['fact-agent-content'],
        }),
        60,
      )

    expect(parseScore(59)?.passed).toBe(false)
    expect(parseScore(60)?.passed).toBe(true)
  })

  it('rejects a passing filtering decision when fact ids are empty', () => {
    expect(
      parseFilteringDecisionContent(
        JSON.stringify({
          matchPercent: 80,
          level: 'good',
          reason: '岗位方向相关',
          selectedFactIds: [' ', '\t'],
        }),
        70,
      ),
    ).toBeNull()
  })

  it('trims and deduplicates filtering fact ids before applying the limit', () => {
    const result = parseFilteringDecisionContent(
      JSON.stringify({
        matchPercent: 80,
        level: 'good',
        reason: '岗位方向相关',
        selectedFactIds: [
          ' fact-agent-content ',
          'fact-agent-content',
          '\tfact-b2b-saas\t',
          'fact-third',
        ],
      }),
      70,
    )

    expect(result?.decision.selectedFactIds).toEqual(['fact-agent-content', 'fact-b2b-saas'])
  })

  it('rejects whitespace-only greeting fact ids', () => {
    expect(() =>
      parseGreetingDraft(
        JSON.stringify({
          messages: ['第一条', '第二条', '第三条'],
          usedFactIds: [' ', '\t'],
          claimMode: 'direct',
          openingPattern: 'jd-hook',
        }),
      ),
    ).toThrow('AI招呼语元数据不完整')
  })

  it('trims and deduplicates greeting fact ids before applying the limit', () => {
    const result = parseGreetingDraft(
      JSON.stringify({
        messages: ['第一条', '第二条', '第三条'],
        usedFactIds: [
          ' fact-agent-content ',
          'fact-agent-content',
          '\tfact-b2b-saas\t',
          'fact-third',
        ],
        claimMode: 'direct',
        openingPattern: 'jd-hook',
      }),
    )

    expect(result.usedFactIds).toEqual(['fact-agent-content', 'fact-b2b-saas'])
  })
})
