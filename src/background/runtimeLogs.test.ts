import { beforeEach, describe, expect, it, vi } from 'vitest'

const { storageGet, storageSet } = vi.hoisted(() => ({
  storageGet: vi.fn(),
  storageSet: vi.fn(),
}))

const { localDiagnosticAppend } = vi.hoisted(() => ({
  localDiagnosticAppend: vi.fn(async () => true),
}))

vi.mock('#imports', () => ({
  storage: {
    getItem: storageGet,
    setItem: storageSet,
  },
}))

vi.mock('./localDiagnosticSink', () => ({
  appendLocalDiagnosticEvent: localDiagnosticAppend,
}))

import type { AiRuntimeDiagnosticEvent } from '@/utils/backgroundAi'

import {
  appendAiTaskFailure,
  createAccountAiRuntimeLogger,
  createRuntimeLogStorageKey,
} from './runtimeLogs'

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
    localDiagnosticAppend.mockResolvedValue(true)
  })

  it('keeps rejected business input and original errors locally even before a provider request', async () => {
    const request = {
      requestId: 'request-invalid',
      task: 'aiGreeting',
      bridgeToken: 'not-for-disk',
      data: {
        accountUid: 'account-a',
        recentGreetings: [
          { messages: ['历史话术正文'.repeat(1000)], usedFactIds: ['a', 'b', 'c', 'd'] },
        ],
      },
    }
    const error = new Error('原始校验原因', { cause: new TypeError('原始内部原因') })
    await appendAiTaskFailure(request, 'request-validation', error)
    expect(localDiagnosticAppend).toHaveBeenCalledWith({
      stream: 'logs',
      event: 'runtime.ai-task-failed',
      accountUid: 'account-a',
      data: {
        requestId: request.requestId,
        task: request.task,
        stage: 'request-validation',
        requestSnapshot: {
          requestId: request.requestId,
          task: request.task,
          data: { recentGreetings: request.data.recentGreetings },
        },
        error: expect.objectContaining({
          name: 'Error',
          message: '原始校验原因',
          stack: expect.any(String),
          cause: expect.objectContaining({ name: 'TypeError', message: '原始内部原因' }),
        }),
      },
    })
    expect(request.data.accountUid).toBe('account-a')
    expect(request.bridgeToken).toBe('not-for-disk')
  })

  it('keeps invalid array data intact and tolerates diagnostic storage failures', async () => {
    localDiagnosticAppend.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(
      appendAiTaskFailure({ data: ['invalid-input'] }, 'request-validation', new Error('invalid')),
    ).resolves.toBeUndefined()
    expect(localDiagnosticAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        accountUid: undefined,
        data: expect.objectContaining({ requestSnapshot: { data: ['invalid-input'] } }),
      }),
    )
  })

  it('skips routine request stages and keeps slow or retried ones', async () => {
    const logger = createAccountAiRuntimeLogger('account-a')
    await logger(event())
    await logger(event({ phase: 'succeeded', durationMs: 20_000 }))
    expect(storageSet).not.toHaveBeenCalled()

    await logger(event({ phase: 'succeeded', durationMs: 90_000 }))
    expect(storageGet).toHaveBeenCalledWith('local:agent-delivery-runtime-logs:account-a', {
      fallback: [],
    })
    expect(storageSet).toHaveBeenCalledTimes(1)
    const written = storageSet.mock.calls[0]![1]
    expect(JSON.stringify(written)).toContain('简历解析')
    expect(JSON.stringify(written)).toContain('模型请求较慢（90 秒）')
    expect(JSON.stringify(written)).not.toContain('apiKey')
    expect(JSON.stringify(written)).not.toContain('简历原文')
    // 3 个完整 AI 阶段事件 + 1 条界面运行日志摘要。
    expect(localDiagnosticAppend).toHaveBeenCalledTimes(4)
  })

  it('mirrors full prompt, request body, and provider response for every AI phase', async () => {
    const logger = createAccountAiRuntimeLogger('account-a')
    await logger(
      event({
        phase: 'succeeded',
        promptMessages: [
          { role: 'system', content: '系统 Prompt' },
          { role: 'user', content: '简历原文和完整 JD' },
        ],
        requestBody: { messages: [{ role: 'user', content: '完整请求' }] },
        providerResponse: { choices: [{ message: { content: '原始模型响应' } }] },
        resultContent: '解析后的结果',
        reasoningContent: '推理文本',
      }),
    )
    expect(localDiagnosticAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'runtime.ai-request',
        data: expect.objectContaining({
          promptMessages: expect.any(Array),
          requestBody: expect.any(Object),
          providerResponse: expect.any(Object),
          resultContent: '解析后的结果',
          reasoningContent: '推理文本',
        }),
      }),
    )
  })

  it('drops routine records left by older versions when writing a new one', async () => {
    // 1.3.6 给每次正常请求都记两条。新版本不再记，老记录就永远挤不出 200 条的名额，
    // 真机上 200 条运行日志里有 180 条是它们。
    storageGet.mockResolvedValue([
      {
        title: 'AI 匹配请求',
        state: 'success',
        state_name: '请求成功',
        message: '模型请求完成',
        createdAt: 3,
      },
      {
        title: 'AI 匹配请求',
        state: 'info',
        state_name: '请求中',
        message: '模型请求已发出（同步）',
        createdAt: 2,
      },
      {
        title: '简历解析',
        state: 'success',
        state_name: '解析成功',
        message: '解析成功',
        createdAt: 1,
      },
    ])
    const logger = createAccountAiRuntimeLogger('account-a')

    await logger(event({ phase: 'succeeded', durationMs: 90_000 }))

    const written = storageSet.mock.calls[0]![1] as Array<{ message: string }>
    expect(written.map((item) => item.message)).toEqual(['模型请求较慢（90 秒）', '解析成功'])
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
