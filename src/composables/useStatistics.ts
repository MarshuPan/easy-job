import { watchThrottled } from '@vueuse/core'
import { defineStore } from 'pinia'
import { reactive } from 'vue'

import { ref } from '#imports'
import { counter } from '@/message'
import type { Statistics } from '@/types/formData'
import { getCurDay } from '@/utils'
import { createAccountStorageKey, normalizeAccountUid } from '@/utils/accountStorage'
import { jsonClone } from '@/utils/deepmerge'
import { logger } from '@/utils/logger'
import { getProviderHeartbeatDiagnostic } from '@/utils/providerHealth'

export const todayKey = 'local:web-geek-job-Today'
export const statisticsKey = 'local:web-geek-job-Statistics'
const statisticsEpochKey = 'local:web-geek-job-StatisticsEpoch'
const statisticsLockName = 'agent-delivery:statistics'
const statisticsWriteReceiptsKey = '__agentDeliveryWriteReceipts'
const maxStatisticsWriteReceipts = 64
const statisticsCounterKeys = [
  'success',
  'searchSuccess',
  'groupSuccess',
  'searchTotal',
  'groupTotal',
  'searchFiltered',
  'groupFiltered',
  'total',
  'jobContent',
  'aiFiltering',
  'companySizeRange',
  'activityFilter',
  'goldHunterFilter',
  'repeat',
  'amap',
] as const
let localStatisticsWriteQueue: Promise<unknown> = Promise.resolve()

interface StatisticsStorageKeys {
  epoch: string
  history: string
  today: string
}

const legacyStatisticsStorageKeys: StatisticsStorageKeys = {
  epoch: statisticsEpochKey,
  history: statisticsKey,
  today: todayKey,
}

function createStatisticsStorageKeys(uid: string): StatisticsStorageKeys {
  return {
    epoch: createAccountStorageKey(statisticsEpochKey, uid),
    history: createAccountStorageKey(statisticsKey, uid),
    today: createAccountStorageKey(todayKey, uid),
  }
}

async function withStatisticsWriteLock<T>(write: () => Promise<T>): Promise<T> {
  const run = async () => {
    const locks = globalThis.navigator?.locks
    if (locks?.request) return await locks.request(statisticsLockName, write)
    return await write()
  }
  const queued = localStatisticsWriteQueue.then(run, run)
  localStatisticsWriteQueue = queued.catch(() => undefined)
  return await queued
}

/**
 * 当日统计的字段全集。实现与测试必须共用这一份，否则新增统计字段时两边会漂移，
 * 测试里缺字段的 mock 会让 `todayData.<field>++` 静默变成 NaN。
 */
