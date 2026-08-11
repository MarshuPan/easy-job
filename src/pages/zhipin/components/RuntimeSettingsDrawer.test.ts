import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { conf, confPersist, persistAiTasks, disableAiGreetingNow, messageWarning } = vi.hoisted(
  () => {
    const confPersist = vi.fn(async () => true)
    const persistAiTasks = vi.fn(async () => true)
    const disableAiGreetingNow = vi.fn(async () => true)
    return {
      confPersist,
      persistAiTasks,
      disableAiGreetingNow,
      messageWarning: vi.fn(),
      conf: {
        isLoaded: true,
        hasPersonalConfig: true,
        readiness: {
          configRevision: 1,
          displayNameReady: true,
          modelReady: true,
          resumeReady: true,
          resumeStatus: 'ready',
          aiFilteringReady: true,
          aiGreetingReady: true,
        },
        confPersist,
        persistAiTasks,
        disableAiGreetingNow,
        formData: {
          aiFiltering: { enable: true, score: 60 },
          aiGreeting: {
            enable: true,
            messageCount: 3,
            targetTotalCharacters: 150,
            prompt: '默认招呼语要求',
          },
          activityFilter: { value: true },
          goldHunterFilter: { value: true },
          jobContent: {
            enable: true,
            include: false,
            value: ['销售岗'],
            options: ['销售岗'],
          },
          sameCompanyFilter: { value: true },
          sameHrFilter: { value: true },
          friendStatus: { value: true },
          amap: {
            enable: false,
            key: '',
            origins: '',
            straightDistance: 0,
            drivingDistance: 30,
            drivingDuration: 60,
            walkingDistance: 0,
            walkingDuration: 0,
          },
          deliveryLimit: { search: 60, group: 40 },
          delay: {
            deliveryInterval: 30,
            deliveryIntervalMax: 60,
            batchSize: 30,
            batchRestMinutes: 10,
          },
        },
      },
    }
  },
)

vi.mock('@/stores/conf', async () => {
  const { reactive } = await vi.importActual<typeof import('vue')>('vue')
  const reactiveConf = reactive(conf)
  return {
    useConf: () => reactiveConf,
  }
})

vi.mock('@/ui/instrument', () => ({
  AgentMessage: {
    warning: messageWarning,
  },
  AgentButton: {
    name: 'AgentButton',
    template: '<button><slot /></button>',
  },
  AgentSelect: {
    name: 'AgentSelect',
    props: {
      modelValue: Array,
      multiple: Boolean,
      filterable: Boolean,
      allowCreate: Boolean,
      collapseTags: Boolean,
      maxCollapseTags: Number,
      placeholder: String,
    },
    template: '<div class="mock-select" />',
  },
  AgentRadioGroup: {
    name: 'AgentRadioGroup',
    props: ['modelValue'],
    emits: ['update:modelValue', 'change'],
    template: '<div class="mock-radio-group"><slot /></div>',
  },
  AgentRadioButton: {
    name: 'AgentRadioButton',
    props: ['value', 'label'],
    template: '<button type="button" :data-value="String(value)">{{ label }}</button>',
  },
  AgentSwitch: {
    name: 'AgentSwitch',
    inheritAttrs: false,
    props: ['modelValue'],
    emits: ['update:modelValue', 'change'],
    template:
      '<button type="button" v-bind="$attrs" @click="$emit(\'update:modelValue\', !modelValue); $emit(\'change\', !modelValue)" />',
  },
  AgentTag: {
    name: 'AgentTag',
    template: '<span><slot /></span>',
  },
}))

import RuntimeSettingsDrawer from './RuntimeSettingsDrawer.vue'

enableAutoUnmount(afterEach)

