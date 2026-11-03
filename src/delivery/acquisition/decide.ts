import type { DeliveryLimitSource } from '@/pages/zhipin/utils/deliveryLimit'

/**
 * 补池决策。
 *
 * 这段判断原先散在 `runMixedQueueBatchIfReady` 及其三个 async 辅助函数的控制流里，
 * 与页面跳转、等待列表加载等副作用交织在一起，既读不清也测不到。这里只回答
 * 「下一步该做什么」，具体动作（切换来源、翻页抓取、处理批次）仍由调用方执行。
 */
export type AcquisitionTrigger = 'low-water' | 'underfilled'

export type AcquisitionDecision =
  /** 在当前来源就地补池。 */
  | { kind: 'prefetch-current'; source: DeliveryLimitSource; trigger: AcquisitionTrigger }
  /** 切到另一个来源补池；candidates 保留完整候选顺序供诊断。 */
  | {
      kind: 'switch-source'
      source: DeliveryLimitSource
      trigger: AcquisitionTrigger
      candidates: DeliveryLimitSource[]
    }
  /** 投递池已有可处理批次，直接消费。 */
  | { kind: 'process-batch' }
  /** 无事可做，交回调用方按原有兜底路径处理。 */
  | { kind: 'idle'; reason: string }

export interface AcquisitionInput {
  enabledSources: readonly DeliveryLimitSource[]
  /** 去重后各来源的可投递岗位数。 */
  poolSizes: Record<DeliveryLimitSource, number>
  /** 各来源的目标池容量。 */
  targetPoolPlan: Record<DeliveryLimitSource, number>
  /** 还有步骤可继续抓取的来源。 */
  prefetchableSources: readonly DeliveryLimitSource[]
  currentSource: DeliveryLimitSource
  lowWaterMark: number
  /** 本轮刚跑完整轮预热；此时不再触发低水位补池，避免与预热重复。 */
  warmupJustCompleted: boolean
  /** 已经可以立即处理的批次大小。 */
  readyBatchSize: number
  /** 补池倒计时已在处理或休息期间走完；只在岗位间安全节点让出执行权。 */
  refillDue?: boolean
  /** 各来源的比例设置。 */
  weights?: Record<DeliveryLimitSource, number>
  /** 今天各来源已处理的岗位数。补哪个来源看它离设定比例差多少。 */
  processedBySource?: Record<DeliveryLimitSource, number>
}

function totalPoolSize(input: AcquisitionInput) {
  return input.enabledSources.reduce((total, source) => total + input.poolSizes[source], 0)
}

/**
 * 今天这个来源离设定比例还差多少个岗位。
 *
 * 每次列表刷新都珍贵（BOSS 不允许频繁刷新），所以不为凑比例多刷新：需要刷新时，
 * 抓今天投得最少、离设定比例最远的来源，比例靠轮流抓来拉平。
 */
function sourceDeficit(input: AcquisitionInput, source: DeliveryLimitSource) {
  const weights = input.weights
  const processed = input.processedBySource
  if (weights == null || processed == null) return 0
  const totalWeight = input.enabledSources.reduce(
    (total, item) => total + Math.max(0, Number(weights[item]) || 0),
    0,
  )
  if (totalWeight <= 0) return 0
  const totalProcessed = input.enabledSources.reduce(
    (total, item) => total + Math.max(0, Number(processed[item]) || 0),
    0,
  )
  const share = Math.max(0, Number(weights[source]) || 0) / totalWeight
  return share * (totalProcessed + 1) - Math.max(0, Number(processed[source]) || 0)
}

/**
 * 今天离比例最远的来源优先；再看池内缺口；都一样时留在当前来源——切来源要多一次跳转，
 * 也是一次列表刷新。
 */
function byLargestGap(input: AcquisitionInput) {
  return (left: DeliveryLimitSource, right: DeliveryLimitSource) =>
    sourceDeficit(input, right) - sourceDeficit(input, left) ||
    input.targetPoolPlan[right] -
      input.poolSizes[right] -
      (input.targetPoolPlan[left] - input.poolSizes[left]) ||
    Number(right === input.currentSource) - Number(left === input.currentSource)
}

/** 补池时各来源的先后：首次补池和低水位补池用同一套排序。 */
export function rankRefillSources(
  input: AcquisitionInput,
  sources: readonly DeliveryLimitSource[],
) {
  return [...sources].sort(byLargestGap(input))
}

export function decideAcquisition(input: AcquisitionInput): AcquisitionDecision {
  if (input.enabledSources.length === 0) return { kind: 'idle', reason: '没有启用的岗位来源' }

  const prefetchable = input.enabledSources.filter((source) =>
    input.prefetchableSources.includes(source),
  )

  // 有岗位可处理时继续投，低水位只安排补给。倒计时走完后才在安全节点补池。
  if (input.readyBatchSize > 0 && !input.refillDue) return { kind: 'process-batch' }

  // 阶段一：空池，或已经利用处理间隔等完的低水位补给。
  if (!input.warmupJustCompleted && totalPoolSize(input) < input.lowWaterMark) {
    const candidates = [...prefetchable].sort(byLargestGap(input))
    if (candidates.length > 0) {
      const target = candidates[0]
      return target === input.currentSource
        ? { kind: 'prefetch-current', source: target, trigger: 'low-water' }
        : { kind: 'switch-source', source: target, trigger: 'low-water', candidates }
    }
  }

  // 阶段二：某个来源没达到目标容量。此时若已有可处理批次，先投递再补——
  // 补池要跳页，让用户看到的进度停滞比池子略浅更糟。
  const underfilled = prefetchable
    .filter((source) => input.poolSizes[source] < input.targetPoolPlan[source])
    .sort(byLargestGap(input))
  if (underfilled.length > 0 && input.readyBatchSize === 0) {
    const target = underfilled[0]
    return target === input.currentSource
      ? { kind: 'prefetch-current', source: target, trigger: 'underfilled' }
      : { kind: 'switch-source', source: target, trigger: 'underfilled', candidates: underfilled }
  }

  if (input.readyBatchSize > 0) return { kind: 'process-batch' }
  return {
    kind: 'idle',
    reason: underfilled.length > 0 ? '当前来源已无更多可抓岗位' : '投递池为空且无可补充来源',
  }
}
