import { SEARCH_DIRECTIONS_PER_CYCLE, selectRotatingCycle } from '@/delivery/acquisition/scheduler'

import type { DeliveryLimitSource } from './deliveryLimit'
import type { JobExpectation } from './jobExpectations'

export interface DeliveryTaskStep {
  source: DeliveryLimitSource
  url: string
  expectation?: JobExpectation
  searchDirection?: string
  poolSizeAtEntry?: number
  prefetchExhausted?: boolean
  status: 'pending' | 'running' | 'waiting' | 'done'
  pagesDone: number
  lastPage?: {
    len: number
    firstJobId: string
  }
  resumeNavigationAttempt?: {
    at: number
    fromUrl: string
    targetUrl: string
  }
}

export interface DeliveryTaskBatchItem {
  source: DeliveryLimitSource
  encryptJobId: string
}

export interface DeliveryTaskActiveBatch {
  id: string
  startedAt: number
  items: DeliveryTaskBatchItem[]
}

export interface DeliveryTask {
  accountUid: string
  id: string
  legacyMigrationPending?: boolean
  startedAt: number
  checkpointAt?: number
  currentIndex: number
  steps: DeliveryTaskStep[]
  acquisitionCycle?: number
  cycleStartedSuccess?: number
  cycleStartedTotal?: number
  noProgressCycles?: number
  retryAt?: number
  runtimeHeartbeat?: {
    at: number
    source: DeliveryLimitSource
    expectId?: string
    searchDirection?: string
  }
  searchRotation?: {
    nextDirectionKey: string
    selectedDirections: string[]
  }
  poolWarmup?: {
    completed: boolean
    attemptedStepIndexes: number[]
    lowWaterArmed?: boolean
  }
  activeBatch?: DeliveryTaskActiveBatch
}

export const DELIVERY_TASK_HEARTBEAT_INTERVAL_MS = 2_000
export const DELIVERY_TASK_HEARTBEAT_MAX_AGE_MS = 120_000
export const DELIVERY_TASK_MAX_EMPTY_CYCLES = 3
const deliveryTaskKey = 'agent-delivery:combined-delivery-task'
const legacyDeliveryTaskKey = `${['boss', 'helper'].join('-')}:combined-delivery-task`
const defaultGroupUrl = 'https://www.zhipin.com/web/geek/jobs'
export const SEARCH_DIRECTIONS_PER_TASK = SEARCH_DIRECTIONS_PER_CYCLE

function createDeliveryTaskId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function getDefaultGroupUrl() {
  return defaultGroupUrl
}

function readDeliveryTaskAtKey(key: string): DeliveryTask | null {
  const raw = window.sessionStorage.getItem(key)
  if (raw == null) return null
  try {
    const task = JSON.parse(raw) as DeliveryTask
    if (!Array.isArray(task.steps) || task.steps.length === 0) {
      window.sessionStorage.removeItem(key)
      return null
    }
    return task
  } catch {
    window.sessionStorage.removeItem(key)
    return null
  }
}

function isDeliveryTask(value: unknown): value is DeliveryTask {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return false
  const task = value as Partial<DeliveryTask>
  return (
    typeof task.accountUid === 'string' &&
    task.accountUid.length > 0 &&
    typeof task.id === 'string' &&
    task.id.length > 0 &&
    typeof task.startedAt === 'number' &&
    Number.isFinite(task.startedAt) &&
    typeof task.currentIndex === 'number' &&
    Number.isInteger(task.currentIndex) &&
    Array.isArray(task.steps) &&
    task.steps.length > 0
  )
}

function normalizePoolWarmup(task: DeliveryTask) {
  if (task.poolWarmup == null) {
    // Tasks created before pool warmup existed may already be delivering. Do not restart their startup fill.
    task.poolWarmup = {
      completed: true,
      attemptedStepIndexes: [],
      lowWaterArmed: false,
    }
    return true
  }

  const storedAttemptedStepIndexes = Array.isArray(task.poolWarmup.attemptedStepIndexes)
    ? task.poolWarmup.attemptedStepIndexes
    : []
  const attemptedStepIndexes = Array.from(
    new Set(
      storedAttemptedStepIndexes.filter(
        (index): index is number =>
          Number.isInteger(index) && index >= 0 && index < task.steps.length,
      ),
    ),
  )
  const completed = task.poolWarmup.completed === true
  const lowWaterArmed =
    typeof task.poolWarmup.lowWaterArmed === 'boolean' ? task.poolWarmup.lowWaterArmed : !completed
  const changed =
    completed !== task.poolWarmup.completed ||
    lowWaterArmed !== task.poolWarmup.lowWaterArmed ||
    attemptedStepIndexes.length !== storedAttemptedStepIndexes.length ||
    attemptedStepIndexes.some((index, position) => storedAttemptedStepIndexes[position] !== index)
  task.poolWarmup = {
    completed,
    attemptedStepIndexes,
    lowWaterArmed,
  }
  return changed
}

