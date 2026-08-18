import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isRef } from 'vue'

const { storageGetMock, storageRmMock, storageSetMock } = vi.hoisted(() => ({
  storageGetMock: vi.fn<(key: string, fallback?: unknown) => Promise<unknown>>(async () => []),
  storageRmMock: vi.fn<(key: string) => Promise<boolean>>(async () => true),
  storageSetMock: vi.fn<(key: string, value: unknown) => Promise<boolean>>(async () => true),
}))

vi.mock('@/message', () => ({
  counter: {
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

import { useLog } from './log'

function makeJob() {
  return {
    encryptJobId: 'job-active',
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
      encryptJobId: 'job-active',
    },
  }
}

describe('useLog persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageGetMock.mockResolvedValue([])
    useLog().data.value = []
  })

  // 形状契约：消费方必须通过 .value 读取日志记录。
  // 这条断言存在的原因是 useDeliver 曾把 log.data 当成裸数组做 Array.isArray 判断，
  // 而测试把 useLog() mock 成裸数组，于是招呼语续发链路在生产恒不执行、测试却全绿。
  // 任何把 data 从 Ref 改成裸数组的重构都必须先让这条断言失败。
  it('exposes delivery records as a ref so consumers must read .value', () => {
    const store = useLog()
    expect(isRef(store.data)).toBe(true)
    expect(Array.isArray(store.data)).toBe(false)
    expect(Array.isArray(store.data.value)).toBe(true)
  })

  it('persists HR active time from compacted job cards', async () => {
    const store = useLog()
    const job = makeJob() as any
    const ctx = {
      listData: job,
      deliverySource: 'group',
      deliverySourceName: 'AI 产品经理',
    } as any

    store.startDelivery(job, ctx)
    await store.flush()

    const calls = storageSetMock.mock.calls as unknown as Array<[string, any[]]>
    const persisted = calls.at(-1)![1]
    expect(persisted[0].job.card.activeTimeDesc).toBe('本月活跃')
    expect(persisted[0].job.expectId).toBe(101)
    expect(persisted[0].data.deliverySourceName).toBe('AI 产品经理')
    // 岗位只保存在 record.job 一处；data.listData 不再重复写入（曾使每条记录含两份完整 JD）。
    expect(persisted[0].data.listData).toBeUndefined()
  })

  it('keeps enough of the JD to check an AI filtering decision against it', async () => {
    // AI 匹配是拿简历事实和这段 JD 比出来的。只存 200 字时，真机上有两条过滤记录的扣分
    // 理由无法核对——它引用的 JD 内容正好在被截掉的那部分。做判断的材料要和判断一起留下。
    const store = useLog()
    const job = makeJob() as any
    job.card.postDescription = `岗位职责：${'需求调研与产品规划。'.repeat(120)}`
    expect(job.card.postDescription.length).toBeGreaterThan(1000)

    store.startDelivery(job, { listData: job, aiFilteringAjson: { matchPercent: 58 } } as any)
    await store.flush()

    const calls = storageSetMock.mock.calls as unknown as Array<[string, any[]]>
    const persisted = calls.at(-1)![1]
    expect(persisted[0].job.card.postDescription).toBe(job.card.postDescription)
    expect(persisted[0].job.card.postDescription).not.toContain('已截断')
  })

  it('keeps only a JD summary when there is no AI decision to check', async () => {
    // 配额是和投递池、缓存、统计共用的。硬规则过滤和取详情失败的记录没有什么可复核的，
    // 给它们也存全文只会把预算顶穿——实测一律按全文存会从 1.69 MB 涨到 2.85 MB。
    const store = useLog()
    const job = makeJob() as any
    job.card.postDescription = `岗位职责：${'需求调研与产品规划。'.repeat(120)}`

    store.startDelivery(job, { listData: job } as any)
    await store.flush()

    const calls = storageSetMock.mock.calls as unknown as Array<[string, any[]]>
    const persisted = calls.at(-1)![1]
    expect(persisted[0].job.card.postDescription).toContain('已截断')
    expect(persisted[0].job.card.postDescription.length).toBeLessThan(400)
  })

  it('restores data.listData from the persisted job on hydrate', async () => {
    const store = useLog()
    const job = makeJob() as any
    store.startDelivery(job, { listData: job, deliverySource: 'group' } as any)
    await store.flush()

    const persisted = (storageSetMock.mock.calls as unknown as Array<[string, any[]]>).at(-1)![1]
    expect(persisted[0].data.listData).toBeUndefined()

    // 模拟刷新后重新加载：内存中 listData 必须被回填，下游不感知存储层的去重。
    storageGetMock.mockResolvedValueOnce(persisted)
    vi.resetModules()
    const { useLog: useHydratedLog } = await import('./log')
    const hydratedStore = useHydratedLog()
    await hydratedStore.hydrate()

    const restored = hydratedStore.data.value[0]
    expect(restored.data?.listData).toBeDefined()
    expect(restored.data?.listData.encryptJobId).toBe(job.encryptJobId)
    expect(restored.data?.listData.card?.activeTimeDesc).toBe('本月活跃')
  })

  it('persists and hydrates public-safe AI greeting metadata', async () => {
    const store = useLog()
    const job = makeJob() as any
    const ctx = {
      listData: job,
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
      aiGreetingMeta: {
        usedFactIds: ['fact-agent-content'],
        claimMode: 'direct',
        openingPattern: 'jd-hook',
        fingerprint: '1234abcd',
      },
    } as any

    store.startDelivery(job, ctx)
    await store.flush()

    const calls = storageSetMock.mock.calls as unknown as Array<[string, any[]]>
    const persisted = calls.at(-1)![1]
    expect(persisted[0].data.aiFilteringDecision).toEqual(ctx.aiFilteringDecision)
    expect(persisted[0].data.aiFilteringThreshold).toBe(80)
    expect(persisted[0].data.aiGreetingMeta).toEqual(ctx.aiGreetingMeta)
    expect(persisted[0].data.communicationCounted).toBe(true)
    expect(persisted[0].data.publish.phase).toBe('confirmed')

    vi.resetModules()
    storageGetMock.mockResolvedValue(persisted)
    const { useLog: useHydratedLog } = await import('./log')
    const hydrated = useHydratedLog()
    await hydrated.hydrate()

    expect(hydrated.data.value[0].data?.aiFilteringDecision).toEqual(ctx.aiFilteringDecision)
    expect(hydrated.data.value[0].data?.aiFilteringThreshold).toBe(80)
    expect(hydrated.data.value[0].data?.aiGreetingMeta).toEqual(ctx.aiGreetingMeta)
    expect(hydrated.data.value[0].data?.communicationCounted).toBe(true)
    expect(hydrated.data.value[0].data?.publish?.phase).toBe('confirmed')
    hydrated.clear()
  })

  it('keeps only the newest 200 logs in memory and persisted storage', async () => {
    let timestamp = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => ++timestamp)
    const store = useLog()

    for (let index = 1; index <= 205; index += 1) {
      store.info(`日志 ${index}`, `内容 ${index}`)
    }

    expect(store.data.value).toHaveLength(200)
    expect(store.data.value[0]?.title).toBe('日志 205')
    expect(store.data.value.at(-1)?.title).toBe('日志 6')

    await store.flush()
    const calls = storageSetMock.mock.calls as unknown as Array<[string, any[]]>
    const persisted = calls.at(-1)![1]
    expect(persisted).toHaveLength(200)
    expect(persisted[0].title).toBe('日志 205')
    expect(persisted.at(-1).title).toBe('日志 6')
  })

  it('applies a clear after any in-flight log write', async () => {
    const events: string[] = []
    let releaseWrite!: () => void
    storageSetMock.mockImplementationOnce(async () => {
      events.push('write-started')
      await new Promise<void>((resolve) => (releaseWrite = resolve))
      events.push('write-finished')
      return true
    })
    storageRmMock.mockImplementationOnce(async () => {
      events.push('removed')
      return true
    })
    const store = useLog()
    store.info('待清空日志', '内容')

    const flushing = store.flush()
    await vi.waitFor(() => expect(events).toContain('write-started'))
    store.clear()

    expect(storageRmMock).not.toHaveBeenCalled()
    releaseWrite()
    await flushing
    await vi.waitFor(() => expect(storageRmMock).toHaveBeenCalledOnce())

    expect(events).toEqual(['write-started', 'write-finished', 'removed'])
    expect(store.data.value).toEqual([])
  })

  it('finishes an in-flight legacy write before migrating logs to an account key', async () => {
    const legacyKey = 'local:web-geek-job-DeliveryLogs'
    const accountKey = `${legacyKey}:account-a`
    const persisted = new Map<string, unknown>()
    let releaseLegacyWrite!: () => void
    storageGetMock.mockImplementation(async (key: string, fallback?: unknown) =>
      persisted.has(key) ? persisted.get(key) : fallback,
    )
    storageSetMock.mockImplementation(async (key: string, value: unknown) => {
      if (key === legacyKey && releaseLegacyWrite == null) {
        await new Promise<void>((resolve) => (releaseLegacyWrite = resolve))
      }
      persisted.set(key, structuredClone(value))
      return true
    })
    storageRmMock.mockImplementation(async (key: string) => {
      persisted.delete(key)
      return true
    })
    vi.resetModules()
    const { useLog: useMigratingLog } = await import('./log')
    const store = useMigratingLog()
    store.info('待迁移日志', '内容')

    const flushing = store.flush()
    await vi.waitFor(() => expect(releaseLegacyWrite).toBeTypeOf('function'))
    const scoping = store.setAccountScope('account-a')
    releaseLegacyWrite()
    await Promise.all([flushing, scoping])

    expect(persisted.has(legacyKey)).toBe(false)
    expect((persisted.get(accountKey) as any[]).map((item) => item.title)).toEqual(['待迁移日志'])
  })

  it('finalizes an interrupted persisted delivery as result unknown during hydration', async () => {
    const job = makeJob() as any
    storageGetMock.mockResolvedValueOnce([
      {
        createdAt: 1000,
        data: { deliveryStage: '正在建立沟通', listData: job, retryable: true },
        job,
        state: 'info',
        state_name: '正在建立沟通',
        title: job.jobName,
      },
    ])
    vi.resetModules()
    const { useLog: useHydratedLog } = await import('./log')
    const store = useHydratedLog()

    await store.hydrate()

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
    store.clear()
    await vi.waitFor(() => expect(storageRmMock).toHaveBeenCalled())
  })

  // 真机日志里的场景：岗位卡在「动作闸门：详情请求限速，等待 158 秒」时被 BOSS 的
  // 安全校验重载了页面。它一次投递请求都没发出过，却被标成「结果不确定」要人工核对。
  it('finalizes a pre-publish interruption as retryable instead of unknown', async () => {
    const job = makeJob() as any
    storageGetMock.mockResolvedValueOnce([
      {
        createdAt: 1000,
        data: {
          deliveryStage: 'JD筛选中',
          listData: job,
          retryable: true,
          trace: [
            { at: 1, stage: '流程', status: 'info', message: '开始处理第 6/9 个岗位' },
            { at: 2, stage: '动作闸门', status: 'info', message: '详情请求限速，等待 158 秒' },
          ],
        },
        job,
        state: 'info',
        state_name: 'JD筛选中',
        title: job.jobName,
      },
    ])
    vi.resetModules()
    const { useLog: useHydratedLog } = await import('./log')
    const store = useHydratedLog()

    await store.hydrate()

    expect(store.data.value[0]).toMatchObject({
      state_name: '待重试',
      data: { retryable: true, state: '待重试' },
    })
    store.clear()
    await vi.waitFor(() => expect(storageRmMock).toHaveBeenCalled())
  })

  // 反向：trace 里出现过「投递接口」就说明 friend/add 发出去了，哪怕阶段名还停在
  // JD筛选中也必须保守处理——误判成没发会导致重复投递，白吃沟通额度。
  it('keeps a publish-attempted interruption unknown even at a pre-publish stage', async () => {
    const job = makeJob() as any
    storageGetMock.mockResolvedValueOnce([
      {
        createdAt: 1000,
        data: {
          deliveryStage: 'JD筛选中',
          listData: job,
          retryable: true,
          trace: [{ at: 1, stage: '投递接口', status: 'info', message: '第 1 次发送投递请求' }],
        },
        job,
        state: 'info',
        state_name: 'JD筛选中',
        title: job.jobName,
      },
    ])
    vi.resetModules()
    const { useLog: useHydratedLog } = await import('./log')
    const store = useHydratedLog()

    await store.hydrate()

    expect(store.data.value[0]).toMatchObject({
      state_name: '结果不确定',
      data: { retryable: false, state: '结果未知' },
    })
    store.clear()
    await vi.waitFor(() => expect(storageRmMock).toHaveBeenCalled())
  })

  // publish 已写入但 deliveryStage 还没来得及更新就被持久化——两次写入之间存在窗口。
  // 这时阶段名还停在 JD筛选中，trace 也可能没落盘，publish 字段是唯一的证据。
  it('trusts the publish field when the stage write lost the race', async () => {
    const job = makeJob() as any
    storageGetMock.mockResolvedValueOnce([
      {
        createdAt: 1000,
        data: {
          deliveryStage: 'JD筛选中',
          listData: job,
          retryable: true,
          publish: { ok: false, attempts: 1, phase: 'sent' },
        },
        job,
        state: 'info',
        state_name: 'JD筛选中',
        title: job.jobName,
      },
    ])
    vi.resetModules()
    const { useLog: useHydratedLog } = await import('./log')
    const store = useHydratedLog()

    await store.hydrate()

    expect(store.data.value[0]).toMatchObject({
      state_name: '结果不确定',
      data: { retryable: false, state: '结果未知' },
    })
    store.clear()
    await vi.waitFor(() => expect(storageRmMock).toHaveBeenCalled())
  })

  it('restores a confirmed communication as a greeting-only retry', async () => {
    const job = makeJob() as any
    storageGetMock.mockResolvedValueOnce([
      {
        createdAt: Date.now(),
        data: {
          communicationCounted: true,
          deliveryStage: '正在打招呼',
          greetingSend: { ok: false, type: 'ai' },
          listData: job,
          publish: { ok: true, attempts: 1, phase: 'confirmed' },
        },
        job,
        state: 'info',
        state_name: '正在打招呼',
        title: job.jobName,
      },
    ])
    vi.resetModules()
    const { useLog: useHydratedLog } = await import('./log')
    const store = useHydratedLog()

    await store.hydrate()

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
    store.clear()
  })

  it('keeps persisted logs isolated when the active account changes', async () => {
    const persisted = new Map<string, unknown>()
    storageGetMock.mockImplementation(async (key: string, fallback?: unknown) =>
      persisted.has(key) ? (persisted.get(key) as unknown[]) : (fallback as unknown[]),
    )
    storageSetMock.mockImplementation(async (key: string, value: unknown) => {
      persisted.set(key, structuredClone(value))
      return true
    })
    storageRmMock.mockImplementation(async (key: string) => {
      persisted.delete(key)
      return true
    })
    vi.resetModules()
    const { useLog: useAccountLog } = await import('./log')
    const store = useAccountLog()

    await store.setAccountScope('account-a')
    store.info('账号 A 日志', 'A')
    await store.flush()
    await store.setAccountScope('account-b')

    expect(store.data.value).toEqual([])
    store.info('账号 B 日志', 'B')
    await store.flush()
    await store.setAccountScope('account-a')

    expect(store.data.value.map((item) => item.title)).toEqual(['账号 A 日志'])
    expect(
      (persisted.get('local:web-geek-job-DeliveryLogs:account-b') as any[]).map(
        (item) => item.title,
      ),
    ).toEqual(['账号 B 日志'])
  })

  it('loads account-scoped background diagnostics separately from delivery records', async () => {
    const runtimeKey = 'local:agent-delivery-runtime-logs:account-a'
    const persisted = new Map<string, unknown>([
      [
        runtimeKey,
        [
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
        ],
      ],
    ])
    storageGetMock.mockImplementation(async (key: string, fallback?: unknown) =>
      persisted.has(key) ? persisted.get(key) : fallback,
    )
    vi.resetModules()
    const { useLog: useRuntimeLog } = await import('./log')
    const store = useRuntimeLog()

    await store.setAccountScope('account-a')

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
