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
      ownership: 'led',
      metrics: [{ name: '团队规模', value: '10 人' }],
      domains: ['AI 平台'],
      skills: ['平台化'],
      evidenceType: 'direct_fact',
      allowedClaimVerbs: ['主导'],
      confidence: 'high',
    },
    {
      id: 'fact-agent-content',
      sourceQuote: 'private agent quote',
      action: '构建',
      object: 'Agent 内容系统',
      ownership: 'owned',
      domains: ['内容生产'],
      skills: ['Agent'],
      evidenceType: 'direct_fact',
      allowedClaimVerbs: ['负责'],
      confidence: 'high',
    },
  ],
  buckets: [],
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

  it('throws when more than two unique fact ids are requested', () => {
    expect(() =>
      resolveSelectedGreetingFacts(evidence, ['fact-platform', 'fact-agent-content', 'fact-third']),
    ).toThrow('筛选事实数量必须为1到2个')
  })
})
