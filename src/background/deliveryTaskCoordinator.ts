import { parseDeliveryConfigSnapshot } from '@/delivery/configSnapshot'

export const DELIVERY_WORKER_LEASE_MS = 15_000
export const DELIVERY_TASK_SCHEMA_VERSION = 2

export type DeliveryTaskActiveStatus = 'running' | 'waiting-for-page'
export type DeliveryTaskTerminalStatus = 'completed' | 'failed' | 'stopped'
/**
 * 暂停既不是「运行中」也不是「已结束」：检查点和运行配置快照都保留，但没有执行端持有租约，
 * 也不参与自动恢复。只有用户点「继续」才会通过 start() 用同一个 runId 重新接管。
 */
export type DeliveryTaskPausedStatus = 'paused'
export type DeliveryTaskStatus =
  | DeliveryTaskActiveStatus
  | DeliveryTaskPausedStatus
  | DeliveryTaskTerminalStatus
export type DeliveryTaskActivePhase = 'acquiring' | 'processing' | 'waiting'
export type DeliveryTaskTerminalReason = 'manual-stop' | 'daily-limit' | 'terminal-error'

export interface DurableDeliveryTask {
  schemaVersion: typeof DELIVERY_TASK_SCHEMA_VERSION
  accountUid: string
  runId: string
  status: DeliveryTaskStatus
  phase?: DeliveryTaskActivePhase
  terminalReason?: DeliveryTaskTerminalReason
  terminalMessage?: string
  checkpoint: unknown
  configSnapshot?: unknown
  workerId?: string
  leaseExpiresAt?: number
  startedAt: number
  updatedAt: number
  lastWorkerAt?: number
  migratedFromSchemaVersion?: number
  revision: number
}

export interface DeliveryTaskCoordinatorStorage {
  read(): Promise<unknown>
  write(tasks: Record<string, DurableDeliveryTask>): Promise<void>
}

export interface DeliveryTaskMutationResult {
  accepted: boolean
  task: DurableDeliveryTask | null
  conflict?: 'active-run' | 'worker-owned' | 'task-missing' | 'task-terminal' | 'task-paused'
}

export interface DeliveryTaskStartRequest {
  uid: string
  runId: string
  workerId: string
  checkpoint: unknown
  configSnapshot?: unknown
}

export interface DeliveryTaskWorkerRequest {
  uid: string
  runId: string
  workerId: string
}

export interface DeliveryTaskCheckpointRequest extends DeliveryTaskWorkerRequest {
  checkpoint: unknown
  phase?: DeliveryTaskActivePhase
}

export interface DeliveryTaskTerminateRequest {
  uid: string
  runId: string
  workerId?: string
  reason: DeliveryTaskTerminalReason
  message?: string
}

const activeStatuses = new Set<DeliveryTaskStatus>(['running', 'waiting-for-page'])
/** 暂停和运行中一样必须保住检查点，因此凡是「不能当成已结束」的判断都要把它算进来。 */
const resumableStatuses = new Set<DeliveryTaskStatus>(['running', 'waiting-for-page', 'paused'])
const terminalStatuses = new Set<DeliveryTaskStatus>(['completed', 'failed', 'stopped'])
const activePhases = new Set<DeliveryTaskActivePhase>(['acquiring', 'processing', 'waiting'])
const terminalReasons = new Set<DeliveryTaskTerminalReason>([
  'manual-stop',
  'daily-limit',
  'terminal-error',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function assertIdentifier(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new Error(`${label}无效`)
  }
}

function assertTimestamp(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error('投递任务时间无效')
}

function assertPayloadSize(value: unknown, label: string, maxCharacters = 500_000) {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error(`${label}无法序列化`)
  }
  if (serialized.length > maxCharacters) throw new Error(`${label}过大`)
}

function assertCheckpoint(value: unknown, uid: string, runId: string) {
  if (
    !isRecord(value) ||
    value.accountUid !== uid ||
    value.id !== runId ||
    !Array.isArray(value.steps) ||
    value.steps.length === 0
  ) {
    throw new Error('投递任务检查点无效')
  }
  assertPayloadSize(value, '投递任务检查点')
}

function cloneTask(task: DurableDeliveryTask): DurableDeliveryTask {
  return structuredClone(task)
}

