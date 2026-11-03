import { afterEach, describe, expect, it, vi } from 'vitest'
const { append, uid } = vi.hoisted(() => ({
  append: vi.fn(async (_input: unknown) => true),
  uid: { value: '' },
}))
vi.mock('@/message', () => ({ counter: { localDiagnosticAppend: append } }))
vi.mock('@/stores/user', () => ({ useUser: () => ({ getUserId: () => uid.value }) }))
import { startRuntimeObservation } from './runtimeObservation'

describe('page health observation', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })
  it('reports missing account initialization and records lifecycle without query strings', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/web/geek/jobs?private=value')
    uid.value = ''
    const stop = startRuntimeObservation()
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      event: 'runtime.page-health',
      accountUid: undefined,
      data: { sequence: 1, accountKnown: false, reason: 'started' },
    })
    uid.value = 'account'
    await vi.advanceTimersByTimeAsync(30_000)
    document.dispatchEvent(new Event('freeze'))
    const records = append.mock.calls.map(([event]) => event) as any[]
    expect(records.at(-1)).toMatchObject({
      event: 'runtime.page-health',
      accountUid: 'account',
      data: { sequence: 3, reason: 'freeze', route: '/web/geek/jobs', accountKnown: true },
    })
    expect(records[1].data.elapsedSinceLastMs).toBe(30_000)
    expect(JSON.stringify(records)).not.toContain('private=value')
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(append).toHaveBeenCalledTimes(3)
  })
})
