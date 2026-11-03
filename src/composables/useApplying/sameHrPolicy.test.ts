import { describe, expect, it } from 'vitest'

import {
  getNaturalWeekKey,
  hasSameHr,
  normalizeSameHrStore,
  recordSameHr,
  resetSameHrHistoryOnce,
  sameHrResetMarkerKey,
  sameHrResetVersion,
} from './sameHrPolicy'

const monday = new Date('2026-10-26T10:00:00')
const sunday = new Date('2026-11-01T23:00:00')
const nextMonday = new Date('2026-11-02T00:00:00')

describe('same-HR weekly policy', () => {
  it('clears only the HR history once for the reset rollout', async () => {
    const values = new Map<string, unknown>([['local:sameHr', { account: [{ id: 'hr-1' }] }]])
    const removed: string[] = []
    const storage = {
      storageGet: async <T>(key: string, fallback: T) =>
        values.has(key) ? (values.get(key) as T) : fallback,
      storageRm: async (key: string) => {
        removed.push(key)
        values.delete(key)
      },
      storageSet: async <T>(key: string, value: T) => {
        values.set(key, value)
      },
    }

    await expect(resetSameHrHistoryOnce(storage)).resolves.toBe(true)
    await expect(resetSameHrHistoryOnce(storage)).resolves.toBe(false)
    expect(removed).toEqual(['local:sameHr'])
    expect(values.get(sameHrResetMarkerKey)).toBe(sameHrResetVersion)
    expect(values.has('local:sameHr')).toBe(false)
  })

  it('keeps legacy IDs permanently without inventing a current-week delivery', () => {
    const migrated = normalizeSameHrStore({ account: ['hr-1', 'hr-1'] }, monday)
    expect(migrated).toEqual({
      store: {
        account: [
          {
            id: 'hr-1',
            date: '',
            deliveredAt: 0,
            week: '',
            origin: 'legacy-unknown',
          },
        ],
      },
      migrated: true,
    })
    expect(hasSameHr(migrated.store, 'account', 'hr-1', monday)).toBe(false)
    expect(hasSameHr(migrated.store, 'account', 'hr-1', nextMonday)).toBe(false)
  })

  it('records only a recruiter once for the current natural week', () => {
    let store = {} as ReturnType<typeof recordSameHr>
    store = recordSameHr(store, 'account', 'hr-1', monday)
    store = recordSameHr(store, 'account', 'hr-1', sunday)
    expect(store.account).toHaveLength(1)
    expect(store.account[0]).toMatchObject({
      id: 'hr-1',
      week: getNaturalWeekKey(monday),
      origin: 'delivery',
    })
    expect(hasSameHr(store, 'account', 'hr-2', sunday)).toBe(false)
  })

  it('allows the same recruiter again after the week changes and keeps both timestamps', () => {
    const first = recordSameHr({}, 'account', 'hr-1', sunday)
    const next = recordSameHr(first, 'account', 'hr-1', nextMonday)
    expect(next.account).toHaveLength(2)
    expect(next.account.map((item) => item.week)).toEqual(['2026-10-26', '2026-11-02'])
  })

  it('migrates the 1.3.29 day record without dropping its ID', () => {
    const migrated = normalizeSameHrStore(
      { account: { date: '2026-10-28', ids: ['hr-1'] } },
      nextMonday,
    )
    expect(migrated.store.account[0]).toMatchObject({
      id: 'hr-1',
      date: '2026-10-28',
      week: '2026-10-26',
      origin: 'legacy-day',
    })
    expect(hasSameHr(migrated.store, 'account', 'hr-1', nextMonday)).toBe(false)
  })

  it('quarantines already-materialized legacy batches from the previous migration bug', () => {
    const fallbackAt = monday.getTime() + 1234
    const migrated = normalizeSameHrStore(
      {
        account: [
          { id: 'hr-1', date: '2026-10-26', deliveredAt: fallbackAt, week: '2026-10-26' },
          { id: 'hr-2', date: '2026-10-26', deliveredAt: fallbackAt, week: '2026-10-26' },
        ],
      },
      monday,
    )

    expect(migrated.migrated).toBe(true)
    expect(migrated.store.account).toEqual([
      { id: 'hr-1', date: '', deliveredAt: 0, week: '', origin: 'legacy-unknown' },
      { id: 'hr-2', date: '', deliveredAt: 0, week: '', origin: 'legacy-unknown' },
    ])
    expect(hasSameHr(migrated.store, 'account', 'hr-1', monday)).toBe(false)
  })

  it('keeps older records with distinct timestamps as dated deliveries', () => {
    const migrated = normalizeSameHrStore(
      {
        account: [
          { id: 'hr-1', date: '2026-10-26', deliveredAt: monday.getTime(), week: '2026-10-26' },
          {
            id: 'hr-2',
            date: '2026-10-26',
            deliveredAt: monday.getTime() + 1000,
            week: '2026-10-26',
          },
        ],
      },
      monday,
    )

    expect(migrated.store.account.every((record) => record.origin === 'delivery')).toBe(true)
    expect(hasSameHr(migrated.store, 'account', 'hr-1', monday)).toBe(true)
  })
})
