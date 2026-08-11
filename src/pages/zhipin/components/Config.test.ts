import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { conf, confPersist, getUserResumeData, messageWarning } = vi.hoisted(() => {
  const confPersist = vi.fn(async () => true)
  const confSaving = vi.fn()
  const confReload = vi.fn()
  const messageWarning = vi.fn()
  const getUserResumeData = vi.fn(async () => ({
    expectList: [
      {
        id: '101',
        positionType: 0,
        positionName: 'AI 产品经理',
        locationName: '上海',
        salaryDesc: '30-50K',
      },
      {
        id: '202',
        positionType: 0,
        positionName: '产品负责人',
        locationName: '杭州',
        salaryDesc: '40-60K',
      },
      {
        id: '303',
        positionType: 0,
        positionName: 'AI 商业化产品',
        locationName: '深圳',
        salaryDesc: '35-55K',
      },
      {
        id: '404',
        positionType: 0,
        positionName: '大模型产品经理',
        locationName: '北京',
        salaryDesc: '40-70K',
      },
    ],
  }))
  const select = (value: string[]) => ({
    enable: true,
    include: true,
    value,
    options: [...value],
  })
  return {
    confSaving,
    confPersist,
    confReload,
    getUserResumeData,
    messageWarning,
    conf: {
      confSaving,
      confPersist,
      confReload,
      availableJobExpectations: [
        {
          id: '101',
          positionName: 'AI 产品经理',
          locationName: '上海',
          salaryDesc: '30-50K',
        },
      ],
      setAvailableJobExpectations(
        expectations: Array<{
          id: string
          positionName: string
          locationName: string
          salaryDesc: string
        }>,
      ) {
        this.availableJobExpectations = expectations
      },
      formData: {
        jobTitle: select(['AI 产品经理']),
        jobContent: select(['Agent']),
        company: select([]),
        hrPosition: select(['猎头']),
        jobSources: {
          searchEnabled: true,
          recommendEnabled: true,
          enabledExpectIds: ['101'],
          expectationsInitialized: true,
        },
        searchConditions: {
          directions: ['AI 产品经理', 'Agent 产品经理'],
          city: '101020100',
          businessDistricts: [],
          salary: '406',
          experience: ['105'],
          degree: ['203'],
          jobType: ['1901'],
        },
        friendStatus: { value: true },
        sameCompanyFilter: { value: true },
        sameHrFilter: { value: true },
        activityFilter: { value: true },
        goldHunterFilter: { value: true },
        amap: {
          enable: false,
          key: '',
          origins: '',
          straightDistance: 0,
          drivingDistance: 0,
          drivingDuration: 0,
          walkingDistance: 0,
          walkingDuration: 0,
        },
      },
    },
  }
})

vi.mock('@/stores/conf', async () => {
  const { reactive } = await vi.importActual<typeof import('vue')>('vue')
  const reactiveConf = reactive(conf)
  return {
    formInfoData: {},
    useConf: () => reactiveConf,
  }
})

vi.mock('@/stores/user', () => ({
  useUser: () => ({ getUserResumeData }),
}))

vi.mock('@/composables/useCommon', () => ({
  useCommon: () => ({ deliverLock: false }),
}))

vi.mock('@/components/form/FormItem.vue', () => ({
  default: { name: 'FormItem', template: '<div><slot /></div>' },
}))

vi.mock('./Ai.vue', () => ({
  default: { name: 'Ai', template: '<div />' },
}))

vi.mock('./Appearance.vue', () => ({
  default: { name: 'Appearance', template: '<div />' },
}))

