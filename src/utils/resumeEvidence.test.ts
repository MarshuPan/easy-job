import { describe, expect, it } from 'vitest'

import type { ResumeEvidence } from '@/types/aiGreeting'

import { resolveSelectedGreetingFacts } from './resumeEvidence'

const evidence: ResumeEvidence = {
  facts: [
    {
      id: 'fact-platform',
      sourceQuote: 'private platform quote',
      action: '搭建',
      object: 'AI 平台',
      metrics: [{ name: '团队规模', value: '10 人' }],
      evidenceType: 'direct_fact',
      allowedClaimVerbs: ['主导'],
    },
    {
      id: 'fact-agent-content',
      sourceQuote: 'private agent quote',
      action: '构建',
      object: 'Agent 内容系统',
      evidenceType: 'direct_fact',
      allowedClaimVerbs: ['负责'],
    },
  ],
  claimPolicy: {
    adjacentOnly: ['模型评测'],
    forbiddenClaims: ['虚构项目经历'],
  },
}

describe('resume evidence resolution', () => {
  it('preserves request order and removes source quotes', () => {
    const { sourceQuote: _platformQuote, ...platformFact } = evidence.facts[0]
    const { sourceQuote: _agentQuote, ...agentFact } = evidence.facts[1]

    const result = resolveSelectedGreetingFacts(evidence, ['fact-agent-content', 'fact-platform'])

    expect(result).toEqual([agentFact, platformFact])
    expect(JSON.stringify(result)).not.toContain('sourceQuote')
    expect(JSON.stringify(result)).not.toContain('private agent quote')
  })

  it('throws for an unknown fact id', () => {
    expect(() => resolveSelectedGreetingFacts(evidence, ['fact-missing'])).toThrow(
      '筛选事实ID无效: fact-missing',
    )
  })

  it('resolves three or more valid facts and still rejects unknown references', () => {
    const expanded = {
      ...evidence,
      facts: [...evidence.facts, { ...evidence.facts[0], id: 'fact-third' }],
    }
    const ids = ['fact-platform', 'fact-agent-content', 'fact-third']
    expect(resolveSelectedGreetingFacts(expanded, ids).map((fact) => fact.id)).toEqual(ids)
    expect(() => resolveSelectedGreetingFacts(evidence, ids)).toThrow('筛选事实ID无效: fact-third')
    expect(() => resolveSelectedGreetingFacts(evidence, [])).toThrow('筛选事实不能为空')
  })
})
