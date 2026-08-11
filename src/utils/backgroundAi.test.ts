import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runConfiguredAiTask } from './backgroundAi'

/**
 * 生产环境使用的模型配置形状。此前这里造的是页面侧旧模型对象，再经一层
 * legacyOpenaiModel 适配——而那条入口在生产中没有任何调用方。
 */
function createOpenaiModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-model-id',
    name: 'Test Model',
    protocol: 'openai-chat-completions',
    url: 'https://ai.example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    reasoningEffort: '',
    timeoutSeconds: 180,
    responsesBackground: 'off',
    generation: {
      temperature: 0.2,
      topP: 1,
      presencePenalty: 0,
      frequencyPenalty: 0,
    },
    ...overrides,
  } as any
}

function createResponsesModel(url = 'https://ai.example.test/v1/responses') {
  return createOpenaiModel({
    protocol: 'openai-responses',
    url,
    model: 'test-reasoning-model',
    reasoningEffort: 'max',
    timeoutSeconds: 900,
    responsesBackground: 'auto',
  })
}

function createResponse(
  status: number,
  body: unknown,
  statusText = 'Bad Request',
  headers: Record<string, string> = {},
) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...headers },
    status,
    statusText,
  })
}

function createSuccessResponse(content = '{"passed":true}') {
  return createResponse(
    200,
    {
      choices: [
        {
          message: {
            content,
            reasoning_content: 'reasoning\ncontent',
          },
        },
      ],
      usage: {
        completion_tokens: 2,
        prompt_tokens: 3,
        total_tokens: 5,
      },
    },
    'OK',
  )
}

function createSseResponse(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n'), {
    headers: { 'Content-Type': 'text/event-stream' },
    status: 200,
    statusText: 'OK',
  })
}

function createChunkedJsonResponse(status: number, chunks: string[], statusText: string) {
  const encoder = new TextEncoder()
  let pullCount = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pullCount >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[pullCount]))
      pullCount += 1
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    response: new Response(body, {
      headers: { 'Content-Type': 'application/json' },
      status,
      statusText,
    }),
    streamState: {
      get cancelled() {
        return cancelled
      },
      get pullCount() {
        return pullCount
      },
    },
  }
}