function hasValidStoredTaskShape(value: Record<string, unknown>) {
  const accountUid = typeof value.accountUid === 'string' ? value.accountUid : ''
  const runId = typeof value.runId === 'string' ? value.runId : ''
  let checkpointValid = false
  try {
    assertCheckpoint(value.checkpoint, accountUid, runId)
    checkpointValid = true
  } catch {
    checkpointValid = false
  }
  return (
    accountUid.length > 0 &&
    accountUid.length <= 128 &&
    runId.length > 0 &&
    runId.length <= 128 &&
    checkpointValid &&
    typeof value.status === 'string' &&
    (resumableStatuses.has(value.status as DeliveryTaskStatus) ||
      terminalStatuses.has(value.status as DeliveryTaskStatus)) &&
    typeof value.startedAt === 'number' &&
    Number.isFinite(value.startedAt) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt) &&
    typeof value.revision === 'number' &&
    Number.isInteger(value.revision) &&
    value.revision > 0
  )
}

function isDurableDeliveryTask(value: unknown): value is DurableDeliveryTask {
  if (!isRecord(value)) return false
  if (!hasValidStoredTaskShape(value)) return false
  const status = value.status as DeliveryTaskStatus
  return (
    value.schemaVersion === DELIVERY_TASK_SCHEMA_VERSION &&
    (!activeStatuses.has(status) ||
      (typeof value.phase === 'string' && activePhases.has(value.phase as DeliveryTaskActivePhase)))
  )
}

function migrateLegacyDeliveryTask(
  value: unknown,
  uid: string,
  now: number,
): DurableDeliveryTask | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !hasValidStoredTaskShape(value)) {
    return null
  }
  if (value.accountUid !== uid) return null
  const status = value.status as DeliveryTaskStatus
  const active = activeStatuses.has(status)
  return {
    schemaVersion: DELIVERY_TASK_SCHEMA_VERSION,
    accountUid: uid,
    runId: String(value.runId),
    status: active ? 'waiting-for-page' : status,
    ...(active ? { phase: 'waiting' as const } : {}),
    ...(typeof value.terminalReason === 'string'
      ? { terminalReason: value.terminalReason as DeliveryTaskTerminalReason }
      : {}),
    ...(typeof value.terminalMessage === 'string'
      ? { terminalMessage: value.terminalMessage }
      : {}),
    checkpoint: structuredClone(value.checkpoint),
    ...(isRecord(value.configSnapshot)
      ? { configSnapshot: structuredClone(value.configSnapshot) }
      : {}),
    startedAt: Number(value.startedAt),
    updatedAt: now,
    ...(typeof value.lastWorkerAt === 'number' && Number.isFinite(value.lastWorkerAt)
      ? { lastWorkerAt: value.lastWorkerAt }
      : {}),
    migratedFromSchemaVersion: 1,
    revision: Number(value.revision) + 1,
  }
}

function normalizeStoredTasks(value: unknown, now: number) {
  if (!isRecord(value)) {
    return { migrated: false, tasks: {} as Record<string, DurableDeliveryTask> }
  }
  const tasks: Record<string, DurableDeliveryTask> = {}
  let migrated = false
  for (const [uid, task] of Object.entries(value)) {
    if (isDurableDeliveryTask(task) && task.accountUid === uid) {
      tasks[uid] = cloneTask(task)
      continue
    }
    const legacy = migrateLegacyDeliveryTask(task, uid, now)
    if (legacy != null) {
      tasks[uid] = legacy
      migrated = true
    }
  }
  return { migrated, tasks }
}

function effectiveTask(task: DurableDeliveryTask, now: number): DurableDeliveryTask {
  // 暂停中的任务同样依赖配置快照才能继续，快照失效就必须直接判失败，
  // 否则用户会点到一个永远继续不了的「继续」。
  if (
    resumableStatuses.has(task.status) &&
    parseDeliveryConfigSnapshot(task.configSnapshot) == null
  ) {
    const {
      workerId: _workerId,
      leaseExpiresAt: _leaseExpiresAt,
      phase: _phase,
      ...terminalTask
    } = task
    return {
      ...terminalTask,
      status: 'failed',
      terminalReason: 'terminal-error',
      terminalMessage: '运行配置快照已失效，请重新开始投递',
      updatedAt: now,
      revision: task.revision + 1,
    }
  }
  if (task.status === 'running' && (task.leaseExpiresAt == null || task.leaseExpiresAt <= now)) {
    const { workerId: _workerId, leaseExpiresAt: _leaseExpiresAt, ...waitingTask } = task
    return {
      ...waitingTask,
      status: 'waiting-for-page',
      phase: 'waiting',
      updatedAt: now,
      revision: task.revision + 1,
    }
  }
  return task
}

