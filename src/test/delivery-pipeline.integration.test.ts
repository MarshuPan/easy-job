import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TechwolfChatProtocol } from '@/composables/useWebSocket/type'

// External browser, BOSS, model and local-file boundaries only. The real pool,
// pipeline, page/content/background validators, AI adapter, audit, protobuf,
// dedupe, records and statistics remain connected.
const fixture = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
  runtimeListeners: [] as Array<(message: any, sender: any) => any>,
  pages: [] as any[],
  aiRequests: [] as any[],
  modelBodies: [] as any[],
  diagnostics: [] as any[],
  sequence: [] as string[],
  formData: undefined as any,
  aiDown: false,
  send: vi.fn(),
  http: vi.fn(),
  get: vi.fn(),
  windowListeners: [] as Array<{ type: string; listener: any }>,
}))

const copy = (value: unknown) => (value == null ? value : JSON.parse(JSON.stringify(value)))

vi.mock('comctx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('comctx')>()),
  // RPC transport is represented by ContentCounter -> BackgroundCounter below.
  defineProxy: () => [vi.fn(), vi.fn(() => ({}))],
}))
vi.mock('#imports', async () => ({
  ...(await import('vue')),
  storage: {
    getItem: vi.fn(async (key: string) => copy(fixture.storage.get(key) ?? null)),
    setItem: vi.fn(async (key: string, value: unknown) => fixture.storage.set(key, copy(value))),
    removeItem: vi.fn(async (key: string) => fixture.storage.delete(key)),
  },
  browser: {
    runtime: {
      id: 'integration-extension',
      getURL: (path: string) => `chrome-extension://integration-extension/${path}`,
      onMessage: {
        addListener: (listener: any) => fixture.runtimeListeners.push(listener),
        removeListener: vi.fn(),
      },
      sendMessage: vi.fn(async (_id: string, message: any) => {
        if (message.task) fixture.aiRequests.push(copy(message))
        for (const listener of fixture.runtimeListeners) {
          const response = listener(message, {
            tab: { id: 41 },
            documentId: 'fixture-document',
            id: 'integration-extension',
          })
          if (response !== undefined) return await response
        }
        throw new Error('No extension transport listener')
      }),
    },
    tabs: {
      query: vi.fn(async () => []),
      sendMessage: vi.fn(),
      onRemoved: { addListener: vi.fn() },
    },
    storage: { local: { getBytesInUse: vi.fn(async () => 0) } },
  },
}))
vi.mock('@/message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/message')>()
  const { BackgroundCounter } = await import('@/message/background')
  const { ContentCounter } = await import('@/message/contentScript')
  const api = new ContentCounter(new BackgroundCounter())
  return {
    ...actual,
    counter: new Proxy(api, {
      get(target, key) {
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
  }
})
vi.mock('@/background/localDiagnosticSink', () => ({
  appendLocalDiagnosticEvent: vi.fn(async (event: any) => {
    fixture.diagnostics.push(copy(event))
    return true
  }),
}))
vi.mock('@/stores/conf', () => ({
  formDataKey: 'fixture-form',
  useConf: () => ({
    get formData() {
      return fixture.formData
    },
    aiTaskTimeoutSeconds: 60,
    availableJobExpectations: [],
  }),
}))
vi.mock('@/composables/useVue', () => ({
  getRootVue: vi.fn(async () => null),
  useHookVueData:
    (_selectors: string, key: string, target: any, update?: (value: any) => void) => async () => {
      if (key === 'jobList') {
        target.value = fixture.pages
        update?.(fixture.pages)
      }
    },
  useHookVueFn: () => async () => vi.fn(),
}))
vi.mock('axios', () => ({ default: Object.assign(fixture.http, { get: fixture.get }) }))
vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/ui/instrument', () => ({
  AgentMessage: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

const factIds = ['fact-planning', 'fact-research', 'fact-delivery', 'fact-measurement']
const messages = [
  '老师您好，我是平台产品经理。',
  '我负责平台规划、用户调研和交付，并用数据核对上线效果。',
  '这些工作覆盖了平台从需求确认到上线验证的完整过程，期待交流。',
]
const jd = '负责平台规划、用户调研、交付和数据验证'

function listJob(id = 'fixture-job', brand = 'fixture-brand') {
  return {
    encryptJobId: id,
    encryptBossId: 'fixture-hr',
    encryptBrandId: brand,
    securityId: `fixture-security-${id}`,
    lid: `fixture-lid-${id}`,
    jobName: '平台产品经理',
    brandName: '示例公司',
    brandScaleName: '100-499人',
    salaryDesc: '20-30K',
    cityName: '示例城市',
    jobExperience: '3-5年',
    jobDegree: '本科',
    bossName: '示例招聘者',
    bossTitle: '招聘经理',
    contact: false,
    fetchedAt: Date.now(),
  }
}

function detail(id: string, securityId: string) {
  return {
    securityId,
    lid: `fixture-lid-${id}`,
    sessionId: 'fixture-session',
    jobInfo: {
      encryptId: id,
      encryptUserId: 'fixture-hr',
      jobName: '平台产品经理',
      postDescription: jd,
      salaryDesc: '20-30K',
      locationName: '示例城市',
      experienceName: '3-5年',
      degreeName: '本科',
      showSkills: ['平台规划'],
      address: '示例地址',
    },
    bossInfo: {
      name: '示例招聘者',
      title: '招聘经理',
      bossOnline: true,
      activeTimeDesc: '刚刚活跃',
    },
    brandComInfo: { brandName: '示例公司' },
    relationInfo: { beFriend: false, interestJob: false },
  }
}

async function finish<T>(operation: Promise<T>): Promise<T> {
  // Observe rejection before advancing timers; every wait is simulated locally.
  const result = operation.then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await vi.advanceTimersByTimeAsync(180_000)
  const settled = await result
  if ('error' in settled) throw settled.error
  return settled.value
}

async function initialize() {
  const { defaultFormData } = await import('@/stores/conf/info')
  const { createDefaultStoredConfigState, createDefaultDeliverySettings } =
    await import('@/config/defaults')
  const { CONFIG_STORAGE_KEY } = await import('@/config/types')
  const form = copy(defaultFormData) as typeof defaultFormData
  form.aiFiltering.enable = true
  form.aiFiltering.score = 60
  form.aiGreeting.enable = true
  form.aiGreeting.messageCount = 3
  form.friendStatus.value = true
  form.sameCompanyFilter.value = true
  form.sameHrFilter.value = true
  form.useCache.value = false
  form.activityFilter.value = false
  form.companySizeRange.enable = false
  fixture.formData = form
  const state = createDefaultStoredConfigState()
  state.profile = {
    displayName: '示例候选人',
    targetRole: '平台产品经理',
    resume: {
      markdown: '我负责平台规划、用户调研和交付，并用数据核对上线效果。',
      evidenceVersion: 3,
      sourceHash: `sha256:${'a'.repeat(64)}`,
      evidence: {
        facts: factIds.map((id, i) => ({
          id,
          sourceQuote: ['平台规划', '用户调研', '交付', '数据'][i],
          action: '负责',
          object: ['平台规划', '用户调研', '交付', '数据验证'][i],
          evidenceType: 'direct_fact' as const,
          allowedClaimVerbs: ['负责'],
        })),
        claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
      },
    },
  }
  state.models = [
    {
      id: 'fixture-model',
      name: '示例模型',
      protocol: 'openai-responses',
      url: 'https://model.example.test/v1/responses',
      apiKey: 'fixture-key',
      model: 'fixture-model',
      reasoningEffort: 'high',
      timeoutSeconds: 60,
      responsesBackground: 'off',
      generation: { temperature: null, topP: null, presencePenalty: null, frequencyPenalty: null },
    },
  ]
  state.tasks.aiFiltering = {
    ...state.tasks.aiFiltering,
    enabled: true,
    modelId: 'fixture-model',
    score: 60,
  }
  state.tasks.aiGreeting = {
    ...state.tasks.aiGreeting,
    enabled: true,
    modelId: 'fixture-model',
    messageCount: 3,
  }
  state.accountSettings['10001'] = createDefaultDeliverySettings()
  fixture.storage.set(CONFIG_STORAGE_KEY, state)

  await import('@/message/background')
  const { setBridgeToken } = await import('@/message/contentScript')
  setBridgeToken('fixture-bridge')
  const { useLog } = await import('@/stores/log')
  const { useStatistics } = await import('@/composables/useStatistics')
  const { jobList } = await import('@/stores/jobs')
  const log = useLog()
  const stats = useStatistics()
  await stats.setAccountScope('10001')
  await log.setAccountScope('10001')
  await jobList.setAccountScope('10001')
  fixture.pages.push(listJob())
  await jobList.initJobList(form)
  expect(
    jobList.captureCurrentPageToDeliveryPool(
      'group',
      undefined,
      undefined,
      undefined,
      '示例期望',
      1,
    ),
  ).toBe(1)

  // Reproduce the previous failure: a sent historical greeting cites four facts.
  const historicalJob = { ...jobList.list[0], encryptJobId: 'historical-job' }
  const context: any = {
    listData: historicalJob,
    aiGreetingMessages: ['历史话术与本次正文不同'],
    aiGreetingMeta: {
      usedFactIds: factIds,
      segmentFactIds: [factIds],
      fingerprint: 'fixture-history',
    },
    greetingSend: { ok: true, type: 'ai', messageCount: 1, messages: [] },
    state: '成功',
    deliveryStage: '投递成功',
  }
  const history = log.startDelivery(historicalJob, context)
  log.finishDelivery(history, null, context)
  await log.flush()
  const { useDeliver } = await import('@/pages/zhipin/hooks/useDeliver')
  const { useCommon } = await import('@/composables/useCommon')
  return { form, log, stats, pool: jobList, deliver: useDeliver(), common: useCommon() }
}

describe('local simulation of the delivery workflow across internal boundaries', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-07T02:00:00Z'))
    setActivePinia(createPinia())
    fixture.storage.clear()
    fixture.runtimeListeners.length = 0
    fixture.pages.length =
      fixture.aiRequests.length =
      fixture.modelBodies.length =
      fixture.diagnostics.length =
      fixture.sequence.length =
        0
    fixture.aiDown = false
    const addListener = window.addEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      fixture.windowListeners.push({ type, listener })
      addListener(type, listener, options)
    })
    sessionStorage.clear()
    document.body.innerHTML = ''
    window.history.replaceState({}, '', '/web/geek/jobs')
    Object.assign(window, {
      _PAGE: { uid: '10001' },
      Cookie: { get: () => 'fixture-bst' },
      GeekChatCore: undefined,
      ChatWebsocket: { send: fixture.send, client: { isConnected: () => true } },
    })
    fixture.send.mockImplementation(() => fixture.sequence.push('text-send'))
    const script = document.createElement('script')
    script.setAttribute('data-agent-delivery-token', 'fixture-bridge')
    Object.defineProperty(document, 'currentScript', { configurable: true, value: script })
    vi.spyOn(window, 'postMessage').mockImplementation((data) => {
      window.dispatchEvent(
        new MessageEvent('message', { data, source: window, origin: location.origin }),
      )
    })
    fixture.get.mockImplementation(async (_url, options) => {
      fixture.sequence.push('detail')
      const id = String(options.params.lid).replace('fixture-lid-', '')
      return { data: { code: 0, zpData: detail(id, options.params.securityId) } }
    })
    fixture.http.mockImplementation(async (request) => {
      if (request.url.endsWith('/friend/add.json')) {
        fixture.sequence.push('publish')
        return { data: { code: 0, message: 'Success' } }
      }
      if (request.url.endsWith('/getBossData')) {
        return {
          data: {
            code: 0,
            zpData: { data: { bossId: 20002, encryptBossId: 'fixture-hr', name: '示例招聘者' } },
          },
        }
      }
      throw new Error(`Unexpected BOSS fixture path: ${new URL(request.url).pathname}`)
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        fixture.modelBodies.push(body)
        if (fixture.aiDown)
          return new Response(
            JSON.stringify({
              error: {
                message: 'Upstream service temporarily unavailable',
                type: 'upstream_error',
              },
            }),
            { status: 502 },
          )
        const filtering = String(body.input[0].content).includes('岗位匹配度评估器')
        fixture.sequence.push(filtering ? 'match' : 'greeting')
        const output = filtering
          ? {
              matchPercent: 85,
              level: 'strong',
              reason: '规划、调研、交付与数据验证均有实际经历',
              risk: null,
              selectedFactIds: factIds,
            }
          : {
              anchor: { need: '推进平台从规划到上线验证', jdQuote: jd },
              messages,
              usedFactIds: factIds,
              segmentFactIds: [[], factIds, []],
            }
        return new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: JSON.stringify(output) }],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )
  })
  afterEach(() => {
    for (const { type, listener } of fixture.windowListeners.splice(0))
      window.removeEventListener(type, listener)
    Reflect.deleteProperty(document, 'currentScript')
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('carries four historical, matched and generated facts through to sending and durable records', async () => {
    const { form, log, stats, pool, deliver } = await initialize()
    const item = pool.listBySource('group')[0]
    expect(await finish(deliver.jobListHandle([{ item, source: 'group' }], form))).toBe('completed')
    expect(
      item.status.status,
      log.data.value
        .map((record) => record.data?.failureReason)
        .filter(Boolean)
        .join('; '),
    ).toBe('success')
    const record = log.data.value.find((record) => record.job?.encryptJobId === item.encryptJobId)!
    expect(record.data?.publish?.ok).toBe(true)
    expect(record.data?.greetingSend).toMatchObject({ ok: true, messageCount: 3 })
    expect(record.data?.aiGreetingMeta?.audit).toMatchObject({
      greetingUsedFactIds: factIds,
      segmentFactMappingComplete: true,
      claimBoundaryValid: true,
      resumeEvidenceMatches: true,
    })
    expect(record.data?.aiGreetingMeta?.audit).not.toHaveProperty('maxFacts')
    expect(fixture.aiRequests.find((request) => request.task === 'aiGreeting').data).toMatchObject({
      filtering: { selectedFactIds: factIds },
      recentGreetings: [expect.objectContaining({ usedFactIds: factIds })],
    })
    expect(fixture.sequence).toEqual([
      'detail',
      'match',
      'greeting',
      'publish',
      'text-send',
      'text-send',
      'text-send',
    ])
    const { AwesomeMessage } = await import('@/composables/useWebSocket/type')
    const sentTexts = fixture.send.mock.calls.map(
      ([message]) =>
        (AwesomeMessage.decode(message.msg) as unknown as TechwolfChatProtocol).messages?.[0]?.body
          ?.text,
    )
    expect(sentTexts).toEqual(messages)
    expect(stats.todayData).toMatchObject({ total: 1, success: 1, groupSuccess: 1 })
    await log.flush()
    await stats.flush()
    await pool.flushSourcePools()
    expect(
      [...fixture.storage.values()].some((value) =>
        JSON.stringify(value).includes('segmentFactMappingComplete'),
      ),
    ).toBe(true)
    expect(
      fixture.diagnostics.some(
        (event) =>
          event.event === 'delivery.finished' &&
          event.data?.publish?.ok &&
          event.data?.greetingSend?.ok,
      ),
    ).toBe(true)

    // Reprocessing a successful pool item does not establish contact or send again.
    await finish(deliver.jobListHandle([{ item, source: 'group' }], form))
    expect(fixture.sequence.filter((step) => step === 'publish')).toHaveLength(1)
    expect(fixture.send).toHaveBeenCalledTimes(3)
    // A different JD with the same HR is filtered in this natural week.
    fixture.pages.splice(0, 1, listJob('same-hr-job', 'another-brand'))
    await pool.initJobList(form)
    pool.captureCurrentPageToDeliveryPool('group')
    const sameHrJob = pool.listBySource('group').find((job) => job.encryptJobId === 'same-hr-job')!
    await finish(deliver.jobListHandle([{ item: sameHrJob, source: 'group' }], form))
    expect(sameHrJob.status.status).toBe('filtered')
    expect(
      log.data.value.find((record) => record.job?.encryptJobId === 'same-hr-job')?.data
        ?.failureReason,
    ).toContain('本周')
    expect(fixture.sequence.filter((step) => step === 'publish')).toHaveLength(1)
  })

  it('keeps the job and quota untouched on 502, then continues once without duplicate contact', async () => {
    const { form, stats, pool, deliver, common } = await initialize()
    const item = pool.listBySource('group')[0]
    fixture.aiDown = true
    expect(await finish(deliver.jobListHandle([{ item, source: 'group' }], form))).toBe(
      'aiUnavailable',
    )
    expect(item.status.status).toBe('wait')
    expect(stats.todayData).toMatchObject({ total: 0, success: 0 })
    expect(fixture.modelBodies).toHaveLength(3)
    expect(fixture.sequence).not.toContain('publish')
    expect(fixture.send).not.toHaveBeenCalled()
    fixture.aiDown = false
    common.deliverStop = false
    expect(await finish(deliver.jobListHandle([{ item, source: 'group' }], form))).toBe('completed')
    expect(item.status.status).toBe('success')
    expect(stats.todayData).toMatchObject({ total: 1, success: 1 })
    expect(fixture.sequence.filter((step) => step === 'publish')).toHaveLength(1)
    expect(fixture.send).toHaveBeenCalledTimes(3)
  })
})
