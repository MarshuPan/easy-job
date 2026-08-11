import { describe, expect, it } from 'vitest'

import { buildDeliveryConfigSnapshot } from '@/delivery/configSnapshot'
import { defaultFormData } from '@/stores/conf/info'

import {
  DELIVERY_WORKER_LEASE_MS,
  DeliveryTaskCoordinator,
  type DeliveryTaskCoordinatorStorage,
  type DurableDeliveryTask,
} from './deliveryTaskCoordinator'

function memoryStorage(initial: Record<string, DurableDeliveryTask> = {}) {
  let value: unknown = structuredClone(initial)
  return {
    adapter: {
      async read() {
        return structuredClone(value)
      },
      async write(tasks) {
        value = structuredClone(tasks)
      },
    } satisfies DeliveryTaskCoordinatorStorage,
    read: () => structuredClone(value) as Record<string, DurableDeliveryTask>,
  }
}

function startRequest(runId = 'run-a', workerId = 'worker-a') {
  return {
    uid: 'account-a',
    runId,
    workerId,
    checkpoint: {
      accountUid: 'account-a',
      id: runId,
      currentIndex: 0,
      steps: [{ source: 'group' }],
    },
    configSnapshot: buildDeliveryConfigSnapshot(defaultFormData, 1),
  }
}

function checkpoint(runId: string, value: Record<string, unknown>) {
  return {
    accountUid: 'account-a',
    id: runId,
    steps: [{ source: 'group' }],
    ...value,
  }
}

