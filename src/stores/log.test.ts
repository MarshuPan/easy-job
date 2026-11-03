import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRef } from 'vue'

const { localDiagnosticAppendMock, storageGetMock, storageRmMock, storageSetMock } = vi.hoisted(
  () => ({
    localDiagnosticAppendMock: vi.fn(async (_input: unknown) => true),
    storageGetMock: vi.fn<(key: string, fallback?: unknown) => Promise<unknown>>(async () => []),
    storageRmMock: vi.fn<(key: string) => Promise<boolean>>(async () => true),
    storageSetMock: vi.fn<(key: string, value: unknown) => Promise<boolean>>(async () => true),
  }),
)

vi.mock('@/message', () => ({
  counter: {
    localDiagnosticAppend: localDiagnosticAppendMock,
    storageGet: storageGetMock,
    storageRm: storageRmMock,
    storageSet: storageSetMock,
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}))

vi.mock('@/utils/providerHealth', () => ({
  getProviderHeartbeatDiagnostic: vi.fn((error) => ({ error })),
}))

import { assertAllowedStorageKey } from '@/message/storageKeys'

const DAY_MS = 24 * 60 * 60 * 1000
const persisted = new Map<string, unknown>()

function dayOf(timestamp: number) {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const recordsKey = (uid: string, day: string) => `local:agent-delivery-records:${uid}:${day}`
const indexKey = (uid: string) => `local:agent-delivery-records:${uid}:days`
const eventsKey = (uid: string) => `local:agent-delivery-run-events:${uid}`

function storedRecords(uid: string, timestamp = Date.now()) {
  return (persisted.get(recordsKey(uid, dayOf(timestamp))) ?? []) as any[]
}

/** 按记录的日期写入存储，模拟上一次页面会话留下的数据。 */
function seedRecords(uid: string, records: any[]) {
  const days = new Set((persisted.get(indexKey(uid)) as string[] | undefined) ?? [])
  // 存储里只可能有可序列化的数据；岗位上的函数（setStatus 等）不会落盘。
  for (const record of JSON.parse(JSON.stringify(records))) {
    const day = dayOf(record.createdAt)
    const key = recordsKey(uid, day)
    persisted.set(key, [...((persisted.get(key) as any[]) ?? []), record])
    days.add(day)
  }
  persisted.set(indexKey(uid), [...days].sort())
}

/** 每个用例用一份新的模块状态，模拟刷新页面后重新加载。 */
async function loadLog(uid: string | null = 'account-a') {
  vi.resetModules()
  const module = await import('./log')
  const store = module.useLog()
  if (uid != null) await store.setAccountScope(uid)
  return { module, store }
}

function makeJob(encryptJobId = 'job-active') {
  return {
    encryptJobId,
    jobName: '活跃度岗位',
    cityName: '上海',
    salaryDesc: '30-60K',
    jobExperience: '5-10年',
    jobDegree: '本科',
    jobLabels: [],
    brandName: '活跃度公司',
    brandScaleName: '1000人以上',
    bossName: '宋女士',
    bossTitle: '招聘经理',
    expectId: 101,
    status: {
      status: 'wait',
      msg: '等待中',
      setStatus: vi.fn(),
    },
    getCard: vi.fn(),
    card: {
      postDescription: '岗位描述',
      jobName: '活跃度岗位',
      salaryDesc: '30-60K',
      cityName: '上海',
      experienceName: '5-10年',
      degreeName: '本科',
      jobLabels: ['AI 产品'],
      address: '上海',
      bossName: '宋女士',
      bossTitle: '招聘经理',
      activeTimeDesc: '本月活跃',
      brandName: '活跃度公司',
      encryptJobId,
    },
  }
}

function interruptedRecord(data: Record<string, unknown>) {
  const job = makeJob() as any
  return {
    createdAt: Date.now() - 1000,
    data: { listData: job, ...data },
    job,
    state: 'info',
    state_name: String(data.deliveryStage),
    title: job.jobName,
  }
}

describe('useLog persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persisted.clear()
    // 每个键都过一遍真实的白名单。1.3.7 真机上岗位记录一条都没存下来，就是因为拆出来的
    // 新键没进白名单，而这里的存储是 mock 的，测试全绿。
    storageGetMock.mockImplementation(async (key: string, fallback?: unknown) => {
      assertAllowedStorageKey(key)
      return persisted.has(key) ? structuredClone(persisted.get(key)) : fallback
    })
    storageSetMock.mockImplementation(async (key: string, value: unknown) => {
      assertAllowedStorageKey(key)
      persisted.set(key, structuredClone(value))
      return true
    })
    storageRmMock.mockImplementation(async (key: string) => {
      assertAllowedStorageKey(key)
      persisted.delete(key)
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  // 形状契约：消费方必须通过 .value 读取日志记录。
  // 这条断言存在的原因是 useDeliver 曾把 log.data 当成裸数组做 Array.isArray 判断，
  // 而测试把 useLog() mock 成裸数组，于是招呼语续发链路在生产恒不执行、测试却全绿。
  // 任何把 data 从 Ref 改成裸数组的重构都必须先让这条断言失败。
  it('exposes delivery records as a ref so consumers must read .value', async () => {
    const { store } = await loadLog(null)
    expect(isRef(store.data)).toBe(true)
    expect(Array.isArray(store.data)).toBe(false)
    expect(Array.isArray(store.data.value)).toBe(true)
  })

  it('keeps records in memory until the account is known, then saves them to that account', async () => {
    const { store } = await loadLog(null)
    const job = makeJob() as any
    store.startDelivery(job, { listData: job } as any)
    await store.flush()
    expect(storageSetMock).not.toHaveBeenCalled()

    await store.setAccountScope('account-a')

    expect(storedRecords('account-a').map((item) => item.job.encryptJobId)).toEqual(['job-active'])
    expect(persisted.get(indexKey('account-a'))).toEqual([dayOf(Date.now())])
  })

  it('persists HR active time from compacted job cards', async () => {
    const { store } = await loadLog()
    const job = makeJob() as any
    store.startDelivery(job, {
      listData: job,
      deliverySource: 'group',
      deliverySourceName: 'AI 产品经理',
    } as any)
    await store.flush()

    const [record] = storedRecords('account-a')
    expect(record.job.card.activeTimeDesc).toBe('本月活跃')
    expect(record.job.expectId).toBe(101)
    expect(record.data.deliverySourceName).toBe('AI 产品经理')
    // 岗位只保存在 record.job 一处；data.listData 不再重复写入（曾使每条记录含两份完整 JD）。
    expect(record.data.listData).toBeUndefined()
  })

  it('keeps enough of the JD to check an AI filtering decision against it', async () => {
    // AI 匹配是拿简历事实和这段 JD 比出来的。只存 200 字时，真机上有两条过滤记录的扣分
    // 理由无法核对——它引用的 JD 内容正好在被截掉的那部分。做判断的材料要和判断一起留下。
    const { store } = await loadLog()
    const job = makeJob() as any
    job.card.postDescription = `岗位职责：${'需求调研与产品规划。'.repeat(120)}`
    expect(job.card.postDescription.length).toBeGreaterThan(1000)

    store.startDelivery(job, { listData: job, matchPercent: 58 } as any)
    await store.flush()

    const [record] = storedRecords('account-a')
    expect(record.job.card.postDescription).toBe(job.card.postDescription)
  })

  it('keeps only a JD summary when there is no AI decision to check', async () => {
    const { store } = await loadLog()
    const job = makeJob() as any
    job.card.postDescription = `岗位职责：${'需求调研与产品规划。'.repeat(120)}`

    store.startDelivery(job, { listData: job } as any)
    await store.flush()

    const [record] = storedRecords('account-a')
    expect(record.job.card.postDescription).toContain('已截断')
    expect(record.job.card.postDescription.length).toBeLessThan(400)
  })

  it('keeps full detail only for the newest records of today', async () => {
    // 配额按最坏情况算：一天投得多时，只有最新的一批留 JD 全文和过程记录。
    const { module, store } = await loadLog()
    const now = Date.now()
    for (let index = 0; index <= module.MAX_DETAILED_DELIVERY_RECORDS; index += 1) {
      vi.spyOn(Date, 'now').mockReturnValue(now - 1000 + index)
      const job = makeJob(`job-${index}`) as any
      job.card.postDescription = '职责'.repeat(600)
      const record = store.startDelivery(job, { listData: job, matchPercent: 80 } as any)
      module.addLogTrace(record.data, '流程', 'info', '开始处理')
    }
    vi.mocked(Date.now).mockRestore()
    await store.flush()

    const records = storedRecords('account-a')
    expect(records).toHaveLength(module.MAX_DETAILED_DELIVERY_RECORDS + 1)
    expect(records[0].data.trace).toHaveLength(1)
    expect(records[0].job.card.postDescription).not.toContain('已截断')
    expect(records.at(-1).data.trace).toBeUndefined()
    expect(records.at(-1).job.card.postDescription).toContain('已截断')
  })

  it('restores data.listData from the persisted job on hydrate', async () => {
    const { store } = await loadLog()
    const job = makeJob() as any
    store.startDelivery(job, { listData: job, deliverySource: 'group' } as any)
    await store.flush()
    expect(storedRecords('account-a')[0].data.listData).toBeUndefined()

    // 模拟刷新后重新加载：内存中 listData 必须被回填，下游不感知存储层的去重。
    const { store: hydrated } = await loadLog()

    const restored = hydrated.data.value[0]
    expect(restored.data?.listData).toBeDefined()
    expect(restored.data?.listData.encryptJobId).toBe(job.encryptJobId)
    expect(restored.data?.listData.card?.activeTimeDesc).toBe('本月活跃')
  })

  it('persists and hydrates public-safe AI greeting metadata', async () => {
    const { store } = await loadLog()
    const job = makeJob() as any
    const ctx = {
      listData: job,
      deliveryStage: '投递成功',
      communicationCounted: true,
      publish: { ok: true, attempts: 1, phase: 'confirmed' },
      aiFilteringThreshold: 80,
      aiFilteringDecision: {
        matchPercent: 82,
        level: 'good',
        reason: '直接证据',
        selectedFactIds: ['fact-agent-content'],
        claimMode: 'direct',
      },
      aiGreetingMessages: ['第一段', '第二段'],
      aiGreetingMeta: {
        usedFactIds: ['fact-agent-content'],
        claimMode: 'direct',
        fingerprint: '1234abcd',
      },
    } as any

    store.startDelivery(job, ctx)
    await store.flush()

    const { store: hydrated } = await loadLog()
    const data = hydrated.data.value[0].data
    expect(data?.aiFilteringDecision).toEqual(ctx.aiFilteringDecision)
    expect(data?.aiFilteringThreshold).toBe(80)
    expect(data?.aiGreetingMessages).toEqual(['第一段', '第二段'])
    expect(data?.aiGreetingMeta).toEqual(ctx.aiGreetingMeta)
    expect(data?.communicationCounted).toBe(true)
    expect(data?.publish?.phase).toBe('confirmed')
  })

  it('keeps run events apart from job records and only the newest 200', async () => {
    let timestamp = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => ++timestamp)
    const { store } = await loadLog()

    for (let index = 1; index <= 205; index += 1) {
      store.info(`日志 ${index}`, `内容 ${index}`)
    }

    expect(store.data.value).toEqual([])
    expect(store.events.value).toHaveLength(200)
    expect(store.events.value[0]?.title).toBe('日志 205')
    expect(store.events.value.at(-1)?.title).toBe('日志 6')

    await store.flush()
    const events = persisted.get(eventsKey('account-a')) as any[]
    expect(events).toHaveLength(200)
    expect(events[0].title).toBe('日志 205')
    expect(persisted.has(recordsKey('account-a', dayOf(Date.now())))).toBe(false)
  })

  it('mirrors complete delivery diagnostics for local test analysis', async () => {
    const { store } = await loadLog()
    const job = makeJob() as any
    job.card.postDescription = '完整 JD 不应进入本机诊断镜像'
    store.startDelivery(job, {
      listData: job,
      deliverySource: 'search',
      deliverySourceName: '大模型产品',
      failureReason: '岗位级失败原因',
      aiGreetingMessages: ['招呼语正文'],
    } as any)
    store.info('投递任务', '开始投递')

    await vi.waitFor(() => expect(localDiagnosticAppendMock).toHaveBeenCalled())
    const payload = JSON.stringify(localDiagnosticAppendMock.mock.calls)
    expect(payload).toContain('大模型产品')
    expect(payload).toContain('岗位级失败原因')
    expect(payload).toContain('完整 JD')
    expect(payload).toContain('招呼语正文')
  })

  it('preserves complete nested diagnostics while leaving credential filtering to the sink', async () => {
    const { store } = await loadLog()
    const job = makeJob() as any
    store.startDelivery(job, {
      listData: job,
      trace: [
        {
          at: Date.now(),
          stage: '招呼语发送',
          status: 'warning',
          message: '聊天页发送器未就绪',
          detail: {
            loaded: false,
            reused: true,
            reloaded: false,
            ready: false,
            code: 'ACCOUNT_UNAVAILABLE',
            accountReady: false,
            handshakeMs: 12_000,
            mainVersion: '1.3.27',
            pendingStatus: {
              stage: 'waiting',
              waitingFor: 'connection',
              reason: '账号尚未就绪',
              observedAt: 123,
            },
            bridgeToken: 'private-fixture-token',
            rawPayload: { resume: 'private-fixture-resume' },
          },
        },
      ],
    } as any)
    await vi.waitFor(() => expect(localDiagnosticAppendMock).toHaveBeenCalled())
    const event = localDiagnosticAppendMock.mock.calls.find(
      ([input]) => (input as any).event === 'delivery.started',
    )?.[0] as any
    expect(event.data.trace[0].detail).toMatchObject({
      loaded: false,
      reused: true,
      reloaded: false,
      accountReady: false,
      handshakeMs: 12_000,
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(event.data.trace[0].detail.pendingStatus).toMatchObject({
      stage: 'waiting',
      waitingFor: 'connection',
      reason: '账号尚未就绪',
    })
    expect(JSON.stringify(event)).toContain('private-fixture-resume')
    expect(JSON.stringify(event)).toContain('private-fixture-token')
  })

  it('normalizes credential field names before redaction without hiding usage counters', async () => {
    const { store } = await loadLog()
    const job = makeJob('credential-field-check') as any
    store.startDelivery(job, {
      listData: job,
      trace: [
        {
          at: Date.now(),
          stage: '诊断',
          status: 'info',
          message: '字段检查',
          detail: {
            api_key: 'api-secret',
            'set-cookie': 'cookie-secret',
            input_tokens: 1200,
            output_tokens: 340,
          },
        },
      ],
    } as any)
    await store.flush()

    const saved = storedRecords('account-a')[0]
    const detail = saved.data.trace[0].detail
    expect(detail.api_key).toBe('[已脱敏]')
    expect(detail['set-cookie']).toBe('[已脱敏]')
    expect(detail.input_tokens).toBe(1200)
    expect(detail.output_tokens).toBe(340)
  })

  it('records implementation details only while diagnostics are on', async () => {
    const { module, store } = await loadLog()

    store.debug('分页诊断', '第 2 页')
    expect(store.events.value).toEqual([])

    module.setDiagnosticsEnabled(true)
    store.debug('分页诊断', '第 3 页')
    expect(store.events.value.map((item) => item.title)).toEqual(['诊断 · 分页诊断'])
    expect(store.events.value[0].message).toBe('第 3 页')
  })

  it('mirrors structured diagnostic fields independently of display truncation and mode', async () => {
    const { store } = await loadLog()
    const detail = {
      taskId: 'task-1',
      durationMs: 105_000,
      reason: 'connection',
      nested: { count: 31 },
    }
    store.recordDiagnostic('诊断正文'.repeat(200), detail)
    expect(store.events.value).toEqual([])
    const event = localDiagnosticAppendMock.mock.calls.at(-1)?.[0] as any
    expect(event).toMatchObject({ event: 'runtime.diagnostic', data: { detail } })
    expect(event.data.message).toBe('诊断正文'.repeat(200))
  })

  it('mirrors the complete runtime message even when the UI stores a compact view', async () => {
    const { store } = await loadLog()
    const message = '运行检查正文'.repeat(300)
    store.info('运行检查', message)

    await vi.waitFor(() => expect(localDiagnosticAppendMock).toHaveBeenCalled())
    const event = localDiagnosticAppendMock.mock.calls.at(-1)?.[0] as any
    expect(event).toMatchObject({ event: 'runtime.event', data: { message } })
  })

  it('keeps the complete job and logData snapshots in the local mirror', async () => {
    const { store } = await loadLog()
    const job = makeJob('job-' + 'x'.repeat(220)) as any
    job.encryptBossId = 'boss-' + 'b'.repeat(220)
    job.card.postDescription = '完整 JD '.repeat(500)
    const listData = { ...job, card: { ...job.card, postDescription: '详情 JD '.repeat(500) } }
    store.startDelivery(job, {
      listData,
      deliverySource: 'search',
      trace: [{ at: 1, stage: '详情', status: 'info', message: '完整过程' }],
    } as any)

    await vi.waitFor(() => expect(localDiagnosticAppendMock).toHaveBeenCalled())
    const event = localDiagnosticAppendMock.mock.calls.find(
      ([input]) => (input as any).event === 'delivery.started',
    )?.[0] as any
    expect(event.data.jobSnapshot.encryptJobId).toBe(job.encryptJobId)
    expect(event.data.jobSnapshot.card.postDescription).toBe(job.card.postDescription)
    expect(event.data.listDataSnapshot.card.postDescription).toBe(listData.card.postDescription)
    expect(event.data.dataSnapshot.listData.card.postDescription).toBe(
      listData.card.postDescription,
    )
    expect(event.data.recordSnapshot.data.listData.card.postDescription).toBe(
      listData.card.postDescription,
    )
    expect(event.data.job.jobId).toBe(job.encryptJobId)
    expect(event.data.job.encryptBossId).toBe(job.encryptBossId)
  })

  it('clears run events without touching job records', async () => {
    const { store } = await loadLog()
    const job = makeJob() as any
    store.startDelivery(job, { listData: job } as any)
    store.info('投递任务', '开始投递')
    await store.flush()
    expect(persisted.has(eventsKey('account-a'))).toBe(true)

    store.clear()
    await vi.waitFor(() => expect(persisted.has(eventsKey('account-a'))).toBe(false))

    expect(store.events.value).toEqual([])
    expect(store.data.value).toHaveLength(1)
    expect(storedRecords('account-a')).toHaveLength(1)
  })

  it('applies a clear after any in-flight log write', async () => {
    const { store } = await loadLog()
    const order: string[] = []
    let releaseWrite!: () => void
    storageSetMock.mockImplementationOnce(async (key: string, value: unknown) => {
      order.push('write-started')
      await new Promise<void>((resolve) => (releaseWrite = resolve))
      persisted.set(key, structuredClone(value))
      order.push('write-finished')
      return true
    })
    storageRmMock.mockImplementationOnce(async (key: string) => {
      persisted.delete(key)
      order.push('removed')
      return true
    })
    store.info('待清空日志', '内容')

    const flushing = store.flush()
    await vi.waitFor(() => expect(order).toContain('write-started'))
    store.clear()

    expect(storageRmMock).not.toHaveBeenCalled()
    releaseWrite()
    await flushing
    await vi.waitFor(() => expect(order).toContain('removed'))

    expect(order).toEqual(['write-started', 'write-finished', 'removed'])
    expect(store.events.value).toEqual([])
    expect(persisted.has(eventsKey('account-a'))).toBe(false)
  })

  it('migrates the legacy shared log into day buckets and run events', async () => {
    const now = Date.now()
    const job = makeJob() as any
    const legacyRecord = {
      createdAt: now - 1000,
      data: { deliveryStage: '投递成功', listData: job },
      job,
      state: 'success',
      state_name: '投递成功',
      title: job.jobName,
    }
    const expiredRecord = {
      ...legacyRecord,
      createdAt: now - 10 * DAY_MS,
      job: makeJob('job-expired'),
    }
    const serializable = <T>(value: T): T => JSON.parse(JSON.stringify(value))
    persisted.set(
      'local:web-geek-job-DeliveryLogs',
      serializable([
        legacyRecord,
        expiredRecord,
        {
          title: '投递任务',
          state: 'info',
          state_name: '消息',
          message: '开始投递',
          createdAt: now,
        },
      ]),
    )
    persisted.set(
      'local:web-geek-job-DeliveryLogs:account-a',
      serializable([{ ...legacyRecord, createdAt: now - DAY_MS, job: makeJob('job-yesterday') }]),
    )

    const { store } = await loadLog()

    expect(storedRecords('account-a').map((item) => item.job.encryptJobId)).toEqual(['job-active'])
    expect(storedRecords('account-a', now - DAY_MS).map((item) => item.job.encryptJobId)).toEqual([
      'job-yesterday',
    ])
    expect((persisted.get(eventsKey('account-a')) as any[]).map((item) => item.message)).toEqual([
      '开始投递',
    ])
    expect(store.data.value.map((item) => item.job?.encryptJobId)).toEqual([
      'job-active',
      'job-yesterday',
    ])
    expect(persisted.has('local:web-geek-job-DeliveryLogs')).toBe(false)
    expect(persisted.has('local:web-geek-job-DeliveryLogs:account-a')).toBe(false)
  })

  it('drops days older than the retention window on hydrate', async () => {
    const now = Date.now()
    seedRecords('account-a', [
      { ...interruptedRecord({ deliveryStage: '投递成功' }), createdAt: now - 1000 },
      { ...interruptedRecord({ deliveryStage: '投递成功' }), createdAt: now - 8 * DAY_MS },
    ])

    const { store } = await loadLog()

    expect(store.data.value).toHaveLength(1)
    expect(persisted.has(recordsKey('account-a', dayOf(now - 8 * DAY_MS)))).toBe(false)
    expect(persisted.get(indexKey('account-a'))).toEqual([dayOf(now)])
  })

  it('stores past days as summaries without the step-by-step trace', async () => {
    const yesterday = Date.now() - DAY_MS
    const record = interruptedRecord({
      deliveryStage: '投递成功',
      matchPercent: 80,
      aiGreetingMessages: ['你好'],
      trace: [{ at: 1, stage: '流程', status: 'info', message: '开始处理' }],
    })
    record.createdAt = yesterday
    ;(record.job as any).card.postDescription = '职责'.repeat(600)
    seedRecords('account-a', [record])

    const { store } = await loadLog()
    store.touchDelivery(store.data.value[0])
    await store.flush()

    const [archived] = storedRecords('account-a', yesterday)
    expect(archived.data.trace).toBeUndefined()
    // Historical extension recovery records keep the outcome only; the local
    // diagnostic mirror owns the complete greeting text.
    expect(archived.data.aiGreetingMessages).toBeUndefined()
    expect(archived.job.card.postDescription).toContain('已截断')
  })

  it('drops the oldest records once the total cap is exceeded', async () => {
    const { MAX_DELIVERY_RECORDS } = await import('./log')
    const yesterday = Date.now() - DAY_MS
    seedRecords(
      'account-a',
      Array.from({ length: MAX_DELIVERY_RECORDS }, (_, index) => ({
        ...interruptedRecord({ deliveryStage: '投递成功' }),
        createdAt: yesterday + index,
        job: makeJob(`old-${index}`),
      })),
    )

    const { store } = await loadLog()
    for (let index = 0; index < 3; index += 1) {
      const job = makeJob(`new-${index}`) as any
      store.startDelivery(job, { listData: job } as any)
    }
    await store.flush()

    const past = storedRecords('account-a', yesterday)
    expect(past).toHaveLength(MAX_DELIVERY_RECORDS - 3)
    expect(past.some((item) => item.job.encryptJobId === 'old-0')).toBe(false)
    expect(storedRecords('account-a')).toHaveLength(3)
    expect(store.data.value).toHaveLength(MAX_DELIVERY_RECORDS)
  })

  it('finalizes an interrupted persisted delivery as result unknown during hydration', async () => {
    seedRecords('account-a', [
      interruptedRecord({ deliveryStage: '正在建立沟通', retryable: true }),
    ])

    const { store } = await loadLog()

    expect(store.data.value[0]).toMatchObject({
      state: 'warning',
      state_name: '结果不确定',
      data: {
        deliveryStage: '投递失败',
        failureStage: '正在建立沟通',
        retryable: false,
        state: '结果未知',
      },
    })
  })

  // 真机日志里的场景：岗位卡在「动作闸门：详情请求限速，等待 158 秒」时被 BOSS 的
  // 安全校验重载了页面。它一次投递请求都没发出过，却被标成「结果不确定」要人工核对。
  it('finalizes a pre-publish interruption as retryable instead of unknown', async () => {
    seedRecords('account-a', [
      interruptedRecord({
        deliveryStage: 'JD筛选中',
        retryable: true,
        trace: [
          { at: 1, stage: '流程', status: 'info', message: '开始处理第 6/9 个岗位' },
          { at: 2, stage: '动作闸门', status: 'info', message: '详情请求限速，等待 158 秒' },
        ],
      }),
    ])

    const { store } = await loadLog()

    expect(store.data.value[0]).toMatchObject({
      state_name: '待重试',
      data: { retryable: true, state: '待重试' },
    })
  })

  // 反向：trace 里出现过「投递接口」就说明 friend/add 发出去了，哪怕阶段名还停在
  // JD筛选中也必须保守处理——误判成没发会导致重复投递，白吃沟通额度。
  it('keeps a publish-attempted interruption unknown even at a pre-publish stage', async () => {
    seedRecords('account-a', [
      interruptedRecord({
        deliveryStage: 'JD筛选中',
        retryable: true,
        trace: [{ at: 1, stage: '投递接口', status: 'info', message: '第 1 次发送投递请求' }],
      }),
    ])

    const { store } = await loadLog()

    expect(store.data.value[0]).toMatchObject({
      state_name: '结果不确定',
      data: { retryable: false, state: '结果未知' },
    })
  })

  // publish 已写入但 deliveryStage 还没来得及更新就被持久化——两次写入之间存在窗口。
  // 这时阶段名还停在 JD筛选中，trace 也可能没落盘，publish 字段是唯一的证据。
  it('trusts the publish field when the stage write lost the race', async () => {
    seedRecords('account-a', [
      interruptedRecord({
        deliveryStage: 'JD筛选中',
        retryable: true,
        publish: { ok: false, attempts: 1, phase: 'sent' },
      }),
    ])

    const { store } = await loadLog()

    expect(store.data.value[0]).toMatchObject({
      state_name: '结果不确定',
      data: { retryable: false, state: '结果未知' },
    })
  })

  it('restores a confirmed communication as a greeting-only retry', async () => {
    seedRecords('account-a', [
      interruptedRecord({
        communicationCounted: true,
        deliveryStage: '正在打招呼',
        greetingSend: { ok: false, type: 'ai' },
        publish: { ok: true, attempts: 1, phase: 'confirmed' },
      }),
    ])

    const { store } = await loadLog()

    expect(store.data.value[0]).toMatchObject({
      state: 'warning',
      state_name: '招呼语待续发',
      data: {
        communicationCounted: true,
        deliveryStage: '投递失败',
        failureStage: '正在打招呼',
        retryable: true,
      },
    })
  })

  it('keeps persisted records and events isolated when the active account changes', async () => {
    const { store } = await loadLog()
    const jobA = makeJob('job-a') as any
    store.startDelivery(jobA, { listData: jobA } as any)
    store.info('账号 A 日志', 'A')
    await store.flush()

    await store.setAccountScope('account-b')
    expect(store.data.value).toEqual([])
    expect(store.events.value).toEqual([])
    const jobB = makeJob('job-b') as any
    store.startDelivery(jobB, { listData: jobB } as any)
    store.info('账号 B 日志', 'B')
    await store.flush()

    await store.setAccountScope('account-a')
    expect(store.data.value.map((item) => item.job?.encryptJobId)).toEqual(['job-a'])
    expect(store.events.value.map((item) => item.title)).toEqual(['账号 A 日志'])
    expect(storedRecords('account-b').map((item) => item.job.encryptJobId)).toEqual(['job-b'])
    expect((persisted.get(eventsKey('account-b')) as any[]).map((item) => item.title)).toEqual([
      '账号 B 日志',
    ])
  })

  it('hides routine AI request records written by older versions', async () => {
    persisted.set('local:agent-delivery-runtime-logs:account-a', [
      {
        title: 'AI 招呼语请求',
        state: 'success',
        state_name: '请求成功',
        message: '模型请求完成',
        createdAt: 4,
      },
      {
        title: 'AI 招呼语请求',
        state: 'info',
        state_name: '请求中',
        message: '模型请求已发出（同步）',
        createdAt: 3,
      },
      {
        title: 'AI 匹配请求',
        state: 'danger',
        state_name: '请求失败',
        message: '模型服务限流',
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

    const { store } = await loadLog()

    expect(store.runtimeData.value.map((item) => item.message)).toEqual([
      '模型服务限流',
      '解析成功',
    ])
  })

  it('loads account-scoped background diagnostics separately from delivery records', async () => {
    persisted.set('local:agent-delivery-runtime-logs:account-a', [
      {
        title: '简历解析',
        state: 'danger',
        state_name: '解析失败',
        message: '模型请求超时',
        data: {
          trace: [
            {
              at: 10,
              stage: '简历解析',
              status: 'danger',
              message: '模型请求超时',
              detail: { timeoutSeconds: 180 },
            },
          ],
        },
        createdAt: 10,
      },
    ])

    const { store } = await loadLog()

    expect(store.data.value).toEqual([])
    expect(store.runtimeData.value).toHaveLength(1)
    expect(store.runtimeData.value[0]).toMatchObject({
      title: '简历解析',
      state_name: '解析失败',
      publicData: {
        trace: [{ detail: { timeoutSeconds: 180 } }],
      },
    })
  })
})
