import { beforeEach, describe, expect, it, vi } from 'vitest'

const { storageGet, storageSet } = vi.hoisted(() => ({
  storageGet: vi.fn(),
  storageSet: vi.fn(),
}))

vi.mock('#imports', () => ({
  storage: {
    getItem: storageGet,
    setItem: storageSet,
  },
}))

import type { AiRuntimeDiagnosticEvent } from '@/utils/backgroundAi'

import { createAccountAiRuntimeLogger, createRuntimeLogStorageKey } from './runtimeLogs'

function event(overrides: Partial<AiRuntimeDiagnosticEvent> = {}): AiRuntimeDiagnosticEvent {
  return {
    at: Date.now(),
    diagnostics: {
      attempts: [],
      endpointType: 'responses',
      maxRetries: 0,
      model: 'gpt-test',
      promptChars: 120,
      requestBodyChars: 240,
      task: 'resumeExtraction',
      timeoutSeconds: 180,
    },
    durationMs: 10,
    model: 'gpt-test',
    phase: 'started',
    protocol: 'openai-responses',
    reasoningEffort: 'max',
    requestMode: 'stream',
    task: 'resumeExtraction',
    ...overrides,
  }
}

describe('background runtime logs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageGet.mockResolvedValue([])
    storageSet.mockResolvedValue(undefined)
  })

  it('writes account-scoped AI request stages without private request content', async () => {
    const logger = createAccountAiRuntimeLogger('account-a')
    await logger(event())

    expect(storageGet).toHaveBeenCalledWith('local:agent-delivery-runtime-logs:account-a', {
      fallback: [],
    })
    expect(storageSet).toHaveBeenCalledTimes(1)
    const written = storageSet.mock.calls[0]![1]
    expect(JSON.stringify(written)).toContain('简历解析')
    expect(JSON.stringify(written)).toContain('模型请求已发出')
    expect(JSON.stringify(written)).not.toContain('apiKey')
    expect(JSON.stringify(written)).not.toContain('简历原文')
  })

  it('keeps useful failure diagnostics while redacting URLs and credentials', async () => {
    const logger = createAccountAiRuntimeLogger('account-a')
    await logger(
      event({
        diagnostics: {
          ...event().diagnostics,
          attempts: [
            {
              attempt: 1,
              durationMs: 3000,
              error: 'request failed for https://private.example.test/v1/responses',
              ok: false,
              status: 500,
            },
          ],
        },
        durationMs: 3000,
        error: new Error('Bearer secret-token failed at https://private.example.test/v1/responses'),
        phase: 'failed',
      }),
    )

    const serialized = JSON.stringify(storageSet.mock.calls[0]![1])
    expect(serialized).toContain('HTTP 500')
    expect(serialized).toContain('[请求地址已脱敏]')
    expect(serialized).toContain('Bearer [已脱敏]')
    expect(serialized).not.toContain('private.example.test')
    expect(serialized).not.toContain('secret-token')
  })

  it('classifies a timed-out HTTP 200 stream as a timeout instead of an HTTP failure', async () => {
    const logger = createAccountAiRuntimeLogger('account-a')
    await logger(
      event({
        diagnostics: {
          ...event().diagnostics,
          attempts: [
            {
              attempt: 1,
              durationMs: 180_000,
              error: 'AI流式响应读取超时',
              ok: false,
              status: 200,
            },
          ],
        },
        durationMs: 180_000,
        error: new Error('AI流式响应读取超时', {
          cause: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        }),
        phase: 'failed',
      }),
    )

    const serialized = JSON.stringify(storageSet.mock.calls[0]![1])
    expect(serialized).toContain('模型请求超时')
    expect(serialized).not.toContain('HTTP 200')
  })

  it('rejects malformed account identifiers before touching storage', () => {
    expect(() => createRuntimeLogStorageKey('account/a')).toThrow('账号标识格式无效')
    expect(storageGet).not.toHaveBeenCalled()
  })
})

describe('token usage in runtime logs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageGet.mockResolvedValue([])
    storageSet.mockResolvedValue(undefined)
  })

  it('records token usage so a slow request can be attributed', async () => {
    // 只有耗时的话，「简历解析变慢了」无法判断是模型本身慢还是我们要的输出变多了。
    const logger = createAccountAiRuntimeLogger('account-a')
    await logger(
      event({
        durationMs: 240_000,
        phase: 'succeeded',
        usage: {
          input_tokens: 12_000,
          output_tokens: 7_800,
          reasoning_tokens: 6_400,
          total_tokens: 19_800,
        },
      }),
    )

    const detail = (storageSet.mock.calls[0]![1] as any)[0].data.trace[0].detail
    // 推理 token 必须单独可见：7800 里有 6400 是思考、只有 1400 是复述出来的内容，
    // 这两种情况的优化手段完全不同。
    expect(detail).toMatchObject({
      durationMs: 240_000,
      inputTokens: 12_000,
      outputTokens: 7_800,
      reasoningTokens: 6_400,
    })
  })
})