describe('DeliveryTaskCoordinator', () => {
  it('persists a running task and restores it after the coordinator restarts', async () => {
    const storage = memoryStorage()
    const first = new DeliveryTaskCoordinator(storage.adapter)
    const started = await first.start(startRequest(), 1_000)
    expect(started.accepted).toBe(true)

    const restarted = new DeliveryTaskCoordinator(storage.adapter)
    const restored = await restarted.read('account-a', 2_000)
    expect(restored).toMatchObject({
      runId: 'run-a',
      status: 'running',
      checkpoint: { currentIndex: 0 },
      configSnapshot: { schemaVersion: 1, configRevision: 1 },
    })
  })

  it('migrates a legacy active task into a v2 waiting run without restoring its worker lease', async () => {
    const legacyTask = {
      schemaVersion: 1,
      accountUid: 'account-a',
      runId: 'legacy-run',
      status: 'running',
      checkpoint: {
        accountUid: 'account-a',
        id: 'legacy-run',
        currentIndex: 0,
        steps: [{ source: 'search' }],
      },
      configSnapshot: buildDeliveryConfigSnapshot(defaultFormData, 1),
      workerId: 'legacy-worker',
      leaseExpiresAt: Date.now() + 60_000,
      startedAt: 1_000,
      updatedAt: 2_000,
      revision: 3,
    } as unknown as DurableDeliveryTask
    const storage = memoryStorage({ 'account-a': legacyTask })
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)

    const migrated = await coordinator.read('account-a', 3_000)

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      runId: 'legacy-run',
      status: 'waiting-for-page',
      phase: 'waiting',
      migratedFromSchemaVersion: 1,
      revision: 4,
    })
    expect(migrated).not.toHaveProperty('workerId')
    expect(migrated).not.toHaveProperty('leaseExpiresAt')
    expect(storage.read()['account-a']).toMatchObject({
      schemaVersion: 2,
      status: 'waiting-for-page',
      phase: 'waiting',
    })
  })

  it('clears the legacy migration marker after the new worker writes a checkpoint', async () => {
    const legacyTask = {
      schemaVersion: 1,
      accountUid: 'account-a',
      runId: 'legacy-run',
      status: 'waiting-for-page',
      checkpoint: {
        accountUid: 'account-a',
        id: 'legacy-run',
        currentIndex: 0,
        steps: [{ source: 'group' }],
      },
      configSnapshot: buildDeliveryConfigSnapshot(defaultFormData, 1),
      startedAt: 1_000,
      updatedAt: 2_000,
      revision: 1,
    } as unknown as DurableDeliveryTask
    const storage = memoryStorage({ 'account-a': legacyTask })
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)

    await coordinator.read('account-a', 3_000)
    await coordinator.claim(
      { uid: 'account-a', runId: 'legacy-run', workerId: 'worker-new' },
      3_100,
    )
    const checkpointed = await coordinator.checkpoint(
      {
        uid: 'account-a',
        runId: 'legacy-run',
        workerId: 'worker-new',
        checkpoint: checkpoint('legacy-run', { currentIndex: 1 }),
        phase: 'processing',
      },
      3_200,
    )

    expect(checkpointed.task).toMatchObject({
      phase: 'processing',
      checkpoint: { currentIndex: 1 },
    })
    expect(checkpointed.task).not.toHaveProperty('migratedFromSchemaVersion')
  })

  it('keeps a task active while its page worker is temporarily disconnected', async () => {
    const storage = memoryStorage()
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)
    await coordinator.start(startRequest(), 1_000)

    const waiting = await coordinator.read('account-a', 1_000 + DELIVERY_WORKER_LEASE_MS)
    expect(waiting?.status).toBe('waiting-for-page')
    expect(await coordinator.isActive('account-a', 20_000)).toBe(true)

    const claimed = await coordinator.claim(
      { uid: 'account-a', runId: 'run-a', workerId: 'worker-b' },
      20_001,
    )
    expect(claimed).toMatchObject({
      accepted: true,
      task: { status: 'running', workerId: 'worker-b' },
    })
  })

  it('reports activity across accounts and ignores terminal tasks', async () => {
    const storage = memoryStorage()
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)
    await coordinator.start(startRequest('run-a', 'worker-a'), 1_000)

    expect(await coordinator.isAnyActive(2_000)).toBe(true)

    await coordinator.terminate(
      {
        uid: 'account-a',
        runId: 'run-a',
        workerId: 'worker-a',
        reason: 'manual-stop',
      },
      2_001,
    )
    expect(await coordinator.isAnyActive(2_002)).toBe(false)
  })

  it('fails an active task with an invalid snapshot before reporting global activity', async () => {
    const started = await new DeliveryTaskCoordinator(memoryStorage().adapter).start(
      startRequest(),
      1_000,
    )
    const invalid = {
      ...started.task!,
      configSnapshot: { schemaVersion: 1 },
    }
    const storage = memoryStorage({ 'account-a': invalid })
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)

    expect(await coordinator.isAnyActive(2_000)).toBe(false)
    expect(storage.read()['account-a']).toMatchObject({
      status: 'failed',
      terminalReason: 'terminal-error',
    })
  })

  it('allows the same tab identity to reclaim immediately after a refresh', async () => {
    const storage = memoryStorage()
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)
    await coordinator.start(startRequest(), 1_000)

    const claimed = await coordinator.claim(
      { uid: 'account-a', runId: 'run-a', workerId: 'worker-a' },
      2_000,
    )
    expect(claimed.accepted).toBe(true)
  })

  it('rejects a second live page worker but lets it claim after lease expiry', async () => {
    const storage = memoryStorage()
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)
    await coordinator.start(startRequest(), 1_000)

    const conflict = await coordinator.claim(
      { uid: 'account-a', runId: 'run-a', workerId: 'worker-b' },
      2_000,
    )
    expect(conflict).toMatchObject({ accepted: false, conflict: 'worker-owned' })

    const claimed = await coordinator.claim(
      { uid: 'account-a', runId: 'run-a', workerId: 'worker-b' },
      1_000 + DELIVERY_WORKER_LEASE_MS,
    )
    expect(claimed.accepted).toBe(true)
  })

  it('does not let a second start replace an active run', async () => {
    const storage = memoryStorage()
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)
    await coordinator.start(startRequest(), 1_000)

    const result = await coordinator.start(startRequest('run-b', 'worker-b'), 2_000)
    expect(result).toMatchObject({
      accepted: false,
      conflict: 'active-run',
      task: { runId: 'run-a' },
    })
  })

  it('rejects a mismatched or malformed checkpoint before it reaches storage', async () => {
    const storage = memoryStorage()
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)

    await expect(
      coordinator.start(
        {
          ...startRequest(),
          checkpoint: { accountUid: 'account-b', id: 'run-a', steps: [] },
        },
        1_000,
      ),
    ).rejects.toThrow('投递任务检查点无效')
    expect(storage.read()).toEqual({})
  })

  it('ignores a stored task whose durable checkpoint is malformed', async () => {
    const malformed = {
      schemaVersion: 1,
      accountUid: 'account-a',
      runId: 'run-a',
      status: 'waiting-for-page',
      checkpoint: { accountUid: 'account-a', id: 'run-a', steps: [] },
      startedAt: 1_000,
      updatedAt: 1_000,
      revision: 1,
    } as unknown as DurableDeliveryTask
    const storage = memoryStorage({ 'account-a': malformed })
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)

    expect(await coordinator.read('account-a', 2_000)).toBeNull()
  })

  it('fails an active stored task whose runtime configuration snapshot is incomplete', async () => {
    const started = await new DeliveryTaskCoordinator(memoryStorage().adapter).start(
      startRequest(),
      1_000,
    )
    const invalid = {
      ...started.task!,
      configSnapshot: { weights: { group: 50, search: 50 } },
    }
    const storage = memoryStorage({ 'account-a': invalid })
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)

    expect(await coordinator.read('account-a', 2_000)).toMatchObject({
      status: 'failed',
      terminalReason: 'terminal-error',
      terminalMessage: '运行配置快照已失效，请重新开始投递',
    })
    expect(await coordinator.isActive('account-a', 2_001)).toBe(false)
  })

  it('persists checkpoints and converts worker release into a non-terminal wait', async () => {
    const storage = memoryStorage()
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)
    await coordinator.start(startRequest(), 1_000)
    await coordinator.checkpoint(
      {
        uid: 'account-a',
        runId: 'run-a',
        workerId: 'worker-a',
        checkpoint: checkpoint('run-a', { currentIndex: 3 }),
        phase: 'processing',
      },
      2_000,
    )
    const released = await coordinator.release(
      { uid: 'account-a', runId: 'run-a', workerId: 'worker-a' },
      3_000,
    )

    expect(released).toMatchObject({
      accepted: true,
      task: {
        status: 'waiting-for-page',
        phase: 'waiting',
        checkpoint: { currentIndex: 3 },
      },
    })
    expect(storage.read()['account-a']).not.toHaveProperty('workerId')
  })

  it('releases a tab-owned task immediately when that browser tab closes', async () => {
    const storage = memoryStorage()
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)
    await coordinator.start(startRequest('run-a', 'boss-tab-17:session-a'), 1_000)

    const released = await coordinator.releaseByWorkerPrefix('boss-tab-17:', 2_000)

    expect(released).toBe(1)
    expect(await coordinator.read('account-a', 2_001)).toMatchObject({
      status: 'waiting-for-page',
      runId: 'run-a',
    })
    expect(storage.read()['account-a']).not.toHaveProperty('workerId')
  })

  it.each([
    ['manual-stop', 'stopped'],
    ['daily-limit', 'completed'],
    ['terminal-error', 'failed'],
  ] as const)('maps %s to the only supported terminal status %s', async (reason, status) => {
    const storage = memoryStorage()
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)
    await coordinator.start(startRequest(), 1_000)

    const result = await coordinator.terminate(
      {
        uid: 'account-a',
        runId: 'run-a',
        workerId: 'worker-a',
        reason,
        message: 'done',
      },
      2_000,
    )
    expect(result).toMatchObject({
      accepted: true,
      task: { status, terminalReason: reason, terminalMessage: 'done' },
    })
    expect(await coordinator.isActive('account-a', 3_000)).toBe(false)
  })

  it('serializes concurrent mutations without losing the latest checkpoint', async () => {
    const storage = memoryStorage()
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)
    await coordinator.start(startRequest(), 1_000)
    await Promise.all([
      coordinator.checkpoint(
        {
          uid: 'account-a',
          runId: 'run-a',
          workerId: 'worker-a',
          checkpoint: checkpoint('run-a', { sequence: 1 }),
        },
        2_000,
      ),
      coordinator.checkpoint(
        {
          uid: 'account-a',
          runId: 'run-a',
          workerId: 'worker-a',
          checkpoint: checkpoint('run-a', { sequence: 2 }),
        },
        3_000,
      ),
    ])

    expect((await coordinator.read('account-a', 3_001))?.checkpoint).toMatchObject({ sequence: 2 })
  })
})

