import type { DeliveryLimitSource } from './deliveryLimit'

export type DeliverySourcePools<T> = Record<DeliveryLimitSource, T[]>
export type DeliveryBatchPlan = Record<DeliveryLimitSource, number>

const orderedSources: DeliveryLimitSource[] = ['group', 'search']

export interface DeliveryQueueArgs<T> {
  batchSize: number
  getItemKey?: (item: T) => unknown
  getItemOrder?: (item: T) => number | undefined
  /** 列表凭据的抓取时间。越新越先投：刷新拿到的一页不该排在旧岗位后面等到过期。 */
  getItemFreshness?: (item: T) => number | undefined
  getItemSource?: (item: T) => DeliveryLimitSource | undefined
  pools: DeliverySourcePools<T>
  weights: DeliveryBatchPlan
}

export interface DeliveryBatchItem<T> {
  source: DeliveryLimitSource
  item: T
}

export function buildDeliveryBatchPlan(args: {
  batchSize: number
  weights: DeliveryBatchPlan
}): DeliveryBatchPlan {
  const batchSize = Math.max(0, Math.floor(args.batchSize))
  const totalWeight = orderedSources.reduce(
    (total, source) => total + Math.max(0, Number(args.weights[source]) || 0),
    0,
  )
  if (batchSize === 0 || totalWeight <= 0) return { group: 0, search: 0 }

  const exact = orderedSources.map((source) => {
    const quota = (batchSize * Math.max(0, Number(args.weights[source]) || 0)) / totalWeight
    return {
      source,
      base: Math.floor(quota),
      remainder: quota - Math.floor(quota),
    }
  })
  const plan: DeliveryBatchPlan = {
    group: exact.find((item) => item.source === 'group')?.base ?? 0,
    search: exact.find((item) => item.source === 'search')?.base ?? 0,
  }
  let allocated = plan.group + plan.search
  for (const item of [...exact].sort((left, right) => right.remainder - left.remainder)) {
    if (allocated >= batchSize) break
    plan[item.source] += 1
    allocated += 1
  }
  return plan
}

/** 同一来源内的处理顺序：凭据越新越先，同样新的按入库先后。 */
function sortWithinSource<T>(items: T[], args: DeliveryQueueArgs<T>) {
  return items
    .map((item, stableIndex) => ({
      item,
      freshness: Number(args.getItemFreshness?.(item)),
      order: Number(args.getItemOrder?.(item)),
      stableIndex,
    }))
    .sort((left, right) => {
      const leftFresh = Number.isFinite(left.freshness) ? left.freshness : 0
      const rightFresh = Number.isFinite(right.freshness) ? right.freshness : 0
      const leftOrder = Number.isFinite(left.order) ? left.order : Number.MAX_SAFE_INTEGER
      const rightOrder = Number.isFinite(right.order) ? right.order : Number.MAX_SAFE_INTEGER
      return (
        rightFresh - leftFresh || leftOrder - rightOrder || left.stableIndex - right.stableIndex
      )
    })
    .map(({ item }) => item)
}

/**
 * 整个待处理队列的处理顺序：一批一批往下排，每批按来源比例分配名额，来源内凭据越新越先。
 *
 * 原来只按入库先后取前 10 个，weights 传进来却没用上——哪个来源先入库，整批就全是它。
 * 真机上设的是求职期望 50% / 搜索 50%，一整天投的全是求职期望。
 * 某个来源不够它的名额时，由另一个来源补齐，不让批次空着。
 */
export function orderDeliveryQueue<T>(args: DeliveryQueueArgs<T>) {
  const pools = dedupeDeliverySourcePools(args.pools, args.getItemKey, args.getItemSource)
  const queues: DeliverySourcePools<T> = {
    group: sortWithinSource(pools.group, args),
    search: sortWithinSource(pools.search, args),
  }
  const batchSize = Math.max(1, Math.floor(args.batchSize))
  const ordered: Array<DeliveryBatchItem<T>> = []
  while (queues.group.length + queues.search.length > 0) {
    const plan = buildDeliveryBatchPlan({ batchSize, weights: args.weights })
    const batch: Array<DeliveryBatchItem<T>> = []
    for (const source of orderedSources) {
      for (const item of queues[source].splice(0, plan[source])) batch.push({ source, item })
    }
    // 名额没用满（某个来源不够）时，用另一个来源按顺序补齐。
    for (const source of orderedSources) {
      if (batch.length >= batchSize) break
      for (const item of queues[source].splice(0, batchSize - batch.length)) {
        batch.push({ source, item })
      }
    }
    if (batch.length === 0) break
    ordered.push(...batch)
  }
  return ordered
}