describe('runtime settings drawer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    conf.isLoaded = true
    conf.readiness.displayNameReady = true
    conf.readiness.modelReady = true
    conf.readiness.resumeReady = true
    conf.readiness.resumeStatus = 'ready'
    conf.formData.aiFiltering.enable = true
    conf.formData.aiFiltering.score = 60
    conf.formData.aiGreeting.enable = true
    conf.formData.aiGreeting.messageCount = 3
    conf.formData.aiGreeting.targetTotalCharacters = 150
    conf.formData.aiGreeting.prompt = '默认招呼语要求'
    conf.formData.amap.enable = false
    conf.formData.jobContent.enable = true
    conf.formData.jobContent.include = false
    // 运行配置字段同样要重置：用例之间共享同一个 conf 对象，
    // 残留值会让下一个用例的第一次修改变成「无变化」而不触发保存。
    conf.formData.delay.deliveryInterval = 30
    conf.formData.delay.deliveryIntervalMax = 60
    conf.formData.delay.batchSize = 30
    conf.formData.delay.batchRestMinutes = 10
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the shared page toolbar and keeps reset as its only manual configuration action', () => {
    const wrapper = mount(RuntimeSettingsDrawer)

    expect(wrapper.find('.runtime-settings__toolbar.instrument-view-toolbar').text()).toContain(
      '运行配置',
    )
    expect(wrapper.get('[data-test="reset-runtime-settings"]').text()).toContain('重置')
    expect(wrapper.find('.runtime-settings__frame.instrument-frame').exists()).toBe(true)
    expect(wrapper.find('.runtime-settings__footer').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('保存配置')
    expect(wrapper.text()).not.toContain('应用个人配置')
    expect(wrapper.text()).not.toContain('私有配置已加载')
  })

  it('auto-saves runtime changes without invoking the reload-based save flow', async () => {
    vi.useFakeTimers()
    const wrapper = mount(RuntimeSettingsDrawer)
    await flushPromises()
    confPersist.mockClear()

    await wrapper.get('[aria-label="单个岗位最短处理间隔"]').setValue('45')
    await vi.advanceTimersByTimeAsync(250)

    expect(conf.formData.delay.deliveryInterval).toBe(45)
    expect(confPersist).toHaveBeenCalledOnce()
    // AI 任务是全局数据，不再随账号级运行配置一起保存。
    expect(persistAiTasks).not.toHaveBeenCalled()
  })

  it('saves AI task settings through their own path, not the account runtime save', async () => {
    vi.useFakeTimers()
    const wrapper = mount(RuntimeSettingsDrawer)
    await flushPromises()
    confPersist.mockClear()
    persistAiTasks.mockClear()

    await wrapper.get('[aria-label="最低匹配度"]').setValue('75')
    await vi.advanceTimersByTimeAsync(250)

    expect(conf.formData.aiFiltering.score).toBe(75)
    expect(persistAiTasks).toHaveBeenCalledOnce()
    expect(confPersist).not.toHaveBeenCalled()
  })

  it('rolls back to the latest successful runtime save when a newer save fails', async () => {
    vi.useFakeTimers()
    let resolveFirst!: (saved: boolean) => void
    let resolveSecond!: (saved: boolean) => void
    confPersist
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (resolveSecond = resolve)))
    const wrapper = mount(RuntimeSettingsDrawer)
    await flushPromises()

    await wrapper.get('[aria-label="单个岗位最短处理间隔"]').setValue('40')
    await vi.advanceTimersByTimeAsync(300)
    await wrapper.get('[aria-label="单个岗位最短处理间隔"]').setValue('45')
    await vi.advanceTimersByTimeAsync(300)
    expect(confPersist).toHaveBeenCalledTimes(2)

    resolveFirst(true)
    await flushPromises()
    resolveSecond(false)
    await flushPromises()

    expect(conf.formData.delay.deliveryInterval).toBe(40)
  })

  it('resets to the page-entry runtime baseline and persists the reset', async () => {
    vi.useFakeTimers()
    const wrapper = mount(RuntimeSettingsDrawer)
    await flushPromises()
    confPersist.mockClear()

    await wrapper.get('[aria-label="最低匹配度"]').setValue('75')
    expect(conf.formData.aiFiltering.score).toBe(75)

    await wrapper.get('[data-test="reset-runtime-settings"]').trigger('click')
    await vi.runAllTimersAsync()

    expect(conf.formData.aiFiltering.score).toBe(60)
    expect(confPersist).toHaveBeenCalledOnce()
  })

  it('restores the latest saved runtime values when reset persistence fails', async () => {
    vi.useFakeTimers()
    const wrapper = mount(RuntimeSettingsDrawer)
    await flushPromises()
    confPersist.mockClear()

    await wrapper.get('[aria-label="单个岗位最短处理间隔"]').setValue('70')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(conf.formData.delay.deliveryInterval).toBe(70)

    confPersist.mockResolvedValueOnce(false)
    await wrapper.get('[data-test="reset-runtime-settings"]').trigger('click')
    await flushPromises()
    await vi.runAllTimersAsync()

    expect(conf.formData.delay.deliveryInterval).toBe(70)
    expect(confPersist).toHaveBeenCalledTimes(2)
  })

  it('describes search and expectation values as source ratios instead of hard limits', () => {
    const wrapper = mount(RuntimeSettingsDrawer)
    const text = wrapper.text()

    expect(text).toContain('搜索来源比例')
    expect(text).toContain('求职期望来源比例')
    expect(text).not.toContain('搜索投递上限')
    expect(text).not.toContain('求职期望投递上限')
  })

  it('separates queue, list filters, detail filters, and AI settings', () => {
    const wrapper = mount(RuntimeSettingsDrawer)

    expect(wrapper.findAll('.instrument-setting-section')).toHaveLength(4)
    expect(wrapper.findAll('.runtime-settings__unit-field')).toHaveLength(5)
    // 招呼语分段间隔也是一个 compound-field，多出来的第 10 个数字输入框是它。
    expect(wrapper.findAll('.runtime-settings__compound-field')).toHaveLength(3)
    expect(wrapper.findAll('input[type="number"]')).toHaveLength(10)
    expect(wrapper.text()).toContain('队列与节奏')
    expect(wrapper.text()).toContain('岗位过滤')
    expect(wrapper.text()).toContain('岗位详情')
    expect(wrapper.text()).toContain('AI 与招呼语')
  })

  it('places deterministic filters in runtime settings instead of search rules', () => {
    const text = mount(RuntimeSettingsDrawer).text()

    expect(text).toContain('已沟通 / 好友状态')
    expect(text).toContain('同公司去重')
    expect(text).toContain('同 HR 去重')
    expect(text).toContain('猎头岗位')
    expect(text).toContain('工作内容')
    expect(text).toContain('招聘者活跃度')
    expect(text).toContain('通勤距离')
  })

  it('only shows the AI match threshold while AI matching is enabled', async () => {
    conf.formData.aiFiltering.score = 60
    const wrapper = mount(RuntimeSettingsDrawer)

    expect(wrapper.find('[aria-label="最低匹配度"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="ai-threshold-panel"]').exists()).toBe(true)

    await wrapper.get('[aria-label="启用 AI 匹配"]').trigger('click')

    expect(conf.formData.aiFiltering.enable).toBe(false)
    expect(wrapper.find('[aria-label="最低匹配度"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ai-threshold-panel"]').exists()).toBe(false)
    expect(conf.formData.aiFiltering.score).toBe(60)

    await wrapper.get('[aria-label="启用 AI 匹配"]').trigger('click')

    expect(conf.formData.aiFiltering.enable).toBe(true)
    expect(wrapper.find('[aria-label="最低匹配度"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="ai-threshold-panel"]').exists()).toBe(true)
    expect((wrapper.get('[aria-label="最低匹配度"]').element as HTMLInputElement).value).toBe('60')
  })

  it('keeps AI switches off and does not persist when no model is configured', async () => {
    vi.useFakeTimers()
    conf.readiness.modelReady = false
    conf.formData.aiFiltering.enable = false
    conf.formData.aiGreeting.enable = false
    const wrapper = mount(RuntimeSettingsDrawer)
    await flushPromises()
    confPersist.mockClear()

    await wrapper.get('[aria-label="启用 AI 匹配"]').trigger('click')
    await wrapper.get('[aria-label="启用 AI 招呼语"]').trigger('click')
    await vi.runAllTimersAsync()

    expect(conf.formData.aiFiltering.enable).toBe(false)
    expect(conf.formData.aiGreeting.enable).toBe(false)
    expect(messageWarning).toHaveBeenCalledTimes(2)
    expect(messageWarning).toHaveBeenNthCalledWith(1, '模型未配置，请先配置')
    expect(messageWarning).toHaveBeenNthCalledWith(2, '模型未配置，请先配置')
    expect(confPersist).not.toHaveBeenCalled()
  })

  it('keeps AI matching off until the personal resume is ready', async () => {
    conf.readiness.resumeReady = false
    conf.formData.aiFiltering.enable = false
    const wrapper = mount(RuntimeSettingsDrawer)

    await wrapper.get('[aria-label="启用 AI 匹配"]').trigger('click')

    expect(conf.formData.aiFiltering.enable).toBe(false)
    expect(messageWarning).toHaveBeenCalledWith('请先填写并保存个人简历')
  })

  it('explains that a saved resume still needs a successful extraction', async () => {
    conf.readiness.resumeReady = false
    conf.readiness.resumeStatus = 'error'
    conf.formData.aiFiltering.enable = false
    const wrapper = mount(RuntimeSettingsDrawer)

    await wrapper.get('[aria-label="启用 AI 匹配"]').trigger('click')

    expect(conf.formData.aiFiltering.enable).toBe(false)
    expect(messageWarning).toHaveBeenCalledWith('个人简历尚未解析成功')
  })

  it('keeps AI greeting off until a display name is configured', async () => {
    conf.readiness.displayNameReady = false
    conf.formData.aiGreeting.enable = false
    const wrapper = mount(RuntimeSettingsDrawer)

    await wrapper.get('[aria-label="启用 AI 招呼语"]').trigger('click')

    expect(conf.formData.aiGreeting.enable).toBe(false)
    expect(messageWarning).toHaveBeenCalledWith('请先填写姓名或对外称呼')
  })

  it('keeps commute unavailable in both its switch and secondary panel', async () => {
    conf.formData.amap.enable = false
    const wrapper = mount(RuntimeSettingsDrawer)

    await wrapper.get('[aria-label="启用通勤距离"]').trigger('click')

    expect(conf.formData.amap.enable).toBe(false)
    expect(messageWarning).toHaveBeenCalledWith('该功能暂未开放')
    expect(wrapper.find('.runtime-settings__commute-panel').exists()).toBe(false)
    expect(wrapper.text()).toContain('该功能暂未开放')
  })

  it('links to the BOSS automatic greeting setting without replacing the delivery page', () => {
    const wrapper = mount(RuntimeSettingsDrawer)
    const link = wrapper.get('.runtime-settings__external-link')

    expect(link.text()).toBe('前往')
    expect(link.attributes('href')).toBe('https://www.zhipin.com/web/geek/notify-set?type=greetSet')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
    expect(wrapper.text()).toContain('开启需关闭自动打招呼')
  })

  it('describes recruiter activity as a strict seven-day filter', () => {
    expect(mount(RuntimeSettingsDrawer).text()).toContain('跳过7日内不活跃的招聘者')
  })

  it('shows greeting settings as a secondary panel and preserves them while disabled', async () => {
    const wrapper = mount(RuntimeSettingsDrawer)

    expect(wrapper.find('[data-test="ai-greeting-panel"]').exists()).toBe(true)
    expect(wrapper.get('[aria-label="AI 招呼语消息条数"]').attributes('max')).toBe('5')

    await wrapper.get('[aria-label="AI 招呼语目标总字数"]').setValue('200')
    expect(wrapper.text()).toContain('175-225')

    // 关闭是即时安全控制，走专用入口而不是常规保存。
    await wrapper.get('[aria-label="启用 AI 招呼语"]').trigger('click')
    expect(conf.formData.aiGreeting.enable).toBe(false)
    expect(disableAiGreetingNow).toHaveBeenCalledOnce()
    expect(wrapper.find('[data-test="ai-greeting-panel"]').exists()).toBe(false)
    expect(conf.formData.aiGreeting.targetTotalCharacters).toBe(200)

    await wrapper.get('[aria-label="启用 AI 招呼语"]').trigger('click')
    expect(wrapper.find('[data-test="ai-greeting-panel"]').exists()).toBe(true)
    expect(
      (wrapper.get('[aria-label="AI 招呼语目标总字数"]').element as HTMLInputElement).value,
    ).toBe('200')
  })

  it('uses the same collapsed tag-input interaction as search keywords', () => {
    const wrapper = mount(RuntimeSettingsDrawer)
    const keywordSelect = wrapper.getComponent({ name: 'AgentSelect' })
    const mode = wrapper.getComponent({ name: 'AgentRadioGroup' })
    const toggleRow = wrapper.get('[data-test="job-content-toggle-row"]')
    const keywordPanel = wrapper.get('[data-test="job-content-keyword-panel"]')

    expect(keywordSelect.props()).toMatchObject({
      multiple: true,
      filterable: true,
      allowCreate: true,
      collapseTags: true,
      maxCollapseTags: 2,
      placeholder: '输入关键词后回车',
    })
    expect(mode.props('modelValue')).toBe(false)
    expect(wrapper.get('[data-test="job-content-mode"]').text()).toContain('包含')
    expect(wrapper.get('[data-test="job-content-mode"]').text()).toContain('排除')
    expect(wrapper.text()).not.toContain('完整 JD 至少命中一个关键词')
    expect(wrapper.text()).not.toContain('完整 JD 命中任一关键词时过滤')
    expect(toggleRow.find('[data-test="job-content-mode"]').exists()).toBe(false)
    expect(toggleRow.get('[aria-label="启用工作内容筛选"]').attributes('aria-label')).toBe(
      '启用工作内容筛选',
    )
    expect(keywordPanel.get('[data-test="job-content-mode"]').text()).toContain('排除')
    expect(keywordPanel.get('[data-test="job-content-keywords"]').attributes('data-test')).toBe(
      'job-content-keywords',
    )
  })

  it('only expands the work-content controls while enabled and preserves their values', async () => {
    conf.formData.jobContent.include = true
    const wrapper = mount(RuntimeSettingsDrawer)

    expect(wrapper.find('[data-test="job-content-mode"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="job-content-keyword-panel"]').exists()).toBe(true)

    await wrapper.get('[aria-label="启用工作内容筛选"]').trigger('click')
    expect(conf.formData.jobContent.enable).toBe(false)
    expect(conf.formData.jobContent.include).toBe(true)
    expect(conf.formData.jobContent.value).toEqual(['销售岗'])
    expect(wrapper.find('[data-test="job-content-mode"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="job-content-keyword-panel"]').exists()).toBe(false)

    expect(conf.formData.jobContent.include).toBe(true)

    await wrapper.get('[aria-label="启用工作内容筛选"]').trigger('click')
    expect(conf.formData.jobContent.enable).toBe(true)
    expect(wrapper.find('[data-test="job-content-mode"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="job-content-keyword-panel"]').exists()).toBe(true)
  })

  it('updates the persisted include or exclude selection through the segmented control', async () => {
    const wrapper = mount(RuntimeSettingsDrawer)
    const mode = wrapper.getComponent({ name: 'AgentRadioGroup' })

    mode.vm.$emit('update:modelValue', true)
    await wrapper.vm.$nextTick()

    expect(conf.formData.jobContent.include).toBe(true)
  })
})
