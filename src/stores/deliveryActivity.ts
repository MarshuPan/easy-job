import { ref } from 'vue'

/**
 * 投递此刻在做什么，给面板看。
 *
 * 原来面板在等待时也只显示「投递中 · 投递流程运行中」：节奏间隔 30-60 秒、批次休息
 * 10 分钟、BOSS 请求限速、来源自动重试，看起来都像卡住了。任务序列也是把 JD 筛选、
 * 生成招呼语、建立沟通三步同时点亮，不反映岗位走到哪一步。
 *
 * 各环节在开始一件事时报告一次，面板只读。岗位上下文是普通对象、被直接改写，面板
 * 追踪不到，所以不从岗位记录里反推，由做事的地方直接报。
 */
export type DeliveryActivityKind = 'stage' | 'wait' | 'acquire'

export interface DeliveryActivity {
  kind: DeliveryActivityKind
  label: string
  since: number
  /** 等待类活动的结束时间，面板据此倒计时。 */
  until?: number
}

const activity = ref<DeliveryActivity | null>(null)

export function useDeliveryActivity() {
  return activity
}

/** 当前岗位进入某个阶段（JD 筛选、生成招呼语、建立沟通……）。 */
export function reportDeliveryStage(label: string) {
  activity.value = { kind: 'stage', label, since: Date.now() }
}

/** 开始一段已知时长的等待。 */
export function reportDeliveryWait(label: string, durationMs: number) {
  const now = Date.now()
  activity.value = { kind: 'wait', label, since: now, until: now + Math.max(0, durationMs) }
}

/** 正在抓取或刷新岗位列表。 */
export function reportDeliveryAcquire(label: string) {
  activity.value = { kind: 'acquire', label, since: Date.now() }
}

/**
 * 限速这类插在某个阶段中间的等待：等完要回到原来的阶段，不然面板会一直停在
 * 「限速等待」，直到下一个阶段开始。
 */
export async function withDeliveryWait<T>(
  label: string,
  durationMs: number,
  operation: () => Promise<T>,
) {
  const previous = activity.value
  reportDeliveryWait(label, durationMs)
  const current = activity.value
  try {
    return await operation()
  } finally {
    if (activity.value === current) activity.value = previous
  }
}

export function clearDeliveryActivity() {
  activity.value = null
}
