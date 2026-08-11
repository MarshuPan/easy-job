import { describe, expect, it } from 'vitest'

import {
  findNextTaskStepIndexBySource,
  getDeliverableJobs,
  getDeliveryJobKey,
  hasPrefetchableStep,
  isSameNavigationLocation,
  isSameTaskStep,
  summarizePools,
} from './deliveryEngine'

function job(encryptJobId: string, status: string) {
  return { encryptJobId, status: { status, msg: '' } } as any
}

function step(overrides: Record<string, unknown> = {}) {
  return {
    source: 'group',
    url: 'https://www.zhipin.com/web/geek/jobs',
    status: 'pending',
    pagesDone: 0,
    ...overrides,
  } as any
}

function task(steps: unknown[]) {
  return { steps, currentIndex: 0 } as any
}

describe('getDeliverableJobs', () => {
  it('keeps only jobs that have not reached a terminal state', () => {
    const jobs = [
      job('pending', 'pending'),
      job('wait', 'wait'),
      job('running', 'running'),
      job('success', 'success'),
      job('warn', 'warn'),
      job('error', 'error'),
    ]
    expect(getDeliverableJobs(jobs).map((item) => item.encryptJobId)).toEqual([
      'pending',
      'wait',
      'running',
    ])
  })

  it('drops filtered jobs so the FIFO batch cannot pick the same ones forever', () => {
    // 被判掉的岗位如果还算待处理，FIFO 每一轮都会重新捞出同一批：它们一进筛选就被判掉、
    // 不走投递节奏，于是每秒十几个地空转，统计里的「处理」一路虚涨。
    expect(getDeliverableJobs([job('filtered', 'filtered')])).toEqual([])
  })

  it('treats an unrecognised status as not deliverable', () => {
    // 用允许清单而不是 default:true —— 将来新增状态时不会又一次默默变回「待处理」。
    expect(getDeliverableJobs([job('future', 'something-new')])).toEqual([])
  })
})

describe('isSameNavigationLocation', () => {
  it('compares path, query and hash but ignores the origin', () => {
    expect(
      isSameNavigationLocation('https://www.zhipin.com/web/geek/jobs?a=1', '/web/geek/jobs?a=1'),
    ).toBe(true)
    expect(isSameNavigationLocation('/web/geek/jobs?a=1', '/web/geek/jobs?a=2')).toBe(false)
    expect(isSameNavigationLocation('/web/geek/jobs', '/web/geek/job')).toBe(false)
  })

  it('falls back to string equality for unparsable input', () => {
    expect(isSameNavigationLocation('::::', '::::')).toBe(true)
  })
})

describe('findNextTaskStepIndexBySource', () => {
  it('finds the next runnable step of the same source', () => {
    const value = task([
      step({ source: 'group', status: 'done' }),
      step({ source: 'search', status: 'pending' }),
      step({ source: 'group', status: 'pending' }),
    ])
    expect(findNextTaskStepIndexBySource(value, 'group')).toBe(2)
  })

  it('reports -1 when every step of that source is finished', () => {
    const value = task([
      step({ source: 'group', status: 'done' }),
      step({ source: 'group', status: 'done' }),
    ])
    expect(findNextTaskStepIndexBySource(value, 'group')).toBe(-1)
  })
})

describe('hasPrefetchableStep', () => {
  it('ignores steps already marked as exhausted', () => {
    expect(
      hasPrefetchableStep(task([step({ source: 'group', prefetchExhausted: true })]), 'group'),
    ).toBe(false)
    expect(hasPrefetchableStep(task([step({ source: 'group' })]), 'group')).toBe(true)
  })
})

describe('isSameTaskStep', () => {
  it('treats steps as identical only when source, expectation and direction all match', () => {
    const base = step({ source: 'group', expectation: { id: '101' } })
    expect(isSameTaskStep(base, step({ source: 'group', expectation: { id: '101' } }))).toBe(true)
    expect(isSameTaskStep(base, step({ source: 'group', expectation: { id: '202' } }))).toBe(false)
    expect(isSameTaskStep(base, step({ source: 'search' }))).toBe(false)
  })
})

describe('summarizePools', () => {
  it('reports per-source counts for diagnostics', () => {
    expect(
      summarizePools({ group: [job('a', 'wait')], search: [job('b', 'wait'), job('c', 'wait')] }),
    ).toMatchObject({ group: 1, search: 2 })
  })
})

describe('getDeliveryJobKey', () => {
  it('prefers the encrypted job id and degrades through the remaining identifiers', () => {
    expect(getDeliveryJobKey({ encryptJobId: 'enc', securityId: 'sec' } as any)).toBe('enc')
    expect(getDeliveryJobKey({ encryptJobId: '', securityId: 'sec' } as any)).toBe('sec')
  })
})