function normalizeActiveBatch(task: DeliveryTask) {
  const batch = task.activeBatch
  if (batch == null) return false
  if (
    typeof batch.id !== 'string' ||
    batch.id.length === 0 ||
    typeof batch.startedAt !== 'number' ||
    !Number.isFinite(batch.startedAt) ||
    !Array.isArray(batch.items)
  ) {
    delete task.activeBatch
    return true
  }

  const seen = new Set<string>()
  const items = batch.items.flatMap((item) => {
    if (
      (item?.source !== 'group' && item?.source !== 'search') ||
      typeof item.encryptJobId !== 'string' ||
      item.encryptJobId.length === 0
    ) {
      return []
    }
    const key = item.encryptJobId
    if (seen.has(key)) return []
    seen.add(key)
    return [{ source: item.source, encryptJobId: item.encryptJobId }]
  })
  if (items.length === 0) {
    delete task.activeBatch
    return true
  }
  const changed =
    items.length !== batch.items.length ||
    items.some(
      (item, index) =>
        item.source !== batch.items[index]?.source ||
        item.encryptJobId !== batch.items[index]?.encryptJobId,
    )
  if (changed) task.activeBatch = { id: batch.id, startedAt: batch.startedAt, items }
  return changed
}

export function advanceDeliveryTaskCycleProgress(
  task: DeliveryTask,
  statistics: { success: number; total: number },
) {
  const previousTotal = task.cycleStartedTotal
  const madeProgress =
    previousTotal == null
      ? statistics.success > (task.cycleStartedSuccess ?? statistics.success)
      : statistics.total > previousTotal
  const noProgressCycles = madeProgress ? 0 : (task.noProgressCycles ?? 0) + 1
  task.cycleStartedSuccess = statistics.success
  task.cycleStartedTotal = statistics.total
  task.noProgressCycles = noProgressCycles
  return { madeProgress, noProgressCycles }
}

export function hasReachedDeliveryTaskEmptyCycleLimit(task: DeliveryTask) {
  return (task.noProgressCycles ?? 0) >= DELIVERY_TASK_MAX_EMPTY_CYCLES
}

export function readDeliveryTask(expectedAccountUid: string): DeliveryTask | null {
  const currentTask = readDeliveryTaskAtKey(deliveryTaskKey)
  const task = currentTask ?? readDeliveryTaskAtKey(legacyDeliveryTaskKey)
  if (task == null) return null

  if (
    typeof task.accountUid !== 'string' ||
    task.accountUid.length === 0 ||
    task.accountUid !== expectedAccountUid
  ) {
    window.sessionStorage.removeItem(deliveryTaskKey)
    window.sessionStorage.removeItem(legacyDeliveryTaskKey)
    return null
  }

  const storedTaskId = typeof task.id === 'string' && task.id.length > 0 ? task.id : null
  if (storedTaskId == null) task.id = createDeliveryTaskId()
  const warmupMigrated = normalizePoolWarmup(task)
  const activeBatchMigrated = normalizeActiveBatch(task)
  if (currentTask == null || storedTaskId == null || warmupMigrated || activeBatchMigrated) {
    saveDeliveryTask(task, storedTaskId)
  }
  return task
}

export function saveDeliveryTask(task: DeliveryTask, expectedTaskId: string | null) {
  if (readStoredDeliveryTaskId() !== expectedTaskId) return false
  task.checkpointAt = Date.now()
  window.sessionStorage.setItem(deliveryTaskKey, JSON.stringify(task))
  window.sessionStorage.removeItem(legacyDeliveryTaskKey)
  return true
}

export function clearDeliveryTask(expectedTaskId: string) {
  if (readStoredDeliveryTaskId() !== expectedTaskId) return false
  window.sessionStorage.removeItem(deliveryTaskKey)
  window.sessionStorage.removeItem(legacyDeliveryTaskKey)
  return true
}

