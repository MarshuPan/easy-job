import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import type { AiModelConfig } from './types'

const {
  appendAccountRuntimeLog,
  createAccountAiRuntimeLogger,
  extractResumeEvidence,
  runtimeSendMessage,
} = vi.hoisted(() => {
  return {
    appendAccountRuntimeLog: vi.fn(),
    createAccountAiRuntimeLogger: vi.fn(() => vi.fn()),
    extractResumeEvidence: vi.fn(),
    runtimeSendMessage: vi.fn<
      (_extensionId: string, message: Record<string, unknown>) => Promise<unknown>
    >(async (_extensionId: string, message: Record<string, unknown>) => {
      structuredClone(message)
      return {
        type: 'AGENT_DELIVERY_CONFIG_RESPONSE',
        requestId: message.requestId,
        ok: true,
        data: {
          configRevision: 1,
          modelReady: true,
          resumeReady: false,
          aiFilteringReady: true,
          aiGreetingReady: true,
        },
      }
    }),
  }
})

vi.mock('@/background/runtimeLogs', () => ({
  appendAccountRuntimeLog,
  createAccountAiRuntimeLogger,
}))

vi.mock('@/profile/resumeExtraction', () => ({
  extractResumeEvidence,
}))

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension',
      sendMessage: runtimeSendMessage,
    },
  },
}))

import { saveAiConfiguration, saveProfileAndExtract, testAiModel } from './client'
import { createDefaultAiTasks } from './defaults'

function model(): AiModelConfig {
  return {
    id: 'model-1',
    name: '默认模型',
    protocol: 'openai-responses',
    url: 'https://api.example.test/v1/responses',
    apiKey: 'test-key',
    model: 'test-model',
    reasoningEffort: 'max',
    timeoutSeconds: 180,
    responsesBackground: 'auto',
    generation: {
      temperature: null,
      topP: null,
      presencePenalty: null,
      frequencyPenalty: null,
    },
  }
}

describe('configuration client clone boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends only reactive model state as a plain runtime message', async () => {
    const state = reactive({
      models: [model()],
      tasks: createDefaultAiTasks(),
    })

    await expect(saveAiConfiguration(state.models)).resolves.toBeDefined()

    const request = runtimeSendMessage.mock.calls[0][1]
    expect(() => structuredClone(request)).not.toThrow()
    expect(request.models).toEqual([model()])
    expect(request).not.toHaveProperty('tasks')
  })

  it('sends a reactive model snapshot during connection tests', async () => {
    const reactiveModel = reactive(model())

    await expect(testAiModel('account-a', reactiveModel)).resolves.toBeDefined()

    const request = runtimeSendMessage.mock.calls[0][1]
    expect(() => structuredClone(request)).not.toThrow()
    expect(request.uid).toBe('account-a')
    expect(request.model).toEqual(model())
  })

  it('runs resume extraction in the options page between two short background transactions', async () => {
    let resolveExtraction!: (value: unknown) => void
    extractResumeEvidence.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveExtraction = resolve
        }),
    )
    runtimeSendMessage.mockImplementation(
      async (_extensionId: string, message: Record<string, unknown>) => ({
        type: 'AGENT_DELIVERY_CONFIG_RESPONSE',
        requestId: message.requestId,
        ok: true,
        data:
          message.action === 'save-profile-draft'
            ? {
                configRevision: 2,
                evidenceVersion: 1,
                factCount: 0,
                reused: false,
                status: 'pending',
              }
            : {
                configRevision: 3,
                evidenceVersion: 1,
                factCount: 1,
                reused: false,
                status: 'ready',
              },
      }),
    )

    const pending = saveProfileAndExtract('account-a', '候选人', '简历内容', model())
    await vi.waitFor(() => expect(extractResumeEvidence).toHaveBeenCalledTimes(1))

    expect(runtimeSendMessage).toHaveBeenCalledTimes(1)
    expect(runtimeSendMessage.mock.calls[0]?.[1].action).toBe('save-profile-draft')
    resolveExtraction({
      facts: [
        {
          id: 'fact-1',
          sourceQuote: '简历内容',
          action: '负责',
          object: '产品',
          ownership: 'owned',
          domains: [],
          skills: [],
          evidenceType: 'direct_fact',
          allowedClaimVerbs: ['负责'],
          confidence: 'high',
        },
      ],
      buckets: [],
      claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
    })

    await expect(pending).resolves.toMatchObject({ factCount: 1, status: 'ready' })
    expect(runtimeSendMessage.mock.calls.map(([, message]) => message.action)).toEqual([
      'save-profile-draft',
      'commit-profile-evidence',
    ])
    expect(appendAccountRuntimeLog).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({ message: '解析成功', state_name: '解析成功' }),
    )
  })

  it('reuses existing resume evidence without issuing a model request', async () => {
    runtimeSendMessage.mockImplementationOnce(
      async (_extensionId: string, message: Record<string, unknown>) => ({
        type: 'AGENT_DELIVERY_CONFIG_RESPONSE',
        requestId: message.requestId,
        ok: true,
        data: {
          configRevision: 2,
          evidenceVersion: 1,
          factCount: 2,
          reused: true,
          status: 'ready',
        },
      }),
    )

    await expect(
      saveProfileAndExtract('account-a', '候选人', '简历内容', model()),
    ).resolves.toMatchObject({ reused: true, factCount: 2 })
    expect(extractResumeEvidence).not.toHaveBeenCalled()
    expect(runtimeSendMessage).toHaveBeenCalledTimes(1)
    expect(appendAccountRuntimeLog).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({ message: '解析成功', state_name: '解析成功' }),
    )
  })

  it('normalizes and redacts a page-side extraction failure', async () => {
    runtimeSendMessage.mockImplementationOnce(
      async (_extensionId: string, message: Record<string, unknown>) => ({
        type: 'AGENT_DELIVERY_CONFIG_RESPONSE',
        requestId: message.requestId,
        ok: true,
        data: {
          configRevision: 2,
          evidenceVersion: 1,
          factCount: 0,
          reused: false,
          status: 'pending',
        },
      }),
    )
    extractResumeEvidence.mockRejectedValueOnce(
      new Error('AI流式响应读取超时：私密简历正文 test-key api.example.test'),
    )

    await expect(
      saveProfileAndExtract('account-a', '候选人', '私密简历正文', model()),
    ).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', message: '模型请求超时' })

    expect(runtimeSendMessage).toHaveBeenCalledTimes(1)
    expect(appendAccountRuntimeLog).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(appendAccountRuntimeLog.mock.calls[0])
    expect(logged).toContain('MODEL_TIMEOUT')
    expect(logged).not.toContain('私密简历正文')
    expect(logged).not.toContain('test-key')
    expect(logged).not.toContain('api.example.test')
  })
})