describe('pausing a delivery run', () => {
  const worker = { uid: 'account-a', runId: 'run-a', workerId: 'worker-a' }

  async function pausedCoordinator() {
    const storage = memoryStorage()
    const coordinator = new DeliveryTaskCoordinator(storage.adapter)
    await coordinator.start(startRequest())
    const paused = await coordinator.pause(worker)
    return { coordinator, paused, storage }
  }

  it('keeps the checkpoint and config snapshot but hands back the worker lease', async () => {
    const { paused } = await pausedCoordinator()

    expect(paused.accepted).toBe(true)
    expect(paused.task).toMatchObject({ status: 'paused' })
    expect(paused.task?.checkpoint).toBeTruthy()
    expect(paused.task?.configSnapshot).toBeTruthy()
    expect(paused.task?.workerId).toBeUndefined()
    expect(paused.task?.leaseExpiresAt).toBeUndefined()
  })

  it('refuses worker writes so a winding-down run cannot cancel the pause', async () => {
    // 用户点暂停后，本轮循环还在收尾，它仍会 checkpoint、release、claim 续约。
    // 这些调用都会把状态写回 running / waiting-for-page，等于自动取消刚刚的暂停。
    const { coordinator } = await pausedCoordinator()

    const checkpointed = await coordinator.checkpoint({
      ...worker,
      checkpoint: checkpoint('run-a', { currentIndex: 3 }),
    })
    expect(checkpointed).toMatchObject({ accepted: false, conflict: 'task-paused' })

    const released = await coordinator.release(worker)
    expect(released).toMatchObject({ accepted: false, conflict: 'task-paused' })

    const claimed = await coordinator.claim(worker)
    expect(claimed).toMatchObject({ accepted: false, conflict: 'task-paused' })

    expect((await coordinator.read('account-a'))?.status).toBe('paused')
  })

  it('resumes only from paused, and takes a fresh lease when it does', async () => {
    const { coordinator } = await pausedCoordinator()

    const resumed = await coordinator.resume(worker)
    expect(resumed.accepted).toBe(true)
    expect(resumed.task).toMatchObject({ status: 'running', workerId: 'worker-a' })
    expect(resumed.task?.leaseExpiresAt).toBeGreaterThan(Date.now())
    // 继续必须接着原来的检查点，否则它只是重新开始。
    expect(resumed.task?.runId).toBe('run-a')
    expect(resumed.task?.checkpoint).toMatchObject({ id: 'run-a' })

    expect(await coordinator.resume(worker)).toMatchObject({ accepted: false })
  })

  it('still lets 结束 terminate a paused run', async () => {
    const { coordinator } = await pausedCoordinator()

    const terminated = await coordinator.terminate({
      uid: 'account-a',
      runId: 'run-a',
      reason: 'manual-stop',
    })
    expect(terminated).toMatchObject({
      accepted: true,
      task: { status: 'stopped', terminalReason: 'manual-stop' },
    })
  })

  it('keeps a paused task across a reload instead of discarding it as malformed', async () => {
    const { storage } = await pausedCoordinator()
    // 状态校验只认识 active 和 terminal 两类时，暂停的任务会在下次读取时被整条丢掉。
    const reopened = new DeliveryTaskCoordinator(memoryStorage(storage.read()).adapter)

    expect(await reopened.read('account-a')).toMatchObject({ status: 'paused' })
  })
})
