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
}

function totalPoolSize(input: AcquisitionInput) {
  return input.enabledSources.reduce((total, source) => total + input.poolSizes[source], 0)
}

/** 缺口大的来源优先补。 */
function byLargestGap(input: AcquisitionInput) {
  return (left: DeliveryLimitSource, right: DeliveryLimitSource) =>
    input.targetPoolPlan[right] -
    input.poolSizes[right] -
    (input.targetPoolPlan[left] - input.poolSizes[left])
}

function pickTarget(candidates: readonly DeliveryLimitSource[], current: DeliveryLimitSource) {
  // 能在当前来源就地补池就不跳转——切换来源要走页面导航，代价高得多。
  return candidates.includes(current) ? current : candidates[0]
}

export function decideAcquisition(input: AcquisitionInput): AcquisitionDecision {
  if (input.enabledSources.length === 0) return { kind: 'idle', reason: '没有启用的岗位来源' }

  const prefetchable = input.enabledSources.filter((source) =>
    input.prefetchableSources.includes(source),
  )

  // 阶段一：整池低于低水位线，优先补到能继续投递。
  if (!input.warmupJustCompleted && totalPoolSize(input) < input.lowWaterMark) {
    const candidates = [...prefetchable].sort(byLargestGap(input))
    if (candidates.length > 0) {
      const target = pickTarget(candidates, input.currentSource)
      return target === input.currentSource
        ? { kind: 'prefetch-current', source: target, trigger: 'low-water' }
        : { kind: 'switch-source', source: target, trigger: 'low-water', candidates }
    }
  }

  // 阶段二：某个来源没达到目标容量。此时若已有可处理批次，先投递再补——
  // 补池要跳页，让用户看到的进度停滞比池子略浅更糟。
  const underfilled = prefetchable.filter(
    (source) => input.poolSizes[source] < input.targetPoolPlan[source],
  )
  if (underfilled.length > 0 && input.readyBatchSize === 0) {
    const target = pickTarget(underfilled, input.currentSource)
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
