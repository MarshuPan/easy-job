import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfigClientError } from '@/config/client'
import { createDefaultConfigBundle } from '@/config/defaults'

const {
  getConfigBundle,
  importConfigJson,
  requestModelOriginPermission,
  requestModelOriginPermissions,
  saveAiConfiguration,
  saveProfileAndExtract,
  testAiModel,
  toastError,
  toastSuccess,
  toastWarning,
} = vi.hoisted(() => ({
  getConfigBundle: vi.fn(),
  importConfigJson: vi.fn(),
  requestModelOriginPermission: vi.fn(),
  requestModelOriginPermissions: vi.fn(),
  saveAiConfiguration: vi.fn(),
  saveProfileAndExtract: vi.fn(),
  testAiModel: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}))

vi.mock('@/config/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/client')>()),
  getConfigBundle,
  importConfigJson,
  saveAiConfiguration,
  saveProfileAndExtract,
  testAiModel,
}))

vi.mock('@/config/modelPermission', () => ({
  requestModelOriginPermission,
  requestModelOriginPermissions,
}))

vi.mock('@/ui/instrument', () => ({
  AgentMessage: {
    error: toastError,
    success: toastSuccess,
    warning: toastWarning,
  },
}))

function configuredBundle() {
  const bundle = createDefaultConfigBundle({
    appVersion: '0.7.1',
    exportedAt: new Date(0).toISOString(),
  })
  bundle.models = [
    {
      id: 'model-1',
      name: '旧配置名称',
      protocol: 'openai-responses',
      url: 'https://api.example.test/v1/responses',
      apiKey: 'secret-key',
      model: 'test-model',
      reasoningEffort: 'max',
      timeoutSeconds: 180,
      responsesBackground: 'auto',
      generation: {
        temperature: null,
        topP: null,
        presencePenalty: null,
        frequencyPenalty: null,
      },
    },
  ]
  bundle.tasks.resumeExtraction.modelId = 'model-1'
  bundle.tasks.aiFiltering.modelId = 'model-1'
  bundle.tasks.aiGreeting.modelId = 'model-1'
  return bundle
}

