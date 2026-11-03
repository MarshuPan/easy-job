import { createStorageMutex } from '@/utils/storageMutex'

export type SameHrDeliveryRecord = {
  id: string
  /** 本地时间日期，便于人工复盘历史触达。 */
  date: string
  /** 成功建立沟通的本地时间戳。 */
  deliveredAt: number
  /** 本地自然周的周一日期，周一至周日为一个周期。 */
  week: string
  /**
   * 日期来源。只有真实投递或旧版带日期记录才可以参与当前周去重。
   * legacy-unknown 只保留招聘者 ID，不会把迁移时刻伪造成投递时间。
   */
  origin: 'delivery' | 'legacy-day' | 'legacy-unknown'
}

export type SameHrStore = Record<string, SameHrDeliveryRecord[]>

/**
 * One-time operational reset for the 1.3.38 rollout. This is deliberately a
 * separate key from the user configuration and from the HR history itself so
 * the migration can remove only the requested de-duplication data.
 */
export const sameHrResetMarkerKey = 'local:sameHrResetVersion'
export const sameHrResetVersion = '1.3.38'

/**
 * The background startup migration and the delivery pipeline share this lock.
 * Both contexts can touch the same browser storage key during extension reload.
 */
export const sameHrStorageMutex = createStorageMutex('agent-delivery:same-hr')

type SameHrStorage = {
  storageGet<T>(key: string, defaultValue: T): Promise<T>
  storageSet<T>(key: string, value: T): Promise<unknown>
  storageRm(key: string): Promise<unknown>
}

export async function resetSameHrHistoryOnce(storage: SameHrStorage) {
  const marker = await storage.storageGet<unknown>(sameHrResetMarkerKey, null)
  if (marker === sameHrResetVersion) return false

  await storage.storageRm('local:sameHr')
  await storage.storageSet(sameHrResetMarkerKey, sameHrResetVersion)
  return true
}

function normalizeIds(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))]
}

function localDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 返回本地时间的自然周周一日期。自然周按周一至周日计算。 */
export function getNaturalWeekKey(value: Date | number = Date.now()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const day = date.getDay()
  const daysSinceMonday = (day + 6) % 7
  date.setDate(date.getDate() - daysSinceMonday)
  return localDateKey(date)
}

function timestampForDate(date: string, fallback: number) {
  const parsed = Date.parse(`${date}T12:00:00`)
  return Number.isFinite(parsed) ? parsed : fallback
}

function createRecord(
  id: string,
  deliveredAt: number,
  date?: string,
  week?: string,
  origin: SameHrDeliveryRecord['origin'] = 'delivery',
) {
  if (origin === 'legacy-unknown') {
    return {
      id,
      date: '',
      deliveredAt: 0,
      week: '',
      origin,
    } satisfies SameHrDeliveryRecord
  }
  const timestamp = Number.isFinite(deliveredAt) ? deliveredAt : Date.now()
  const normalizedDate =
    typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date
      : localDateKey(new Date(timestamp))
  return {
    id,
    date: normalizedDate,
    deliveredAt: timestamp,
    week:
      typeof week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(week)
        ? week
        : getNaturalWeekKey(timestamp),
    origin,
  } satisfies SameHrDeliveryRecord
}

function normalizeRecord(value: unknown, fallbackAt: number): SameHrDeliveryRecord | null {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  if (!id) return null
  const date = typeof source.date === 'string' ? source.date : undefined
  const deliveredAt =
    typeof source.deliveredAt === 'number' && Number.isFinite(source.deliveredAt)
      ? source.deliveredAt
      : timestampForDate(date ?? '', fallbackAt)
  const week = typeof source.week === 'string' ? source.week : undefined
  const origin =
    source.origin === 'legacy-day' ||
    source.origin === 'legacy-unknown' ||
    source.origin === 'delivery'
      ? source.origin
      : 'delivery'
  return createRecord(id, deliveredAt, date, week, origin)
}

function recordsFromLegacyDay(value: Record<string, unknown>, fallbackAt: number) {
  const date = typeof value.date === 'string' ? value.date : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return normalizeIds(value.ids).map((id) =>
      createRecord(id, 0, undefined, undefined, 'legacy-unknown'),
    )
  }
  const deliveredAt = timestampForDate(date, fallbackAt)
  return normalizeIds(value.ids).map((id) =>
    createRecord(id, deliveredAt, date, getNaturalWeekKey(deliveredAt), 'legacy-day'),
  )
}

function hasExplicitOrigin(value: unknown) {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return false
  const origin = (value as Record<string, unknown>).origin
  return origin === 'delivery' || origin === 'legacy-day' || origin === 'legacy-unknown'
}

