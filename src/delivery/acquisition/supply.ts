const minute = 60_000
const defaultJobMs = 70_000
const defaultRefillMs = 90_000

function recentMean(samples: readonly number[], fallback: number, maxMs: number) {
  const recent = samples.filter((value) => Number.isFinite(value) && value >= 0).slice(-20)
  if (recent.length === 0) return fallback
  // 少量样本先与默认值混合；快速过滤不能一直被当作完整 AI 投递。
  const priorCount = Math.max(0, 3 - recent.length)
  const total = recent.reduce((sum, value) => sum + Math.min(maxMs, Math.max(1000, value)), 0)
  return (total + fallback * priorCount) / (recent.length + priorCount)
}

/** 只用当前任务的耗时，不保存岗位、账号或个人内容。 */
export function estimateSupplyPolicy(
  jobDurations: readonly number[],
  refillDurations: readonly number[] = [],
) {
  const jobMs = recentMean(jobDurations, defaultJobMs, 5 * minute)
  const refillMs = Math.max(45_000, recentMean(refillDurations, defaultRefillMs, 5 * minute))
  const targetSize = Math.min(60, Math.max(2, Math.ceil((10 * minute) / jobMs)))
  const lowWaterMark = Math.min(targetSize, Math.max(1, Math.ceil((refillMs + 30_000) / jobMs)))
  return { jobMs, refillMs, targetSize, lowWaterMark }
}

/** 倒计时只计划一次，持续处理岗位不能把翻页时间不断往后推。 */
export class SupplyRefillSchedule {
  private taskId: string | undefined
  private readyAt: number | undefined

  schedule(taskId: string, delayMs: number, now = Date.now()) {
    if (this.taskId !== taskId) {
      this.taskId = taskId
      this.readyAt = undefined
    }
    this.readyAt ??= now + Math.max(0, delayMs)
    return this.readyAt
  }

  getReadyAt(taskId: string) {
    return this.taskId === taskId ? this.readyAt : undefined
  }

  clear(taskId: string) {
    if (this.taskId === taskId) this.readyAt = undefined
  }
}
