import type { MyJobListData } from '@/stores/jobs'

import type { DeliveryLimitSource } from './deliveryLimit'
import type { DeliveryTask } from './deliveryTask'
import { getExpectationLabel } from './jobExpectations'

const sourceLabelMap: Record<DeliveryLimitSource, string> = {
  group: '求职期望',
  search: '搜索',
}

/**
 * 投递引擎中不依赖 DOM、不依赖组件作用域的判断与摘要。
 *
 * 它们原先与取岗、翻页、等待列表加载的副作用混在同一个 SFC 里，只能通过挂载组件
 * 才能测到。搬到这里后可以直接单测，组件也少了一批与渲染无关的实现细节。
 */

export function isSameNavigationLocation(left: string, right: string) {
  try {
    const leftUrl = new URL(left, location.origin)
    const rightUrl = new URL(right, location.origin)
    return (
      leftUrl.pathname === rightUrl.pathname &&
      leftUrl.search === rightUrl.search &&
      leftUrl.hash === rightUrl.hash
    )
  } catch {
    return left === right
  }
}

export function getDeliveryJobKey(item: MyJobListData) {
  return item.encryptJobId || item.securityId || item.lid || item
}

export function getDeliveryJobOrder(item: MyJobListData) {
  return item.deliveryQueueOrder
}

export function getDeliveryJobSource(item: MyJobListData) {
  return item.deliveryQueueSource
}

export function getTaskStepLabel(step: DeliveryTask['steps'][number]) {
  if (step.expectation) return getExpectationLabel(step.expectation)
  if (step.searchDirection) return `搜索 · ${step.searchDirection}`
  return sourceLabelMap[step.source]
}

export function isSameTaskStep(
  left: DeliveryTask['steps'][number] | undefined,
  right: DeliveryTask['steps'][number] | undefined,
) {
  if (!left || !right || left.source !== right.source) return false
  if (left.source === 'search') {
    return (
      left.searchDirection === right.searchDirection &&
      isSameNavigationLocation(left.url, right.url)
    )
  }
  return left.expectation?.id === right.expectation?.id
}

export function findNextTaskStepIndexBySource(task: DeliveryTask, source: DeliveryLimitSource) {
  const orderedIndexes = [
    ...task.steps.slice(task.currentIndex + 1).map((_, index) => task.currentIndex + 1 + index),
    ...task.steps.slice(0, task.currentIndex + 1).map((_, index) => index),
  ]
  return (
    orderedIndexes.find(
      (index) =>
        task.steps[index]?.source === source &&
        task.steps[index]?.status !== 'done' &&
        !task.steps[index]?.prefetchExhausted,
    ) ?? -1
  )
}

export function hasPrefetchableStep(task: DeliveryTask, source: DeliveryLimitSource) {
  return task.steps.some(
    (step) => step.source === source && step.status !== 'done' && !step.prefetchExhausted,
  )
}

/**
 * 待处理只认「还没有结论」的三种状态。
 *
 * 用允许清单而不是 `default: return true`：filtered 曾经落进 default，于是被过滤掉的岗位
 * 永远留在待处理池里，FIFO 每一轮都把同一批捞出来重跑。这些岗位一进筛选就被判掉、不走投递节奏，
 * 于是形成每秒十几个的空转，统计里的「处理」一路虚涨，而投递记录按岗位去重，两边就对不上了。
 * 被过滤的岗位要重新参与投递，只能由用户点「重置待处理」显式放回 wait。
 */
export function getDeliverableJobs(items: MyJobListData[]) {
  return items.filter((item) => {
    const status = item.status?.status
    return status === 'pending' || status === 'wait' || status === 'running'
  })
}

export function summarizePools(pools: { group: MyJobListData[]; search: MyJobListData[] }) {
  return {
    group: pools.group.length,
    search: pools.search.length,
  }
}

export function summarizeTaskSteps(task: DeliveryTask) {
  return task.steps.map((step) => ({
    source: step.source,
    expectId: step.expectation?.id ?? null,
    expectation: step.expectation ? getExpectationLabel(step.expectation) : null,
    searchDirection: step.searchDirection ?? null,
    poolSizeAtEntry: step.poolSizeAtEntry ?? null,
    prefetchExhausted: step.prefetchExhausted === true,
    status: step.status,
    pagesDone: step.pagesDone,
    url: step.url,
    lastPage: step.lastPage,
    resumeNavigationAttempt: step.resumeNavigationAttempt,
  }))
}