function ownsLiveWorker(task: DurableDeliveryTask, workerId: string, now: number) {
  return (
    task.status === 'running' &&
    task.workerId != null &&
    task.workerId !== workerId &&
    task.leaseExpiresAt != null &&
    task.leaseExpiresAt > now
  )
}

function terminalStatus(reason: DeliveryTaskTerminalReason): DeliveryTaskTerminalStatus {
  if (reason === 'manual-stop') return 'stopped'
  if (reason === 'daily-limit') return 'completed'
  return 'failed'
}

export class DeliveryTaskCoordinator {
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly taskStorage: DeliveryTaskCoordinatorStorage) {}

  private mutate<T>(
    operation: (
      tasks: Record<string, DurableDeliveryTask>,
    ) => Promise<{ changed: boolean; result: T }> | { changed: boolean; result: T },
  ): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void
    let rejectResult!: (reason?: unknown) => void
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const queued = this.mutationQueue.then(async () => {
      try {
        const normalized = normalizeStoredTasks(await this.taskStorage.read(), Date.now())
        const tasks = normalized.tasks
        const outcome = await operation(tasks)
        if (normalized.migrated || outcome.changed) await this.taskStorage.write(tasks)
        resolveResult(outcome.result)
      } catch (error) {
        rejectResult(error)
      }
    })
    this.mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async read(uid: string, now = Date.now()): Promise<DurableDeliveryTask | null> {
    assertIdentifier(uid, '账号 uid')
    assertTimestamp(now)
    return this.mutate<DurableDeliveryTask | null>((tasks) => {
      const stored = tasks[uid]
      if (!stored) return { changed: false, result: null }
      const current = effectiveTask(stored, now)
      const changed = current !== stored
      if (changed) tasks[uid] = current
      return { changed, result: cloneTask(current) }
    })
  }

  async isActive(uid: string, now = Date.now()) {
    const task = await this.read(uid, now)
    return task != null && activeStatuses.has(task.status)
  }

  async isAnyActive(now = Date.now()) {
    assertTimestamp(now)
    return this.mutate<boolean>((tasks) => {
      let changed = false
      let active = false
      for (const [uid, stored] of Object.entries(tasks)) {
        const current = effectiveTask(stored, now)
        if (current !== stored) {
          tasks[uid] = current
          changed = true
        }
        if (activeStatuses.has(current.status)) active = true
      }
      return { changed, result: active }
    })
  }

  async start(
    request: DeliveryTaskStartRequest,
    now = Date.now(),
  ): Promise<DeliveryTaskMutationResult> {
    assertIdentifier(request.uid, '账号 uid')
    assertIdentifier(request.runId, '投递运行 ID')
    assertIdentifier(request.workerId, '投递执行端 ID')
    assertCheckpoint(request.checkpoint, request.uid, request.runId)
    if (request.configSnapshot !== undefined) {
      if (parseDeliveryConfigSnapshot(request.configSnapshot) == null) {
        throw new Error('投递配置快照无效')
      }
      assertPayloadSize(request.configSnapshot, '投递配置快照')
    } else {
      throw new Error('投递配置快照无效')
    }
    assertTimestamp(now)
    return this.mutate<DeliveryTaskMutationResult>((tasks) => {
      const stored = tasks[request.uid]
      const current = stored ? effectiveTask(stored, now) : null
      // 暂停中的任务不阻挡另开一轮：界面在暂停态只给「继续」和「结束」，
      // 真的走到这里说明用户明确要开新的一轮，覆盖旧检查点是预期结果。
      if (current && activeStatuses.has(current.status) && current.runId !== request.runId) {
        if (current !== stored) tasks[request.uid] = current
        return {
          changed: current !== stored,
          result: {
            accepted: false,
            task: cloneTask(current),
            conflict: 'active-run' as const,
          },
        }
      }

      const startedAt = current?.runId === request.runId ? current.startedAt : now
      const next: DurableDeliveryTask = {
        schemaVersion: DELIVERY_TASK_SCHEMA_VERSION,
        accountUid: request.uid,
        runId: request.runId,
        status: 'running',
        phase: 'acquiring',
        checkpoint: structuredClone(request.checkpoint),
        ...(request.configSnapshot === undefined
          ? {}
          : { configSnapshot: structuredClone(request.configSnapshot) }),
        workerId: request.workerId,
        leaseExpiresAt: now + DELIVERY_WORKER_LEASE_MS,
        startedAt,
        updatedAt: now,
        lastWorkerAt: now,
        revision: current?.runId === request.runId ? current.revision + 1 : 1,
      }
      tasks[request.uid] = next
      return {
        changed: true,
        result: { accepted: true, task: cloneTask(next) },
      }
    })
  }

  async claim(
    request: DeliveryTaskWorkerRequest,
    now = Date.now(),
  ): Promise<DeliveryTaskMutationResult> {
    assertIdentifier(request.uid, '账号 uid')
    assertIdentifier(request.runId, '投递运行 ID')
    assertIdentifier(request.workerId, '投递执行端 ID')
    assertTimestamp(now)
    return this.mutate<DeliveryTaskMutationResult>((tasks) => {
      const stored = tasks[request.uid]
      if (!stored || stored.runId !== request.runId) {
        return {
          changed: false,
          result: {
            accepted: false,
            task: stored ? cloneTask(stored) : null,
            conflict: 'task-missing',
          },
        }
      }
      const current = effectiveTask(stored, now)
      if (terminalStatuses.has(current.status)) {
        if (current !== stored) tasks[request.uid] = current
        return {
          changed: current !== stored,
          result: {
            accepted: false,
            task: cloneTask(current),
            conflict: 'task-terminal' as const,
          },
        }
      }
      // claim 是执行端续约用的，运行循环收尾时还会调用它。若允许它接管暂停中的任务，
      // 暂停会被自己这一轮的收尾动作立刻取消。恢复暂停必须走 resume()。
      if (current.status === 'paused') {
        return {
          changed: current !== stored,
          result: {
            accepted: false,
            task: cloneTask(current),
            conflict: 'task-paused' as const,
          },
        }
      }
      if (ownsLiveWorker(current, request.workerId, now)) {
        return {
          changed: current !== stored,
          result: {
            accepted: false,
            task: cloneTask(current),
            conflict: 'worker-owned' as const,
          },
        }
      }
      const next: DurableDeliveryTask = {
        ...current,
        status: 'running',
        phase: current.phase === 'waiting' ? 'acquiring' : (current.phase ?? 'acquiring'),
        terminalReason: undefined,
        terminalMessage: undefined,
        workerId: request.workerId,
        leaseExpiresAt: now + DELIVERY_WORKER_LEASE_MS,
        lastWorkerAt: now,
        updatedAt: now,
        revision: current.revision + 1,
      }
      tasks[request.uid] = next
      return { changed: true, result: { accepted: true, task: cloneTask(next) } }
    })
  }

  /**
   * 从暂停恢复：只接受暂停中的任务，重新取回租约。
   *
   * 与 claim 分开是必要的——claim 会被运行循环用于续约，如果它也能接管暂停任务，
   * 用户点暂停后这一轮的收尾续约就会立刻把暂停取消掉。
   */
  async resume(request: DeliveryTaskWorkerRequest, now = Date.now()) {
    assertIdentifier(request.uid, '账号 uid')
    assertIdentifier(request.runId, '投递运行 ID')
    assertIdentifier(request.workerId, '投递执行端 ID')
    assertTimestamp(now)
    return this.mutate<DeliveryTaskMutationResult>((tasks) => {
      const stored = tasks[request.uid]
      if (!stored || stored.runId !== request.runId) {
        return {
          changed: false,
          result: {
            accepted: false,
            task: stored ? cloneTask(stored) : null,
            conflict: 'task-missing' as const,
          },
        }
      }
      const current = effectiveTask(stored, now)
      if (current.status !== 'paused') {
        if (current !== stored) tasks[request.uid] = current
        return {
          changed: current !== stored,
          result: {
            accepted: false,
            task: cloneTask(current),
            conflict: terminalStatuses.has(current.status)
              ? ('task-terminal' as const)
              : ('worker-owned' as const),
          },
        }
      }
      const next: DurableDeliveryTask = {
        ...current,
        status: 'running',
        phase: 'acquiring',
        terminalReason: undefined,
        terminalMessage: undefined,
        workerId: request.workerId,
        leaseExpiresAt: now + DELIVERY_WORKER_LEASE_MS,
        lastWorkerAt: now,
        updatedAt: now,
        revision: current.revision + 1,
      }
      tasks[request.uid] = next
      return { changed: true, result: { accepted: true, task: cloneTask(next) } }
    })
  }

  /**
   * 暂停当前运行：保留检查点与配置快照，释放执行端租约。
   *
   * 之所以要落到持久任务而不是只在页面内置一个标志位，是因为暂停必须扛得住刷新——
   * 页面内的标志位刷新即失，用户会看到任务凭空回到未开始。释放租约是为了不让暂停期间
   * 的过期租约把状态判成 waiting-for-page 后被自动恢复接管。
   */
  async pause(request: DeliveryTaskWorkerRequest, now = Date.now()) {
    assertIdentifier(request.uid, '账号 uid')
    assertIdentifier(request.runId, '投递运行 ID')
    assertIdentifier(request.workerId, '投递执行端 ID')
    assertTimestamp(now)
    return this.mutate<DeliveryTaskMutationResult>((tasks) => {
      const stored = tasks[request.uid]
      if (!stored || stored.runId !== request.runId) {
        return {
          changed: false,
          result: {
            accepted: false,
            task: stored ? cloneTask(stored) : null,
            conflict: 'task-missing' as const,
          },
        }
      }
      const current = effectiveTask(stored, now)
      if (terminalStatuses.has(current.status)) {
        if (current !== stored) tasks[request.uid] = current
        return {
          changed: current !== stored,
          result: {
            accepted: false,
            task: cloneTask(current),
            conflict: 'task-terminal' as const,
          },
        }
      }
      if (current.status === 'paused') {
        if (current !== stored) tasks[request.uid] = current
        return { changed: current !== stored, result: { accepted: true, task: cloneTask(current) } }
      }
      const { phase: _phase, workerId: _workerId, leaseExpiresAt: _lease, ...rest } = current
      const next: DurableDeliveryTask = {
        ...rest,
        status: 'paused',
        lastWorkerAt: now,
        updatedAt: now,
        revision: current.revision + 1,
      }
      tasks[request.uid] = next
      return { changed: true, result: { accepted: true, task: cloneTask(next) } }
    })
  }

  async checkpoint(
    request: DeliveryTaskCheckpointRequest,
    now = Date.now(),
  ): Promise<DeliveryTaskMutationResult> {
    assertCheckpoint(request.checkpoint, request.uid, request.runId)
    return this.mutateWorkerTask(request, now, (task) => {
      const { migratedFromSchemaVersion: _migratedFromSchemaVersion, ...current } = task
      return {
        ...current,
        status: 'running',
        phase: request.phase ?? task.phase ?? 'processing',
        checkpoint: structuredClone(request.checkpoint),
        workerId: request.workerId,
        leaseExpiresAt: now + DELIVERY_WORKER_LEASE_MS,
        lastWorkerAt: now,
        updatedAt: now,
        revision: task.revision + 1,
      }
    })
  }

  async release(
    request: DeliveryTaskWorkerRequest,
    now = Date.now(),
  ): Promise<DeliveryTaskMutationResult> {
    return this.mutateWorkerTask(request, now, (task) => {
      const { workerId: _workerId, leaseExpiresAt: _leaseExpiresAt, ...waitingTask } = task
      return {
        ...waitingTask,
        status: 'waiting-for-page',
        phase: 'waiting',
        updatedAt: now,
        revision: task.revision + 1,
      }
    })
  }

  async releaseByWorkerPrefix(workerIdPrefix: string, now = Date.now()): Promise<number> {
    assertIdentifier(workerIdPrefix, '投递执行端前缀')
    assertTimestamp(now)
    return this.mutate<number>((tasks) => {
      let changed = false
      let released = 0
      for (const [uid, stored] of Object.entries(tasks)) {
        const current = effectiveTask(stored, now)
        if (current !== stored) {
          tasks[uid] = current
          changed = true
        }
        if (
          current.status !== 'running' ||
          current.workerId == null ||
          !current.workerId.startsWith(workerIdPrefix)
        ) {
          continue
        }
        const { workerId: _workerId, leaseExpiresAt: _leaseExpiresAt, ...waitingTask } = current
        tasks[uid] = {
          ...waitingTask,
          status: 'waiting-for-page',
          phase: 'waiting',
          updatedAt: now,
          revision: current.revision + 1,
        }
        changed = true
        released += 1
      }
      return { changed, result: released }
    })
  }

  async terminate(
    request: DeliveryTaskTerminateRequest,
    now = Date.now(),
  ): Promise<DeliveryTaskMutationResult> {
    assertIdentifier(request.uid, '账号 uid')
    assertIdentifier(request.runId, '投递运行 ID')
    if (request.workerId != null) assertIdentifier(request.workerId, '投递执行端 ID')
    if (!terminalReasons.has(request.reason)) throw new Error('投递任务终止原因无效')
    if (request.reason !== 'manual-stop' && request.workerId == null) {
      throw new Error('投递执行端 ID 无效')
    }
    assertTimestamp(now)
    return this.mutate<DeliveryTaskMutationResult>((tasks) => {
      const stored = tasks[request.uid]
      if (!stored || stored.runId !== request.runId) {
        return {
          changed: false,
          result: {
            accepted: false,
            task: stored ? cloneTask(stored) : null,
            conflict: 'task-missing',
          },
        }
      }
      const current = effectiveTask(stored, now)
      if (terminalStatuses.has(current.status)) {
        return {
          changed: current !== stored,
          result: { accepted: true, task: cloneTask(current) },
        }
      }
      if (
        request.reason !== 'manual-stop' &&
        request.workerId != null &&
        ownsLiveWorker(current, request.workerId, now)
      ) {
        return {
          changed: current !== stored,
          result: {
            accepted: false,
            task: cloneTask(current),
            conflict: 'worker-owned' as const,
          },
        }
      }
      const {
        workerId: _workerId,
        leaseExpiresAt: _leaseExpiresAt,
        phase: _phase,
        ...terminalTask
      } = current
      const next: DurableDeliveryTask = {
        ...terminalTask,
        status: terminalStatus(request.reason),
        terminalReason: request.reason,
        ...(request.message?.trim()
          ? { terminalMessage: request.message.trim().slice(0, 512) }
          : { terminalMessage: undefined }),
        updatedAt: now,
        revision: current.revision + 1,
      }
      tasks[request.uid] = next
      return { changed: true, result: { accepted: true, task: cloneTask(next) } }
    })
  }

  private async mutateWorkerTask(
    request: DeliveryTaskWorkerRequest,
    now: number,
    update: (task: DurableDeliveryTask) => DurableDeliveryTask,
  ): Promise<DeliveryTaskMutationResult> {
    assertIdentifier(request.uid, '账号 uid')
    assertIdentifier(request.runId, '投递运行 ID')
    assertIdentifier(request.workerId, '投递执行端 ID')
    assertTimestamp(now)
    return this.mutate<DeliveryTaskMutationResult>((tasks) => {
      const stored = tasks[request.uid]
      if (!stored || stored.runId !== request.runId) {
        return {
          changed: false,
          result: {
            accepted: false,
            task: stored ? cloneTask(stored) : null,
            conflict: 'task-missing',
          },
        }
      }
      const current = effectiveTask(stored, now)
      if (terminalStatuses.has(current.status)) {
        return {
          changed: current !== stored,
          result: {
            accepted: false,
            task: cloneTask(current),
            conflict: 'task-terminal' as const,
          },
        }
      }
      // 暂停后执行端仍在收尾，它的 checkpoint 会把状态写回 running，等于把任务自动恢复。
      // 暂停中的任务没有活跃执行端，只能由 claim（用户点「继续」）重新接管。
      if (current.status === 'paused') {
        return {
          changed: current !== stored,
          result: {
            accepted: false,
            task: cloneTask(current),
            conflict: 'task-paused' as const,
          },
        }
      }
      if (ownsLiveWorker(current, request.workerId, now)) {
        return {
          changed: current !== stored,
          result: {
            accepted: false,
            task: cloneTask(current),
            conflict: 'worker-owned' as const,
          },
        }
      }
      const next = update(current)
      tasks[request.uid] = next
      return { changed: true, result: { accepted: true, task: cloneTask(next) } }
    })
  }
}
