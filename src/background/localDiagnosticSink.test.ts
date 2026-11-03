import { beforeEach, describe, expect, it, vi } from 'vitest'

const { storageGet, storageSet, fetchMock } = vi.hoisted(() => ({
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock('#imports', () => ({
  storage: {
    getItem: storageGet,
    setItem: storageSet,
  },
}))

describe('local diagnostic sink', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    storageGet.mockResolvedValue([])
    storageSet.mockResolvedValue(undefined)
    fetchMock.mockImplementation(async (_url, options) => ({
      ok: true,
      json: async () => ({ ok: true, accepted: JSON.parse(options.body).events.length }),
    }))
    vi.stubGlobal('fetch', fetchMock)
  })

  it('hashes account ids, preserves business text, and strips credentials before sending', async () => {
    const { appendLocalDiagnosticEvent } = await import('./localDiagnosticSink')
    await appendLocalDiagnosticEvent({
      stream: 'deliveries',
      event: 'delivery.finished',
      accountUid: 'real-account-id',
      data: {
        jobName: 'AI 产品经理',
        apiKey: 'secret-key',
        api_key: 'secret-key-underscore',
        'set-cookie': 'cookie-secret',
        prompt: '完整 Prompt\n包含简历和 JD',
        message: '投递成功',
      },
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const sent = body.events[0]
    expect(sent.accountUid).toMatch(/^anon-[a-f0-9]+$/)
    expect(sent.accountUid).not.toContain('real-account-id')
    expect(sent.data).toMatchObject({ jobName: 'AI 产品经理', message: '投递成功' })
    expect(sent.data.apiKey).toBeUndefined()
    expect(sent.data.api_key).toBeUndefined()
    expect(sent.data['set-cookie']).toBeUndefined()
    expect(sent.data.prompt).toBe('完整 Prompt\n包含简历和 JD')
  })

  it('keeps usage counters and ordinary key text while redacting credential-shaped URLs', async () => {
    const { appendLocalDiagnosticEvent } = await import('./localDiagnosticSink')
    await appendLocalDiagnosticEvent({
      stream: 'logs',
      event: 'runtime.ai-request',
      accountUid: 'account-a',
      data: {
        input_tokens: 1200,
        output_tokens: 340,
        reasoning_tokens: 80,
        max_output_tokens: 2048,
        keyName: 'key-business-domain',
        ordinaryText: 'token 这个词是 Prompt 的业务内容',
        requestUrl:
          'wss://example.test/chat?access_token=private-token&direction=incoming&jobId=job-1',
      },
    })

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).events[0]
    expect(sent.data).toMatchObject({
      input_tokens: 1200,
      output_tokens: 340,
      reasoning_tokens: 80,
      max_output_tokens: 2048,
      keyName: 'key-business-domain',
      ordinaryText: 'token 这个词是 Prompt 的业务内容',
      requestUrl: 'wss://example.test/chat?access_token=[已脱敏]&direction=incoming&jobId=job-1',
    })
  })

  it('splits a large resume event without replacing its business payload', async () => {
    const { appendLocalDiagnosticEvent } = await import('./localDiagnosticSink')
    const resumeMarkdown = '完整简历段落\n'.repeat(120_000)
    await appendLocalDiagnosticEvent({
      stream: 'logs',
      event: 'runtime.ai-request',
      accountUid: 'account-a',
      data: { resumeMarkdown, promptMessages: [{ role: 'user', content: '完整 Prompt' }] },
    })

    const chunks = fetchMock.mock.calls
      .flatMap(([, options]) => JSON.parse(options.body).events)
      .filter((event) => event.data?.__localLogChunk)
      .sort((left, right) => left.data.chunkIndex - right.data.chunkIndex)
    expect(chunks.length).toBeGreaterThan(1)
    const restored = JSON.parse(chunks.map((event) => event.data.payload).join(''))
    expect(restored.data.resumeMarkdown).toBe(resumeMarkdown)
    expect(restored.data.promptMessages).toEqual([{ role: 'user', content: '完整 Prompt' }])
  })

  it('allows explicitly unattributed runtime health, but never unattributed business feedback', async () => {
    const { appendLocalDiagnosticEvent } = await import('./localDiagnosticSink')
    expect(
      await appendLocalDiagnosticEvent({
        stream: 'logs',
        event: 'runtime.page-health',
        data: { accountKnown: false },
      }),
    ).toBe(true)
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).events[0]
    expect(sent).toMatchObject({ accountUid: 'unattributed', data: { accountKnown: false } })
    expect(await appendLocalDiagnosticEvent({ stream: 'feedback', event: 'greeting.sent' })).toBe(
      false,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the event in extension storage when the helper is offline', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    const { appendLocalDiagnosticEvent, localDiagnosticSink } =
      await import('./localDiagnosticSink')
    const sent = await appendLocalDiagnosticEvent({
      stream: 'logs',
      event: 'runtime.event',
      accountUid: 'account-a',
      data: { message: '开始投递' },
    })

    expect(sent).toBe(false)
    expect(storageSet).toHaveBeenCalledWith(localDiagnosticSink.queueKey, expect.any(Array))
    expect(
      storageSet.mock.calls.filter(([key]) => key === localDiagnosticSink.queueKey).at(-1)?.[1],
    ).toHaveLength(1)
  })

  it('allows bounded feedback text in the dedicated local stream', async () => {
    const { appendLocalDiagnosticEvent } = await import('./localDiagnosticSink')
    await appendLocalDiagnosticEvent({
      stream: 'feedback',
      event: 'conversation.message',
      accountUid: 'account-a',
      data: {
        direction: 'incoming',
        text: '招聘者回复',
        textLength: 5,
      },
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.events[0]).toMatchObject({
      stream: 'feedback',
      data: { direction: 'incoming', text: '招聘者回复', textLength: 5 },
    })
  })

  it('requires an explicit full receipt before deleting the durable batch', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, accepted: 0 }) })
    const { appendLocalDiagnosticEvent, localDiagnosticSink } =
      await import('./localDiagnosticSink')
    expect(
      await appendLocalDiagnosticEvent({ stream: 'logs', event: 'check', accountUid: 'a' }),
    ).toBe(false)
    expect(
      storageSet.mock.calls.filter(([key]) => key === localDiagnosticSink.queueKey).at(-1)?.[1],
    ).toHaveLength(1)
  })

  it('keeps a restored outbox when the separate health metadata cannot be read', async () => {
    const { flushLocalDiagnosticQueue, localDiagnosticSink } = await import('./localDiagnosticSink')
    const queued = {
      schemaVersion: 1,
      id: 'durable',
      at: Date.now(),
      accountUid: 'anon-12345678',
      stream: 'logs',
      event: 'check',
      data: {},
    }
    storageGet.mockImplementation(async (key) => {
      if (key === localDiagnosticSink.healthKey) throw new Error('health unavailable')
      return [queued]
    })
    await flushLocalDiagnosticQueue()
    const sent = fetchMock.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events)
    expect(sent.some((event) => event.id === 'durable')).toBe(true)
  })

  it('does not overwrite an unreadable durable queue', async () => {
    const { appendLocalDiagnosticEvent, localDiagnosticSink } =
      await import('./localDiagnosticSink')
    storageGet.mockImplementation(async (key) => {
      if (key === localDiagnosticSink.queueKey) throw new Error('storage unavailable')
      return null
    })
    await expect(
      appendLocalDiagnosticEvent({
        stream: 'feedback',
        event: 'conversation.message',
        accountUid: 'a',
        data: {
          source: 'network',
          conversationKey: 'boss:2',
          direction: 'incoming',
          messageId: 'not-yet-durable',
        },
      }),
    ).rejects.toThrow('outbox could not be read')
    expect(storageSet).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps independent background health after restart with an empty queue', async () => {
    const { flushLocalDiagnosticQueue, localDiagnosticSink } = await import('./localDiagnosticSink')
    storageGet.mockImplementation(async (key) =>
      key === localDiagnosticSink.healthKey
        ? { produced: 20, dropped: -9, accounts: ['anon-12345678', 'raw-account'] }
        : [],
    )
    await flushLocalDiagnosticQueue()
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).events
    expect(sent).toEqual([
      expect.objectContaining({
        accountUid: 'anon-12345678',
        event: 'collector.health',
        sourceSessionId: expect.any(String),
        sequence: 1,
        data: expect.objectContaining({ produced: 21, dropped: 0 }),
      }),
    ])
  })

  it('retains the full recovered backlog and drains it across bounded flushes', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockRejectedValue(new Error('offline'))
      const { appendLocalDiagnosticEvent, flushLocalDiagnosticQueue, localDiagnosticSink } =
        await import('./localDiagnosticSink')
      for (let i = 0; i < 505; i++)
        await appendLocalDiagnosticEvent({
          stream: 'logs',
          event: 'check',
          accountUid: 'a',
          data: { i },
        })
      const persisted = storageSet.mock.calls
        .filter(([key]) => key === localDiagnosticSink.healthKey)
        .at(-1)?.[1]
      expect(persisted).toMatchObject({ produced: 505, dropped: 0 })
      vi.setSystemTime(Date.now() + 16_000)
      const successfulFlushStart = fetchMock.mock.calls.length
      fetchMock.mockImplementation(async (_url, options) => ({
        ok: true,
        json: async () => ({ ok: true, accepted: JSON.parse(options.body).events.length }),
      }))
      // One wake drains at most 20 batches, but it never evicts the remainder.
      expect(await flushLocalDiagnosticQueue()).toBe(false)
      expect(
        storageSet.mock.calls.filter(([key]) => key === localDiagnosticSink.queueKey).at(-1)?.[1],
      ).toHaveLength(6)
      vi.setSystemTime(Date.now() + 16_000)
      expect(await flushLocalDiagnosticQueue()).toBe(true)
      expect(
        storageSet.mock.calls.filter(([key]) => key === localDiagnosticSink.queueKey).at(-1)?.[1],
      ).toEqual([])
      const sent = fetchMock.mock.calls
        .slice(successfulFlushStart)
        .flatMap(([, options]) => JSON.parse(options.body).events)
      expect(sent).toHaveLength(506)
      expect(sent.find((event) => event.event === 'collector.health')).toMatchObject({
        event: 'collector.health',
        sequence: 506,
        data: { dropped: 0 },
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
