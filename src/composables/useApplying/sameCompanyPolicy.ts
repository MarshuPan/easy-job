export const SAME_COMPANY_WINDOW_MS = 15 * 24 * 60 * 60 * 1000
export const SAME_COMPANY_MAX_JOBS = 3

export type SameCompanyRecord = {
  brandId: string
  jobIds: string[]
  deliveredCount: number
  lastDeliveredAt: number
}

export type SameCompanyStore = Record<string, SameCompanyRecord[]>

export type SameCompanyDecision = 'allow' | 'same-job' | 'company-limit'

function isFresh(record: SameCompanyRecord, now: number) {
  return now - record.lastDeliveredAt < SAME_COMPANY_WINDOW_MS
}

function normalizeJobIds(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0)
}

function normalizeRecord(brandId: string, value: unknown, now: number) {
  if (typeof value === 'string' && value.length > 0) {
    return {
      record: {
        brandId: value,
        jobIds: [],
        deliveredCount: 1,
        lastDeliveredAt: now,
      },
      migrated: true,
    }
  }

  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return { record: null, migrated: true }
  }

  const source = value as Record<string, unknown>
  const normalizedBrandId =
    typeof source.brandId === 'string' && source.brandId.length > 0 ? source.brandId : brandId
  if (!normalizedBrandId) return { record: null, migrated: true }

  const jobIds = normalizeJobIds(source.jobIds)
  const rawCount = Number(source.deliveredCount)
  const deliveredCount = Math.max(
    jobIds.length,
    Number.isFinite(rawCount) ? rawCount : jobIds.length,
  )
  const rawTimestamp = Number(source.lastDeliveredAt)
  const lastDeliveredAt = Number.isFinite(rawTimestamp) && rawTimestamp > 0 ? rawTimestamp : now

  return {
    record: {
      brandId: normalizedBrandId,
      jobIds: jobIds.slice(-SAME_COMPANY_MAX_JOBS),
      deliveredCount,
      lastDeliveredAt,
    },
    migrated:
      normalizedBrandId !== brandId ||
      !Number.isFinite(rawCount) ||
      !Number.isFinite(rawTimestamp) ||
      rawTimestamp <= 0 ||
      jobIds.length > SAME_COMPANY_MAX_JOBS,
  }
}

/**
 * Convert the legacy `{ uid: string[] }` store and prune expired company windows.
 * Legacy IDs have no timestamp or JD history, so they count as one delivery from
 * the migration time and then follow the new 15-day policy.
 */
export function normalizeSameCompanyStore(
  raw: unknown,
  now: number,
): {
  store: SameCompanyStore
  migrated: boolean
} {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) {
    return { store: {}, migrated: raw != null }
  }

  const store: SameCompanyStore = {}
  let migrated = false
  for (const [uid, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      migrated = true
      continue
    }

    const records: SameCompanyRecord[] = []
    for (const item of value) {
      const brandId =
        typeof item === 'string'
          ? item
          : typeof item === 'object' && item != null && typeof (item as any).brandId === 'string'
            ? (item as any).brandId
            : ''
      const normalized = normalizeRecord(brandId, item, now)
      migrated ||= normalized.migrated
      if (!normalized.record || !isFresh(normalized.record, now)) {
        if (normalized.record) migrated = true
        continue
      }
      const existing = records.find((record) => record.brandId === normalized.record!.brandId)
      if (existing == null) {
        records.push(normalized.record)
        continue
      }
      migrated = true
      existing.jobIds = Array.from(
        new Set([...existing.jobIds, ...normalized.record.jobIds]),
      ).slice(-SAME_COMPANY_MAX_JOBS)
      existing.deliveredCount = Math.max(existing.deliveredCount, normalized.record.deliveredCount)
      existing.lastDeliveredAt = Math.max(
        existing.lastDeliveredAt,
        normalized.record.lastDeliveredAt,
      )
    }
    if (records.length > 0) store[uid] = records
  }
  return { store, migrated }
}

export function evaluateSameCompany(
  records: readonly SameCompanyRecord[],
  brandId: string | null | undefined,
  jobId: string | null | undefined,
  now: number,
): SameCompanyDecision {
  if (!brandId) return 'allow'
  const record = records.find((item) => item.brandId === brandId)
  if (record == null || !isFresh(record, now)) return 'allow'
  if (jobId && record.jobIds.includes(jobId)) return 'same-job'
  if (record.deliveredCount >= SAME_COMPANY_MAX_JOBS) return 'company-limit'
  return 'allow'
}

export function recordSameCompanyDelivery(
  records: readonly SameCompanyRecord[],
  brandId: string,
  jobId: string,
  now: number,
) {
  const activeRecords = records.filter((record) => isFresh(record, now))
  const existing = activeRecords.find((record) => record.brandId === brandId)
  if (existing == null) {
    return [...activeRecords, { brandId, jobIds: [jobId], deliveredCount: 1, lastDeliveredAt: now }]
  }
  if (existing.jobIds.includes(jobId)) return activeRecords.slice()

  return activeRecords.map((record) =>
    record === existing
      ? {
          ...record,
          jobIds: [...record.jobIds, jobId].slice(-SAME_COMPANY_MAX_JOBS),
          deliveredCount: record.deliveredCount + 1,
          lastDeliveredAt: now,
        }
      : record,
  )
}
