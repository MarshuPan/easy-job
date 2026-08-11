import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiModelConfig } from '@/config/types'

import {
  runConfiguredAiTask,
  testConfiguredAiModel,
  unsupportedModelSettings,
} from './backgroundAi'

function configuredModel(overrides: Partial<AiModelConfig> = {}): AiModelConfig {
  return {
    id: 'configured-model',
    name: '配置模型',
    protocol: 'openai-chat-completions',
    url: 'https://ai.example.test/custom-endpoint',
    apiKey: 'test-key',
    model: 'test-model',
    reasoningEffort: 'max',
    timeoutSeconds: 180,
    responsesBackground: 'off',
    generation: {
      temperature: 0.2,
      topP: 0.9,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
    },
    ...overrides,
  }
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sseResponse(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('configured AI protocols', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes Chat Completions by protocol instead of URL suffix', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
    )

    const result = await runConfiguredAiTask({
      model: configuredModel({ url: 'http://127.0.0.1:8787/not-chat-completions' }),
      template: '返回 JSON',
      data: {},
      json: true,
      maxOutputTokens: 1234,
    })

    expect(result.content).toBe('{"ok":true}')
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8787/not-chat-completions')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      max_completion_tokens: 1234,
      messages: [{ role: 'user', content: '返回 JSON' }],
      reasoning_effort: 'max',
      response_format: { type: 'json_object' },
    })
  })

  it('emits bounded start and success diagnostics without changing the request result', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
      }),
    )
    const onDiagnostic = vi.fn()

    await expect(
      runConfiguredAiTask({
        model: configuredModel(),
        template: '返回 JSON',
        data: {},
        json: true,
        onDiagnostic,
        task: 'resumeExtraction',
      }),
    ).resolves.toMatchObject({ content: '{"ok":true}' })

    expect(onDiagnostic).toHaveBeenCalledTimes(2)
    expect(onDiagnostic.mock.calls.map(([item]) => item.phase)).toEqual(['started', 'succeeded'])
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({
      model: 'test-model',
      protocol: 'openai-chat-completions',
      requestMode: 'sync',
      task: 'resumeExtraction',
    })
    expect(onDiagnostic.mock.calls[1]![0].diagnostics.attempts).toMatchObject([
      { ok: true, status: 200 },
    ])
  })

  it('ignores diagnostic persistence failures and preserves the model result', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
      }),
    )

    await expect(
      runConfiguredAiTask({
        model: configuredModel(),
        template: '返回 JSON',
        data: {},
        json: true,
        onDiagnostic: vi.fn(async () => {
          throw new Error('runtime log storage unavailable')
        }),
      }),
    ).resolves.toMatchObject({ content: '{"ok":true}' })
  })

  it('routes Responses by protocol even when the URL has no responses suffix', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      }),
    )
    const model = configuredModel({
      protocol: 'openai-responses',
      url: 'https://compatible.example.test/generate',
      responsesBackground: 'off',
    })

    await expect(
      runConfiguredAiTask({ model, template: '返回 JSON', data: {}, json: true }),
    ).resolves.toMatchObject({ content: '{"ok":true}' })

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body).toMatchObject({
      input: [{ role: 'user', content: '返回 JSON' }],
      reasoning: { effort: 'max' },
      text: { format: { type: 'json_object' } },
    })
    expect(body).not.toHaveProperty('messages')
    expect(body).not.toHaveProperty('background')
  })

  it.each([
    ['openai-chat-completions', { choices: [{ message: { content: '{"ok":true}' } }] }],
    ['openai-responses', { output_text: '{"ok":true}' }],
    ['anthropic-messages', { content: [{ type: 'text', text: '{"ok":true}' }] }],
  ] as const)('applies the resume extraction timeout to %s', async (protocol, responseBody) => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(responseBody))
    const result = await runConfiguredAiTask({
      model: configuredModel({
        protocol,
        reasoningEffort: '',
        responsesBackground: 'off',
        timeoutSeconds: 180,
      }),
      template: '返回 JSON',
      data: {},
      json: true,
      task: 'resumeExtraction',
    })

    expect(result.diagnostics).toMatchObject({
      timeoutSeconds: 600,
    })
  })

  it('removes unsupported validation keywords from OpenAI-compatible schemas', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        output: [{ content: [{ type: 'output_text', text: '{"tags":[],"score":0}' }] }],
      }),
    )
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        tags: {
          type: 'array',
          uniqueItems: true,
          maxItems: 2,
          items: { type: 'string', minLength: 1, maxLength: 20, pattern: '^[a-z]+$' },
        },
        score: { type: 'number', minimum: 0, maximum: 100 },
      },
      required: ['tags', 'score'],
    }

    await runConfiguredAiTask({
      model: configuredModel({
        protocol: 'openai-responses',
        responsesBackground: 'off',
      }),
      template: '返回 JSON',
      data: {},
      json: true,
      jsonSchema: schema,
    })

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body.text.format.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
        score: { type: 'number' },
      },
      required: ['tags', 'score'],
    })
    expect(schema.properties.tags.uniqueItems).toBe(true)
  })

  it('uses SSE for max-effort Responses requests on custom endpoints in auto mode', async () => {
    vi.mocked(fetch).mockResolvedValue(
      sseResponse([
        { type: 'response.output_text.delta', delta: '{"ok":' },
        { type: 'response.output_text.delta', delta: 'true}' },
        {
          type: 'response.completed',
          response: {
            output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }],
          },
        },
      ]),
    )

    const result = await runConfiguredAiTask({
      model: configuredModel({
        protocol: 'openai-responses',
        responsesBackground: 'auto',
        url: 'https://compatible.example.test/v1/responses',
      }),
      template: '返回 JSON',
      data: {},
      json: true,
      task: 'resumeExtraction',
    })

    expect(result).toMatchObject({
      content: '{"ok":true}',
      diagnostics: {
        endpointType: 'responses',
        maxRetries: 0,
        attempts: [{ ok: true, status: 200 }],
        timeoutSeconds: 600,
      },
    })
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body.stream).toBe(true)
    expect(body.background).toBeUndefined()
  })

  it('streams a known-slow task even when the effort label is not max', async () => {
    // 传输方式原来只认 effort === 'max'。effort=high 的简历解析实测单次要 3 分钟以上，
    // 走同步请求会被网关掐断返回 502，重试再花几分钟——真机上 7 分 22 秒里有 4 分 18 秒是白等的。
    vi.mocked(fetch).mockResolvedValue(
      sseResponse([
        {
          type: 'response.completed',
          response: { status: 'completed', output_text: '{"ok":true}' },
        },
      ]),
    )

    await runConfiguredAiTask({
      model: configuredModel({
        protocol: 'openai-responses',
        responsesBackground: 'auto',
        reasoningEffort: 'high',
        url: 'https://compatible.example.test/v1/responses',
      }),
      template: '返回 JSON',
      data: {},
      json: true,
      task: 'resumeExtraction',
    })

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body.stream).toBe(true)
  })

  it('still uses a plain sync request for short tasks at the same effort', async () => {
    // 只有已知会跑很久的任务才改传输方式；匹配和招呼语是秒级的，不需要为它们付流式的复杂度。
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ output_text: '{"ok":true}' }))

    await runConfiguredAiTask({
      model: configuredModel({
        protocol: 'openai-responses',
        responsesBackground: 'auto',
        reasoningEffort: 'high',
        url: 'https://compatible.example.test/v1/responses',
      }),
      template: '返回 JSON',
      data: {},
      json: true,
      task: 'aiFiltering',
    })

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body.stream).toBeUndefined()
    expect(body.background).toBeUndefined()
  })

  it('falls back to SSE when a custom Responses endpoint rejects background mode', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { type: 'upstream_error' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        sseResponse([
          { type: 'response.output_text.delta', delta: '{"ok":true}' },
          {
            type: 'response.completed',
            response: {
              output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }],
            },
          },
        ]),
      )
    const onDiagnostic = vi.fn()

    await expect(
      runConfiguredAiTask({
        model: configuredModel({
          protocol: 'openai-responses',
          responsesBackground: 'on',
          url: 'https://compatible.example.test/v1/responses',
        }),
        template: '返回 JSON',
        data: {},
        json: true,
        onDiagnostic,
        task: 'resumeExtraction',
      }),
    ).resolves.toMatchObject({
      content: '{"ok":true}',
      diagnostics: {
        attempts: [
          { attempt: 1, ok: false, status: 400 },
          { attempt: 2, ok: true, status: 200 },
        ],
      },
    })

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    const secondBody = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))
    expect(firstBody).toMatchObject({ background: true })
    expect(firstBody.stream).toBeUndefined()
    expect(secondBody).toMatchObject({ stream: true })
    expect(secondBody.background).toBeUndefined()
    expect(onDiagnostic.mock.calls.map(([event]) => [event.phase, event.requestMode])).toEqual([
      ['started', 'background'],
      ['progress', 'stream'],
      ['succeeded', 'stream'],
    ])
  })

  it('reports an aborted HTTP 200 stream as a stream timeout', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        )
      },
    })
    vi.mocked(fetch).mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )

    await expect(
      runConfiguredAiTask({
        model: configuredModel({
          protocol: 'openai-responses',
          responsesBackground: 'auto',
          url: 'https://compatible.example.test/v1/responses',
        }),
        template: '返回 JSON',
        data: {},
        json: true,
        task: 'resumeExtraction',
      }),
    ).rejects.toThrow('AI流式响应读取超时')
  })

  it('surfaces bounded provider details from a Responses failure event', async () => {
    vi.mocked(fetch).mockResolvedValue(
      sseResponse([
        {
          type: 'response.failed',
          response: {
            error: {
              code: 'server_error',
              message: `provider task failed\n${'x'.repeat(300)}`,
            },
          },
        },
      ]),
    )

    const request = runConfiguredAiTask({
      model: configuredModel({
        protocol: 'openai-responses',
        responsesBackground: 'auto',
        url: 'https://compatible.example.test/v1/responses',
      }),
      template: '返回 JSON',
      data: {},
      json: true,
      // 这条用例验的是 SSE 的错误处理，不是传输选择；显式声明慢任务才会走流式。
      task: 'resumeExtraction',
    })

    await expect(request).rejects.toThrow(
      /^AI流式响应返回失败事件：server_error: provider task failed x{219}$/,
    )
  })

  it('does not retain large reasoning events while reading a Responses stream', async () => {
    vi.mocked(fetch).mockResolvedValue(
      sseResponse([
        {
          type: 'response.reasoning_summary_text.delta',
          delta: 'x'.repeat(1024 * 1024 + 1),
        },
        { type: 'response.output_text.delta', delta: '{"ok":true}' },
        {
          type: 'response.completed',
          response: {
            output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }],
          },
        },
      ]),
    )

    await expect(
      runConfiguredAiTask({
        model: configuredModel({
          protocol: 'openai-responses',
          responsesBackground: 'auto',
          url: 'https://compatible.example.test/v1/responses',
        }),
        template: '返回 JSON',
        data: {},
        json: true,
        // 验的是流式读取时的内存占用，不是传输选择；显式声明慢任务才会走流式。
        task: 'resumeExtraction',
      }),
    ).resolves.toMatchObject({ content: '{"ok":true}' })
  })

  it.each([
    ['openai-responses', 'https://ai.example.test/v1', 'https://ai.example.test/v1/responses'],
    [
      'openai-chat-completions',
      'https://ai.example.test/v1/',
      'https://ai.example.test/v1/chat/completions',
    ],
    ['anthropic-messages', 'https://ai.example.test', 'https://ai.example.test/v1/messages'],
  ] as const)('expands a standard base URL for %s', async (protocol, url, expectedUrl) => {
    vi.mocked(fetch).mockResolvedValue(
      protocol === 'openai-responses'
        ? jsonResponse({ output_text: '{"ok":true}' })
        : protocol === 'anthropic-messages'
          ? jsonResponse({ content: [{ type: 'text', text: '{"ok":true}' }] })
          : jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }),
    )

    await runConfiguredAiTask({
      model: configuredModel({ protocol, url, responsesBackground: 'off' }),
      template: '返回 JSON',
      data: {},
    })

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(expectedUrl)
  })

  it('uses Anthropic Messages headers, system field and adaptive thinking for a word effort', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        content: [{ type: 'text', text: '{"ok":true}' }],
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
    )
    const model = configuredModel({
      protocol: 'anthropic-messages',
      url: 'https://api.anthropic.test/v1/messages',
      model: 'claude-test',
    })

    const result = await runConfiguredAiTask({
      model,
      template: [
        { role: 'system', content: '固定系统契约' },
        { role: 'user', content: '返回 JSON' },
      ],
      data: {},
      json: true,
      jsonSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
    })

    expect(result).toMatchObject({
      content: '{"ok":true}',
      diagnostics: { endpointType: 'anthropicMessages' },
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    })
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'test-key',
    })
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      // 这个协议的 max_tokens 必填，没法表达「不设上限」，只能给一个足够大的值。
      max_tokens: 64_000,
      messages: [{ role: 'user', content: '返回 JSON' }],
      model: 'claude-test',
      // Messages 协议没有 response_format，结构化输出只能走工具调用。
      tools: [expect.objectContaining({ name: 'agent_delivery_result' })],
      system: '固定系统契约',
      thinking: { type: 'adaptive' },
    })
    expect(body).not.toHaveProperty('presence_penalty')
    expect(body).not.toHaveProperty('frequency_penalty')
  })

  it.each([
    ['openai-chat-completions', { choices: [{ message: { content: '{"ok":true}' } }] }],
    ['openai-responses', { output_text: '{"ok":true}' }],
    ['anthropic-messages', { content: [{ type: 'text', text: '{"ok":true}' }] }],
  ] as const)(
    'keeps system, user prompt and input data separate for %s',
    async (protocol, response) => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(response))
      const template = [
        { role: 'system' as const, content: '固定系统契约' },
        { role: 'user' as const, content: '用户写作 Prompt' },
        { role: 'user' as const, content: '本次输入数据' },
      ]

      await runConfiguredAiTask({
        model: configuredModel({ protocol, reasoningEffort: '', responsesBackground: 'off' }),
        template,
        data: {},
        json: true,
      })

      const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
      if (protocol === 'openai-responses') {
        expect(body.input).toEqual(template)
      } else if (protocol === 'openai-chat-completions') {
        expect(body.messages).toEqual(template)
      } else {
        expect(body.system).toBe('固定系统契约')
        expect(body.messages).toEqual(template.slice(1))
      }
    },
  )

  it('omits authorization for a user-selected endpoint with an empty key', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    await runConfiguredAiTask({
      model: configuredModel({ apiKey: '' }),
      template: 'ping',
      data: {},
    })
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({
      'Content-Type': 'application/json',
    })
  })

  it('tests connectivity through the same configured protocol path', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }),
    )
    await expect(testConfiguredAiModel(configuredModel())).resolves.toMatchObject({
      ok: true,
      model: 'test-model',
      protocol: 'openai-chat-completions',
    })
  })
})