export function restoreDeliveryTask(
  checkpoint: unknown,
  expectedAccountUid: string,
): DeliveryTask | null {
  if (!isDeliveryTask(checkpoint) || checkpoint.accountUid !== expectedAccountUid) return null
  const task = structuredClone(checkpoint)
  normalizePoolWarmup(task)
  normalizeActiveBatch(task)
  window.sessionStorage.setItem(deliveryTaskKey, JSON.stringify(task))
  window.sessionStorage.removeItem(legacyDeliveryTaskKey)
  return task
}

function readStoredDeliveryTaskId(): string | null {
  const raw =
    window.sessionStorage.getItem(deliveryTaskKey) ??
    window.sessionStorage.getItem(legacyDeliveryTaskKey)
  if (raw == null) return null
  try {
    const task = JSON.parse(raw) as Partial<DeliveryTask>
    return typeof task.id === 'string' && task.id.length > 0 ? task.id : null
  } catch {
    return null
  }
}

export function getCurrentTaskStep(task: DeliveryTask) {
  return task.steps[task.currentIndex]
}

export function touchDeliveryTaskHeartbeat(task: DeliveryTask, now = Date.now()) {
  const step = getCurrentTaskStep(task)
  if (step == null) return false

  const previousHeartbeat = task.runtimeHeartbeat
  task.runtimeHeartbeat = {
    at: now,
    source: step.source,
    ...(step.expectation?.id ? { expectId: step.expectation.id } : {}),
    ...(step.searchDirection ? { searchDirection: step.searchDirection } : {}),
  }
  if (saveDeliveryTask(task, task.id)) return true

  if (previousHeartbeat == null) delete task.runtimeHeartbeat
  else task.runtimeHeartbeat = previousHeartbeat
  return false
}

export function getFreshDeliveryTaskHeartbeat(
  task: DeliveryTask,
  expectedSource: DeliveryLimitSource,
  now = Date.now(),
  expectedExpectId?: string,
  expectedSearchDirection?: string,
) {
  const heartbeat = task.runtimeHeartbeat
  if (heartbeat == null || heartbeat.source !== expectedSource) return null
  if (expectedExpectId && heartbeat.expectId !== expectedExpectId) return null
  if (expectedSearchDirection && heartbeat.searchDirection !== expectedSearchDirection) return null

  const ageMs = now - heartbeat.at
  if (!Number.isFinite(heartbeat.at) || ageMs < 0 || ageMs >= DELIVERY_TASK_HEARTBEAT_MAX_AGE_MS) {
    return null
  }
  return {
    ...heartbeat,
    ageMs,
  }
}

export function markCurrentStepDone(task: DeliveryTask) {
  const current = getCurrentTaskStep(task)
  if (current) current.status = 'done'
}

export function rotateToNextTaskStep(task: DeliveryTask) {
  const current = getCurrentTaskStep(task)
  if (current && current.status !== 'done') {
    current.status = 'waiting'
    current.pagesDone += 1
  }
  const orderedIndexes = [
    ...task.steps.slice(task.currentIndex + 1).map((_, index) => task.currentIndex + 1 + index),
    ...task.steps.slice(0, task.currentIndex + 1).map((_, index) => index),
  ]
  const nextIndex = orderedIndexes.find((index) => task.steps[index]?.status !== 'done') ?? -1
  task.currentIndex = nextIndex
  return nextIndex >= 0 ? task.steps[nextIndex] : null
}

export function findNextWarmupStepIndex(
  task: DeliveryTask,
  underfilledSources: DeliveryLimitSource[],
) {
  const attempted = new Set(task.poolWarmup?.attemptedStepIndexes ?? [])
  const orderedIndexes = [
    task.currentIndex,
    ...task.steps.map((_, index) => index).filter((index) => index !== task.currentIndex),
  ]
  return (
    orderedIndexes.find((index) => {
      const step = task.steps[index]
      return (
        step != null &&
        !attempted.has(index) &&
        underfilledSources.includes(step.source) &&
        step.status !== 'done' &&
        !step.prefetchExhausted
      )
    }) ?? -1
  )
}

