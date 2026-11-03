import { describe, expect, it } from 'vitest'

import {
  buildDeliveryBatchPlan,
  canCaptureIntoDeliveryPool,
  previewDeliveryQueue,
  selectDeliveryBatch,
} from './deliveryQueue'

function jobs(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`)
}

describe('delivery source queue scheduler', () => {
  it('allocates the 100-job acquisition target from any configured source ratio', () => {
    expect(buildDeliveryBatchPlan({ batchSize: 100, weights: { group: 50, search: 50 } })).toEqual({
      group: 50,
      search: 50,
    })
    expect(buildDeliveryBatchPlan({ batchSize: 100, weights: { group: 80, search: 20 } })).toEqual({
      group: 80,
      search: 20,
    })
    expect(buildDeliveryBatchPlan({ batchSize: 100, weights: { group: 0, search: 100 } })).toEqual({
      group: 0,
      search: 100,
    })
  })

  it('keeps source weights limited to acquisition planning', () => {
    expect(buildDeliveryBatchPlan({ batchSize: 10, weights: { group: 40, search: 60 } })).toEqual({
      group: 4,
      search: 6,
    })
  })

  // 2026-09-24 用户确认：每批按来源比例分名额，来源内凭据越新越先。原来按入库先后 FIFO、
  // 不按比例——设的是求职期望 50% / 搜索 50%，一整天投的全是求职期望；刷新拿到的新一页
  // 排在二三十个旧岗位后面，轮到时凭据已经过期，那次刷新就白费了。
  it('splits each batch by the source ratio, freshest credentials first within a source', () => {
    const group = jobs('group', 20).map((id, index) => ({ id, order: index + 1, fetchedAt: index }))
    const search = jobs('search', 20).map((id, index) => ({
      id,
      order: index + 21,
      fetchedAt: 100 + index,
    }))
    const weights = { group: 40, search: 60 }

    const first = selectDeliveryBatch({
      batchSize: 10,
      getItemKey: (item) => item.id,
      getItemOrder: (item) => item.order,
      getItemFreshness: (item) => item.fetchedAt,
      pools: { group, search },
      weights,
    })
    expect(first.plan).toEqual({ group: 4, search: 6 })
    // 来源内凭据最新的先投：group-20 是最后抓到的。
    expect(
      first.items.filter((item) => item.source === 'group').map(({ item }) => item.id),
    ).toEqual(['group-20', 'group-19', 'group-18', 'group-17'])
    expect(first.remaining.group).toHaveLength(16)
    expect(first.remaining.search).toHaveLength(14)
  })

  it('fills a batch from the other source when one source runs short', () => {
    const group = jobs('group', 20).map((id, index) => ({ id, order: index + 1 }))
    const search = jobs('search', 2).map((id, index) => ({ id, order: index + 21 }))

    const batch = selectDeliveryBatch({
      batchSize: 10,
      getItemKey: (item) => item.id,
      getItemOrder: (item) => item.order,
      pools: { group, search },
      weights: { group: 50, search: 50 },
    })

    expect(batch.plan).toEqual({ group: 8, search: 2 })
  })

  it('previews the queue in the same order it will be processed', () => {
    const group = jobs('group', 40).map((id, index) => ({ id, order: index + 1 }))
    const search = jobs('search', 60).map((id, index) => ({ id, order: index + 41 }))
    const args = {
      batchSize: 10,
      getItemKey: (item: { id: string }) => item.id,
      getItemOrder: (item: { order: number }) => item.order,
      pools: { group, search },
      weights: { group: 40, search: 60 },
    }
    const preview = previewDeliveryQueue({ ...args, limit: 60 })

    expect(preview).toHaveLength(60)
    expect(preview.slice(0, 10).filter((item) => item.source === 'group')).toHaveLength(4)
    expect(preview.slice(0, 10).map(({ item }) => item.id)).toEqual(
      selectDeliveryBatch(args).items.map(({ item }) => item.id),
    )
  })

  it('dedupes jobs that appear in multiple source pools before selecting a batch', () => {
    const duplicate = { encryptJobId: 'same-job' }
    const first = selectDeliveryBatch({
      batchSize: 4,
      getItemKey: (item) => item.encryptJobId,
      pools: {
        group: [duplicate, { encryptJobId: 'group-only' }],
        search: [duplicate, { encryptJobId: 'search-only-1' }, { encryptJobId: 'search-only-2' }],
      },
      weights: { group: 50, search: 50 },
    })

    expect(first.items.map(({ item }) => item.encryptJobId)).toEqual([
      'same-job',
      'group-only',
      'search-only-1',
      'search-only-2',
    ])
    expect(new Set(first.items.map(({ item }) => item.encryptJobId)).size).toBe(first.items.length)
  })

  it('keeps the source and position assigned when a job first entered the queue', () => {
    const duplicate = {
      encryptJobId: 'same-job',
      deliveryQueueOrder: 1,
      deliveryQueueSource: 'search' as const,
    }
    const batch = selectDeliveryBatch({
      batchSize: 2,
      getItemKey: (item) => item.encryptJobId,
      getItemOrder: (item) => item.deliveryQueueOrder,
      getItemSource: (item) => item.deliveryQueueSource,
      pools: {
        group: [duplicate],
        search: [duplicate, { ...duplicate, encryptJobId: 'search-2', deliveryQueueOrder: 2 }],
      },
      weights: { group: 50, search: 50 },
    })

    expect(batch.items.map(({ source, item }) => `${source}:${item.encryptJobId}`)).toEqual([
      'search:same-job',
      'search:search-2',
    ])
  })
})

describe('canCaptureIntoDeliveryPool', () => {
  it('refuses a search page that cannot be attributed to a configured direction', () => {
    // 真机上 URL 只有 salary 筛选、没有 query，整页进了池：「运营总监」和滴滴的政府关系岗
    // 就是这么混进来的——和求职方向毫无关系，却各自烧掉一次详情请求和一次 AI 调用。
    expect(canCaptureIntoDeliveryPool('search', undefined)).toBe(false)
    expect(canCaptureIntoDeliveryPool('search', null)).toBe(false)
    expect(canCaptureIntoDeliveryPool('search', '')).toBe(false)
    expect(canCaptureIntoDeliveryPool('search', '   ')).toBe(false)
  })

  it('keeps capturing a search page that has a direction', () => {
    expect(canCaptureIntoDeliveryPool('search', 'AI产品经理')).toBe(true)
  })

  it('never blocks the expectation source, which carries its own direction', () => {
    // 求职期望的页面本身就是那个期望的列表，没有 searchDirection 是正常的，不能一起拦掉。
    expect(canCaptureIntoDeliveryPool('group', undefined)).toBe(true)
  })
})