describe('output token budget', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('omits the cap when a task declares no output limit', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ output_text: '{"ok":true}' }))

    await runConfiguredAiTask({
      model: configuredModel({ protocol: 'openai-responses' }),
      template: '返回 JSON',
      data: {},
      json: true,
      maxOutputTokens: null,
    })

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect('max_output_tokens' in body).toBe(false)
  })

  it('still sends a large max_tokens to Anthropic, which requires the field', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ content: [{ type: 'text', text: '{"ok":true}' }] }),
    )

    await runConfiguredAiTask({
      model: configuredModel({ protocol: 'anthropic-messages' }),
      template: '返回 JSON',
      data: {},
      json: true,
      maxOutputTokens: null,
    })

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body.max_tokens).toBeGreaterThan(9768)
  })

  it('declares no output ceiling by default', async () => {
    // 推理 token 计入输出上限。写死 4096 时，一次高强度的匹配光推理就可能顶满，
    // 响应被截断成非法 JSON，整个岗位失败——每天上百次。
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ output_text: '{"ok":true}' }))

    await runConfiguredAiTask({
      model: configuredModel({ protocol: 'openai-responses' }),
      template: '返回 JSON',
      data: {},
      json: true,
    })

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect('max_output_tokens' in body).toBe(false)
  })
})

