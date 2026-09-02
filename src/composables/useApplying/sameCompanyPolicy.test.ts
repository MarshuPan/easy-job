import { describe, expect, it } from 'vitest'

import {
  SAME_COMPANY_MAX_JOBS,
  SAME_COMPANY_WINDOW_MS,
  evaluateSameCompany,
  normalizeSameCompanyStore,
  recordSameCompanyDelivery,
} from './sameCompanyPolicy'

const now = 1_800_000_000_000

describe('same company delivery policy', () => {
  it('allows three different jobs and rejects the fourth within the fresh window', () => {
    let records = [] as ReturnType<typeof recordSameCompanyDelivery>
    records = recordSameCompanyDelivery(records, 'brand-a', 'job-1', now)
    records = recordSameCompanyDelivery(records, 'brand-a', 'job-2', now + 1)
    records = recordSameCompanyDelivery(records, 'brand-a', 'job-3', now + 2)

    expect(records[0].deliveredCount).toBe(SAME_COMPANY_MAX_JOBS)
    expect(evaluateSameCompany(records, 'brand-a', 'job-4', now + 3)).toBe('company-limit')
  })

  it('rejects the same JD even when the company has not reached the limit', () => {
    const records = recordSameCompanyDelivery([], 'brand-a', 'job-1', now)

    expect(evaluateSameCompany(records, 'brand-a', 'job-1', now + 1)).toBe('same-job')
    expect(evaluateSameCompany(records, 'brand-a', 'job-2', now + 1)).toBe('allow')
  })

  it('resets the company window after fifteen days', () => {
    const records = recordSameCompanyDelivery([], 'brand-a', 'job-1', now)

    expect(evaluateSameCompany(records, 'brand-a', 'job-2', now + SAME_COMPANY_WINDOW_MS)).toBe(
      'allow',
    )
    expect(
      recordSameCompanyDelivery(records, 'brand-a', 'job-2', now + SAME_COMPANY_WINDOW_MS),
    ).toEqual([
      {
        brandId: 'brand-a',
        jobIds: ['job-2'],
        deliveredCount: 1,
        lastDeliveredAt: now + SAME_COMPANY_WINDOW_MS,
      },
    ])
  })

  it('migrates legacy company IDs as one delivery and gives them a fresh window', () => {
    const result = normalizeSameCompanyStore({ 'account-a': ['brand-a'] }, now)

    expect(result.migrated).toBe(true)
    expect(result.store['account-a']).toEqual([
      {
        brandId: 'brand-a',
        jobIds: [],
        deliveredCount: 1,
        lastDeliveredAt: now,
      },
    ])
    expect(evaluateSameCompany(result.store['account-a'], 'brand-a', 'new-job', now)).toBe('allow')
  })

  it('prunes expired records while normalizing storage', () => {
    const result = normalizeSameCompanyStore(
      {
        'account-a': [
          {
            brandId: 'expired',
            jobIds: ['old-job'],
            deliveredCount: 1,
            lastDeliveredAt: now - SAME_COMPANY_WINDOW_MS,
          },
        ],
      },
      now,
    )

    expect(result.migrated).toBe(true)
    expect(result.store).toEqual({})
  })

  it('keeps records isolated by account in the storage shape', () => {
    const result = normalizeSameCompanyStore(
      {
        'account-a': [
          { brandId: 'brand-a', jobIds: ['job-a'], deliveredCount: 1, lastDeliveredAt: now },
        ],
        'account-b': [
          { brandId: 'brand-a', jobIds: ['job-b'], deliveredCount: 1, lastDeliveredAt: now },
        ],
      },
      now,
    )

    expect(evaluateSameCompany(result.store['account-a'], 'brand-a', 'job-a', now)).toBe('same-job')
    expect(evaluateSameCompany(result.store['account-b'], 'brand-a', 'job-a', now)).toBe('allow')
  })
})
