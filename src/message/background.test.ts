import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DELIVERY_WORKER_IDENTITY_REQUEST_TYPE,
  DELIVERY_WORKER_IDENTITY_RESPONSE_TYPE,
} from '@/message/types'
import { AI_TASK_REQUEST_TYPE, AI_TASK_RESPONSE_TYPE } from '@/utils/backgroundAiProtocol'
import {
  EXTENSION_BACKGROUND_PROBE_REQUEST_TYPE,
  EXTENSION_BACKGROUND_PROBE_RESPONSE_TYPE,
  getCurrentAppVersion,
} from '@/utils/extensionRuntimeHealth'

const { runConfiguredAiTask, runtimeListeners, storageGet, tabRemovedListeners, tabsSendMessage } =
  vi.hoisted(() => ({
    runConfiguredAiTask: vi.fn(),
    runtimeListeners: [] as Array<(message: unknown, sender: unknown) => unknown>,
    storageGet: vi.fn(),
    tabRemovedListeners: [] as Array<(tabId: number) => void>,
    tabsSendMessage: vi.fn(),
  }))

vi.mock('comctx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('comctx')>()
  return {
    ...actual,
    defineProxy: vi.fn(() => [vi.fn(), vi.fn()]),
  }
})

vi.mock('#imports', () => ({
  browser: {
    cookies: {
      getAll: vi.fn(async () => []),
      remove: vi.fn(),
      set: vi.fn(),
    },
    runtime: {
      id: 'test-extension',
      getURL: vi.fn((path: string) => `chrome-extension://test-extension${path}`),
      onMessage: {
        addListener: vi.fn((listener) => runtimeListeners.push(listener)),
        removeListener: vi.fn(),
      },
    },
    tabs: {
      create: vi.fn(),
      get: vi.fn(),
      query: vi.fn(async () => []),
      reload: vi.fn(),
      sendMessage: tabsSendMessage,
      update: vi.fn(),
      onRemoved: {
        addListener: vi.fn((listener) => tabRemovedListeners.push(listener)),
      },
    },
  },
  storage: {
    getItem: storageGet,
    setItem: vi.fn(),
  },
}))

vi.mock('@/utils/backgroundAi', () => ({
  runConfiguredAiTask,
  testConfiguredAiModel: vi.fn(),
}))

import { createDefaultStoredConfigState, createDefaultDeliverySettings } from '@/config/defaults'
import type { StoredConfigStateV1 } from '@/config/types'

import { BackgroundCounter, ProvideBackgroundAdapter, userKey } from './background'

function canonicalState(options: { messageCount?: number } = {}): StoredConfigStateV1 {
  const state = createDefaultStoredConfigState()
  state.profile = {
    displayName: '候选人',
    resume: {
      markdown: '负责 B 端 SaaS 平台',
      sourceHash: `sha256:${'1'.repeat(64)}`,
      evidenceVersion: 1,
      evidence: {
        facts: [
          {
            id: 'fact-canonical',
            sourceQuote: '负责 B 端 SaaS 平台',
            action: '负责',
            object: 'B 端 SaaS 平台',
            ownership: 'owned',
            domains: ['企业服务'],
            skills: ['平台规划'],
            evidenceType: 'direct_fact',
            allowedClaimVerbs: ['负责'],
            confidence: 'high',
          },
        ],
        buckets: [],
        claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
      },
    },
  }
  state.models = [
    {
      id: 'canonical-model',
      name: 'Canonical Model',
      protocol: 'openai-responses',
      url: 'https://example.test/v1/responses',
      apiKey: 'canonical-secret',
      model: 'canonical-model-name',
      reasoningEffort: 'max',
      timeoutSeconds: 180,
      responsesBackground: 'auto',
      generation: {
        temperature: null,
        topP: null,
        presencePenalty: null,
        frequencyPenalty: null,
      },
    },
  ]
  state.tasks.aiFiltering = {
    enabled: true,
    modelId: 'canonical-model',
    score: 80,
    prompt: '只作为筛选偏好',
  }
  state.tasks.aiGreeting = {
    enabled: true,
    modelId: 'canonical-model',
    messageCount: options.messageCount ?? 2,
    minTotalCharacters: 20,
    maxTotalCharacters: 120,
    prompt: '只作为写作偏好',
  }
  state.accountSettings['account-canonical'] = createDefaultDeliverySettings()
  return state
}

