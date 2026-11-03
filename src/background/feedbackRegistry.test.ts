import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LocalDiagnosticEvent } from './localDiagnosticSink'

const { saved, getItem, setItem } = vi.hoisted(() => {
  const saved = new Map<string, unknown>()
  return {
    saved,
    getItem: vi.fn(async (key: string) => saved.get(key)),
    setItem: vi.fn(async (key: string, value: unknown) => {
      saved.set(key, structuredClone(value))
    }),
  }
})
vi.mock('#imports', () => ({ storage: { getItem, setItem } }))

const baseTime = 1793000000000
function event(
  name: string,
  data: Record<string, unknown>,
  accountUid = 'a',
  at = baseTime,
): LocalDiagnosticEvent {
  return {
    schemaVersion: 1,
    id: Math.random().toString(),
    stream: 'feedback',
    event: name,
    accountUid,
    at,
    data,
  }
}
const greeting = () =>
  event('greeting.sent', {
    conversationKey: 'boss:2',
    greetingId: 'g1',
    jobId: 'j1',
    promptFingerprint: 'sha256:sample',
  })
const reply = (overrides = {}, account = 'a') =>
  event(
    'conversation.message',
    {
      source: 'network',
      conversationKey: 'boss:2',
      messageId: 'm1',
      direction: 'incoming',
      messageType: 'text',
      messageAt: baseTime + 1000,
      replyEligible: true,
      ...overrides,
    },
    account,
  )

describe('feedback attribution', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    saved.clear()
    getItem.mockImplementation(async (key) => saved.get(key))
  })
  it('associates a platform reply to the first sent segment and its prompt across restart', async () => {
    let registry = await import('./feedbackRegistry')
    await registry.enrichFeedback(greeting())
    await registry.enrichFeedback({ ...greeting(), at: baseTime + 500 })
    vi.resetModules()
    registry = await import('./feedbackRegistry')
    const enriched = await registry.enrichFeedback(reply())
    expect(enriched?.data).toMatchObject({
      greetingId: 'g1',
      jobId: 'j1',
      promptFingerprint: 'sha256:sample',
      firstSentAt: baseTime,
      replyEligible: true,
      associationStatus: 'matched',
    })
    vi.resetModules()
    expect(await (await import('./feedbackRegistry')).enrichFeedback(reply())).toBeNull()
  })
  it('matches a DOM URL alias to a network UID alias from the same greeting', async () => {
    const { enrichFeedback } = await import('./feedbackRegistry')
    await enrichFeedback(
      event('greeting.sent', {
        conversationKey: 'boss:20002',
        conversationKeys: ['boss:20002', 'boss:encrypted-1'],
        greetingId: 'g-alias',
      }),
    )
    const enriched = await enrichFeedback(
      reply({ conversationKey: 'boss:encrypted-1', messageId: 'alias-reply' }),
    )
    expect(enriched?.data).toMatchObject({
      greetingId: 'g-alias',
      associationStatus: 'matched',
      replyEligible: true,
    })
  })
  it('associates live platform messages when the platform timestamp lags local send time', async () => {
    const { enrichFeedback } = await import('./feedbackRegistry')
    await enrichFeedback(greeting())
    const enriched = await enrichFeedback(
      reply({
        messageAt: baseTime - 30_000,
        observedAt: baseTime + 2_000,
        messageId: 'clock-skew-reply',
      }),
    )
    expect(enriched?.data).toMatchObject({
      greetingId: 'g1',
      associationStatus: 'matched',
      replyEligible: true,
      platformClockSkewMs: -30_000,
    })
  })
  it('keeps account, platform time, direction, system and DOM boundaries', async () => {
    const { enrichFeedback } = await import('./feedbackRegistry')
    await enrichFeedback(greeting())
    for (const [input, eligible] of [
      [reply({}, 'b'), false],
      [reply({ messageAt: baseTime - 3 * 60_000 }), false],
      [reply({ messageAt: baseTime - 3 * 60_000, messageId: 'too-old' }), false],
      [reply({ direction: 'outgoing' }), false],
      [reply({ messageType: 'system' }), false],
      [reply({ source: 'dom', observation: 'live' }), true],
      [reply({ messageAt: undefined }), false],
      [reply({ observation: 'history' }), false],
      [reply({ observedAt: baseTime - 1, messageId: 'observed-before-send' }), false],
    ] as const) {
      input.data.messageId = Math.random().toString()
      expect((await enrichFeedback(input))?.data.replyEligible).toBe(eligible)
    }
  })
  it('retries registry initialization after a failed dedup-index read', async () => {
    const { enrichFeedback } = await import('./feedbackRegistry')
    let failed = false
    getItem.mockImplementation(async (key) => {
      if (key.endsWith('-seen') && !failed) {
        failed = true
        throw new Error('transient')
      }
      return saved.get(key)
    })
    await expect(enrichFeedback(greeting())).rejects.toThrow('transient')
    await enrichFeedback(greeting())
    expect((await enrichFeedback(reply()))?.data.replyEligible).toBe(true)
  })
})
