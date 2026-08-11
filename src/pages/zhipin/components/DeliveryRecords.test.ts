import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import DeliveryRecords from './DeliveryRecords.vue'

const { jobs, logData, makeJob, removeLog, removeJob, sourceLists } = vi.hoisted(() => {
  const makeJob = (
    encryptJobId: string,
    jobName: string,
    brandName: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    encryptJobId,
    jobName,
    cityName: '上海',
    salaryDesc: '30-60K',
    jobExperience: '3-5年',
    jobDegree: '本科',
    jobLabels: [],
    brandName,
    brandScaleName: '1000-9999人',
    bossName: '刘女士',
    bossTitle: 'HRBP',
    expectId: 101,
    card: {
      activeTimeDesc: '今日活跃',
      bossName: '刘女士',
      bossTitle: 'HRBP',
      degreeName: '本科',
      experienceName: '3-5年',
      jobLabels: ['AI 产品'],
      postDescription: `${jobName} 的完整 JD 描述`,
    },
    source: 'group',
    status: {
      status: 'wait',
      msg: '等待中',
      setStatus: vi.fn(),
    },
    getCard: vi.fn(async () => ({
      postDescription: `${jobName} 懒加载 JD 描述`,
    })),
    ...overrides,
  })
  const jobA = makeJob('job-a', '第一位岗位', 'A 公司', { expectId: 0 })
  const jobB = makeJob('job-b', '第二位岗位', 'B 公司')
  const jobC = makeJob('job-c', '第三位岗位', 'C 公司')
  const initialLogData = {
    title: '第三位岗位',
    state: 'info' as const,
    state_name: '打招呼语生成中',
    createdAt: 1000,
    updatedAt: 9999,
    job: jobC,
    data: {
      listData: jobC,
      deliverySource: 'group' as const,
      deliveryStage: '打招呼语生成中' as const,
      matchPercent: 88,
      trace: [
        {
          at: 1000,
          stage: 'JD筛选',
          status: 'success' as const,
          message: '岗位通过筛选',
        },
      ],
      aiGreetingMessages: ['你好，我关注到这个 AI 产品岗位。'],
    },
  }

  return {
    jobs: [jobA, jobB, jobC],
    makeJob,
    logData: {
      initial: initialLogData as any,
      value: [initialLogData] as any[],
    },
    removeJob: vi.fn(),
    removeLog: vi.fn(),
    sourceLists: {
      group: [jobA, jobB, jobC],
      search: [] as ReturnType<typeof makeJob>[],
    },
  }
})

vi.mock('@/stores/log', () => ({
  useLog: () => ({
    data: logData,
    remove: removeLog,
  }),
}))

vi.mock('@/stores/jobs', () => ({
  jobList: {
    list: jobs,
    listBySource: (source: 'group' | 'search') => sourceLists[source],
    remove: removeJob,
  },
}))

vi.mock('@/stores/conf', () => ({
  useConf: () => ({
    availableJobExpectations: [
      {
        id: '101',
        positionName: 'AI 产品经理',
        locationName: '上海',
        salaryDesc: '30-60K',
      },
    ],
    formData: {
      deliveryLimit: {
        group: 40,
        search: 60,
      },
    },
  }),
}))

vi.mock('@/composables/useCommon', () => ({
  useCommon: () => ({
    deliverLock: false,
  }),
}))

vi.mock('../hooks/useDeliver', () => ({
  useDeliver: () => ({
    deliverOne: vi.fn(),
    retryRecord: vi.fn(),
  }),
}))

vi.mock('../utils/deliveryLimit', () => ({
  getDeliveryLimit: (
    formData: { deliveryLimit: Record<'group' | 'search', number> },
    source: 'group' | 'search',
  ) => formData.deliveryLimit[source],
  inferDeliveryLimitSource: () => 'group',
}))

vi.mock('@/utils/jsonImportExport', () => ({
  exportJson: vi.fn(),
}))