describe('reasoning token accounting', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('separates reasoning tokens from the emitted output', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        output_text: '{"ok":true}',
        usage: {
          input_tokens: 6865,
          output_tokens: 9768,
          output_tokens_details: { reasoning_tokens: 7200 },
          total_tokens: 16_633,
        },
      }),
    )

    const result = await runConfiguredAiTask({
      model: configuredModel({ protocol: 'openai-responses' }),
      template: '返回 JSON',
      data: {},
      json: true,
    })

    expect(result.usage).toMatchObject({ output_tokens: 9768, reasoning_tokens: 7200 })
  })
})

describe('reasoning effort no longer decides transport', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['high', 'max', 'minimal', ''])(
    'keeps a per-job call on the sync path at effort %s',
    async (reasoningEffort) => {
      // 匹配和招呼语是秒级请求，每个岗位都要跑一次。流式会把传输层的重试降到 0，
      // 让它们为了一个「想多深」的设置失去重试，是拿一个问题换另一个问题。
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ output_text: '{"ok":true}' }))

      await runConfiguredAiTask({
        model: configuredModel({
          protocol: 'openai-responses',
          responsesBackground: 'auto',
          reasoningEffort,
          url: 'https://compatible.example.test/v1/responses',
        }),
        template: '返回 JSON',
        data: {},
        json: true,
        task: 'aiGreeting',
      })

      const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
      expect(body.stream).toBeUndefined()
      expect(body.background).toBeUndefined()
      // 强度本身照常传给模型——它只是不再决定请求怎么发。
      expect(body.reasoning?.effort).toBe(reasoningEffort || undefined)
    },
  )

  it('still streams the known-slow task at any effort', async () => {
    vi.mocked(fetch).mockResolvedValue(
      sseResponse([
        {
          type: 'response.completed',
          response: { status: 'completed', output_text: '{"ok":true}' },
        },
      ]),
    )

    await runConfiguredAiTask({
      model: configuredModel({
        protocol: 'openai-responses',
        responsesBackground: 'auto',
        reasoningEffort: 'low',
        url: 'https://compatible.example.test/v1/responses',
      }),
      template: '返回 JSON',
      data: {},
      json: true,
      task: 'resumeExtraction',
    })

    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).stream).toBe(true)
  })
})

