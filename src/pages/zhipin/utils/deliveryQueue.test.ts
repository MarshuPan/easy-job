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

  it('consumes the persisted queue in FIFO order without rebuilding a source ratio', () => {
    const group = jobs('group', 20).map((id, index) => ({ id, order: index + 1 }))
    const search = jobs('search', 20).map((id, index) => ({ id, order: index + 21 }))
    const weights = { group: 40, search: 60 }

    const first = selectDeliveryBatch({
      batchSize: 10,
      getItemKey: (item) => item.id,
      getItemOrder: (item) => item.order,
      pools: { group, search },
      weights,
    })
    expect(first.items.map((item) => item.source)).toEqual(
      Array.from({ length: 10 }, () => 'group'),
    )
    expect(first.remaining.group).toHaveLength(10)
    expect(first.remaining.search).toHaveLength(20)

    const second = selectDeliveryBatch({
      batchSize: 10,
      getItemKey: (item) => item.id,
      getItemOrder: (item) => item.order,
      pools: first.remaining,
      weights,
    })
    expect(second.items.map((item) => item.source)).toEqual(
      Array.from({ length: 10 }, () => 'group'),
    )
    expect(second.remaining.search).toHaveLength(20)
  })

  it('builds the queue preview from acquisition order rather than source ratio', () => {
    const group = jobs('group', 40).map((id, index) => ({ id, order: index + 1 }))
    const search = jobs('search', 60).map((id, index) => ({ id, order: index + 41 }))
    const preview = previewDeliveryQueue({
      batchSize: 10,
      limit: 60,
      getItemKey: (item) => item.id,
      getItemOrder: (item) => item.order,
      pools: { group, search },
      weights: { group: 40, search: 60 },
    })

    expect(preview).toHaveLength(60)
    expect(preview.filter((item) => item.source === 'group')).toHaveLength(40)
    expect(preview.filter((item) => item.source === 'search')).toHaveLength(20)
    expect(preview.slice(0, 10).map((item) => item.source)).toEqual(
      Array.from({ length: 10 }, () => 'group'),
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
