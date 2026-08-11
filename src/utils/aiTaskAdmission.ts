export interface AiTaskAdmissionOptions {
  maxConcurrent: number
  maxRequests: number
  windowMs: number
}

export const defaultAiTaskAdmissionOptions: AiTaskAdmissionOptions = {
  maxConcurrent: 2,
  maxRequests: 20,
  windowMs: 60_000,
}

export class AiTaskAdmissionController {
  private active = 0
  private requestTimes: number[] = []

  constructor(private readonly options: AiTaskAdmissionOptions) {}

  acquire(now = Date.now()): { ok: true; release: () => void } | { ok: false; error: string } {
    this.requestTimes = this.requestTimes.filter(
      (requestedAt) => requestedAt > now - this.options.windowMs,
    )
    if (this.active >= this.options.maxConcurrent) {
      return {
        ok: false,
        error: `后台AI任务并发超过 ${this.options.maxConcurrent} 个限制`,
      }
    }
    if (this.requestTimes.length >= this.options.maxRequests) {
      return {
        ok: false,
        error: `后台AI任务速率超过 ${this.options.maxRequests} 次/${this.options.windowMs / 1000}秒限制`,
      }
    }

    this.active += 1
    this.requestTimes.push(now)
    let released = false
    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        this.active -= 1
      },
    }
  }
}