describe('settings the selected protocol cannot carry', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the penalties that only chat-completions accepts', () => {
    // 过去这两项对 responses 和 anthropic 是静默丢弃的：用户配了，请求里没有，
    // 也没有任何地方说明。列出来至少让「配了不生效」当场可见。
    const generation = {
      temperature: 0.2,
      topP: 0.9,
      presencePenalty: 0.5,
      frequencyPenalty: 0.5,
    }

    expect(
      unsupportedModelSettings(configuredModel({ protocol: 'openai-responses', generation })),
    ).toEqual(['presencePenalty', 'frequencyPenalty'])
    expect(
      unsupportedModelSettings(
        configuredModel({ protocol: 'openai-chat-completions', generation }),
      ),
    ).toEqual([])
  })

  it('says when an effort word cannot be turned into a thinking budget', () => {
    const anthropic = configuredModel({
      protocol: 'anthropic-messages',
      reasoningEffort: 'ultra-think',
      generation: {
        temperature: null,
        topP: null,
        presencePenalty: null,
        frequencyPenalty: null,
      },
    })

    expect(unsupportedModelSettings(anthropic).join()).toContain('reasoningEffort')
  })

  it('also names the sampling parameters thinking forces us to drop', () => {
    // 这一轮刚建立「接不住的设置要报出来」的机制，就不能在同一处再制造一次静默丢弃：
    // Anthropic 开启扩展思考时接口不接受 temperature / top_p，我们只能丢掉它们。
    const dropped = unsupportedModelSettings(
      configuredModel({
        protocol: 'anthropic-messages',
        reasoningEffort: 'high',
        generation: {
          temperature: 0.2,
          topP: 0.9,
          presencePenalty: null,
          frequencyPenalty: null,
        },
      }),
    ).join()

    expect(dropped).toContain('temperature')
    expect(dropped).toContain('topP')
  })

  it('says nothing about sampling parameters when thinking is off', () => {
    expect(
      unsupportedModelSettings(
        configuredModel({
          protocol: 'anthropic-messages',
          reasoningEffort: 'none',
          generation: {
            temperature: 0.2,
            topP: 0.9,
            presencePenalty: null,
            frequencyPenalty: null,
          },
        }),
      ),
    ).toEqual([])
  })

  it('reports nothing when every configured field can be sent', () => {
    expect(
      unsupportedModelSettings(
        configuredModel({
          protocol: 'openai-responses',
          reasoningEffort: 'high',
          generation: {
            temperature: 0.2,
            topP: 0.9,
            presencePenalty: null,
            frequencyPenalty: null,
          },
        }),
      ),
    ).toEqual([])
  })

  async function anthropicThinkingFor(reasoningEffort: string, maxOutputTokens?: number | null) {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ content: [{ type: 'text', text: '{"ok":true}' }] }),
    )
    await runConfiguredAiTask({
      model: configuredModel({ protocol: 'anthropic-messages', reasoningEffort }),
      template: '返回 JSON',
      data: {},
      json: true,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    })
    const calls = vi.mocked(fetch).mock.calls
    return JSON.parse(String(calls[calls.length - 1]![1]?.body)).thinking
  }

  it.each(['none', 'minimal', 'off', ''])(
    'sends no thinking at all for effort %s',
    async (effort) => {
      // 以前任何非空字符串都会开启思考，填 none 的人得到的是和填 max 一样的行为。
      expect(await anthropicThinkingFor(effort)).toBeUndefined()
    },
  )

  it.each([2048, 16_384, 32_768])(
    'uses %i directly when the effort is a number',
    async (budget) => {
      // 协议用 token 预算表达强度，没有档位词。与其编一个「high 等于多少 token」的换算，
      // 不如让想精确控制的人直接把数字填进去。
      expect(await anthropicThinkingFor(String(budget), null)).toEqual({
        type: 'enabled',
        budget_tokens: budget,
      })
    },
  )

  it.each(['high', 'max', 'ultra-think'])(
    'leaves %s to the model rather than inventing a number for it',
    async (effort) => {
      expect(await anthropicThinkingFor(effort, null)).toEqual({ type: 'adaptive' })
    },
  )

  it('raises max_tokens to fit the requested budget instead of shrinking it', async () => {
    // 预算必须小于 max_tokens。压缩预算等于用一个上限去决定模型想多深，
    // 方向反了——该让上限迁就用户要的思考。
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ content: [{ type: 'text', text: '{"ok":true}' }] }),
    )
    await runConfiguredAiTask({
      model: configuredModel({ protocol: 'anthropic-messages', reasoningEffort: '32768' }),
      template: '返回 JSON',
      data: {},
      json: true,
      maxOutputTokens: 4096,
    })
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))

    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 32_768 })
    expect(body.max_tokens).toBeGreaterThan(32_768)
  })
})