export function createDeliveryTask(args: {
  accountUid: string
  currentSource: DeliveryLimitSource
  currentUrl: string
  currentGroupExpectId?: string
  searchUrl?: string
  searchUrls?: Array<{ direction: string; url: string }>
  searchCursorKey?: string
  groupUrl?: string
  groupExpectations?: JobExpectation[]
  hasRemaining: (source: DeliveryLimitSource) => boolean
}): DeliveryTask | null {
  const groupUrl =
    args.currentSource === 'group' ? args.currentUrl : (args.groupUrl ?? defaultGroupUrl)
  const configuredSearchSteps = normalizeSearchSteps(args.searchUrls, args.searchUrl)
  const selectedSearch = selectRotatingCycle({
    items: configuredSearchSteps,
    cursorKey: args.searchCursorKey,
    getKey: getSearchStepKey,
  })
  const searchSteps = args.hasRemaining('search') ? selectedSearch.items : []
  const groupSteps: Array<{
    source: 'group'
    url: string
    expectation?: JobExpectation
  }> = args.hasRemaining('group')
    ? args.groupExpectations == null
      ? [{ source: 'group' as const, url: groupUrl }]
      : args.groupExpectations.map((expectation) => ({
          source: 'group' as const,
          url: groupUrl,
          expectation,
        }))
    : []
  if (searchSteps.length === 0 && groupSteps.length === 0) return null

  const orderedGroupSteps = [...groupSteps].sort((left, right) => {
    const leftCurrent = left.expectation?.id === args.currentGroupExpectId ? 0 : 1
    const rightCurrent = right.expectation?.id === args.currentGroupExpectId ? 0 : 1
    return leftCurrent - rightCurrent
  })
  const orderedSearchSteps = [...searchSteps].sort((left, right) => {
    const leftCurrent = isSameLocation(left.url, args.currentUrl) ? 0 : 1
    const rightCurrent = isSameLocation(right.url, args.currentUrl) ? 0 : 1
    return leftCurrent - rightCurrent
  })
  const steps =
    args.currentSource === 'group'
      ? [...orderedGroupSteps, ...orderedSearchSteps]
      : [...orderedSearchSteps, ...orderedGroupSteps]

  return {
    accountUid: args.accountUid,
    id: createDeliveryTaskId(),
    startedAt: Date.now(),
    checkpointAt: Date.now(),
    currentIndex: 0,
    acquisitionCycle: 1,
    cycleStartedSuccess: 0,
    noProgressCycles: 0,
    poolWarmup: {
      completed: false,
      attemptedStepIndexes: [],
      lowWaterArmed: true,
    },
    ...(searchSteps.length > 0
      ? {
          searchRotation: {
            nextDirectionKey: selectedSearch.nextCursorKey,
            selectedDirections: searchSteps.map((step) => step.searchDirection ?? ''),
          },
        }
      : {}),
    steps: steps.map((step, index) => ({
      ...step,
      status: index === 0 ? 'running' : 'pending',
      pagesDone: 0,
      lastPage: undefined,
      ...(step.source === 'search' && index === 0 ? { poolSizeAtEntry: 0 } : {}),
    })),
  }
}

function getSearchStepKey(step: { searchDirection?: string; url: string }) {
  const direction = step.searchDirection?.replace(/\s+/g, '').toLocaleLowerCase() ?? ''
  return direction || step.url
}

function normalizeSearchSteps(
  searchUrls: Array<{ direction: string; url: string }> | undefined,
  fallbackUrl: string | undefined,
) {
  const candidates =
    searchUrls && searchUrls.length > 0
      ? searchUrls
      : fallbackUrl
        ? [{ direction: readSearchDirection(fallbackUrl), url: fallbackUrl }]
        : []
  const seen = new Set<string>()
  return candidates.flatMap((item) => {
    const direction = item.direction.trim()
    const url = item.url.trim()
    if (!url) return []
    const key = `${direction.replace(/\s+/g, '').toLocaleLowerCase()}|${url}`
    if (seen.has(key)) return []
    seen.add(key)
    return [
      { source: 'search' as const, url, ...(direction ? { searchDirection: direction } : {}) },
    ]
  })
}

function readSearchDirection(url: string) {
  try {
    return new URL(url, defaultGroupUrl).searchParams.get('query')?.trim() ?? ''
  } catch {
    return ''
  }
}

function isSameLocation(left: string, right: string) {
  try {
    const leftUrl = new URL(left, defaultGroupUrl)
    const rightUrl = new URL(right, defaultGroupUrl)
    return (
      leftUrl.pathname === rightUrl.pathname &&
      leftUrl.search === rightUrl.search &&
      leftUrl.hash === rightUrl.hash
    )
  } catch {
    return left === right
  }
}
