import { describe, expect, it } from 'vitest'

import {
  AiTaskResponseInvalidError,
  AI_TASK_REQUEST_TYPE,
  AI_TASK_RESPONSE_TYPE,
  createAiTaskResponse,
  isAiTaskRequestMessage,
  isAiTaskResponseMessage,
} from './backgroundAiProtocol'

function validMessage() {
  return {
    type: AI_TASK_REQUEST_TYPE,
    requestId: 'request-1',
    task: 'aiFiltering',
    data: {
      data: { encryptJobId: 'job-1' },
      boss: { name: '招聘者' },
      card: { jobName: 'AI 产品经理' },
      amap: { distance: 1200 },
    },
    json: true,
    bridgeToken: 'bridge-token',
  }
}

/** 招呼语任务的合法基座。阈值只在这一侧存在——匹配任务拿到它就会去对齐分数。 */
function validGreetingMessage() {
  const base = validMessage()
  return { ...base, task: 'aiGreeting', data: { ...base.data, filteringThreshold: 70 } }
}

function validFilteringContext() {
  return {
    matchPercent: 78,
    level: 'good',
    reason: '相邻经验',
    selectedFactIds: ['fact-agent-content'],
    claimMode: 'adjacent',
  }
}

function nestedValue(depth: number): unknown {
  let value: unknown = 'leaf'
  for (let index = 0; index < depth; index += 1) {
    value = { child: value }
  }
  return value
}