describe('anthropic messages protocol shape', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function anthropicRequest(overrides: Partial<AiModelConfig> = {}, json = true) {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        content: [
          { type: 'thinking', thinking: '内部推理' },
          { type: 'tool_use', name: 'agent_delivery_result', input: { ok: true } },
        ],
      }),
    )
    const result = await runConfiguredAiTask({
      model: configuredModel({ protocol: 'anthropic-messages', ...overrides }),
      template: '返回 JSON',
      data: {},
      json,
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    })
    const call = vi.mocked(fetch).mock.calls[0]!
    return { body: JSON.parse(String(call[1]?.body)), init: call[1]!, result }
  }

  it('declares direct browser access, which the API refuses without', async () => {
    // 扩展后台仍然是浏览器上下文，请求带着 chrome-extension:// 的 Origin。
    // 不声明这个头，官方接口会在 CORS 预检阶段直接挡下。
    const { init } = await anthropicRequest()
    const headers = init.headers as Record<string, string>

    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['x-api-key']).toBe('test-key')
    expect(headers.Authorization).toBeUndefined()
  })

  it('asks for structured output through tools, the only mechanism this protocol has', async () => {
    // Messages 协议没有 response_format。之前发的 output_config 不是协议字段，
    // 官方接口会因为未知字段报错——而本扩展的每个任务都要求 JSON 输出。
    const { body } = await anthropicRequest({ reasoningEffort: '' })

    expect(body.output_config).toBeUndefined()
    expect(body.tools).toEqual([
      expect.objectContaining({
        name: 'agent_delivery_result',
        input_schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      }),
    ])
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'agent_delivery_result' })
  })

  it('reads the result out of the tool call, not the text blocks', async () => {
    const { result } = await anthropicRequest({ reasoningEffort: '' })

    expect(result.content).toBe('{"ok":true}')
  })

  it('drops sampling parameters while extended thinking is on', async () => {
    // 开启扩展思考时接口不接受 temperature / top_p，一起发出去会被直接拒绝。
    const { body } = await anthropicRequest({ reasoningEffort: 'high' })

    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    // 思考开启时不能强制指定工具。
    expect(body.tool_choice).toEqual({ type: 'auto' })
  })

  it('keeps sampling parameters when thinking is off', async () => {
    const { body } = await anthropicRequest({ reasoningEffort: 'none' })

    expect(body.thinking).toBeUndefined()
    expect(body.temperature).toBe(0.2)
    expect(body.top_p).toBe(0.9)
  })

  it('sends no tool at all when the task does not need JSON', async () => {
    const { body } = await anthropicRequest({ reasoningEffort: '' }, false)

    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })
})