vi.mock('@/utils/amap', () => ({ amapGeocode: vi.fn() }))
vi.mock('@/utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))

vi.mock('@/ui/instrument', () => ({
  AgentButton: {
    name: 'AgentButton',
    props: ['disabled'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  AgentCheckbox: {
    name: 'AgentCheckbox',
    template: '<label><input type="checkbox" /><slot /></label>',
  },
  AgentForm: {
    name: 'AgentForm',
    template: '<form><slot /></form>',
  },
  AgentFormItem: {
    name: 'AgentFormItem',
    template: '<div><slot /></div>',
  },
  AgentInput: {
    name: 'AgentInput',
    template: '<div><slot name="append" /></div>',
  },
  AgentInputNumber: {
    name: 'AgentInputNumber',
    template: '<div />',
  },
  AgentLink: {
    name: 'AgentLink',
    template: '<a><slot /></a>',
  },
  AgentMessage: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: messageWarning },
  AgentSelect: {
    name: 'AgentSelect',
    inheritAttrs: false,
    props: ['modelValue', 'collapseTags', 'maxCollapseTags'],
    emits: ['update:modelValue', 'change'],
    template:
      '<button type="button" class="mock-select" v-bind="$attrs" :data-collapse-tags="collapseTags" :data-max-collapse-tags="maxCollapseTags" @click="$emit(\'change\', modelValue)"><slot /></button>',
  },
  AgentSwitch: {
    name: 'AgentSwitch',
    inheritAttrs: false,
    props: ['modelValue'],
    emits: ['change'],
    template: '<button type="button" v-bind="$attrs" @click="$emit(\'change\', !modelValue)" />',
  },
}))

import Config from './Config.vue'

describe('filter settings instrument layout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    confPersist.mockResolvedValue(true)
    conf.formData.searchConditions.directions = ['AI 产品经理', 'Agent 产品经理']
    conf.formData.jobSources.searchEnabled = true
    conf.formData.jobSources.recommendEnabled = true
    conf.formData.jobSources.enabledExpectIds = ['101']
    conf.formData.jobSources.expectationsInitialized = true
  })

  it('shows search rules inline before the real expectation sources', async () => {
    const wrapper = mount(Config, { props: { section: 'filter' } })
    await flushPromises()

    const jobRules = wrapper.get('[data-test="job-source-rules"]')
    expect(
      jobRules
        .findAll(':scope > .instrument-setting-section > .instrument-setting-title')
        .map((item) => item.text()),
    ).toEqual(['搜索', '求职期望'])
    expect(
      jobRules.get('[data-test="search-rules-module"]').findAll('.instrument-setting-title'),
    ).toHaveLength(0)
    expect(jobRules.get('[data-test="search-rules-module"]').element.parentElement).toBe(
      jobRules.get('[data-source="search"]').element.parentElement,
    )
    expect(wrapper.findAll('.job-source-row')).toHaveLength(6)
    expect(wrapper.text()).toContain('岗位规则')
    expect(wrapper.text()).not.toContain('个来源已开启')
    expect(wrapper.text()).toContain('AI 产品经理(上海)')
    expect(wrapper.text()).toContain('产品负责人(杭州)')
    expect(wrapper.text()).toContain('AI 商业化产品(深圳)')
    expect(wrapper.text()).toContain('大模型产品经理(北京)')
    expect(wrapper.text()).toContain('刷新求职期望')
    expect(wrapper.text()).not.toContain('保存岗位规则')
    expect(wrapper.findAll('[data-test="filter-select"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="filter-rules-drawer"]').exists()).toBe(false)
    expect(jobRules.find('.filter-rules-footer').exists()).toBe(false)
    expect(jobRules.findAll('.search-condition-control')).toHaveLength(6)
    const directionSelect = jobRules.get('[data-test="search-directions"]')
    expect(directionSelect.attributes()).toHaveProperty('data-collapse-tags')
    expect(directionSelect.attributes('data-max-collapse-tags')).toBe('2')
    expect(jobRules.text()).not.toContain('岗位方向')
    expect(jobRules.text()).not.toContain('BOSS 搜索条件')
    expect(wrapper.text()).not.toContain('工作区域')
    expect(wrapper.text()).toContain('按 BOSS 推荐列表获取岗位')
    expect(wrapper.text()).toContain('求职类型')
    expect(jobRules.text()).not.toContain('保存规则')
    expect(jobRules.text()).toContain('重置')
    const searchActions = jobRules.get('.job-source-row__actions')
    expect(searchActions.get('[data-test="reset-search-rules"]').text()).toContain('重置')
    expect(searchActions.element.lastElementChild?.getAttribute('aria-label')).toBe('开启搜索来源')
    expect(jobRules.text()).not.toContain('工作内容排除')
    expect(jobRules.text()).not.toContain('同公司去重')
    expect(jobRules.text()).not.toContain('招聘者活跃度')
    expect(wrapper.find('.filter-collapse').exists()).toBe(false)
  })

  it('auto-saves search conditions and keeps them when search is disabled', async () => {
    const wrapper = mount(Config, { props: { section: 'filter' } })
    await flushPromises()

    conf.formData.searchConditions.directions.push('自动保存岗位')
    await wrapper.get('[data-test="search-directions"]').trigger('click')
    await flushPromises()

    expect(confPersist).toHaveBeenCalled()
    await wrapper.get('[aria-label="开启搜索来源"]').trigger('click')
    await flushPromises()

    expect(conf.formData.jobSources.searchEnabled).toBe(false)
    expect(conf.formData.searchConditions.directions).toEqual([
      'AI 产品经理',
      'Agent 产品经理',
      '自动保存岗位',
    ])
    expect(wrapper.find('[data-test="search-rules-module"]').exists()).toBe(false)
    expect(wrapper.findAll('.search-condition-control')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('保存规则')
    expect(wrapper.text()).toContain('重置')
    expect(wrapper.text()).toContain('求职期望')

    await wrapper.get('[aria-label="开启搜索来源"]').trigger('click')
    await flushPromises()

    expect(conf.formData.jobSources.searchEnabled).toBe(true)
    expect(wrapper.find('[data-test="search-rules-module"]').exists()).toBe(true)
    expect(wrapper.findAll('.search-condition-control')).toHaveLength(6)
  })

  it('connects every search condition control to automatic persistence', async () => {
    const wrapper = mount(Config, { props: { section: 'filter' } })
    await flushPromises()
    confPersist.mockClear()

    for (const selector of [
      '[data-test="search-directions"]',
      '[data-test="search-city"]',
      '[data-test="search-salary"]',
      '[data-test="search-experience"]',
      '[data-test="search-degree"]',
      '[data-test="search-job-type"]',
    ]) {
      await wrapper.get(selector).trigger('click')
      await flushPromises()
      expect(confPersist).toHaveBeenCalled()
      confPersist.mockClear()
    }
  })

  it('auto-saves each search-rule change and resets to the page-entry baseline', async () => {
    const wrapper = mount(Config, { props: { section: 'filter' } })
    await flushPromises()

    conf.formData.searchConditions.directions = ['大模型产品经理']
    await wrapper.get('[data-test="search-directions"]').trigger('click')
    await flushPromises()

    expect(conf.formData.searchConditions.directions).toEqual(['大模型产品经理'])
    expect(confPersist).toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('保存规则')

    await wrapper.get('[data-test="reset-search-rules"]').trigger('click')
    await flushPromises()

    expect(conf.formData.searchConditions.directions).toEqual(['AI 产品经理', 'Agent 产品经理'])
    expect(confPersist).toHaveBeenCalledTimes(2)
  })

  it('rolls back to the latest successful search-rule save when a newer save fails', async () => {
    let resolveFirst!: (saved: boolean) => void
    let resolveSecond!: (saved: boolean) => void
    confPersist
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (resolveSecond = resolve)))
    const wrapper = mount(Config, { props: { section: 'filter' } })
    await flushPromises()

    conf.formData.searchConditions.directions = ['第一次保存']
    await wrapper.get('[data-test="search-directions"]').trigger('click')
    conf.formData.searchConditions.directions = ['第二次保存']
    await wrapper.get('[data-test="search-directions"]').trigger('click')
    expect(confPersist).toHaveBeenCalledTimes(2)

    resolveFirst(true)
    await flushPromises()
    resolveSecond(false)
    await flushPromises()

    expect(conf.formData.searchConditions.directions).toEqual(['第一次保存'])
  })

  it('keeps auto-saved search conditions when the job-rules view is hidden', async () => {
    const wrapper = mount(Config, { props: { section: 'filter', visible: true } })
    await flushPromises()

    conf.formData.searchConditions.directions.push('自动保存岗位')
    await wrapper.get('[data-test="search-directions"]').trigger('click')
    await flushPromises()
    await wrapper.setProps({ visible: false })

    expect(conf.formData.searchConditions.directions).toEqual([
      'AI 产品经理',
      'Agent 产品经理',
      '自动保存岗位',
    ])
  })

  it('restores the last persisted rules when the final search direction is removed', async () => {
    const wrapper = mount(Config, { props: { section: 'filter' } })
    await flushPromises()

    conf.formData.searchConditions.directions = []
    await wrapper.get('[data-test="search-directions"]').trigger('click')
    await flushPromises()

    expect(conf.formData.searchConditions.directions).toEqual(['AI 产品经理', 'Agent 产品经理'])
    expect(messageWarning).toHaveBeenCalledWith('请至少保留一个岗位方向')
    expect(confPersist).not.toHaveBeenCalled()
  })

  it('keeps at least one currently loaded job source enabled', async () => {
    conf.formData.jobSources.enabledExpectIds = []
    conf.formData.jobSources.recommendEnabled = false
    const wrapper = mount(Config, { props: { section: 'filter' } })
    await flushPromises()

    await wrapper.get('[aria-label="开启搜索来源"]').trigger('click')

    expect(conf.formData.jobSources.searchEnabled).toBe(true)
    expect(messageWarning).toHaveBeenCalledWith('至少开启一个岗位来源')

    await wrapper.get('[aria-label="开启推荐来源"]').trigger('click')
    await wrapper.get('[aria-label="开启搜索来源"]').trigger('click')
    await flushPromises()

    expect(conf.formData.jobSources.searchEnabled).toBe(false)
    expect(conf.formData.jobSources.recommendEnabled).toBe(true)
    expect(conf.formData.jobSources.enabledExpectIds).toEqual([])
    expect(confPersist).toHaveBeenCalledTimes(2)
  })
})