export function createEmptyStatistics(date: string): Statistics {
  return {
    date,
    success: 0,
    searchSuccess: 0,
    groupSuccess: 0,
    searchTotal: 0,
    groupTotal: 0,
    searchFiltered: 0,
    groupFiltered: 0,
    total: 0,
    jobContent: 0,
    aiFiltering: 0,
    companySizeRange: 0,
    activityFilter: 0,
    goldHunterFilter: 0,
    repeat: 0,
    amap: 0,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function isStatisticsDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function normalizeCounter(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

function normalizeStatistics(data: unknown, fallbackDate = getCurDay()): Statistics {
  const source = isPlainObject(data) ? data : {}
  const normalized = createEmptyStatistics(
    isStatisticsDate(source.date) ? source.date : fallbackDate,
  )
  for (const key of statisticsCounterKeys) {
    normalized[key] = normalizeCounter(source[key])
  }
  if (source.searchSuccess == null) {
    normalized.searchSuccess = Math.max(0, normalized.success - (normalized.groupSuccess ?? 0))
  }
  normalized.groupTotal = Math.max(
    normalized.groupTotal ?? 0,
    (normalized.groupSuccess ?? 0) + (normalized.groupFiltered ?? 0),
  )
  normalized.searchTotal = Math.max(
    normalized.searchTotal ?? 0,
    (normalized.searchSuccess ?? 0) + (normalized.searchFiltered ?? 0),
  )
  // 来源累计和顶部总处理必须是同一本账。旧版本或并行写入可能留下来源累计高于
  // total 的快照；按较大的已处理数修复，避免每日额度被低估而继续超额投递。
  const attributedTotal = normalized.groupTotal + normalized.searchTotal
  normalized.total = Math.max(normalized.total, normalized.success, attributedTotal)
  return normalized
}

function isStatisticsSchema(value: unknown): value is Statistics {
  return (
    isPlainObject(value) &&
    isStatisticsDate(value.date) &&
    statisticsCounterKeys.every(
      (key) =>
        typeof value[key] === 'number' &&
        Number.isFinite(value[key]) &&
        Number.isInteger(value[key]) &&
        value[key] >= 0,
    ) &&
    typeof value.total === 'number' &&
    typeof value.success === 'number' &&
    value.total >= value.success
  )
}

function normalizeStatisticsHistory(value: unknown) {
  if (!Array.isArray(value)) return []
  const dates = new Set<string>()
  const history: Statistics[] = []
  for (const item of value) {
    if (!isPlainObject(item) || !isStatisticsDate(item.date) || dates.has(item.date)) continue
    dates.add(item.date)
    history.push(normalizeStatistics(item, item.date))
  }
  return history
}

function isStatisticsHistorySchema(value: unknown): value is Statistics[] {
  if (!Array.isArray(value) || !value.every(isStatisticsSchema)) return false
  return new Set(value.map((item) => item.date)).size === value.length
}

function normalizeEpoch(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function isEpochSchema(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

interface StatisticsWriteReceipt {
  at: number
  token: string
}

type StatisticsWriteReceipts = Record<string, StatisticsWriteReceipt>

function isStatisticsWriteReceipt(value: unknown): value is StatisticsWriteReceipt {
  return (
    isPlainObject(value) &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    value.token.length <= 128 &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at) &&
    value.at >= 0
  )
}

function normalizeStatisticsWriteReceipts(value: unknown): StatisticsWriteReceipts {
  if (!isPlainObject(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, StatisticsWriteReceipt] =>
          entry[0].length > 0 && entry[0].length <= 128 && isStatisticsWriteReceipt(entry[1]),
      )
      .sort(([, left], [, right]) => right.at - left.at)
      .slice(0, maxStatisticsWriteReceipts),
  )
}

function isStatisticsWriteReceiptsSchema(value: unknown) {
  if (value == null) return true
  if (!isPlainObject(value) || Object.keys(value).length > maxStatisticsWriteReceipts) return false
  return Object.entries(value).every(
    ([writerId, receipt]) =>
      writerId.length > 0 && writerId.length <= 128 && isStatisticsWriteReceipt(receipt),
  )
}

function createPersistedToday(today: Statistics, receipts: StatisticsWriteReceipts) {
  if (Object.keys(receipts).length === 0) return today
  return { ...today, [statisticsWriteReceiptsKey]: receipts }
}

function addStatisticsWriteReceipt(
  receipts: StatisticsWriteReceipts,
  writerId: string,
  token: string,
) {
  const receipt: StatisticsWriteReceipt = { at: Date.now(), token }
  const olderReceipts = Object.entries(receipts)
    .filter(([id]) => id !== writerId)
    .sort(([, left], [, right]) => right.at - left.at)
  return Object.fromEntries(
    [[writerId, receipt], ...olderReceipts].slice(0, maxStatisticsWriteReceipts),
  )
}

function createStatisticsOpaqueId(prefix: string) {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36)}`
  return `${prefix}-${id}`
}

interface PersistedStatisticsState {
  epoch: number
  history: Statistics[]
  receipts: StatisticsWriteReceipts
  today: Statistics
  todayNeedsWrite: boolean
}

async function readCurrentStatisticsState(
  keys: StatisticsStorageKeys,
  currentDate: string,
  rolloverData?: Statistics,
  deferTodayWrite = false,
): Promise<PersistedStatisticsState> {
  const rawToday = await counter.storageGet<unknown>(keys.today, createEmptyStatistics(currentDate))
  const rawHistory = await counter.storageGet<unknown>(keys.history, [])
  const rawEpoch = await counter.storageGet<unknown>(keys.epoch, 0)
  let today = normalizeStatistics(rawToday, currentDate)
  let history = normalizeStatisticsHistory(rawHistory)
  let epoch = normalizeEpoch(rawEpoch)
  let receipts = normalizeStatisticsWriteReceipts(
    isPlainObject(rawToday) ? rawToday[statisticsWriteReceiptsKey] : undefined,
  )
  let todayDirty =
    !isStatisticsSchema(rawToday) ||
    !isStatisticsWriteReceiptsSchema(
      isPlainObject(rawToday) ? rawToday[statisticsWriteReceiptsKey] : undefined,
    )
  let historyDirty = !isStatisticsHistorySchema(rawHistory)
  let epochDirty = !isEpochSchema(rawEpoch)
  const needsEpochReset = todayDirty || epochDirty || today.date !== currentDate

  if (today.date !== currentDate) {
    history = [today, ...history.filter((item) => item.date !== today.date)]
    today =
      rolloverData?.date === currentDate
        ? normalizeStatistics(rolloverData, currentDate)
        : createEmptyStatistics(currentDate)
    receipts = {}
    todayDirty = true
    historyDirty = true
  }
  if (needsEpochReset) {
    epoch += 1
    epochDirty = true
  }

  if (todayDirty || historyDirty) {
    logger.warn('统计持久数据格式损坏或日期已变化，正在写锁内修复', {
      historyRepaired: historyDirty,
      todayRepaired: todayDirty,
    })
  }
  if (todayDirty && !deferTodayWrite) {
    await counter.storageSet(keys.today, createPersistedToday(today, receipts))
  }
  if (historyDirty) await counter.storageSet(keys.history, history)
  if (epochDirty) await counter.storageSet(keys.epoch, epoch)
  return { epoch, history, receipts, today, todayNeedsWrite: todayDirty && deferTodayWrite }
}

function mergeStatisticsDelta(stored: Statistics, snapshot: Statistics, baseline: Statistics) {
  const merged = normalizeStatistics(stored, stored.date)
  for (const key of statisticsCounterKeys) {
    const delta = Math.max(0, (snapshot[key] ?? 0) - (baseline[key] ?? 0))
    merged[key] = normalizeCounter((merged[key] ?? 0) + delta)
  }
  return merged
}

export const useStatistics = defineStore('statistics', () => {
  const todayData = reactive<Statistics>(createEmptyStatistics(getCurDay()))
  const statisticsData = ref<Statistics[]>([])
  let baselineToday = createEmptyStatistics(todayData.date)
  let baselineEpoch: number | null = null
  let queuedBaselineToday = createEmptyStatistics(todayData.date)
  let queuedBaselineEpoch: number | null = null
  let pendingPersistCount = 0
  let previousPersistSucceeded = true
  const statisticsWriterId = createStatisticsOpaqueId('writer')
  let uncertainWrite: { epoch: number; snapshot: Statistics; token: string } | undefined
  let accountUid: string | undefined
  let storageKeys = legacyStatisticsStorageKeys

  function adoptStatisticsState(state: PersistedStatisticsState) {
    baselineToday = jsonClone(state.today)
    baselineEpoch = state.epoch
    if (pendingPersistCount === 0) {
      queuedBaselineToday = jsonClone(state.today)
      queuedBaselineEpoch = state.epoch
      Object.assign(todayData, state.today)
    }
    statisticsData.value = jsonClone(state.history)
  }

  function finishPendingPersist(syncTodayData: boolean) {
    pendingPersistCount = Math.max(0, pendingPersistCount - 1)
    if (pendingPersistCount !== 0) return
    queuedBaselineToday = jsonClone(baselineToday)
    queuedBaselineEpoch = baselineEpoch
    if (syncTodayData) Object.assign(todayData, baselineToday)
  }

  async function getStatistics(): Promise<string> {
    await flush()
    return JSON.stringify(jsonClone({ t: todayData, s: statisticsData.value }))
  }

  async function setStatistics(data: string) {
    const parsed: unknown = JSON.parse(data)
    if (!isPlainObject(parsed) || !isPlainObject(parsed.t) || !Array.isArray(parsed.s)) {
      throw new Error('统计快照格式损坏')
    }
    const restoredToday = normalizeStatistics(parsed.t)
    const restoredHistory = normalizeStatisticsHistory(parsed.s)
    const operationKeys = storageKeys
    await withStatisticsWriteLock(async () => {
      const rawEpoch = await counter.storageGet<unknown>(operationKeys.epoch, 0)
      const nextEpoch = normalizeEpoch(rawEpoch) + 1
      await counter.storageSet(operationKeys.today, restoredToday)
      await counter.storageSet(operationKeys.history, restoredHistory)
      await counter.storageSet(operationKeys.epoch, nextEpoch)
      adoptStatisticsState({
        epoch: nextEpoch,
        history: restoredHistory,
        receipts: {},
        today: restoredToday,
        todayNeedsWrite: false,
      })
    })
  }

  watchThrottled(
    todayData,
    (value) => {
      void persistTodaySnapshot(jsonClone(value)).catch((error) => {
        logger.warn(
          '统计自动保存失败，已保留当前页面内存统计',
          getProviderHeartbeatDiagnostic(error),
        )
      })
    },
    { throttle: 200 },
  )

  function updateStatistics(curData?: Statistics) {
    const requestedData = curData == null ? undefined : normalizeStatistics(jsonClone(curData))
    return withStatisticsWriteLock(() => updateStatisticsNow(requestedData))
  }

  function persistTodaySnapshot(snapshot: Statistics) {
    const operationKeys = storageKeys
    const hasPendingPersist = pendingPersistCount > 0
    if (!hasPendingPersist) previousPersistSucceeded = true
    const expectedEpoch = hasPendingPersist ? queuedBaselineEpoch : baselineEpoch
    const expectedBaseline = jsonClone(hasPendingPersist ? queuedBaselineToday : baselineToday)
    queuedBaselineToday = jsonClone(snapshot)
    queuedBaselineEpoch = expectedEpoch
    pendingPersistCount += 1
    const writeToken = createStatisticsOpaqueId('write')
    let operationStarted = false
    let operationSucceeded = false
    let attemptedWrite: { epoch: number; snapshot: Statistics; token: string } | undefined

    return withStatisticsWriteLock(async () => {
      operationStarted = true
      try {
        const currentDate = getCurDay()
        const state = await readCurrentStatisticsState(operationKeys, currentDate, undefined, true)
        let confirmedUncertainBaseline: Statistics | undefined
        if (uncertainWrite != null) {
          const receipt = state.receipts[statisticsWriterId]
          if (uncertainWrite.epoch === state.epoch && receipt?.token === uncertainWrite.token) {
            confirmedUncertainBaseline = uncertainWrite.snapshot
            previousPersistSucceeded = true
          } else if (uncertainWrite.epoch === state.epoch) {
            previousPersistSucceeded = false
          } else {
            previousPersistSucceeded = true
          }
          uncertainWrite = undefined
        }
        if (!isStatisticsDate(snapshot.date) || snapshot.date !== currentDate) {
          if (state.todayNeedsWrite) {
            await counter.storageSet(
              operationKeys.today,
              createPersistedToday(state.today, state.receipts),
            )
          }
          adoptStatisticsState(state)
          previousPersistSucceeded = true
          operationSucceeded = true
          return state.today
        }
        if (expectedEpoch != null && expectedEpoch !== state.epoch) {
          if (state.todayNeedsWrite) {
            await counter.storageSet(
              operationKeys.today,
              createPersistedToday(state.today, state.receipts),
            )
          }
          adoptStatisticsState(state)
          previousPersistSucceeded = true
          operationSucceeded = true
          return state.today
        }

        const normalizedSnapshot = normalizeStatistics(snapshot, currentDate)
        const expectedBaselineIsCurrent =
          (expectedEpoch == null || expectedEpoch === state.epoch) &&
          expectedBaseline.date === currentDate
        const persistedBaselineIsCurrent =
          baselineEpoch === state.epoch && baselineToday.date === currentDate
        const baseline =
          confirmedUncertainBaseline ??
          (previousPersistSucceeded && expectedBaselineIsCurrent
            ? expectedBaseline
            : persistedBaselineIsCurrent
              ? baselineToday
              : createEmptyStatistics(currentDate))
        const mergedToday = mergeStatisticsDelta(state.today, normalizedSnapshot, baseline)
        const hasChanges = statisticsCounterKeys.some(
          (key) => mergedToday[key] !== state.today[key],
        )
        const nextReceipts =
          hasChanges || state.todayNeedsWrite
            ? addStatisticsWriteReceipt(state.receipts, statisticsWriterId, writeToken)
            : state.receipts
        if (hasChanges || state.todayNeedsWrite) {
          attemptedWrite = { epoch: state.epoch, snapshot: normalizedSnapshot, token: writeToken }
          await counter.storageSet(
            operationKeys.today,
            createPersistedToday(mergedToday, nextReceipts),
          )
          attemptedWrite = undefined
        }
        adoptStatisticsState({
          ...state,
          receipts: nextReceipts,
          today: mergedToday,
          todayNeedsWrite: false,
        })
        previousPersistSucceeded = true
        operationSucceeded = true
        return mergedToday
      } catch (error) {
        if (attemptedWrite != null) uncertainWrite = attemptedWrite
        previousPersistSucceeded = false
        throw error
      } finally {
        finishPendingPersist(operationSucceeded)
      }
    }).catch((error) => {
      if (!operationStarted) {
        previousPersistSucceeded = false
        finishPendingPersist(false)
      }
      throw error
    })
  }

  async function updateStatisticsNow(curData?: Statistics) {
    const currentDate = getCurDay()
    const state = await readCurrentStatisticsState(storageKeys, currentDate, curData)
    logger.debug('统计数据:', currentDate, state.today)
    adoptStatisticsState(state)
    return state.today
  }

  async function flush() {
    if (todayData.date !== getCurDay()) await updateStatistics()
    await persistTodaySnapshot(jsonClone(todayData))
  }

  async function setAccountScope(uid: string | number) {
    const nextAccountUid = normalizeAccountUid(uid)
    if (accountUid === nextAccountUid) {
      await updateStatistics()
      return
    }

    if (accountUid != null) await flush()
    else await localStatisticsWriteQueue

    const nextKeys = createStatisticsStorageKeys(nextAccountUid)
    await withStatisticsWriteLock(async () => {
      const [scopedToday, scopedHistory, scopedEpoch] = await Promise.all([
        counter.storageGet<unknown>(nextKeys.today, null),
        counter.storageGet<unknown>(nextKeys.history, null),
        counter.storageGet<unknown>(nextKeys.epoch, null),
      ])
      if (scopedToday != null || scopedHistory != null || scopedEpoch != null) return

      const [legacyToday, legacyHistory, legacyEpoch] = await Promise.all([
        counter.storageGet<unknown>(todayKey, null),
        counter.storageGet<unknown>(statisticsKey, null),
        counter.storageGet<unknown>(statisticsEpochKey, null),
      ])
      if (legacyToday == null && legacyHistory == null && legacyEpoch == null) return

      await counter.storageSet(nextKeys.today, normalizeStatistics(legacyToday))
      await counter.storageSet(nextKeys.history, normalizeStatisticsHistory(legacyHistory))
      await counter.storageSet(nextKeys.epoch, normalizeEpoch(legacyEpoch))
      await Promise.allSettled([
        counter.storageRm(todayKey),
        counter.storageRm(statisticsKey),
        counter.storageRm(statisticsEpochKey),
      ])
    })

    accountUid = nextAccountUid
    storageKeys = nextKeys
    baselineToday = createEmptyStatistics(getCurDay())
    baselineEpoch = null
    queuedBaselineToday = createEmptyStatistics(getCurDay())
    queuedBaselineEpoch = null
    pendingPersistCount = 0
    previousPersistSucceeded = true
    uncertainWrite = undefined
    Object.assign(todayData, createEmptyStatistics(getCurDay()))
    statisticsData.value = []
    await updateStatistics()
  }

  return {
    todayData,
    statisticsData,
    updateStatistics,
    flush,
    getStatistics,
    setStatistics,
    setAccountScope,
  }
})
