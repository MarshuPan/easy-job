import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('@/utils/logger', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('@/utils/providerHealth', () => ({
  getProviderHeartbeatDiagnostic: vi.fn((error) => ({ error })),
}))

import { addLogTrace, MAX_DELIVERY_RECORDS, useLog, type logData } from './log'

/**
 * chrome.storage.local 在未申请 unlimitedStorage 时上限为 10 MiB，而岗位记录、
 * pipeline 缓存、投递池、统计共用这一份配额。岗位记录是其中最大的消费者，且体积回归
 * 没有任何其他可观测症状——配额耗尽后所有写入静默失败、只剩内存态。
 * 这条测试是防止体积回归的唯一护栏。
 */
const QUOTA_BYTES = 10 * 1024 * 1024
// 岗位记录保留 7 天，按最坏情况算：总数顶到上限，今天最新的一批带 JD 全文和过程记录，
// 其余只留摘要。JD 全文是 AI 匹配的判断依据，不留原文就没法回答「过滤得准不准」，
// 所以最新一批仍然留着；往天的记录只用于导出复盘，摘要就够。
// 投递池约 0.6 MB、pipeline 缓存约 0.4 MB，加上这里的预算合计约 4.5 MB，离 80% 的配额
// 告警线还有距离。
const DELIVERY_RECORD_BUDGET_BYTES = 3.5 * 1024 * 1024

const utf8 = new TextEncoder()
const bytesOf = (value: unknown) => utf8.encode(JSON.stringify(value)).length

const CN = '负责核心业务系统的架构设计与研发，参与需求评审、技术方案制定和线上问题排查，'
const chineseText = (length: number) => CN.repeat(Math.ceil(length / CN.length)).slice(0, length)

/** JD 正文由同一段话重复而成，需要一个唯一标记才能可靠地数出它被存了几份。 */
const jdMarker = (index: number) => `【JD-UNIQUE-MARKER-${index}】`

function makeJob(index: number, jdLength: number) {
  const encryptJobId = `enc-job-${String(index).padStart(6, '0')}`
  return {
    encryptJobId,
    expectId: 1001,
    jobName: '高级前端开发工程师',
    cityName: '上海',
    salaryDesc: '30-60K·15薪',
    jobExperience: '5-10年',
    jobDegree: '本科',
    jobLabels: ['TypeScript', 'Vue', '前端架构', 'Node.js'],
    brandName: '某某网络科技有限公司',
    brandScaleName: '1000-9999人',
    bossName: '张女士',
    bossTitle: '技术招聘负责人',
    status: { status: 'success', msg: '投递成功', setStatus: vi.fn() },
    getCard: vi.fn(),
    card: {
      postDescription: jdMarker(index) + chineseText(jdLength),
      jobName: '高级前端开发工程师',
      salaryDesc: '30-60K·15薪',
      cityName: '上海',
      experienceName: '5-10年',
      degreeName: '本科',
      jobLabels: ['TypeScript', 'Vue', '前端架构'],
      address: '上海市浦东新区某某路 1000 号某某大厦 20 层',
      bossName: '张女士',
      bossTitle: '技术招聘负责人',
      activeTimeDesc: '刚刚活跃',
      brandName: '某某网络科技有限公司',
      encryptJobId,
    },
  } as any
}

function makeContext(job: any, traceCount: number): logData {
  const ctx: logData = {
    listData: job,
    deliverySource: 'search',
    deliverySourceName: '搜索 · 前端开发',
    deliveryStage: '投递成功',
    matchPercent: 82,
    aiFilteringThreshold: 60,
    communicationCounted: true,
    state: '成功',
    publish: { ok: true, attempts: 1, phase: 'confirmed', code: 0, message: '成功' },
    greetingSend: {
      ok: true,
      type: 'ai',
      channel: 'websocket',
      contentLength: 270,
      messageCount: 3,
      messages: Array.from({ length: 3 }, (_, i) => ({
        index: i,
        ok: true,
        channel: 'websocket',
        content: chineseText(90),
        contentLength: 90,
      })),
    },
    aiFilteringAtext: chineseText(150),
    aiFilteringAjson: { matchPercent: 82, level: 'good', reason: chineseText(120) },
    aiGreetingA: chineseText(200),
    aiGreetingMessages: Array.from({ length: 3 }, () => chineseText(90)),
  }
  for (let i = 0; i < traceCount; i += 1) {
    addLogTrace(ctx, '投递后处理', 'info', `第 ${i + 1} 步处理完成，正在继续后续流程`, {
      step: i,
      jobId: job.encryptJobId,
    })
  }
  return ctx
}

async function persistFullRecordSet(jdLength: number, traceCount: number) {
  const store = useLog()
  await store.setAccountScope('account-a')
  store.data.value = []
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now')
  for (let i = 0; i < MAX_DELIVERY_RECORDS; i += 1) {
    clock.mockReturnValue(now - MAX_DELIVERY_RECORDS + i)
    const job = makeJob(i, jdLength)
    const ctx = makeContext(job, traceCount)
    store.finishDelivery(store.startDelivery(job, ctx), null, ctx, '投递成功')
  }
  clock.mockRestore()
  await store.flush()
  const recordWrites = storageSetMock.mock.calls.filter(([key]) =>
    /^local:agent-delivery-records:account-a:\d{4}-\d{2}-\d{2}$/.test(key),
  )
  return (recordWrites.at(-1)?.[1] ?? []) as any[]
}

describe('delivery record storage budget', () => {
  beforeEach(() => {
    storageGetMock.mockImplementation(async (_key: string, fallback?: unknown) => fallback)
    storageSetMock.mockClear()
  })

  it('keeps a full record set within its storage budget', async () => {
    // 典型投递：JD 约 2000 中文字、20 条 trace。
    const payload = await persistFullRecordSet(2000, 20)
    const total = bytesOf(payload)

    expect(payload).toHaveLength(MAX_DELIVERY_RECORDS)
    expect(total).toBeLessThan(DELIVERY_RECORD_BUDGET_BYTES)
    // 岗位记录单独占满整个配额是绝对不可接受的，即便预算份额将来调整。
    expect(total).toBeLessThan(QUOTA_BYTES / 2)
  })

  it('stores each job exactly once per record', async () => {
    const payload = await persistFullRecordSet(2000, 20)
    const record = payload[0]

    // 岗位只保存在 record.job；data.listData 由 hydrate 回填，不进入存储。
    expect(record.job?.card?.postDescription).toBeTruthy()
    expect(record.data?.listData).toBeUndefined()

    // 直接对序列化结果计数，避免将来换字段名后这条护栏悄悄失效。
    // 记录按最新在前排序，payload[0] 对应最后写入的那条。
    const marker = jdMarker(MAX_DELIVERY_RECORDS - 1)
    expect(record.job.card.postDescription.startsWith(marker)).toBe(true)
    const occurrences = JSON.stringify(record).split(marker).length - 1
    expect(occurrences).toBe(1)
  })
})