function greetingMessage(requestId: string) {
  return {
    type: AI_TASK_REQUEST_TYPE,
    requestId,
    task: 'aiGreeting',
    data: {
      filteringThreshold: 70,
      data: { skills: ['平台产品'] },
      boss: { data: { name: '王女士' } },
      card: { jobName: 'AI 产品经理' },
      filtering: {
        matchPercent: 82,
        level: 'good',
        reason: '平台经验匹配',
        selectedFactIds: ['fact-b2b-saas'],
        claimMode: 'direct',
      },
      recentGreetings: [],
    },
    json: true,
  }
}

function backgroundRpcRequest(id = 'config-runtime-request') {
  return {
    type: 'apply' as const,
    sender: 'injector' as const,
    id,
    path: ['configRuntime'],
    args: ['account-a'],
    meta: { url: 'https://www.zhipin.com/web/geek/job' },
    namespace: '__agent-delivery-background__',
    timeStamp: Date.now(),
  }
}

/**
 * 按 Chrome 的真实语义分发运行时消息：逐个询问监听器，第一个返回非 undefined 的
 * 即认领该消息。测试因此不依赖监听器的注册顺序——按下标取会在增删监听器时集体错位。
 */
function dispatchRuntimeMessage(message: unknown, sender: unknown = {}) {
  for (const listener of runtimeListeners) {
    const result = listener(message, sender)
    if (result !== undefined) return result
  }
  return undefined
}

describe('background RPC adapter lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tabsSendMessage.mockResolvedValue(undefined)
  })

  it('ignores runtime messages that are not valid background RPC requests', () => {
    const adapter = new ProvideBackgroundAdapter()
    const callback = vi.fn()
    adapter.onMessage(callback)
    const listener = runtimeListeners.at(-1)!

    const result = listener(
      {
        type: EXTENSION_BACKGROUND_PROBE_REQUEST_TYPE,
        requestId: 'direct-probe',
      },
      { tab: { id: 11 } },
    )

    expect(result).toBeUndefined()
    expect(callback).not.toHaveBeenCalled()
  })

  it('keeps the listener pending until the async operation and tab response both complete', async () => {
    let finishConfigRead = () => {}
    const configRead = new Promise<void>((resolve) => {
      finishConfigRead = resolve
    })
    let finishTabResponse = () => {}
    tabsSendMessage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishTabResponse = resolve
        }),
    )

    const adapter = new ProvideBackgroundAdapter()
    adapter.onMessage(async (message) => {
      await configRead
      void adapter.sendMessage(
        {
          ...backgroundRpcRequest(message?.id),
          sender: 'provider',
          data: { accountInitialized: true },
          meta: message?.meta ?? { url: '' },
        },
        [],
      )
    })
    const listener = runtimeListeners.at(-1)!
    const lifecycle = listener(backgroundRpcRequest(), { tab: { id: 12 } }) as Promise<void>
    let settled = false
    void lifecycle.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(tabsSendMessage).not.toHaveBeenCalled()
    expect(settled).toBe(false)

    finishConfigRead()
    await Promise.resolve()
    await Promise.resolve()
    expect(tabsSendMessage).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        id: 'config-runtime-request',
        sender: 'provider',
        meta: expect.objectContaining({ tabId: 12 }),
      }),
    )
    expect(settled).toBe(false)

    finishTabResponse()
    await lifecycle
    expect(settled).toBe(true)
  })
})