function normalizeParsedRecords(
  parsed: Array<{ record: SameHrDeliveryRecord; explicitOrigin: boolean }>,
) {
  // 1.3.30/1.3.31 converted an old string array by assigning one Date.now() value to
  // every ID. A real serial delivery cannot produce the same millisecond for multiple
  // recruiters, so quarantine those already-materialized batches as unknown history.
  const timestampCounts = new Map<number, number>()
  for (const item of parsed) {
    if (item.explicitOrigin || item.record.origin !== 'delivery' || item.record.deliveredAt <= 0) {
      continue
    }
    timestampCounts.set(
      item.record.deliveredAt,
      (timestampCounts.get(item.record.deliveredAt) ?? 0) + 1,
    )
  }
  const legacyBatchTimestamps = new Set(
    [...timestampCounts.entries()].filter(([, count]) => count > 1).map(([timestamp]) => timestamp),
  )

  return parsed.map(({ record, explicitOrigin }) => {
    if (!explicitOrigin && legacyBatchTimestamps.has(record.deliveredAt)) {
      return createRecord(record.id, 0, undefined, undefined, 'legacy-unknown')
    }
    return record
  })
}

/**
 * 读取并迁移所有历史形状：旧版数组、1.3.29 的 { date, ids }，以及当前的永久记录数组。
 * 只有带可靠日期的记录参与当前周过滤；只有 ID 的旧记录会永久保留，但作为未知历史跳过过滤。
 */
export function normalizeSameHrStore(
  raw: unknown,
  now: number | Date = Date.now(),
): { store: SameHrStore; migrated: boolean } {
  const fallbackAt = now instanceof Date ? now.getTime() : now
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) {
    return { store: {}, migrated: raw != null }
  }

  const store: SameHrStore = {}
  let migrated = false
  for (const [uid, value] of Object.entries(raw as Record<string, unknown>)) {
    let parsed: Array<{ record: SameHrDeliveryRecord; explicitOrigin: boolean }> = []
    if (Array.isArray(value)) {
      parsed = value.flatMap((item) => {
        if (typeof item === 'string') {
          return [
            {
              record: createRecord(item, 0, undefined, undefined, 'legacy-unknown'),
              explicitOrigin: true,
            },
          ]
        }
        const record = normalizeRecord(item, fallbackAt)
        return record ? [{ record, explicitOrigin: hasExplicitOrigin(item) }] : []
      })
      // A string array is the oldest format; an array of records is already current.
      migrated ||= value.some((item) => {
        if (typeof item === 'string') return true
        const record = normalizeRecord(item, fallbackAt)
        if (!record || typeof item !== 'object' || item == null || Array.isArray(item)) return true
        const source = item as Record<string, unknown>
        return (
          typeof source.date !== 'string' ||
          typeof source.deliveredAt !== 'number' ||
          typeof source.week !== 'string'
        )
      })
    } else if (typeof value === 'object' && value != null) {
      const source = value as Record<string, unknown>
      if (Array.isArray(source.records)) {
        parsed = source.records.flatMap((item) => {
          const record = normalizeRecord(item, fallbackAt)
          return record ? [{ record, explicitOrigin: hasExplicitOrigin(item) }] : []
        })
        migrated ||= parsed.length !== source.records.length
        migrated ||= source.records.some((item) => {
          if (typeof item !== 'object' || item == null || Array.isArray(item)) return true
          const record = item as Record<string, unknown>
          return (
            typeof record.id !== 'string' ||
            typeof record.date !== 'string' ||
            typeof record.deliveredAt !== 'number' ||
            typeof record.week !== 'string'
          )
        })
      } else if ('date' in source || 'ids' in source) {
        parsed = recordsFromLegacyDay(source, fallbackAt).map((record) => ({
          record,
          explicitOrigin: true,
        }))
        migrated = true
      } else {
        migrated = true
      }
    } else {
      migrated = true
    }

    const records = normalizeParsedRecords(parsed)
    migrated ||= records.some((item, index) => {
      const original = parsed[index]?.record
      return (
        !parsed[index]?.explicitOrigin ||
        original?.origin !== item.origin ||
        original?.week !== item.week ||
        original?.deliveredAt !== item.deliveredAt
      )
    })
    const unique = new Map<string, SameHrDeliveryRecord>()
    for (const record of records) {
      const key = `${record.id}\u0000${record.deliveredAt}\u0000${record.week}`
      if (!unique.has(key)) unique.set(key, record)
    }
    if (unique.size > 0) {
      store[uid] = [...unique.values()].sort((a, b) => a.deliveredAt - b.deliveredAt)
    }
    if (records.length !== unique.size) migrated = true
  }
  return { store, migrated }
}

export function hasSameHr(
  store: SameHrStore,
  uid: string,
  recruiterId: string | null | undefined,
  now: number | Date = Date.now(),
) {
  if (!recruiterId) return false
  const week = getNaturalWeekKey(now)
  return (store[uid] ?? []).some(
    (record) =>
      record.origin !== 'legacy-unknown' && record.id === recruiterId && record.week === week,
  )
}

export function recordSameHr(
  store: SameHrStore,
  uid: string,
  recruiterId: string,
  now: number | Date = Date.now(),
): SameHrStore {
  const deliveredAt = now instanceof Date ? now.getTime() : now
  const record = createRecord(recruiterId, deliveredAt)
  const current = store[uid] ?? []
  if (current.some((item) => item.id === recruiterId && item.week === record.week)) return store
  return {
    ...store,
    [uid]: [...current, record].sort((a, b) => a.deliveredAt - b.deliveredAt),
  }
}
