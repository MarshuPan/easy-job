import { beforeEach, describe, expect, it } from 'vitest'

import {
  advanceDeliveryTaskCycleProgress,
  clearDeliveryTask,
  createDeliveryTask,
  DELIVERY_TASK_HEARTBEAT_MAX_AGE_MS,
  findNextWarmupStepIndex,
  markWarmupStepAttempted,
  getFreshDeliveryTaskHeartbeat,
  hasReachedDeliveryTaskEmptyCycleLimit,
  type DeliveryTask,
  readDeliveryTask,
  restoreDeliveryTask,
  saveDeliveryTask,
  touchDeliveryTaskHeartbeat,
} from './deliveryTask'

const deliveryTaskKey = 'agent-delivery:combined-delivery-task'
const legacyDeliveryTaskKey = `${['boss', 'helper'].join('-')}:combined-delivery-task`

function task(id = 'task-1'): DeliveryTask {
  return {
    accountUid: 'account-a',
    id,
    startedAt: 1000,
    currentIndex: 0,
    steps: [
      {
        source: 'search',
        url: 'https://www.zhipin.com/web/geek/job?query=AI',
        status: 'running',
        pagesDone: 0,
      },
    ],
  }
}

describe('delivery task storage', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('stores delivery tasks under the Agent Delivery key', () => {
    saveDeliveryTask(task(), null)

    expect(window.sessionStorage.getItem(deliveryTaskKey)).not.toBeNull()
    expect(readDeliveryTask('account-a')?.checkpointAt).toEqual(expect.any(Number))
  })

  it('restores a validated background checkpoint into the page session', () => {
    const restored = restoreDeliveryTask(
      { ...task('background-task'), acquisitionCycle: 3 },
      'account-a',
    )

    expect(restored).toMatchObject({ id: 'background-task', acquisitionCycle: 3 })
    expect(readDeliveryTask('account-a')?.id).toBe('background-task')
  })

  it('rejects a background checkpoint owned by another account', () => {
    expect(restoreDeliveryTask(task('other-account-task'), 'account-b')).toBeNull()
    expect(window.sessionStorage.getItem(deliveryTaskKey)).toBeNull()
  })

  it('marks legacy active tasks as already warmed to avoid repeating startup acquisition', () => {
    window.sessionStorage.setItem(deliveryTaskKey, JSON.stringify(task()))

    expect(readDeliveryTask('account-a')?.poolWarmup).toEqual({
      completed: true,
      attemptedStepIndexes: [],
      lowWaterArmed: false,
    })
  })

  it('normalizes malformed warmup progress without crashing task recovery', () => {
    window.sessionStorage.setItem(
      deliveryTaskKey,
      JSON.stringify({
        ...task(),
        poolWarmup: {
          completed: false,
          attemptedStepIndexes: [0, 0, -1, 99, 'invalid'],
        },
      }),
    )

    expect(readDeliveryTask('account-a')?.poolWarmup).toEqual({
      completed: false,
      attemptedStepIndexes: [0],
      lowWaterArmed: true,
    })
  })

  it('does not select completed or exhausted steps for another warmup attempt', () => {
    const deliveryTask: DeliveryTask = {
      ...task(),
      currentIndex: 3,
      poolWarmup: {
        completed: false,
        attemptedStepIndexes: [3],
        lowWaterArmed: false,
      },
      steps: [
        {
          source: 'search',
          url: 'https://www.zhipin.com/web/geek/job?query=one',
          status: 'done',
          prefetchExhausted: true,
          pagesDone: 18,
        },
        {
          source: 'search',
          url: 'https://www.zhipin.com/web/geek/job?query=two',
          status: 'done',
          prefetchExhausted: true,
          pagesDone: 17,
        },
        {
          source: 'search',
          url: 'https://www.zhipin.com/web/geek/job?query=three',
          status: 'done',
          prefetchExhausted: true,
          pagesDone: 19,
        },
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 32,
        },
      ],
    }

    expect(findNextWarmupStepIndex(deliveryTask, ['group', 'search'])).toBe(-1)
  })

  it('warms the highest-priority underfilled source before the current source', () => {
    const deliveryTask: DeliveryTask = {
      ...task(),
      currentIndex: 0,
      poolWarmup: {
        completed: false,
        attemptedStepIndexes: [],
        lowWaterArmed: false,
      },
      steps: [
        {
          source: 'search',
          url: 'https://www.zhipin.com/web/geek/job?query=one',
          status: 'running',
          pagesDone: 0,
        },
        {
          source: 'search',
          url: 'https://www.zhipin.com/web/geek/job?query=two',
          status: 'pending',
          pagesDone: 0,
        },
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'pending',
          pagesDone: 0,
        },
      ],
    }

    expect(findNextWarmupStepIndex(deliveryTask, ['group', 'search'])).toBe(2)
  })

  it('rotates expectation warmup across acquisition cycles', () => {
    const deliveryTask: DeliveryTask = {
      ...task(),
      groupExpectationCursorId: '101',
      poolWarmup: { completed: false, attemptedStepIndexes: [], lowWaterArmed: false },
      steps: [
        {
          source: 'group',
          expectation: {
            id: '101',
            index: 0,
            positionName: '一',
            locationName: '',
            salaryDesc: '',
          },
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'pending',
          pagesDone: 0,
        },
        {
          source: 'group',
          expectation: {
            id: '202',
            index: 1,
            positionName: '二',
            locationName: '',
            salaryDesc: '',
          },
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'pending',
          pagesDone: 0,
        },
        {
          source: 'group',
          expectation: {
            id: '303',
            index: 2,
            positionName: '三',
            locationName: '',
            salaryDesc: '',
          },
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'pending',
          pagesDone: 0,
        },
      ],
    }

    expect(findNextWarmupStepIndex(deliveryTask, ['group'])).toBe(1)
    markWarmupStepAttempted(deliveryTask, 1)
    expect(findNextWarmupStepIndex(deliveryTask, ['group'])).toBe(2)
  })

  it('skips a temporarily deferred warmup source without exhausting it', () => {
    const deliveryTask: DeliveryTask = {
      ...task(),
      currentIndex: 0,
      poolWarmup: { completed: false, attemptedStepIndexes: [], lowWaterArmed: false },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'waiting',
          pagesDone: 0,
          prefetchExhausted: false,
          prefetchRetryAt: Date.now() + 60_000,
        },
        {
          source: 'search',
          url: 'https://www.zhipin.com/web/geek/job?query=AI',
          status: 'pending',
          pagesDone: 0,
        },
      ],
    }

    expect(findNextWarmupStepIndex(deliveryTask, ['group', 'search'])).toBe(1)
  })

  it('normalizes an active batch so a page remount can resume its remaining jobs', () => {
    window.sessionStorage.setItem(
      deliveryTaskKey,
      JSON.stringify({
        ...task(),
        activeBatch: {
          id: 'batch-1',
          startedAt: 2000,
          items: [
            { source: 'group', encryptJobId: 'job-1' },
            { source: 'group', encryptJobId: 'job-1' },
            { source: 'search', encryptJobId: 'job-1' },
            { source: 'invalid', encryptJobId: 'job-2' },
            { source: 'search', encryptJobId: 'job-3' },
          ],
        },
      }),
    )

    expect(readDeliveryTask('account-a')?.activeBatch).toEqual({
      id: 'batch-1',
      startedAt: 2000,
      items: [
        { source: 'group', encryptJobId: 'job-1' },
        { source: 'search', encryptJobId: 'job-3' },
      ],
    })
  })

  it('tracks cycle progress from processed jobs instead of successful deliveries', () => {
    const deliveryTask = {
      ...task(),
      cycleStartedSuccess: 4,
      cycleStartedTotal: 20,
      noProgressCycles: 2,
    }

    expect(
      advanceDeliveryTaskCycleProgress(deliveryTask, {
        success: 4,
        total: 35,
      }),
    ).toEqual({ madeProgress: true, noProgressCycles: 0 })
    expect(deliveryTask.cycleStartedTotal).toBe(35)

    expect(
      advanceDeliveryTaskCycleProgress(deliveryTask, {
        success: 4,
        total: 35,
      }),
    ).toEqual({ madeProgress: false, noProgressCycles: 1 })

    deliveryTask.noProgressCycles = 2
    expect(hasReachedDeliveryTaskEmptyCycleLimit(deliveryTask)).toBe(false)
    deliveryTask.noProgressCycles = 3
    expect(hasReachedDeliveryTaskEmptyCycleLimit(deliveryTask)).toBe(true)
  })

  it('migrates a legacy saved delivery task to the Agent Delivery key', () => {
    window.sessionStorage.setItem(legacyDeliveryTaskKey, JSON.stringify(task()))

    expect(readDeliveryTask('account-a')?.id).toBe('task-1')
    expect(window.sessionStorage.getItem(deliveryTaskKey)).not.toBeNull()
    expect(window.sessionStorage.getItem(legacyDeliveryTaskKey)).toBeNull()
  })

  it('discards a pre-account task instead of restoring it for an unknown owner', () => {
    const storedTask: Partial<ReturnType<typeof task>> = structuredClone(task())
    delete storedTask.accountUid
    window.sessionStorage.setItem(deliveryTaskKey, JSON.stringify(storedTask))

    expect(readDeliveryTask('account-a')).toBeNull()
    expect(window.sessionStorage.getItem(deliveryTaskKey)).toBeNull()
  })

  it('discards a task owned by another account', () => {
    window.sessionStorage.setItem(deliveryTaskKey, JSON.stringify(task()))

    expect(readDeliveryTask('account-b')).toBeNull()
    expect(window.sessionStorage.getItem(deliveryTaskKey)).toBeNull()
  })

  it.each([deliveryTaskKey, legacyDeliveryTaskKey])(
    'assigns an id while migrating a pre-id task from %s',
    (storageKey) => {
      const storedTask: Partial<ReturnType<typeof task>> = structuredClone(task())
      delete storedTask.id
      window.sessionStorage.setItem(storageKey, JSON.stringify(storedTask))

      const migrated = readDeliveryTask('account-a')

      expect(migrated?.id).toEqual(expect.any(String))
      expect(migrated?.id).not.toBe('')
      expect(JSON.parse(window.sessionStorage.getItem(deliveryTaskKey) ?? '{}').id).toBe(
        migrated?.id,
      )
      expect(window.sessionStorage.getItem(legacyDeliveryTaskKey)).toBeNull()
      expect(clearDeliveryTask(migrated?.id ?? '')).toBe(true)
    },
  )

  it('discards a structurally invalid task so a new task can be saved', () => {
    window.sessionStorage.setItem(
      deliveryTaskKey,
      JSON.stringify({ id: 'broken-task', currentIndex: 0, startedAt: 1000, steps: [] }),
    )

    expect(readDeliveryTask('account-a')).toBeNull()
    expect(window.sessionStorage.getItem(deliveryTaskKey)).toBeNull()
    expect(saveDeliveryTask(task('replacement-task'), null)).toBe(true)
    expect(readDeliveryTask('account-a')?.id).toBe('replacement-task')
  })

  it('falls back to a valid legacy task when the current task is invalid', () => {
    window.sessionStorage.setItem(
      deliveryTaskKey,
      JSON.stringify({ id: 'broken-task', currentIndex: 0, startedAt: 1000, steps: [] }),
    )
    window.sessionStorage.setItem(legacyDeliveryTaskKey, JSON.stringify(task('legacy-task')))

    expect(readDeliveryTask('account-a')?.id).toBe('legacy-task')
    expect(JSON.parse(window.sessionStorage.getItem(deliveryTaskKey) ?? '{}').id).toBe(
      'legacy-task',
    )
    expect(window.sessionStorage.getItem(legacyDeliveryTaskKey)).toBeNull()
  })

  it('clears both current and legacy delivery task keys', () => {
    window.sessionStorage.setItem(deliveryTaskKey, JSON.stringify(task()))
    window.sessionStorage.setItem(legacyDeliveryTaskKey, JSON.stringify(task()))

    clearDeliveryTask('task-1')

    expect(window.sessionStorage.getItem(deliveryTaskKey)).toBeNull()
    expect(window.sessionStorage.getItem(legacyDeliveryTaskKey)).toBeNull()
  })

  it('does not overwrite a different current task when the expected task id is stale', () => {
    saveDeliveryTask(task('task-2'), null)

    expect(saveDeliveryTask(task('task-1'), 'task-1')).toBe(false)
    expect(readDeliveryTask('account-a')?.id).toBe('task-2')
  })

  it('does not clear a different current task when the expected task id is stale', () => {
    saveDeliveryTask(task('task-2'), null)

    expect(clearDeliveryTask('task-1')).toBe(false)
    expect(readDeliveryTask('account-a')?.id).toBe('task-2')
  })

  it('records a fresh runtime heartbeat for the current delivery source', () => {
    const activeTask = task()
    saveDeliveryTask(activeTask, null)

    expect(touchDeliveryTaskHeartbeat(activeTask, 10_000)).toBe(true)
    expect(getFreshDeliveryTaskHeartbeat(activeTask, 'search', 12_000)).toEqual({
      at: 10_000,
      source: 'search',
      ageMs: 2_000,
    })
    expect(readDeliveryTask('account-a')?.runtimeHeartbeat).toEqual({
      at: 10_000,
      source: 'search',
    })
  })

  it('rejects expired or wrong-source runtime heartbeats', () => {
    const activeTask = task()
    activeTask.runtimeHeartbeat = { at: 10_000, source: 'search' }

    expect(getFreshDeliveryTaskHeartbeat(activeTask, 'group', 11_000)).toBeNull()
    expect(
      getFreshDeliveryTaskHeartbeat(
        activeTask,
        'search',
        10_000 + DELIVERY_TASK_HEARTBEAT_MAX_AGE_MS,
      ),
    ).toBeNull()
  })

  it('keeps recommendation and every configured expectation under the existing source class', () => {
    const created = createDeliveryTask({
      accountUid: 'account-a',
      currentSource: 'group',
      currentUrl: 'https://www.zhipin.com/web/geek/jobs',
      currentGroupExpectId: '202',
      searchUrl: 'https://www.zhipin.com/web/geek/job?query=AI',
      groupExpectations: [
        {
          id: 'recommend',
          index: -1,
          positionName: '推荐',
          locationName: '',
          salaryDesc: 'BOSS 推荐岗位',
        },
        {
          id: '101',
          index: 0,
          positionName: 'AI 产品经理',
          locationName: '上海',
          salaryDesc: '30-50K',
        },
        {
          id: '202',
          index: 1,
          positionName: '产品负责人',
          locationName: '杭州',
          salaryDesc: '40-60K',
        },
        {
          id: '303',
          index: 2,
          positionName: 'AI 商业化产品',
          locationName: '深圳',
          salaryDesc: '35-55K',
        },
        {
          id: '404',
          index: 3,
          positionName: '大模型产品经理',
          locationName: '北京',
          salaryDesc: '40-70K',
        },
      ],
      hasRemaining: () => true,
    })

    expect(created?.steps.map((step) => [step.source, step.expectation?.id])).toEqual([
      ['group', '202'],
      ['group', 'recommend'],
      ['group', '101'],
      ['group', '303'],
      ['group', '404'],
      ['search', undefined],
    ])
    expect(created?.poolWarmup).toEqual({
      completed: false,
      attemptedStepIndexes: [],
      lowWaterArmed: true,
    })
    expect(created).toMatchObject({
      acquisitionCycle: 1,
      cycleStartedSuccess: 0,
      noProgressCycles: 0,
    })
  })

  it('creates one aggregated-search step per configured direction', () => {
    const created = createDeliveryTask({
      accountUid: 'account-a',
      currentSource: 'search',
      currentUrl: 'https://www.zhipin.com/web/geek/job?query=Agent&city=101020100',
      searchUrls: [
        {
          direction: 'AI产品经理',
          url: 'https://www.zhipin.com/web/geek/job?query=AI%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&city=101020100',
        },
        {
          direction: 'Agent',
          url: 'https://www.zhipin.com/web/geek/job?query=Agent&city=101020100',
        },
      ],
      hasRemaining: (source) => source === 'search',
    })

    expect(created?.steps.map((step) => [step.source, step.searchDirection])).toEqual([
      ['search', 'Agent'],
      ['search', 'AI产品经理'],
    ])
    expect(created?.steps[0]?.poolSizeAtEntry).toBe(0)
  })

  it('selects at most three search directions for one task and exposes the next cursor', () => {
    const searchUrls = Array.from({ length: 8 }, (_, index) => ({
      direction: `方向 ${index + 1}`,
      url: `https://www.zhipin.com/web/geek/job?query=${index + 1}`,
    }))

    const first = createDeliveryTask({
      accountUid: 'account-a',
      currentSource: 'search',
      currentUrl: searchUrls[0].url,
      searchUrls,
      hasRemaining: (source) => source === 'search',
    })
    const second = createDeliveryTask({
      accountUid: 'account-a',
      currentSource: 'search',
      currentUrl: searchUrls[3].url,
      searchUrls,
      searchCursorKey: first?.searchRotation?.nextDirectionKey,
      hasRemaining: (source) => source === 'search',
    })

    expect(first?.steps.map((step) => step.searchDirection)).toEqual(['方向 1', '方向 2', '方向 3'])
    expect(second?.steps.map((step) => step.searchDirection)).toEqual([
      '方向 4',
      '方向 5',
      '方向 6',
    ])
    expect(second?.searchRotation?.nextDirectionKey).toBe('方向7')
  })

  it('wraps search rotation in order and supports fewer than three directions', () => {
    const searchUrls = Array.from({ length: 5 }, (_, index) => ({
      direction: `方向 ${index + 1}`,
      url: `https://www.zhipin.com/web/geek/job?query=${index + 1}`,
    }))
    const wrapped = createDeliveryTask({
      accountUid: 'account-a',
      currentSource: 'search',
      currentUrl: searchUrls[3].url,
      searchUrls,
      searchCursorKey: '方向4',
      hasRemaining: (source) => source === 'search',
    })
    const small = createDeliveryTask({
      accountUid: 'account-a',
      currentSource: 'search',
      currentUrl: searchUrls[0].url,
      searchUrls: searchUrls.slice(0, 2),
      hasRemaining: (source) => source === 'search',
    })

    expect(wrapped?.steps.map((step) => step.searchDirection)).toEqual([
      '方向 4',
      '方向 5',
      '方向 1',
    ])
    expect(wrapped?.searchRotation?.nextDirectionKey).toBe('方向2')
    expect(small?.steps.map((step) => step.searchDirection)).toEqual(['方向 1', '方向 2'])
    expect(small?.searchRotation?.nextDirectionKey).toBe('方向1')
  })

  it('keeps long-run search direction usage balanced', () => {
    const searchUrls = Array.from({ length: 8 }, (_, index) => ({
      direction: `方向 ${index + 1}`,
      url: `https://www.zhipin.com/web/geek/job?query=${index + 1}`,
    }))
    const counts = new Map(searchUrls.map((item) => [item.direction, 0]))
    let cursor = ''

    for (let batch = 0; batch < 100; batch += 1) {
      const created = createDeliveryTask({
        accountUid: 'account-a',
        currentSource: 'search',
        currentUrl: searchUrls[0].url,
        searchUrls,
        searchCursorKey: cursor,
        hasRemaining: (source) => source === 'search',
      })
      for (const step of created?.steps ?? []) {
        const direction = step.searchDirection ?? ''
        counts.set(direction, (counts.get(direction) ?? 0) + 1)
      }
      cursor = created?.searchRotation?.nextDirectionKey ?? ''
    }

    const usages = [...counts.values()]
    expect(Math.max(...usages) - Math.min(...usages)).toBeLessThanOrEqual(1)
  })

  it('binds a search heartbeat to the active direction', () => {
    const activeTask = task()
    activeTask.steps[0].searchDirection = 'Agent'
    saveDeliveryTask(activeTask, null)

    expect(touchDeliveryTaskHeartbeat(activeTask, 10_000)).toBe(true)
    expect(getFreshDeliveryTaskHeartbeat(activeTask, 'search', 11_000, undefined, 'Agent')).toEqual(
      {
        at: 10_000,
        source: 'search',
        searchDirection: 'Agent',
        ageMs: 1_000,
      },
    )
    expect(
      getFreshDeliveryTaskHeartbeat(activeTask, 'search', 11_000, undefined, 'AI产品经理'),
    ).toBeNull()
  })

  it('binds a heartbeat to the active expectation without changing the group source key', () => {
    const activeTask = task()
    activeTask.steps[0] = {
      source: 'group',
      url: 'https://www.zhipin.com/web/geek/jobs',
      expectation: {
        id: '101',
        index: 0,
        positionName: 'AI 产品经理',
        locationName: '上海',
        salaryDesc: '30-50K',
      },
      status: 'running',
      pagesDone: 0,
    }
    saveDeliveryTask(activeTask, null)

    expect(touchDeliveryTaskHeartbeat(activeTask, 10_000)).toBe(true)
    expect(getFreshDeliveryTaskHeartbeat(activeTask, 'group', 11_000, '101')).toMatchObject({
      source: 'group',
      expectId: '101',
    })
    expect(getFreshDeliveryTaskHeartbeat(activeTask, 'group', 11_000, '202')).toBeNull()
  })
})