describe('background account state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runConfiguredAiTask.mockReset()
    tabsSendMessage.mockResolvedValue(undefined)
    storageGet.mockResolvedValue({
      'account-a': {
        cookies: [{ name: 'session', value: 'account-a-cookie-secret' }],
        info: {
          uid: 'account-a',
          user: '账号 A',
          form: { userId: 'account-a' },
          statistics: '{"private":"account-a-statistics"}',
        },
      },
      'account-b': {
        cookies: [{ name: 'session', value: 'account-b-cookie-secret' }],
        info: {
          uid: 'account-b',
          user: '账号 B',
          avatar: { token: 'metadata-token-secret' },
          remark: 'remark-b',
          gender: 'man',
          flag: 'staff',
          date: '2026-07-10',
          form: {
            userId: 'account-b',
            useCache: { value: true },
            record: { enable: true, model: ['record-model-secret'] },
            amap: {
              key: 'amap-secret-api-key',
              origins: '116.397,39.908',
              straightDistance: 1_200,
              drivingDistance: 1_800,
              enable: false,
              nested: {
                safe: 'public-distance-value',
                prompt: 'nested-prompt-secret',
                model: 'nested-model-secret',
                cookies: ['nested-cookie-secret'],
                accessToken: 'nested-access-token-secret',
              },
            },
            aiGreeting: {
              enable: true,
              prompt: 'account-b-prompt-secret',
              model: 'private-model-key',
              token: 'nested-token-secret',
            },
            cookies: ['top-level-cookie-secret'],
            credentials: { apiKey: 'unknown-top-level-api-key' },
          },
          statistics:
            '{"t":{"date":"2026-07-10","total":5,"token":"statistics-token-secret"},"s":[{"date":"2026-07-09","success":2,"model":"statistics-model-secret"}]}',
        },
      },
    })
  })

  it('answers the direct runtime probe asynchronously without exposing background state', async () => {
    const response = dispatchRuntimeMessage(
      {
        type: EXTENSION_BACKGROUND_PROBE_REQUEST_TYPE,
        requestId: 'background-probe-1',
      },
      { tab: { id: 1 } },
    )

    expect(response).toBeInstanceOf(Promise)
    await expect(response).resolves.toEqual({
      type: EXTENSION_BACKGROUND_PROBE_RESPONSE_TYPE,
      requestId: 'background-probe-1',
      ok: true,
      version: getCurrentAppVersion(),
    })
  })

  it('binds a delivery worker identity to the real Chrome tab id through an async response', async () => {
    const response = dispatchRuntimeMessage(
      {
        type: DELIVERY_WORKER_IDENTITY_REQUEST_TYPE,
        sessionToken: 'session-token-123',
      },
      { tab: { id: 42 } },
    )

    expect(response).toBeInstanceOf(Promise)
    await expect(response).resolves.toEqual({
      type: DELIVERY_WORKER_IDENTITY_RESPONSE_TYPE,
      workerId: 'boss-tab-42:session-token-123',
    })
    expect(
      dispatchRuntimeMessage(
        {
          type: DELIVERY_WORKER_IDENTITY_REQUEST_TYPE,
          sessionToken: 'session-token-123',
        },
        {},
      ),
    ).toBeUndefined()
  })

  it('allows an embedded extension page but rejects a BOSS page for full config reads', async () => {
    storageGet.mockResolvedValueOnce(null)
    const request = {
      type: 'AGENT_DELIVERY_CONFIG_REQUEST',
      requestId: 'config-get-1',
      action: 'get',
      uid: 'account-a',
    }

    await expect(
      dispatchRuntimeMessage(request, {
        id: 'test-extension',
        tab: { id: 7 },
        url: 'chrome-extension://test-extension/options.html?uid=account-a',
      }),
    ).resolves.toMatchObject({ ok: true, requestId: 'config-get-1' })
    expect(
      dispatchRuntimeMessage(request, {
        id: 'test-extension',
        tab: { id: 7 },
        url: 'https://www.zhipin.com/web/geek/job',
      }),
    ).toEqual({
      type: 'AGENT_DELIVERY_CONFIG_RESPONSE',
      requestId: 'config-get-1',
      ok: false,
      errorCode: 'CONFIG_FORBIDDEN',
      error: '当前上下文无权访问完整配置',
    })
  })

  it('returns one sanitized account snapshot without cookies or AI secrets', async () => {
    const background = new BackgroundCounter() as BackgroundCounter & {
      accountState(uid: string): Promise<unknown>
    }

    const result = await background.accountState('account-b')
    const serialized = JSON.stringify(result)

    expect(storageGet).toHaveBeenCalledWith(userKey, { fallback: {} })
    expect(result).toEqual({
      uid: 'account-b',
      metadata: {
        user: '账号 B',
        avatar: '',
        remark: 'remark-b',
        gender: 'man',
        flag: 'staff',
        date: '2026-07-10',
      },
      form: {
        userId: 'account-b',
        useCache: { value: true },
        record: { enable: true },
        amap: {
          origins: '116.397,39.908',
          straightDistance: 1_200,
          drivingDistance: 1_800,
          enable: false,
        },
        aiGreeting: { enable: true },
      },
      statistics: '{"t":{"date":"2026-07-10","total":5},"s":[{"date":"2026-07-09","success":2}]}',
    })
    for (const secret of [
      'account-a',
      'cookie-secret',
      'account-b-prompt-secret',
      'private-model-key',
      'nested-token-secret',
      'record-model-secret',
      'nested-prompt-secret',
      'nested-model-secret',
      'nested-cookie-secret',
      'nested-access-token-secret',
      'top-level-cookie-secret',
      'unknown-top-level-api-key',
      'public-distance-value',
      'metadata-token-secret',
      'statistics-token-secret',
      'statistics-model-secret',
      'amap-secret-api-key',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).not.toMatch(/"(?:cookies|prompt|model|token|accessToken)"/)
    expect(serialized).not.toContain('"key"')
  })

  it('returns null for an unknown account', async () => {
    const background = new BackgroundCounter() as BackgroundCounter & {
      accountState(uid: string): Promise<unknown>
    }

    await expect(background.accountState('missing')).resolves.toBeNull()
  })

  it('rejects AI tasks that do not identify an initialized canonical account', async () => {
    const response = await dispatchRuntimeMessage(
      {
        type: AI_TASK_REQUEST_TYPE,
        requestId: 'missing-canonical-account',
        task: 'aiFiltering',
        data: {},
        json: true,
      },
      { tab: { id: 30 }, documentId: 'missing-canonical-account-document' },
    )

    expect(response).toMatchObject({
      type: AI_TASK_RESPONSE_TYPE,
      requestId: 'missing-canonical-account',
      ok: false,
      errorCode: 'AI_TASK_FAILED',
    })
    expect(runConfiguredAiTask).not.toHaveBeenCalled()
  })

  it('runs canonical filtering with the stored model and resume evidence', async () => {
    const state = canonicalState()
    storageGet.mockResolvedValue(state)
    const content = JSON.stringify({
      matchPercent: 81,
      level: 'good',
      reason: '平台经验匹配',
      selectedFactIds: ['fact-canonical'],
    })
    runConfiguredAiTask.mockResolvedValue({ content, prompt: 'private-canonical-prompt' })

    const response = await dispatchRuntimeMessage(
      {
        type: AI_TASK_REQUEST_TYPE,
        requestId: 'canonical-filtering',
        task: 'aiFiltering',
        data: {
          accountUid: 'account-canonical',
          data: {
            jobName: '平台产品经理',
            securityId: 'must-not-reach-model',
          },
          card: {
            jobName: '平台产品经理',
            postDescription: '负责平台产品规划与落地',
            jobInfo: { postDescription: 'must-not-duplicate-jd' },
          },
        },
        json: true,
      },
      { tab: { id: 31 }, documentId: 'canonical-filtering-document' },
    )

    expect(response).toEqual({
      type: AI_TASK_RESPONSE_TYPE,
      requestId: 'canonical-filtering',
      ok: true,
      data: {
        content: JSON.stringify({
          matchPercent: 81,
          level: 'good',
          reason: '平台经验匹配',
          selectedFactIds: ['fact-canonical'],
          claimMode: 'direct',
        }),
      },
    })
    expect(runConfiguredAiTask).toHaveBeenCalledTimes(1)
    const call = runConfiguredAiTask.mock.calls[0][0]
    expect(call.model).toEqual(state.models[0])
    expect(call.task).toBe('aiFiltering')
    const serializedTemplate = JSON.stringify(call.template)
    // 阈值不进模板。见 aiTaskPrompts.test.ts 里同名守护的说明。
    expect(serializedTemplate).not.toContain('filteringThreshold')
    expect(serializedTemplate).toContain('fact-canonical')
    expect(serializedTemplate).toContain('负责平台产品规划与落地')
    expect(serializedTemplate).not.toContain('must-not-reach-model')
    expect(serializedTemplate).not.toContain('must-not-duplicate-jd')
    expect(JSON.stringify(response)).not.toContain('private-canonical-prompt')
    expect(JSON.stringify(response)).not.toContain('canonical-secret')
  })

  it('uses the canonical greeting count and length contract', async () => {
    storageGet.mockResolvedValue(canonicalState({ messageCount: 2 }))
    const draft = {
      messages: [
        '王老师您好，我是候选人。关注到贵司的平台产品经理岗位。',
        '过往负责过B端SaaS平台，希望进一步了解岗位目标。',
      ],
      usedFactIds: ['fact-canonical'],
      claimMode: 'direct',
      openingPattern: 'job-hook',
    }
    runConfiguredAiTask.mockResolvedValue({
      content: JSON.stringify(draft),
      prompt: 'private-canonical-prompt',
    })

    const response = await dispatchRuntimeMessage(
      {
        ...greetingMessage('canonical-greeting'),
        data: {
          ...greetingMessage('unused').data,
          accountUid: 'account-canonical',
          filtering: {
            matchPercent: 82,
            level: 'good',
            reason: '平台经验匹配',
            selectedFactIds: ['fact-canonical'],
            claimMode: 'direct',
          },
        },
      },
      { tab: { id: 32 }, documentId: 'canonical-greeting-document' },
    )

    expect(response).toEqual({
      type: AI_TASK_RESPONSE_TYPE,
      requestId: 'canonical-greeting',
      ok: true,
      data: { content: JSON.stringify(draft) },
    })
    expect(runConfiguredAiTask).toHaveBeenCalledTimes(1)
    const call = runConfiguredAiTask.mock.calls[0][0]
    expect(call.task).toBe('aiGreeting')
    expect(call.jsonSchema.properties.messages).toMatchObject({ minItems: 2, maxItems: 2 })
    expect(call.template[0].content).toContain('恰好 2 条')
    expect(call.template[0].content).toContain('45-95')
    expect(JSON.stringify(response)).not.toContain('private-canonical-prompt')
  })

  it('accepts the first greeting draft when only the soft length target is missed', async () => {
    const state = canonicalState({ messageCount: 2 })
    state.tasks.aiGreeting.minTotalCharacters = 20
    state.tasks.aiGreeting.maxTotalCharacters = 60
    storageGet.mockResolvedValue(state)
    runConfiguredAiTask.mockResolvedValue({
      content: JSON.stringify({
        messages: [`王老师您好，我是候选人。${'x'.repeat(45)}`, 'y'.repeat(45)],
        usedFactIds: ['fact-canonical'],
        claimMode: 'direct',
        openingPattern: 'job-hook',
      }),
    })
    const message = greetingMessage('greeting-too-long-twice')
    ;(message.data as typeof message.data & { accountUid: string }).accountUid = 'account-canonical'
    message.data.filtering.selectedFactIds = ['fact-canonical']

    const response = await dispatchRuntimeMessage(message, {
      tab: { id: 35 },
      documentId: 'greeting-too-long-document',
    })

    expect(runConfiguredAiTask).toHaveBeenCalledTimes(1)
    expect(response).toMatchObject({
      type: AI_TASK_RESPONSE_TYPE,
      requestId: 'greeting-too-long-twice',
      ok: true,
    })
    expect(
      JSON.parse((response as { data: { content: string } }).data.content).messages,
    ).toHaveLength(2)
  })

  it('regenerates an explicit third-person self-description once', async () => {
    const state = canonicalState({ messageCount: 2 })
    storageGet.mockResolvedValue(state)
    runConfiguredAiTask.mockResolvedValueOnce({
      content: JSON.stringify({
        messages: [
          '候选人担任平台产品经理，关注到当前岗位。',
          '相关经验能够支持产品规划和持续迭代。',
        ],
        usedFactIds: ['fact-canonical'],
        claimMode: 'direct',
        openingPattern: 'job-hook',
      }),
    })
    runConfiguredAiTask.mockResolvedValueOnce({
      content: JSON.stringify({
        messages: [
          '王老师您好，我是候选人，关注到当前平台产品经理岗位。',
          '我负责过B端SaaS平台，相关经验能够支持产品规划和持续迭代。',
        ],
        usedFactIds: ['fact-canonical'],
        claimMode: 'direct',
        openingPattern: 'job-hook-repaired',
      }),
    })
    const message = greetingMessage('greeting-third-person-twice')
    ;(message.data as typeof message.data & { accountUid: string }).accountUid = 'account-canonical'
    message.data.filtering.selectedFactIds = ['fact-canonical']

    const response = await dispatchRuntimeMessage(message, {
      tab: { id: 36 },
      documentId: 'greeting-third-person-document',
    })

    expect(runConfiguredAiTask).toHaveBeenCalledTimes(2)
    expect(response).toMatchObject({
      type: AI_TASK_RESPONSE_TYPE,
      requestId: 'greeting-third-person-twice',
      ok: true,
    })
  })

  it('generates greetings directly from resume evidence when AI filtering is disabled', async () => {
    const state = canonicalState()
    state.tasks.aiFiltering.enabled = false
    storageGet.mockResolvedValue(state)
    const draft = {
      messages: [
        '王老师您好，我是候选人。关注到贵司的平台产品经理岗位。',
        '过往负责过B端SaaS平台，希望进一步了解岗位目标。',
      ],
      usedFactIds: ['fact-canonical'],
      claimMode: 'direct',
      openingPattern: 'job-hook',
    }
    runConfiguredAiTask.mockResolvedValue({ content: JSON.stringify(draft) })
    const message = greetingMessage('greeting-without-filtering')
    delete (message.data as Partial<typeof message.data>).filtering
    ;(message.data as typeof message.data & { accountUid: string }).accountUid = 'account-canonical'

    const response = await dispatchRuntimeMessage(message, {
      tab: { id: 33 },
      documentId: 'greeting-without-filtering-document',
    })

    expect(response).toMatchObject({
      type: AI_TASK_RESPONSE_TYPE,
      requestId: 'greeting-without-filtering',
      ok: true,
    })
    const call = runConfiguredAiTask.mock.calls[0][0]
    expect(JSON.stringify(call.template)).toContain('fact-canonical')
    expect(call.template[0].content).toContain('不要跟随 filtering.claimMode')
  })

  it('rejects a filtering context without usable fact IDs at the protocol boundary', async () => {
    const state = canonicalState()
    state.profile.resume.evidence!.facts[0].evidenceType = 'adjacent_only'
    state.profile.resume.evidence!.facts.push({
      ...state.profile.resume.evidence!.facts[0],
      id: 'fact-secondary',
      object: '企业服务产品规划',
      skills: ['需求分析'],
    })
    storageGet.mockResolvedValue(state)
    const draft = {
      messages: [
        '王老师您好，我是候选人。关注到贵司的平台产品经理岗位。',
        '相关平台经验可以迁移到当前岗位，希望进一步了解团队目标。',
      ],
      usedFactIds: ['fact-canonical'],
      claimMode: 'adjacent',
      openingPattern: 'job-hook',
    }
    runConfiguredAiTask.mockResolvedValue({ content: JSON.stringify(draft) })

    const message = greetingMessage('greeting-empty-filtering-facts')
    ;(message.data as typeof message.data & { accountUid: string }).accountUid = 'account-canonical'
    message.data.filtering.selectedFactIds = []

    const response = await dispatchRuntimeMessage(message, {
      tab: { id: 34 },
      documentId: 'greeting-empty-filtering-facts-document',
    })

    expect(response).toBeUndefined()
    expect(runConfiguredAiTask).not.toHaveBeenCalled()
  })

  it('keeps the per-tab concurrency limit across a new document in the same tab', async () => {
    storageGet.mockResolvedValue(canonicalState())
    const pendingResolvers: Array<(value: unknown) => void> = []
    runConfiguredAiTask.mockImplementation(() => {
      if (runConfiguredAiTask.mock.calls.length <= 2) {
        return new Promise((resolve) => pendingResolvers.push(resolve))
      }
      return Promise.resolve({ content: 'unexpected third result', prompt: 'internal' })
    })
    const message = (requestId: string) => ({
      type: AI_TASK_REQUEST_TYPE,
      requestId,
      task: 'aiFiltering',
      data: { accountUid: 'account-canonical' },
      json: true,
    })

    const first = dispatchRuntimeMessage(message('tab-task-1'), {
      tab: { id: 17 },
      documentId: 'document-1',
    })
    const second = dispatchRuntimeMessage(message('tab-task-2'), {
      tab: { id: 17 },
      documentId: 'document-1',
    })
    const third = await dispatchRuntimeMessage(message('tab-task-3'), {
      tab: { id: 17 },
      documentId: 'document-2',
    })

    await vi.waitFor(() => expect(runConfiguredAiTask).toHaveBeenCalledTimes(2))
    expect(third).toEqual(
      expect.objectContaining({
        type: AI_TASK_RESPONSE_TYPE,
        requestId: 'tab-task-3',
        ok: false,
        errorCode: 'AI_TASK_FAILED',
        error: '后台AI任务失败',
      }),
    )

    const content = JSON.stringify({
      matchPercent: 81,
      level: 'good',
      reason: '平台经验匹配',
      selectedFactIds: ['fact-canonical'],
    })
    pendingResolvers.forEach((resolve) => resolve({ content, prompt: 'internal' }))
    await Promise.all([first, second])
  })
})
