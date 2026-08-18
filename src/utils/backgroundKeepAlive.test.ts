import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KEEP_ALIVE_INTERVAL_MS, startBackgroundKeepAlive } from './backgroundKeepAlive'

describe('backgroundKeepAlive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps pinging on the interval while a run is active', () => {
    const ping = vi.fn().mockResolvedValue(undefined)
    const handle = startBackgroundKeepAlive(ping)

    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS * 3)

    expect(ping).toHaveBeenCalledTimes(3)
    handle.stop()
  })

  it('stays under the service worker idle timeout', () => {
    // 30 秒是浏览器回收 worker 的阈值，间隔必须明显小于它，否则保活本身就是摆设。
    expect(KEEP_ALIVE_INTERVAL_MS).toBeLessThan(30_000)
  })

  it('stops pinging once the run ends', () => {
    const ping = vi.fn().mockResolvedValue(undefined)
    const handle = startBackgroundKeepAlive(ping)

    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS)
    handle.stop()
    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS * 5)

    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('is idempotent on stop', () => {
    const ping = vi.fn().mockResolvedValue(undefined)
    const handle = startBackgroundKeepAlive(ping)

    handle.stop()
    handle.stop()
    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS * 3)

    expect(ping).not.toHaveBeenCalled()
  })

  it('keeps going after a failed ping', async () => {
    // worker 正在重启时这一拍必然失败，但下一拍要把它唤醒——不能因为一次失败就停摆。
    const ping = vi
      .fn()
      .mockRejectedValueOnce(new Error('heartbeat check timeout 5000ms'))
      .mockResolvedValue(undefined)
    const handle = startBackgroundKeepAlive(ping)

    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS)

    expect(ping).toHaveBeenCalledTimes(2)
    handle.stop()
  })

  it('does not stack timers when started twice', () => {
    const ping = vi.fn().mockResolvedValue(undefined)
    const first = startBackgroundKeepAlive(ping)
    first.stop()
    const second = startBackgroundKeepAlive(ping)

    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS * 2)

    expect(ping).toHaveBeenCalledTimes(2)
    second.stop()
  })
})