export function selectDeliveryBatch<T>(args: DeliveryQueueArgs<T>) {
  const items = orderDeliveryQueue(args).slice(0, Math.max(0, Math.floor(args.batchSize)))
  const getItemKey = args.getItemKey ?? ((item: T) => item)
  const selectedKeys = new Set(items.map(({ item }) => getItemKey(item)))
  const pools = dedupeDeliverySourcePools(args.pools, args.getItemKey, args.getItemSource)
  const remaining: DeliverySourcePools<T> = {
    group: pools.group.filter((item) => !selectedKeys.has(getItemKey(item))),
    search: pools.search.filter((item) => !selectedKeys.has(getItemKey(item))),
  }
  const plan = items.reduce<DeliveryBatchPlan>(
    (counts, entry) => {
      counts[entry.source] += 1
      return counts
    },
    { group: 0, search: 0 },
  )

  return {
    items,
    plan,
    remaining,
  }
}

/** 待处理列表的展示顺序与实际处理顺序一致。 */
export function previewDeliveryQueue<T>(args: DeliveryQueueArgs<T> & { limit: number }) {
  const limit = Math.max(0, Math.floor(args.limit))
  return orderDeliveryQueue(args).slice(0, limit)
}

export function sourcesNeedingPrefetch<T>(args: DeliveryQueueArgs<T>): DeliveryLimitSource[] {
  const plan = buildDeliveryBatchPlan(args)
  const pools = dedupeDeliverySourcePools(args.pools, args.getItemKey)
  return orderedSources.filter((source) => plan[source] > 0 && pools[source].length < plan[source])
}

export function dedupeDeliverySourcePools<T>(
  pools: DeliverySourcePools<T>,
  getItemKey: (item: T) => unknown = (item) => item,
  getItemSource?: (item: T) => DeliveryLimitSource | undefined,
): DeliverySourcePools<T> {
  const seen = new Set<unknown>()
  const result: DeliverySourcePools<T> = {
    group: [],
    search: [],
  }

  for (const source of orderedSources) {
    for (const item of pools[source]) {
      const key = getItemKey(item)
      if (seen.has(key)) continue
      seen.add(key)
      result[getItemSource?.(item) ?? source].push(item)
    }
  }

  return result
}

export function flattenDeliveryQueue<T>(
  args: Pick<DeliveryQueueArgs<T>, 'getItemKey' | 'getItemOrder' | 'getItemSource' | 'pools'>,
) {
  const pools = dedupeDeliverySourcePools(args.pools, args.getItemKey, args.getItemSource)
  return orderedSources
    .flatMap((source) => pools[source].map((item) => ({ item, source })))
    .map((entry, stableIndex) => ({
      ...entry,
      order: args.getItemOrder?.(entry.item),
      stableIndex,
    }))
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left.order) ? Number(left.order) : Number.MAX_SAFE_INTEGER
      const rightOrder = Number.isFinite(right.order)
        ? Number(right.order)
        : Number.MAX_SAFE_INTEGER
      return leftOrder - rightOrder || left.stableIndex - right.stableIndex
    })
    .map(({ item, source }) => ({ item, source }))
}

/**
 * 当前这一页能不能收进投递池。
 *
 * 求职期望（group）自带方向，页面就是那个期望的列表。搜索（search）不是——它只是「某个
 * 岗位列表页」，方向要么来自任务步骤，要么来自 URL 的 query。两个都没有时，这一页不属于
 * 用户配置的任何一次搜索，收进去等于把一个无过滤的岗位流灌进投递池。
 *
 * 真机上就是这样：URL 只有 salary 筛选、没有 query，整页进池，于是「运营总监」「政府关系」
 * 这类和求职方向毫无关系的岗位混了进来。它们每一个都要烧掉一次详情请求（当前最紧的配额）
 * 和一次 AI 调用，最后还得靠模型把自己判掉——判错一次就投出去了。
 */
export function canCaptureIntoDeliveryPool(
  source: DeliveryLimitSource,
  searchDirection?: string | null,
) {
  if (source !== 'search') return true
  return typeof searchDirection === 'string' && searchDirection.trim().length > 0
}