async function mountPage(search = '?uid=account-a') {
  window.history.replaceState({}, '', `/options.html${search}`)
  vi.resetModules()
  const App = (await import('./App.vue')).default
  const wrapper = mount(App, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('personal configuration page', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    getConfigBundle.mockImplementation(async () => structuredClone(configuredBundle()))
    importConfigJson.mockResolvedValue({})
    saveAiConfiguration.mockResolvedValue({})
    requestModelOriginPermission.mockResolvedValue(true)
    requestModelOriginPermissions.mockResolvedValue(true)
    testAiModel.mockResolvedValue({
      ok: true,
      durationMs: 12,
      model: 'test-model',
      protocol: 'openai-responses',
    })
    saveProfileAndExtract.mockResolvedValue({
      configRevision: 2,
      evidenceVersion: 1,
      factCount: 1,
      reused: false,
      status: 'ready',
    })
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    )
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders three instrument setting groups and keeps the API key masked', async () => {
    wrapper = await mountPage()

    expect(getConfigBundle).toHaveBeenCalledWith('account-a')
    expect(wrapper.find('.instrument-view-toolbar').text()).toContain('个人信息')
    expect(wrapper.find('.instrument-frame').exists()).toBe(true)
    expect(wrapper.findAll('.instrument-setting-section')).toHaveLength(3)
    expect(wrapper.findAll('.instrument-setting-title').map((item) => item.text())).toEqual([
      '个人简历',
      'AI 模型',
      '个人配置',
    ])
    expect(wrapper.text()).toContain('个人简历')
    expect(wrapper.text()).toContain('AI 模型')
    expect(wrapper.text()).toContain('个人配置')
    expect(wrapper.get('[data-test="model-key"]').attributes('type')).toBe('password')
    expect(wrapper.get('input[type="text"]').attributes('maxlength')).toBe('10')
    expect(wrapper.get('textarea').attributes('maxlength')).toBe('5000')
    expect(wrapper.text()).toContain('0 / 5000')
    expect(wrapper.find('.profile-notice').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('配置备份')
    expect(wrapper.text()).not.toContain('AI 任务与招呼语')
    expect(wrapper.text()).not.toContain('配置名称')
    expect(wrapper.text()).not.toContain('超时')
    expect(wrapper.text()).not.toContain('高级生成参数')
    expect(wrapper.text()).not.toContain('重置')
    expect(wrapper.text()).toContain('可填写基础地址或完整请求地址')
  })

  it('saves exactly one model channel without exposing task routing', async () => {
    wrapper = await mountPage()

    await wrapper.get('[data-test="model-protocol"]').setValue('openai-chat-completions')
    await wrapper.get('[data-test="model-url"]').setValue('https://api.example.test/v1/chat')
    await wrapper.get('[data-test="model-id"]').setValue('gpt-test')
    await wrapper.get('[data-test="model-effort"]').setValue('high')
    await wrapper.get('[data-test="save-model"]').trigger('click')
    await flushPromises()

    expect(requestModelOriginPermissions).toHaveBeenCalledWith(['https://api.example.test/v1/chat'])
    const [models] = saveAiConfiguration.mock.calls[0]
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      name: 'gpt-test',
      protocol: 'openai-chat-completions',
      model: 'gpt-test',
      reasoningEffort: 'high',
      responsesBackground: 'off',
    })
    expect(saveAiConfiguration.mock.calls[0]).toHaveLength(1)
    expect(toastSuccess).toHaveBeenCalledWith('模型已保存')
    expect(wrapper.find('.profile-notice').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('简历事实提取模型')
    expect(wrapper.text()).not.toContain('AI 匹配模型')
    expect(wrapper.text()).not.toContain('AI 招呼语模型')
  })

  it('preserves an imported Responses background preference when saving the model', async () => {
    const imported = configuredBundle()
    imported.models[0]!.responsesBackground = 'on'
    getConfigBundle.mockImplementation(async () => structuredClone(imported))
    wrapper = await mountPage()

    await wrapper.get('[data-test="save-model"]').trigger('click')
    await flushPromises()

    expect(saveAiConfiguration.mock.calls[0]?.[0][0]).toMatchObject({
      protocol: 'openai-responses',
      responsesBackground: 'on',
    })
  })

  it('offers one complete import/export pair without a reset action', async () => {
    wrapper = await mountPage()

    expect(wrapper.text()).toContain('导入配置')
    expect(wrapper.text()).toContain('导出配置')
    expect(wrapper.find('input[type="file"][accept="application/json,.json"]').exists()).toBe(true)
    expect(wrapper.findAll('button').some((button) => button.text().includes('重置'))).toBe(false)
  })

  it('rejects an empty or whitespace-only resume before saving', async () => {
    wrapper = await mountPage()
    const saveButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('保存并解析'))!

    await saveButton.trigger('click')
    await flushPromises()
    expect(toastWarning).toHaveBeenLastCalledWith('请填写简历内容')
    expect(saveProfileAndExtract).not.toHaveBeenCalled()

    await wrapper.get('textarea').setValue('   \n  ')
    await saveButton.trigger('click')
    await flushPromises()
    expect(toastWarning).toHaveBeenLastCalledWith('请填写简历内容')
    expect(saveProfileAndExtract).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalledWith('简历已保存')
  })

  it('reports resume, import and export actions through concise toasts', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:config')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    wrapper = await mountPage()

    await wrapper.get('textarea').setValue('负责企业服务产品规划')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('保存并解析'))!
      .trigger('click')
    await flushPromises()
    expect(toastSuccess).toHaveBeenCalledWith('简历保存并解析成功')

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('导出配置'))!
      .trigger('click')
    await flushPromises()
    expect(toastSuccess).toHaveBeenCalledWith('导出成功')

    const file = {
      size: 2,
      text: vi.fn(async () => '{}'),
    }
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await flushPromises()

    expect(importConfigJson).toHaveBeenCalledWith('account-a', '{}', 2)
    expect(requestModelOriginPermissions).toHaveBeenCalledWith([
      'https://api.example.test/v1/responses',
    ])
    expect(toastSuccess).toHaveBeenCalledWith('导入成功')
    expect(wrapper.find('.profile-notice').exists()).toBe(false)
  })

  it('shows parsing, success and failure states for resume extraction', async () => {
    let resolveSave!: (value: unknown) => void
    saveProfileAndExtract.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    )
    wrapper = await mountPage()
    await wrapper.get('textarea').setValue('负责企业服务产品规划')
    const resumeSection = wrapper.findAll('.instrument-setting-section')[0]!
    const saveButton = resumeSection
      .findAll('button')
      .find((button) => button.text().includes('保存并解析'))!

    await saveButton.trigger('click')
    expect(resumeSection.get('.resume-status.is-loading').text()).toBe('解析中')
    expect(saveButton.text()).toContain('解析中')
    expect(saveButton.attributes('disabled')).toBeDefined()
    const pendingSave = saveProfileAndExtract.mock.results.at(-1)?.value as Promise<unknown>

    resolveSave({
      configRevision: 2,
      evidenceVersion: 1,
      factCount: 3,
      reused: false,
      status: 'ready',
    })
    await pendingSave
    await flushPromises()
    await vi.waitFor(() => {
      expect(wrapper!.get('.resume-status.is-success').text()).toBe('解析成功')
    })

    saveProfileAndExtract.mockRejectedValueOnce(
      new ConfigClientError('模型服务返回 HTTP 400', 'MODEL_HTTP_FAILED'),
    )
    await wrapper!.get('textarea').setValue('负责企业服务产品规划')
    const retryButton = wrapper!
      .findAll('button')
      .find((button) => button.text().includes('保存并解析'))!
    await retryButton.trigger('click')
    const failedSave = saveProfileAndExtract.mock.results.at(-1)?.value
    expect(failedSave).toBeInstanceOf(Promise)
    await (failedSave as Promise<unknown>).catch(() => undefined)
    await flushPromises()
    expect(wrapper!.get('.resume-status.is-error').text()).toBe('解析失败')
    expect(toastError).toHaveBeenLastCalledWith('简历已保存，但解析失败：模型服务返回 HTTP 400')

    saveProfileAndExtract.mockRejectedValueOnce(
      new ConfigClientError('模型任务执行失败（server_error）', 'MODEL_TASK_FAILED'),
    )
    await wrapper!.get('textarea').setValue('负责企业服务产品规划')
    const taskFailureButton = wrapper!
      .findAll('button')
      .find((button) => button.text().includes('保存并解析'))!
    await taskFailureButton.trigger('click')
    await flushPromises()
    expect(toastError).toHaveBeenLastCalledWith(
      '简历已保存，但解析失败：模型任务执行失败（server_error）',
    )
  })

  it('shows only a concise connection result and exposes a loading state', async () => {
    let resolveTest!: (value: unknown) => void
    testAiModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve
        }),
    )
    wrapper = await mountPage()
    const modelSection = wrapper.findAll('.instrument-setting-section')[1]!
    const testButton = modelSection
      .findAll('button')
      .find((button) => button.text().includes('测试连接'))!

    await testButton.trigger('click')
    expect(testButton.text()).toContain('测试中')
    expect(testButton.attributes('disabled')).toBeDefined()
    expect(modelSection.find('.status-line').exists()).toBe(false)

    resolveTest({
      ok: true,
      durationMs: 12,
      model: 'test-model',
      protocol: 'openai-responses',
    })
    await flushPromises()

    expect(modelSection.get('.status-line.is-success').text()).toBe('连接成功')
    expect(wrapper.text()).not.toContain('HTTP 200')
    expect(wrapper.text()).not.toContain('12 ms')
  })

  it('hides model error details behind the concise failed connection state', async () => {
    testAiModel.mockRejectedValueOnce(new Error('模型服务返回 HTTP 500 / raw-response-code'))
    wrapper = await mountPage()
    const modelSection = wrapper.findAll('.instrument-setting-section')[1]!

    await modelSection
      .findAll('button')
      .find((button) => button.text().includes('测试连接'))!
      .trigger('click')
    await flushPromises()

    expect(modelSection.get('.status-line.is-error').text()).toBe('连接失败')
    expect(wrapper.text()).not.toContain('HTTP 500')
    expect(wrapper.text()).not.toContain('raw-response-code')
  })

  it('does not request configuration when no active account UID is present', async () => {
    wrapper = await mountPage('')

    expect(getConfigBundle).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith('未识别当前 BOSS 账号，请重新打开个人信息')
    expect(wrapper.find('.profile-notice').exists()).toBe(false)
  })
})
