import { describe, expect, it } from 'vitest'

import type { log } from '@/stores/log'

import { fingerprintGreeting, getRecentGreetingSummaries } from './greetingHistory'

function record(overrides: Partial<log> = {}): log {
  const messages = [
    '张老师，您好！我是林小舟，关注到真实岗位名。',
    '我在相邻项目中负责过 Agent 工作流。',
    '希望能和真实公司名进一步沟通。',
  ]

  return {
    title: '真实岗位名',
    state: 'success',
    state_name: '投递成功',
    createdAt: 100,
    data: {
      listData: {
        jobName: '真实岗位名',
        brandName: '真实公司名',
        bossName: '张老师',
        status: { status: 'success', msg: '' },
      } as never,
      greetingSend: {
        ok: true,
        type: 'ai',
        messages: messages.map((content, index) => ({
          index,
          ok: true,
          content,
          contentLength: content.length,
        })),
      },
      aiGreetingMeta: {
        usedFactIds: ['fact-agent-content'],
        claimMode: 'adjacent',
        openingPattern: '张老师-真实岗位名-hook',
        fingerprint: 'persisted-value-is-not-reused',
      },
    },
    ...overrides,
  }
}

describe('recent greeting history', () => {
  it('returns only complete successful AI greetings with identity values removed', () => {
    const successful = record({ createdAt: 200 })
    const records = [
      successful,
      record({ state: 'danger' }),
      record({ data: { ...successful.data!, greetingSend: { ok: true, type: 'custom' } } }),
      record({ data: { ...successful.data!, aiGreetingMeta: undefined } }),
      record({
        data: {
          ...successful.data!,
          greetingSend: {
            ok: true,
            type: 'ai',
            messages: [],
          },
        },
      }),
    ]

    const summaries = getRecentGreetingSummaries(records, 10)

    expect(summaries).toHaveLength(1)
    expect(summaries[0].usedFactIds).toEqual(['fact-agent-content'])
    expect(summaries[0].messages.join('')).not.toContain('张老师')
    expect(summaries[0].messages.join('')).not.toContain('真实公司名')
    expect(summaries[0].messages.join('')).not.toContain('真实岗位名')
    expect(summaries[0].messages.join('')).not.toContain('林小舟')
    expect(summaries[0].openingPattern).not.toContain('张老师')
    expect(summaries[0].openingPattern).not.toContain('真实岗位名')
    expect(summaries[0].fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(summaries[0].fingerprint).toBe(fingerprintGreeting(summaries[0].messages))
  })

  it('returns the newest bounded records first', () => {
    const records = Array.from({ length: 12 }, (_, index) =>
      record({ createdAt: index + 1, updatedAt: index + 101 }),
    )

    const summaries = getRecentGreetingSummaries(records, 3)

    expect(summaries.map((summary) => summary.sentAt)).toEqual([112, 111, 110])
  })
})