describe('provider failure detail', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the reason the provider gave for rejecting the request', async () => {
    // 真机上一次 400 只留下「状态码: 400」，原因在响应体里而我们读出来就丢掉了，
    // 于是无从判断是请求太大、参数不认识还是别的。
    // 每次尝试都要给一个新的 Response：body 只能读一次，复用同一个对象会让第二、三次
    // 读到空正文，测试就看不出真实行为了。
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'input too long for requested model' } }), {
          status: 400,
          statusText: 'Bad Request',
        }),
    )

    // 三次尝试都会拿到同一个 400，最终错误里要带着供应商给的原因。
    await expect(
      runConfiguredAiTask({
        model: configuredModel({ protocol: 'openai-responses' }),
        template: '返回 JSON',
        data: {},
        json: true,
      }),
    ).rejects.toThrow(/input too long/)
  })

  it('bounds the detail so a large error body cannot flood the log', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('x'.repeat(5000), { status: 400, statusText: 'Bad Request' }),
    )

    const message = await runConfiguredAiTask({
      model: configuredModel({ protocol: 'openai-responses' }),
      template: '返回 JSON',
      data: {},
      json: true,
    }).then(
      () => '',
      (error: Error) => error.message,
    )

    expect(message.length).toBeLessThan(400)
    expect(message).toContain('400')
  })
})