describe('MAIN-world AI task protocol limits', () => {
  it('accepts a bounded request containing only public task fields', () => {
    expect(isAiTaskRequestMessage(validMessage())).toBe(true)
  })

  it('accepts bounded greeting context without private fact bodies', () => {
    const base = validGreetingMessage()
    const message = {
      ...base,
      data: {
        ...base.data,
        filtering: {
          matchPercent: 78,
          level: 'good',
          reason: '相邻经验',
          selectedFactIds: ['fact-agent-content'],
          claimMode: 'adjacent',
        },
        recentGreetings: [],
      },
    }
    expect(isAiTaskRequestMessage(message)).toBe(true)
  })

  it('accepts a score that reaches a configured threshold below 70', () => {
    const base = validGreetingMessage()
    expect(
      isAiTaskRequestMessage({
        ...base,
        data: {
          ...base.data,
          filteringThreshold: 60,
          filtering: {
            ...validFilteringContext(),
            matchPercent: 60,
            level: 'maybe',
            claimMode: 'adjacent',
          },
        },
      }),
    ).toBe(true)
  })

  it('accepts a score that exactly reaches an 80-point threshold', () => {
    const base = validGreetingMessage()
    expect(
      isAiTaskRequestMessage({
        ...base,
        data: {
          ...base.data,
          filteringThreshold: 80,
          filtering: {
            ...validFilteringContext(),
            matchPercent: 80,
            claimMode: 'direct',
          },
        },
      }),
    ).toBe(true)
  })

  it('rejects a greeting score below the configured threshold', () => {
    const base = validGreetingMessage()
    expect(
      isAiTaskRequestMessage({
        ...base,
        data: {
          ...base.data,
          filteringThreshold: 70,
          filtering: {
            ...validFilteringContext(),
            matchPercent: 60,
            level: 'maybe',
            claimMode: 'adjacent',
          },
        },
      }),
    ).toBe(false)
  })

  it('rejects selected fact bodies crossing from MAIN world', () => {
    expect(
      isAiTaskRequestMessage({
        ...validGreetingMessage(),
        data: {
          ...validGreetingMessage().data,
          selectedFacts: [{ id: 'private', sourceQuote: 'secret' }],
        },
      }),
    ).toBe(false)
  })

  it.each([
    ['filtering', validFilteringContext()],
    ['recentGreetings', []],
  ])('rejects %s on filtering requests', (field, value) => {
    expect(
      isAiTaskRequestMessage({
        ...validMessage(),
        data: { ...validMessage().data, [field]: value },
      }),
    ).toBe(false)
  })

  it('allows greeting requests without AI filtering context', () => {
    expect(isAiTaskRequestMessage(validGreetingMessage())).toBe(true)
  })

  it.each([
    [78, 'direct'],
    [80, 'adjacent'],
  ])('accepts score %s with fact-derived claim mode %s', (matchPercent, claimMode) => {
    expect(
      isAiTaskRequestMessage({
        ...validGreetingMessage(),
        data: {
          ...validGreetingMessage().data,
          filtering: { ...validFilteringContext(), matchPercent, claimMode },
        },
      }),
    ).toBe(true)
  })

  it('rejects a passing greeting context without selected fact IDs', () => {
    expect(
      isAiTaskRequestMessage({
        ...validGreetingMessage(),
        data: {
          ...validGreetingMessage().data,
          filtering: { ...validFilteringContext(), selectedFactIds: [] },
        },
      }),
    ).toBe(false)
  })

  it('rejects a greeting context with more than two selected fact IDs', () => {
    const selectedFactIds = ['fact-1', 'fact-2', 'fact-3']
    expect(
      isAiTaskRequestMessage({
        ...validGreetingMessage(),
        data: {
          ...validGreetingMessage().data,
          filtering: { ...validFilteringContext(), selectedFactIds },
        },
      }),
    ).toBe(false)
  })

  it.each([undefined, 60.5, -1, 101])(
    'rejects an invalid filtering threshold %s',
    (filteringThreshold) => {
      // 阈值只在招呼语任务里出现（那里要拿它复核匹配结论），所以取值范围也只在那边验。
      const base = validMessage()
      expect(
        isAiTaskRequestMessage({
          ...base,
          task: 'aiGreeting',
          data: { ...base.data, filteringThreshold, filtering: validFilteringContext() },
        }),
      ).toBe(false)
    },
  )

  it('rejects a filtering task that carries the delivery threshold', () => {
    // 模型只要看得见门槛，就会先决定「投不投」再倒推一个刚好落在线下的分数——用户在真机上
    // 看到的正是这个：把门槛从 80 调到 40，能投的岗位并没有变多。判定留在代码这一侧，
    // 阈值不进发给模型的数据。
    const base = validMessage()
    expect(
      isAiTaskRequestMessage({
        ...base,
        data: { ...base.data, filteringThreshold: 70 },
      }),
    ).toBe(false)
  })

  it('rejects more than ten recent greeting summaries', () => {
    const summary = {
      sentAt: 1,
      usedFactIds: ['fact-agent-content'],
      openingPattern: 'jd-hook',
      messages: ['第一条', '第二条', '第三条'],
      fingerprint: 'fingerprint',
    }
    expect(
      isAiTaskRequestMessage({
        ...validGreetingMessage(),
        data: {
          ...validGreetingMessage().data,
          filtering: validFilteringContext(),
          recentGreetings: Array.from({ length: 11 }, () => summary),
        },
      }),
    ).toBe(false)
  })

  it('rejects private fields nested inside greeting filtering context', () => {
    expect(
      isAiTaskRequestMessage({
        ...validGreetingMessage(),
        data: {
          ...validGreetingMessage().data,
          filtering: { ...validFilteringContext(), sourceQuote: 'secret' },
        },
      }),
    ).toBe(false)
  })

  it('rejects unknown top-level request fields', () => {
    expect(isAiTaskRequestMessage({ ...validMessage(), model: 'private-model' })).toBe(false)
  })

  it('rejects unknown top-level data fields', () => {
    expect(
      isAiTaskRequestMessage({
        ...validMessage(),
        data: { ...validMessage().data, prompt: 'private-prompt' },
      }),
    ).toBe(false)
  })

  it('rejects data nested deeper than eight levels', () => {
    expect(
      isAiTaskRequestMessage({
        ...validMessage(),
        data: { data: nestedValue(9) },
      }),
    ).toBe(false)
  })

  it('rejects strings longer than 32 KiB', () => {
    expect(
      isAiTaskRequestMessage({
        ...validMessage(),
        data: { data: { description: 'x'.repeat(32 * 1024 + 1) } },
      }),
    ).toBe(false)
  })

  it('rejects arrays longer than 200 items', () => {
    expect(
      isAiTaskRequestMessage({
        ...validMessage(),
        data: { data: { items: Array.from({ length: 201 }, (_, index) => index) } },
      }),
    ).toBe(false)
  })

  it('rejects requests larger than 256 KiB in total', () => {
    const chunks = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`chunk${index}`, 'x'.repeat(16 * 1024)]),
    )

    expect(
      isAiTaskRequestMessage({
        ...validMessage(),
        data: { data: chunks },
      }),
    ).toBe(false)
  })

  it('returns only a stable code and generic message for provider failures', () => {
    const providerSecret = 'provider-echoed-super-secret'
    const authorization = 'Bearer private-api-key'
    const prompt = 'private-resume-prompt'
    const error = new Error(`${providerSecret} ${authorization} ${prompt}`)
    error.name = 'ProviderSecretError'
    error.stack = `ProviderSecretError: ${providerSecret}\n    at private-provider.ts:1:1`
    Object.assign(error, {
      diagnostics: {
        attempts: [{ attempt: 1, durationMs: 1, error: providerSecret, ok: false }],
        endpointType: 'chatCompletions',
        maxRetries: 5,
        model: 'private-model-name',
        promptChars: prompt.length,
        requestBodyChars: 100,
        timeoutSeconds: 180,
      },
    })

    const response = createAiTaskResponse('request-secret', { ok: false, error })
    const serialized = JSON.stringify(response)

    expect(response).toEqual({
      type: AI_TASK_RESPONSE_TYPE,
      requestId: 'request-secret',
      ok: false,
      errorCode: 'AI_TASK_FAILED',
      error: '后台AI任务失败',
    })
    for (const secret of [
      providerSecret,
      authorization,
      prompt,
      'private-model-name',
      'ProviderSecretError',
      'private-provider.ts',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it.each([
    [401, 'AI_TASK_AUTH_FAILED', '后台AI鉴权失败'],
    [403, 'AI_TASK_AUTH_FAILED', '后台AI鉴权失败'],
    [429, 'AI_TASK_RATE_LIMITED', '后台AI请求触发限流'],
    [504, 'AI_TASK_TIMEOUT', '后台AI任务超时'],
    [503, 'AI_TASK_HTTP_FAILED', '后台AI请求失败（HTTP 503）'],
  ])('classifies HTTP %i without exposing provider response data', (status, errorCode, message) => {
    const error = Object.assign(new Error('provider body must remain private'), {
      diagnostics: {
        attempts: [
          {
            attempt: 1,
            durationMs: 1,
            error: 'provider body must remain private',
            ok: false,
            status,
          },
        ],
      },
    })

    const response = createAiTaskResponse(`request-${status}`, { ok: false, error })

    expect(response).toEqual({
      type: AI_TASK_RESPONSE_TYPE,
      requestId: `request-${status}`,
      ok: false,
      errorCode,
      error: message,
    })
    expect(isAiTaskResponseMessage(response)).toBe(true)
    expect(JSON.stringify(response)).not.toContain('provider body must remain private')
  })

  it('classifies timeouts and invalid responses with safe messages', () => {
    const timeoutResponse = createAiTaskResponse('request-timeout', {
      ok: false,
      error: new Error('AbortError: request timed out with private details'),
    })
    const invalidResponse = createAiTaskResponse('request-invalid', {
      ok: false,
      error: new Error('AI响应不是合法 JSON：private provider body'),
    })
    const qualityGateResponse = createAiTaskResponse('request-quality-gate', {
      ok: false,
      error: new AiTaskResponseInvalidError(2, [
        'FACT_NOT_ALLOWED',
        'FORBIDDEN_CLAIM',
        'provider-secret-must-not-pass',
      ]),
    })

    expect(timeoutResponse).toMatchObject({
      errorCode: 'AI_TASK_TIMEOUT',
      error: '后台AI任务超时',
    })
    expect(invalidResponse).toMatchObject({
      errorCode: 'AI_TASK_RESPONSE_INVALID',
      error: '后台AI响应格式异常',
    })
    expect(qualityGateResponse).toMatchObject({
      errorCode: 'AI_TASK_RESPONSE_INVALID',
      error: '后台AI响应格式异常（第2次：FACT_NOT_ALLOWED,FORBIDDEN_CLAIM）',
    })
    expect(isAiTaskResponseMessage(timeoutResponse)).toBe(true)
    expect(isAiTaskResponseMessage(invalidResponse)).toBe(true)
    expect(isAiTaskResponseMessage(qualityGateResponse)).toBe(true)
    expect(JSON.stringify(qualityGateResponse)).not.toContain('provider-secret')
  })

  it('omits prompt and background diagnostics from successful responses', () => {
    const response = createAiTaskResponse('request-success', {
      ok: true,
      data: {
        content: '{"passed":true}',
        prompt: 'private-resume-prompt',
        reasoning_content: 'provider-repeated-private-resume-prompt',
        diagnostics: {
          attempts: [{ attempt: 1, durationMs: 1, ok: true }],
          endpointType: 'chatCompletions',
          maxRetries: 5,
          model: 'private-model-name',
          promptChars: 21,
          requestBodyChars: 100,
          timeoutSeconds: 180,
        },
      },
    })

    expect(response).toEqual({
      type: AI_TASK_RESPONSE_TYPE,
      requestId: 'request-success',
      ok: true,
      data: { content: '{"passed":true}' },
    })
    expect(JSON.stringify(response)).not.toContain('provider-repeated-private-resume-prompt')
  })
})
