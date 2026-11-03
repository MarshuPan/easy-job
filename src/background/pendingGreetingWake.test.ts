import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getItem, watch, query, probe, record } = vi.hoisted(() => ({
  getItem: vi.fn(),
  watch: vi.fn((_key: string, _changed: () => void) => vi.fn()),
  query: vi.fn(),
  probe: vi.fn(),
  record: vi.fn(),
}))
vi.mock('#imports', () => ({
  storage: { getItem, watch },
  browser: { tabs: { query } },
}))
vi.mock('./chatRuntime', () => ({ probeChatRuntime: probe, recordChatRuntime: record }))

describe('background chat queue wake', () => {
  let stop: (() => void) | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    query.mockResolvedValue([{ id: 7 }])
    probe.mockResolvedValue({ ready: true, code: 'READY', wakeDelivered: true })
    getItem.mockResolvedValue([])
  })
  afterEach(() => {
    stop?.()
    vi.useRealTimers()
  })
  it('wakes an existing background chat through runtime messages and stops when drained', async () => {
    getItem.mockResolvedValue([
      { fromUid: 'account-a', createdAt: Date.now(), status: { stage: 'waiting' } },
    ])
    stop = (await import('./pendingGreetingWake')).startPendingGreetingWake()
    await vi.advanceTimersByTimeAsync(2100)
    expect(probe).toHaveBeenCalledTimes(3)
    expect(probe).toHaveBeenLastCalledWith(7, 'account-a', true)
    expect(record).toHaveBeenCalledExactlyOnceWith(
      'account-a',
      expect.objectContaining({
        stage: 'wake',
        states: [expect.objectContaining({ wakeDelivered: true })],
      }),
    )
    getItem.mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(5000)
    expect(probe).toHaveBeenCalledTimes(3)
  })
  it('does not wake an uncertain send, and reacts to a subsequent queue change', async () => {
    getItem.mockResolvedValue([{ createdAt: Date.now(), status: { stage: 'sending' } }])
    stop = (await import('./pendingGreetingWake')).startPendingGreetingWake()
    await vi.advanceTimersByTimeAsync(5000)
    expect(probe).not.toHaveBeenCalled()
    getItem.mockResolvedValue([
      { fromUid: 'account-a', createdAt: Date.now(), status: { stage: 'queued' } },
    ])
    const changed = watch.mock.calls[0][1] as unknown as () => void
    changed()
    await vi.advanceTimersByTimeAsync(1000)
    expect(probe).toHaveBeenCalledOnce()
  })
  it('records missing chat pages and a wake failure instead of silently losing the reason', async () => {
    getItem.mockResolvedValue([
      { fromUid: 'account-a', createdAt: Date.now(), status: { stage: 'queued' } },
    ])
    query.mockResolvedValue([])
    stop = (await import('./pendingGreetingWake')).startPendingGreetingWake()
    await vi.advanceTimersByTimeAsync(0)
    expect(record).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({
        states: [expect.objectContaining({ code: 'NO_CHAT_TAB' })],
      }),
    )
    query.mockResolvedValue([{ id: 7 }])
    probe.mockRejectedValue(new Error('test wake failure'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(record).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({
        states: [expect.objectContaining({ code: 'CHAT_WAKE_FAILED' })],
      }),
    )
  })
})