describe('transient failures before giving up', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries a network failure instead of surrendering on the first one', async () => {
    // 上层遇到 AI 失败会暂停整轮投递。网络抖动过去一次都不重试，
    // 于是一次抖动就足以让投递停下来，用户看到的是「动一下就暂停」。
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ output_text: '{"ok":true}' }))

    await expect(
      runConfiguredAiTask({
        model: configuredModel({ protocol: 'openai-responses' }),
        template: '返回 JSON',
        data: {},
        json: true,
        task: 'aiFiltering',
      }),
    ).resolves.toMatchObject({ content: '{"ok":true}' })
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  })

  it('gives a job three attempts in total before reporting failure', async () => {
    // 「单个岗位试三次都失败才算 AI 有问题」——两次不够，瞬时故障常常连着来两下。
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(
      runConfiguredAiTask({
        model: configuredModel({ protocol: 'openai-responses' }),
        template: '返回 JSON',
        data: {},
        json: true,
        task: 'aiFiltering',
      }),
    ).rejects.toThrow(/网络失败/)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3)
  })

  it('still retries a rate limit and a provider outage', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ output_text: '{"ok":true}' }))

    await expect(
      runConfiguredAiTask({
        model: configuredModel({ protocol: 'openai-responses' }),
        template: '返回 JSON',
        data: {},
        json: true,
        task: 'aiFiltering',
      }),
    ).resolves.toMatchObject({ content: '{"ok":true}' })
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3)
  })
})