describe('background AI requests', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([400, 401, 403])('still gives HTTP %s the full three attempts', async (status) => {
    // 这三个状态过去被当成「确定性错误」直接放弃。现在不按状态码区分：上层遇到 AI 失败
    // 会暂停整轮投递，判定失败前一律给满三次，规则统一才不会在下一次改动里又漂掉。
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(
      createResponse(status, { error: { message: 'openai_error', type: 'invalid_request' } }),
    )

    const promise = runConfiguredAiTask({
      data: { jobName: 'AI产品经理' },
      json: true,
      model: createOpenaiModel(),
      template: '判断 {{ jobName }}',
      task: 'aiFiltering',
    })
    // 断言要在推时钟之前挂上：重试跑完后 promise 就 reject 了，这时还没有 handler
    // 的话 Node 会把它记成未处理拒绝，测试通过但门禁是红的。
    const rejection = expect(promise).rejects.toThrow(`${status}`)
    await vi.runAllTimersAsync()
    await rejection
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each([408, 500, 503])(
    'retries transient HTTP %s responses after a short backoff',
    async (status) => {
      const fetchMock = vi.mocked(fetch)
      fetchMock
        .mockResolvedValueOnce(createResponse(status, { error: { message: 'temporary' } }))
        .mockResolvedValueOnce(createSuccessResponse())

      const promise = runConfiguredAiTask({
        data: { jobName: 'AI产品经理' },
        json: true,
        model: createOpenaiModel(),
        template: '判断 {{ jobName }}',
        task: 'aiFiltering',
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.runAllTimersAsync()
      await expect(promise).resolves.toMatchObject({ content: '{"passed":true}' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  it('honors a bounded Retry-After delay longer than one second for HTTP 429', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(
        createResponse(429, { error: { message: 'rate_limited' } }, 'Too Many Requests', {
          'Retry-After': '5',
        }),
      )
      .mockResolvedValueOnce(createSuccessResponse())

    const promise = runConfiguredAiTask({
      data: { jobName: 'AI产品经理' },
      json: true,
      model: createOpenaiModel(),
      template: '判断 {{ jobName }}',
      task: 'aiFiltering',
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).resolves.toMatchObject({ content: '{"passed":true}' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries an ambiguous network failure, which for inference costs only tokens', async () => {
    // 这里原本不重试，理由是 POST 非幂等：fetch 抛错时无法确定服务端是否已经处理，
    // 重试可能让同一件事做两次。那个顾虑对有副作用的接口成立，但这条路径上的三个任务
    // ——匹配、招呼语生成、简历解析——都是纯推理，重复的代价只是 token。
    // 而不重试的代价已经变大：AI 失败会暂停整轮投递，一次网络抖动就能让投递停下来。
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockRejectedValue(new TypeError('network unavailable'))

    const promise = runConfiguredAiTask({
      data: { jobName: 'AI产品经理' },
      json: true,
      model: createOpenaiModel(),
      template: '判断 {{ jobName }}',
      task: 'aiFiltering',
    })
    const rejection = expect(promise).rejects.toThrow(/网络失败/)
    await vi.runAllTimersAsync()
    await rejection
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('uses the configured endpoint with a fixed header set and no ambient credentials', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(createSuccessResponse())

    await runConfiguredAiTask({
      data: { jobName: 'AI产品经理' },
      json: true,
      model: createOpenaiModel(),
      template: '判断 {{ jobName }}',
      task: 'aiFiltering',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://ai.example.test/v1/chat/completions',
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        },
      }),
    )
  })

  it('runs max-effort Responses requests in background mode and polls to completion', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(
        createResponse(200, { id: 'resp_123', output: [], status: 'queued' }, 'OK'),
      )
      .mockResolvedValueOnce(
        createResponse(200, { id: 'resp_123', output: [], status: 'in_progress' }, 'OK'),
      )
      .mockResolvedValueOnce(
        createResponse(
          200,
          {
            id: 'resp_123',
            output: [
              {
                content: [{ text: '{"matchPercent":80}', type: 'output_text' }],
                type: 'message',
              },
            ],
            status: 'completed',
            usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
          },
          'OK',
        ),
      )

    const promise = runConfiguredAiTask({
      data: { jobName: 'AI产品经理' },
      json: true,
      model: createResponsesModel('https://api.openai.com/v1/responses'),
      template: '判断 {{ jobName }}',
      task: 'resumeExtraction',
    })

    await vi.advanceTimersByTimeAsync(4000)
    await expect(promise).resolves.toMatchObject({
      content: '{"matchPercent":80}',
      diagnostics: {
        background: {
          pollCount: 2,
          responseId: 'resp_123',
          status: 'completed',
        },
        maxRetries: 0,
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const [createUrl, createInit] = fetchMock.mock.calls[0]
    expect(createUrl).toBe('https://api.openai.com/v1/responses')
    expect(JSON.parse(String(createInit?.body))).toMatchObject({
      background: true,
      model: 'test-reasoning-model',
      reasoning: { effort: 'max' },
    })
    expect(fetchMock.mock.calls[1]).toEqual([
      'https://api.openai.com/v1/responses/resp_123',
      expect.objectContaining({ method: 'GET' }),
    ])
  })

  it('streams max reasoning effort without background mode on compatible endpoints', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(
      createSseResponse([
        { type: 'response.output_text.delta', delta: '{"matchPercent":80}' },
        {
          type: 'response.completed',
          response: {
            id: 'resp_compatible',
            output: [
              {
                content: [{ text: '{"matchPercent":80}', type: 'output_text' }],
                type: 'message',
              },
            ],
            status: 'completed',
            usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
          },
        },
      ]),
    )

    await expect(
      runConfiguredAiTask({
        data: { jobName: 'AI产品经理' },
        json: true,
        model: createResponsesModel(),
        template: '判断 {{ jobName }}',
        // 这条验的是兼容端点上的 SSE 读取；传输不再由强度决定，用慢任务显式触发流式。
        task: 'resumeExtraction',
      }),
    ).resolves.toMatchObject({
      content: '{"matchPercent":80}',
      diagnostics: { maxRetries: 0 },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [createUrl, createInit] = fetchMock.mock.calls[0]
    expect(createUrl).toBe('https://ai.example.test/v1/responses')
    const body = JSON.parse(String(createInit?.body))
    expect(body).toMatchObject({
      model: 'test-reasoning-model',
      reasoning: { effort: 'max' },
      stream: true,
    })
    expect(body).not.toHaveProperty('background')
  })

  it('does not duplicate a max-effort background task when creation fails', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(createResponse(503, { error: { message: 'temporary' } }))

    await expect(
      runConfiguredAiTask({
        data: { jobName: 'AI产品经理' },
        json: true,
        model: createResponsesModel('https://api.openai.com/v1/responses'),
        template: '判断 {{ jobName }}',
        task: 'resumeExtraction',
      }),
    ).rejects.toMatchObject({ diagnostics: { maxRetries: 0 } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries transient background polling failures without recreating the task', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(
        createResponse(200, { id: 'resp_transient', output: [], status: 'queued' }, 'OK'),
      )
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockResolvedValueOnce(
        createResponse(429, { error: { message: 'rate_limited' } }, 'Too Many Requests', {
          'Retry-After': '5',
        }),
      )
      .mockResolvedValueOnce(
        createResponse(
          200,
          {
            id: 'resp_transient',
            output: [
              {
                content: [{ text: '{"matchPercent":82}', type: 'output_text' }],
                type: 'message',
              },
            ],
            status: 'completed',
          },
          'OK',
        ),
      )

    const promise = runConfiguredAiTask({
      data: { jobName: 'AI产品经理' },
      json: true,
      model: createResponsesModel('https://api.openai.com/v1/responses'),
      template: '判断 {{ jobName }}',
      task: 'resumeExtraction',
    })

    await vi.runAllTimersAsync()
    await expect(promise).resolves.toMatchObject({
      content: '{"matchPercent":82}',
      diagnostics: { background: { pollCount: 3, status: 'completed' }, maxRetries: 0 },
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(fetchMock.mock.calls.slice(1).every(([, init]) => init?.method === 'GET')).toBe(true)
  })

  it('does not retry a deterministic background polling failure', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(
        createResponse(200, { id: 'resp_denied', output: [], status: 'queued' }, 'OK'),
      )
      .mockResolvedValueOnce(createResponse(401, { error: { message: 'unauthorized' } }))

    const promise = runConfiguredAiTask({
      data: { jobName: 'AI产品经理' },
      json: true,
      model: createResponsesModel('https://api.openai.com/v1/responses'),
      template: '判断 {{ jobName }}',
      task: 'resumeExtraction',
    })
    const rejection = expect(promise).rejects.toThrow('后台AI任务状态查询失败，状态码: 401')

    await vi.advanceTimersByTimeAsync(2000)
    await rejection
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects redirected provider responses', async () => {
    const fetchMock = vi.mocked(fetch)
    const response = createSuccessResponse()
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: 'https://redirected.example.test/v1/chat/completions' },
    })
    fetchMock.mockResolvedValue(response)

    await expect(
      runConfiguredAiTask({
        data: { jobName: 'AI产品经理' },
        json: true,
        model: createOpenaiModel(),
        template: '判断 {{ jobName }}',
        task: 'aiFiltering',
      }),
    ).rejects.toThrow('AI响应不允许重定向')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized request bodies before fetch', async () => {
    const fetchMock = vi.mocked(fetch)

    await expect(
      runConfiguredAiTask({
        data: {},
        json: true,
        model: createOpenaiModel(),
        template: 'x'.repeat(1024 * 1024 + 1),
        task: 'aiFiltering',
      }),
    ).rejects.toThrow('AI请求体过大')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects non-JSON provider responses without retrying', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(
      createResponse(200, '<html>unexpected</html>', 'OK', { 'Content-Type': 'text/html' }),
    )

    await expect(
      runConfiguredAiTask({
        data: { jobName: 'AI产品经理' },
        json: true,
        model: createOpenaiModel(),
        template: '判断 {{ jobName }}',
        task: 'aiFiltering',
      }),
    ).rejects.toThrow('AI响应 Content-Type 必须是 application/json')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops reading an oversized successful provider response stream', async () => {
    const fetchMock = vi.mocked(fetch)
    const chunks = [
      '{"choices":[{"message":{"content":"',
      ...Array.from({ length: 40 }, () => 'x'.repeat(64 * 1024)),
      '"}}]}',
    ]
    const { response, streamState } = createChunkedJsonResponse(200, chunks, 'OK')
    fetchMock.mockResolvedValue(response)

    await expect(
      runConfiguredAiTask({
        data: { jobName: 'AI产品经理' },
        json: true,
        model: createOpenaiModel(),
        template: '判断 {{ jobName }}',
        task: 'aiFiltering',
      }),
    ).rejects.toThrow('AI响应体过大')

    expect(streamState.cancelled).toBe(true)
    expect(streamState.pullCount).toBeLessThan(chunks.length)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops reading an oversized error response stream without retrying it', async () => {
    const fetchMock = vi.mocked(fetch)
    const providerSecret = 'provider-echoed-super-secret'
    const chunks = [
      `{"error":{"message":"${providerSecret}`,
      ...Array.from({ length: 40 }, () => 'x'.repeat(64 * 1024)),
      '"}}',
    ]
    const { response, streamState } = createChunkedJsonResponse(400, chunks, 'Bad Request')
    fetchMock.mockResolvedValue(response)

    const result = runConfiguredAiTask({
      data: { jobName: 'AI产品经理' },
      json: true,
      model: createOpenaiModel(),
      template: '判断 {{ jobName }}',
      task: 'aiFiltering',
    })

    await expect(result).rejects.not.toThrow(providerSecret)
    await expect(result).rejects.toThrow('AI响应体过大')
    expect(streamState.cancelled).toBe(true)
    expect(streamState.pullCount).toBeLessThan(chunks.length)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
