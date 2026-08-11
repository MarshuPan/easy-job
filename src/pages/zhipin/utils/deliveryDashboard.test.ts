import { describe, expect, it } from 'vitest'

import {
  buildDeliveryDashboard,
  buildDeliveryTaskTitle,
  classifyDeliveryFailure,
} from './deliveryDashboard'

function job(encryptJobId: string, jobName = encryptJobId) {
  return {
    encryptJobId,
    jobName,
    status: {
      status: 'wait',
    },
  }
}

function timestampFor(date: string, hour = 12) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, hour).getTime()
}

describe('delivery dashboard metrics', () => {
  it('uses the JD name as the task title without batch wording', () => {
    expect(buildDeliveryTaskTitle('AI 产品经理')).toBe('AI 产品经理投递')
    expect(buildDeliveryTaskTitle('AI 产品经理投递')).toBe('AI 产品经理投递')
    // 兜底文案不能长得像真实岗位名，否则未开始投递时看起来像已经在投某个岗位。
    expect(buildDeliveryTaskTitle()).toBe('未开始投递')
    expect(buildDeliveryTaskTitle('', true)).toBe('正在准备岗位')
    expect(buildDeliveryTaskTitle('  ')).toBe('未开始投递')
    expect(buildDeliveryTaskTitle('AI 产品经理', true)).toBe('AI 产品经理投递')
  })

  it('groups failure reasons into stable dashboard categories', () => {
    expect(
      classifyDeliveryFailure({
        title: 'AI 产品经理',
        state: 'warning',
        state_name: 'AI匹配度',
        message: 'AI匹配度跳过 42%/60%',
        createdAt: 1,
        data: { listData: job('ai'), deliverySource: 'search', failureReason: '低于最低要求' },
      }),
    ).toBe('jobFit')

    expect(
      classifyDeliveryFailure({
        title: '后端产品',
        state: 'warning',
        state_name: '岗位名筛选',
        message: '岗位名不符',
        createdAt: 2,
        data: { listData: job('title'), deliverySource: 'group' },
      }),
    ).toBe('jobFit')

    expect(
      classifyDeliveryFailure({
        title: '岗位',
        state: 'warning',
        state_name: '薪资筛选',
        message: '不匹配的薪资范围',
        createdAt: 3,
        data: { listData: job('salary'), deliverySource: 'group' },
      }),
    ).toBe('hardFilter')

    expect(
      classifyDeliveryFailure({
        title: '岗位',
        state: 'warning',
        state_name: '重复沟通',
        message: '相同公司已投递',
        createdAt: 4,
        data: { listData: job('repeat'), deliverySource: 'search' },
      }),
    ).toBe('dedupe')

    expect(
      classifyDeliveryFailure({
        title: '岗位',
        state: 'danger',
        state_name: '打招呼出错',
        message: 'AI招呼语生成失败',
        createdAt: 5,
        data: { listData: job('greet'), deliverySource: 'search' },
      }),
    ).toBe('aiGreeting')

    expect(
      classifyDeliveryFailure({
        title: '岗位',
        state: 'danger',
        state_name: 'AI请求异常',
        message: 'Provider unavailable: heartbeat check timeout 30000ms',
        createdAt: 6,
        data: {
          listData: job('provider'),
          deliverySource: 'search',
          deliveryStage: '投递失败',
          failureStage: 'JD筛选中',
          failureReason: 'AI请求异常',
        },
      }),
    ).toBe('aiGreeting')
  })

  it('builds source and summary metrics from pools, records, and today statistics', () => {
    const targetDate = '2026-07-09'
    const dashboard = buildDeliveryDashboard({
      dailyLimit: 150,
      pools: {
        group: [
          job('group-1'),
          job('group-2'),
          { ...job('group-done'), status: { status: 'success' } },
        ],
        search: [job('search-1'), job('search-2'), job('search-3')],
      },
      records: [
        {
          title: '分组失败',
          state: 'warning',
          state_name: '岗位名筛选',
          message: '岗位名不符',
          createdAt: timestampFor(targetDate, 10),
          data: {
            listData: job('group-failed'),
            deliverySource: 'group',
            deliveryStage: '已过滤',
          },
        },
        {
          title: '搜索失败',
          state: 'danger',
          state_name: '投递出错',
          message: '投递接口异常',
          createdAt: timestampFor(targetDate, 11),
          data: { listData: job('search-failed'), deliverySource: 'search' },
        },
        {
          title: '分组成功',
          state: 'success',
          state_name: '投递成功',
          message: 'ok',
          createdAt: timestampFor(targetDate, 12),
          data: {
            listData: job('group-sent'),
            deliverySource: 'group',
            deliveryStage: '投递成功',
          },
        },
        {
          title: '搜索成功',
          state: 'success',
          state_name: '投递成功',
          message: 'ok',
          createdAt: timestampFor(targetDate, 13),
          data: {
            listData: job('search-sent'),
            deliverySource: 'search',
            deliveryStage: '投递成功',
          },
        },
      ],
      todayData: {
        date: '2026-07-09',
        success: 34,
        searchSuccess: 30,
        groupSuccess: 4,
        total: 50,
        jobContent: 0,
        aiFiltering: 0,
        amap: 0,
        companySizeRange: 0,
        activityFilter: 0,
        goldHunterFilter: 0,
        repeat: 0,
      },
      targetDate,
      weights: { group: 40, search: 60 },
    })

    // 摘要来自统计计数器（全量），表格来自投递记录（最近 200 条的窗口）。
    // 两者不再按「今天有没有成功记录」互相切换，各自恒定同源。
    expect(dashboard.summary).toMatchObject({ processed: 50, success: 34, failed: 16 })
    expect(dashboard.summary.successRate).toBe(68)
    expect(dashboard.summary.remaining).toBe(116)
    expect(dashboard.summary.fetched).toBe(6)
    expect(dashboard.summary.estimatedRequiredProcessed).toBe(171)
    expect(dashboard.sources.group).toMatchObject({
      fetched: 3,
      pending: 2,
      processed: 2,
      success: 1,
      filtered: 1,
      failed: 0,
      actualPercent: 50,
      targetPercent: 40,
      successRate: 50,
    })
    expect(dashboard.sources.search).toMatchObject({
      fetched: 3,
      pending: 3,
      processed: 2,
      success: 1,
      filtered: 0,
      failed: 1,
      actualPercent: 50,
      targetPercent: 60,
      successRate: 50,
    })
    expect(dashboard.failureCategories.find((item) => item.id === 'jobFit')?.count).toBe(1)
    expect(dashboard.failureCategories.find((item) => item.id === 'publish')?.count).toBe(1)
  })

  it('keeps records without source attribution out of search source metrics', () => {
    const targetDate = '2026-07-09'
    const dashboard = buildDeliveryDashboard({
      dailyLimit: 150,
      pools: {
        group: [],
        search: [],
      },
      records: [
        {
          title: '历史失败',
          state: 'danger',
          state_name: '投递出错',
          message: '旧日志没有来源字段',
          createdAt: timestampFor(targetDate),
          data: { listData: job('unknown-failed') },
        },
      ],
      todayData: {
        date: '2026-07-09',
        success: 0,
        searchSuccess: 0,
        groupSuccess: 0,
        total: 1,
        jobContent: 0,
        aiFiltering: 0,
        amap: 0,
        companySizeRange: 0,
        activityFilter: 0,
        goldHunterFilter: 0,
        repeat: 0,
      },
      targetDate,
      weights: { group: 40, search: 60 },
    })

    expect(dashboard.sources.search.failed).toBe(0)
    expect(dashboard.summary.failed).toBe(1)
    expect(dashboard.sourceRows.find((item) => item.source === 'unknown')).toMatchObject({
      label: '未归因来源',
      fetched: 0,
      processed: 1,
      filtered: 0,
      failed: 1,
      actualPercent: 0,
      targetPercent: 0,
    })
  })

  it('counts only records created on the target local date', () => {
    const targetDate = '2026-07-10'
    const dashboard = buildDeliveryDashboard({
      dailyLimit: 100,
      pools: { group: [], search: [] },
      records: [
        {
          title: '昨天失败',
          state: 'danger',
          state_name: '投递出错',
          message: '昨天的投递接口异常',
          createdAt: timestampFor('2026-07-09'),
          data: { listData: job('yesterday'), deliverySource: 'group' },
        },
        {
          title: '今天失败',
          state: 'danger',
          state_name: '投递出错',
          message: '今天的投递接口异常',
          createdAt: timestampFor(targetDate),
          data: { listData: job('today'), deliverySource: 'group' },
        },
      ],
      todayData: {
        date: targetDate,
        success: 0,
        searchSuccess: 0,
        groupSuccess: 0,
        total: 1,
        jobContent: 0,
        aiFiltering: 0,
        amap: 0,
        companySizeRange: 0,
        activityFilter: 0,
        goldHunterFilter: 0,
        repeat: 0,
      },
      targetDate,
      weights: { group: 50, search: 50 },
    })

    expect(dashboard.sources.group.failed).toBe(1)
    expect(dashboard.summary.fetched).toBe(0)
    expect(dashboard.failureCategories.find((item) => item.id === 'publish')?.count).toBe(1)
  })

  it('deduplicates the same job globally across sources and unknown records', () => {
    const targetDate = '2026-07-10'
    const duplicate = job('same-job')
    const dashboard = buildDeliveryDashboard({
      dailyLimit: 100,
      pools: { group: [duplicate], search: [duplicate] },
      records: [
        {
          title: '同一岗位记录',
          state: 'info',
          state_name: '待处理',
          message: '缺少来源字段',
          createdAt: timestampFor(targetDate),
          data: { listData: duplicate },
        },
      ],
      todayData: {
        date: targetDate,
        success: 0,
        searchSuccess: 0,
        groupSuccess: 0,
        total: 0,
        jobContent: 0,
        aiFiltering: 0,
        amap: 0,
        companySizeRange: 0,
        activityFilter: 0,
        goldHunterFilter: 0,
        repeat: 0,
      },
      targetDate,
      weights: { group: 50, search: 50 },
    })

    expect(dashboard.summary.fetched).toBe(1)
    expect(dashboard.sources.group.fetched).toBe(1)
    expect(dashboard.sources.search.fetched).toBe(0)
    expect(dashboard.sourceRows.some((item) => item.source === 'unknown')).toBe(false)
  })

  it('deduplicates successful and processed jobs globally across sources', () => {
    const targetDate = '2026-07-10'
    const duplicate = job('same-success')
    const dashboard = buildDeliveryDashboard({
      dailyLimit: 100,
      pools: { group: [], search: [] },
      records: [
        {
          title: '分组成功记录',
          state: 'success',
          state_name: '投递成功',
          message: 'ok',
          createdAt: timestampFor(targetDate, 10),
          data: { listData: duplicate, deliverySource: 'group', deliveryStage: '投递成功' },
        },
        {
          title: '搜索成功记录',
          state: 'success',
          state_name: '投递成功',
          message: 'ok',
          createdAt: timestampFor(targetDate, 11),
          data: { listData: duplicate, deliverySource: 'search', deliveryStage: '投递成功' },
        },
      ],
      todayData: {
        date: targetDate,
        success: 2,
        searchSuccess: 1,
        groupSuccess: 1,
        total: 2,
      } as any,
      targetDate,
      weights: { group: 50, search: 50 },
    })

    // 同一岗位被两个来源各记一次，来源行必须只算一次（归给较晚的那条记录）。
    // 摘要不参与这个去重：它用的是统计计数器，答的是「今天总共处理了多少次」。
    expect(dashboard.summary).toMatchObject({ processed: 2, success: 2 })
    expect(dashboard.sources.group).toMatchObject({ processed: 0, success: 0 })
    expect(dashboard.sources.search).toMatchObject({ processed: 1, success: 1 })
  })
})

describe('pool pending accounting', () => {
  const targetDate = '2026-07-09'
  const emptyStatistics = {
    date: targetDate,
    total: 0,
    success: 0,
    groupSuccess: 0,
    searchSuccess: 0,
    jobContent: 0,
    aiFiltering: 0,
    amap: 0,
    companySizeRange: 0,
    activityFilter: 0,
    goldHunterFilter: 0,
    repeat: 0,
  }

  it('stops counting filtered jobs as waiting in the pool', () => {
    // 「投递池待处理」必须和 getDeliverableJobs 同一套判定，否则界面上会一直显示
    // 一批早已判掉、永远不会再被投出去的岗位。
    const dashboard = buildDeliveryDashboard({
      dailyLimit: 150,
      pools: {
        group: [
          job('group-waiting'),
          { ...job('group-filtered'), status: { status: 'filtered' } },
          { ...job('group-done'), status: { status: 'success' } },
        ],
        search: [],
      },
      records: [],
      targetDate,
      todayData: emptyStatistics,
      weights: { group: 50, search: 50 },
    })

    expect(dashboard.sources.group.fetched).toBe(3)
    expect(dashboard.sources.group.pending).toBe(1)
    expect(dashboard.summary.pending).toBe(1)
  })
})