vi.mock('@/ui/instrument', () => ({
  AgentButton: {
    name: 'AgentButton',
    props: ['disabled'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
  },
  AgentDrawer: {
    name: 'AgentDrawer',
    props: ['modelValue', 'title'],
    emits: ['update:modelValue'],
    template:
      '<section v-if="modelValue" data-test="process-drawer"><h2>{{ title }}</h2><slot /></section>',
  },
  AgentEmpty: {
    name: 'AgentEmpty',
    template: '<div data-test="empty"><slot /></div>',
  },
  AgentMessage: {
    success: vi.fn(),
    warning: vi.fn(),
  },
  AgentPagination: {
    name: 'AgentPagination',
    template: '<nav data-test="pagination" />',
  },
  AgentPopconfirm: {
    name: 'AgentPopconfirm',
    template: '<span><slot name="reference" /></span>',
  },
  AgentTag: {
    name: 'AgentTag',
    template: '<span><slot /></span>',
  },
  AgentTooltip: {
    name: 'AgentTooltip',
    template: '<span><slot /></span>',
  },
}))

describe('DeliveryRecords', () => {
  beforeEach(() => {
    logData.value = [logData.initial]
    sourceLists.group = jobs
    sourceLists.search = []
    removeJob.mockClear()
    removeLog.mockClear()
  })

  it('renders compact job data columns with normalized delivery statuses', () => {
    const successLog = {
      title: '第一位岗位',
      state: 'success' as const,
      state_name: '投递成功',
      createdAt: 1100,
      updatedAt: 1100,
      job: jobs[0],
      data: {
        listData: jobs[0],
        deliverySource: 'group' as const,
        deliveryStage: '投递成功' as const,
        greetingSend: { ok: true, type: 'ai' as const },
        matchPercent: 92,
      },
    }
    const filteredLog = {
      title: '第二位岗位',
      state: 'warning' as const,
      state_name: '岗位方向不符',
      message: '岗位名称不符',
      createdAt: 1200,
      updatedAt: 1200,
      job: jobs[1],
      data: {
        listData: jobs[1],
        deliverySource: 'group' as const,
        deliveryStage: '已过滤' as const,
        failureReason: '岗位名称不符',
        failureStage: 'JD筛选中' as const,
        matchPercent: 42,
      },
    }
    logData.value = [successLog, filteredLog, logData.initial]

    const wrapper = mount(DeliveryRecords)
    const headers = wrapper.findAll('thead th').map((item) => item.text())
    const header = wrapper.find('thead').text()
    const rows = wrapper.findAll('tbody > tr')

    expect(headers).toEqual([
      '岗位 / 公司',
      '薪资 / 要求',
      '来源',
      '匹配度',
      '状态',
      '进度',
      '操作',
    ])
    expect(header).not.toContain('HR 活跃')
    expect(header).not.toContain('流程进度')
    expect(header).not.toContain('地点')
    expect(header).not.toContain('经验')
    expect(header).not.toContain('学历')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.text()).toContain('A 公司')
    expect(rows[0]!.text()).toContain('第一位岗位')
    expect(rows[0]!.findAll('td')[4]?.text()).toContain('已投递')
    expect(rows[0]!.findAll('td')[5]?.text()).toBe('8/8')
    expect(rows[1]!.findAll('td')[4]?.text()).toContain('已过滤')
    expect(rows[1]!.findAll('td')[5]?.text()).toBe('2/8')
    expect(rows[2]!.findAll('td')[4]?.text()).toContain('处理中')
    expect(rows[2]!.findAll('td')[5]?.text()).toBe('5/8')
    expect(rows[0]!.findAll('td')[2]?.text()).toBe('推荐')
    expect(rows[1]!.findAll('td')[2]?.text()).toBe('AI 产品经理')
    expect(rows[2]!.text()).not.toContain('打招呼语生成中')
    expect(wrapper.find('.delivery-records__detail-row').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('流程详情')
    expect(wrapper.text()).not.toContain('招聘状态')
    expect(wrapper.text()).not.toContain('投递失败')
  })

  it('uses historical card data for JD display while hiding HR active time', () => {
    const currentJobWithoutCard = makeJob('job-active-merge', '活跃度岗位', '活跃度公司', {
      card: undefined,
    }) as any
    const historicalJobWithCard = makeJob('job-active-merge', '活跃度岗位', '活跃度公司', {
      card: {
        activeTimeDesc: '本月活跃',
        bossName: '宋女士',
        bossTitle: '招聘经理',
        postDescription: '历史详情 JD',
      },
    }) as any
    sourceLists.group = [currentJobWithoutCard]
    sourceLists.search = []
    logData.value = [
      {
        title: '活跃度岗位',
        state: 'warning' as const,
        state_name: '岗位方向不符',
        message: '岗位名称不符',
        createdAt: 1000,
        updatedAt: 1000,
        job: historicalJobWithCard,
        data: {
          listData: historicalJobWithCard,
          deliverySource: 'group' as const,
          deliveryStage: '投递失败' as const,
          failureReason: '岗位名称不符',
          failureStage: 'JD筛选中' as const,
        },
      },
    ]

    const wrapper = mount(DeliveryRecords)
    const targetRow = wrapper.findAll('tbody > tr')[0]!

    expect(targetRow.find('.delivery-records__jd-button').attributes('title')).toContain(
      '历史详情 JD',
    )
    expect(targetRow.text()).not.toContain('历史详情 JD')
    expect(targetRow.text()).not.toContain('本月活跃')
  })

  it('opens a process detail drawer with JD, trace, greeting, and failure details', async () => {
    logData.value = [
      {
        title: '第三位岗位',
        state: 'warning' as const,
        state_name: '岗位方向不符',
        message: '岗位名称不符',
        createdAt: 1000,
        updatedAt: 1000,
        job: jobs[2],
        data: {
          listData: jobs[2],
          deliverySource: 'group' as const,
          deliveryStage: '投递失败' as const,
          failureReason: '岗位名称不符',
          failureStage: 'JD筛选中' as const,
          trace: [
            {
              at: 1000,
              stage: 'JD筛选',
              status: 'warning' as const,
              message: '岗位名称不符',
            },
          ],
          aiGreetingMessages: ['你好，我关注到这个 AI 产品岗位。'],
        },
      },
    ]

    const wrapper = mount(DeliveryRecords)
    const targetRow = wrapper
      .findAll('tbody > tr')
      .find((row) => row.text().includes('第三位岗位'))!
    await targetRow
      .findAll('button')
      .find((button) => button.text().includes('第三位岗位'))!
      .trigger('click')

    const drawer = wrapper.find('[data-test="process-drawer"]')
    expect(drawer.exists()).toBe(true)
    expect(drawer.text()).toContain('第三位岗位 的完整 JD 描述')
    expect(drawer.text()).toContain('岗位名称不符')
    expect(drawer.text()).toContain('你好，我关注到这个 AI 产品岗位。')
    expect(drawer.text()).toContain('复制全部详情')

    await wrapper.setProps({ visible: false })

    expect(wrapper.find('[data-test="process-drawer"]').exists()).toBe(false)
  })

  it('keeps created waiting records in processing state instead of marking them filtered', () => {
    logData.value = [
      {
        title: '第一位岗位',
        state: 'info' as const,
        state_name: '待处理',
        createdAt: 1000,
        updatedAt: 1000,
        job: jobs[0],
        data: {
          listData: jobs[0],
          deliverySource: 'group' as const,
          deliveryStage: '待处理' as const,
        },
      },
    ]

    const wrapper = mount(DeliveryRecords)
    const targetRow = wrapper.findAll('tbody > tr')[0]!

    expect(targetRow.text()).toContain('处理中')
    expect(targetRow.text()).not.toContain('已过滤')
  })

  it('allows removing stale waiting records instead of locking them forever', () => {
    logData.value = [
      {
        title: '第一位岗位',
        state: 'info' as const,
        state_name: '待处理',
        createdAt: 1000,
        updatedAt: 1000,
        job: jobs[0],
        data: {
          listData: jobs[0],
          deliverySource: 'group' as const,
          deliveryStage: '待处理' as const,
        },
      },
    ]

    const wrapper = mount(DeliveryRecords)
    const removeButton = wrapper
      .findAll('tbody > tr')[0]!
      .findAll('button')
      .find((button) => button.text().includes('移除'))!

    expect(removeButton.attributes('disabled')).toBeUndefined()
  })

  it('marks runtime delivery failures as exceptions instead of filters', () => {
    logData.value = [
      {
        title: '第一位岗位',
        state: 'danger' as const,
        state_name: 'AI请求异常',
        message: 'Provider unavailable: heartbeat check timeout 30000ms',
        createdAt: 1000,
        updatedAt: 1000,
        job: jobs[0],
        data: {
          listData: jobs[0],
          deliverySource: 'group' as const,
          deliveryStage: '投递失败' as const,
          failureReason: 'Provider unavailable: heartbeat check timeout 30000ms',
          failureStage: '打招呼语生成中' as const,
          retryable: true,
        },
      },
    ]

    const wrapper = mount(DeliveryRecords)
    const targetRow = wrapper.findAll('tbody > tr')[0]!

    expect(targetRow.text()).toContain('异常')
    expect(targetRow.text()).not.toContain('已过滤')
  })

  it('loads JD detail on demand when opening detail for a job without cached card', async () => {
    const uncachedJob = makeJob('job-no-card', '未缓存岗位', '未缓存公司', {
      card: undefined,
    }) as any
    logData.value = []
    sourceLists.group = [uncachedJob]
    sourceLists.search = []

    const wrapper = mount(DeliveryRecords)
    await wrapper
      .findAll('tbody > tr')[0]!
      .findAll('button')
      .find((button) => button.text().includes('未缓存岗位'))!
      .trigger('click')

    expect(uncachedJob.getCard).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-test="process-drawer"]').text()).toContain(
      '未缓存岗位 懒加载 JD 描述',
    )
  })

  it('shows JD detail loading errors in the drawer', async () => {
    const uncachedJob = makeJob('job-card-error', '详情失败岗位', '详情失败公司', {
      card: undefined,
      getCard: vi.fn(async () => {
        throw new Error('detail api failed')
      }),
    }) as any
    logData.value = []
    sourceLists.group = [uncachedJob]
    sourceLists.search = []

    const wrapper = mount(DeliveryRecords)
    await wrapper
      .findAll('tbody > tr')[0]!
      .findAll('button')
      .find((button) => button.text().includes('详情失败岗位'))!
      .trigger('click')

    const drawerText = wrapper.find('[data-test="process-drawer"]').text()
    expect(drawerText).toContain('JD 读取失败，请稍后重试')
    expect(drawerText).not.toContain('detail api failed')
  })

  it('renders pending jobs in FIFO acquisition order without source rebalancing', () => {
    logData.value = []
    sourceLists.group = Array.from({ length: 10 }, (_, index) =>
      makeJob(`group-${index + 1}`, `分组岗位 ${index + 1}`, '分组公司'),
    )
    sourceLists.search = Array.from({ length: 10 }, (_, index) =>
      makeJob(`search-${index + 1}`, `搜索岗位 ${index + 1}`, '搜索公司'),
    )

    const wrapper = mount(DeliveryRecords)
    const rows = wrapper.findAll('tbody > tr:not(.delivery-records__detail-row)')
    const firstTenSources = rows.slice(0, 10).map((row) => row.findAll('td')[2]?.text())

    expect(firstTenSources).toEqual(Array.from({ length: 10 }, () => 'AI 产品经理'))
  })
})
