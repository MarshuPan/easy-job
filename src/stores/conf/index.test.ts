import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LEGACY_DEFAULT_AI_GREETING_PROMPT,
  LEGACY_DEFAULT_AI_GREETING_PROMPT_WITH_SYSTEM_RULES,
} from '@/config/legacyGreetingPrompts.fixture'

const {
  accountState,
  changeUser,
  configRuntime,
  configRuntimeSave,
  revisionListenerState,
  storageGet,
  storageSet,
  userIdState,
} = vi.hoisted(() => ({
  accountState: vi.fn(),
  changeUser: vi.fn(async () => undefined),
  configRuntime: vi.fn(),
  configRuntimeSave: vi.fn(),
  revisionListenerState: {
    value: undefined as ((configRevision: number) => void) | undefined,
  },
  storageGet: vi.fn(async (_key: string, fallback?: unknown) => fallback),
  storageSet: vi.fn(async () => true),
  userIdState: { value: 'account-a' as string | null },
}))

vi.mock('@/message', () => ({
  counter: {
    accountState,
    configRuntime,
    configRuntimeSave,
    storageGet,
    storageRm: vi.fn(async () => true),
    storageSet,
  },
  onConfigRevisionChanged: vi.fn((listener: (configRevision: number) => void) => {
    revisionListenerState.value = listener
    return vi.fn()
  }),
}))

vi.mock('@/stores/user', () => ({
  useUser: () => ({
    changeUser,
    getUserId: vi.fn(() => userIdState.value),
  }),
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('@/ui/instrument', () => ({
  AgentMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}))

import {
  DEFAULT_AI_GREETING_PROMPT,
  DEFAULT_JOB_CONTENT_EXCLUSIONS,
  DEFAULT_SEARCH_CITY,
  DEFAULT_SEARCH_DIRECTIONS,
  DEFAULT_SEARCH_SALARY,
} from '@/config/defaults'
import deepmerge, { jsonClone } from '@/utils/deepmerge'

import { defaultFormData, useConf } from './index'

const pristineDefaults = jsonClone(defaultFormData)

/**
 * 仓库里两种 store 形态并存：useLog 是普通函数、返回裸 Ref（读要带 .value），
 * useConf/useStatistics 是 pinia setup store、返回 unwrap 后的 reactive（不带 .value）。
 * R1 那个长期存活的缺陷正踩在这个不一致上，因此把形状钉死。
 */
describe('conf store shape contract', () => {
  it('exposes formData as a plain reactive object, not a ref', () => {
    setActivePinia(createPinia())
    const conf = useConf()
    expect(conf.formData).not.toHaveProperty('value')
    expect(conf.formData).toHaveProperty('aiGreeting')
    expect(conf.formData).toHaveProperty('deliveryLimit')
  })

  it('exposes availableJobExpectations as an array, not a ref', () => {
    setActivePinia(createPinia())
    expect(Array.isArray(useConf().availableJobExpectations)).toBe(true)
  })
})

describe('configuration commands', () => {
  beforeEach(() => {
    deepmerge(defaultFormData, jsonClone(pristineDefaults), { clone: false })
    setActivePinia(createPinia())
    vi.clearAllMocks()
    userIdState.value = 'account-a'
    revisionListenerState.value = undefined
    accountState.mockResolvedValue(null)
    storageGet.mockImplementation(async (_key: string, fallback?: unknown) => fallback)
    configRuntime.mockResolvedValue({
      accountInitialized: false,
      enabledExpectations: [],
      formData: {},
      readiness: {
        configRevision: 0,
        modelReady: false,
        resumeReady: false,
        aiFilteringReady: true,
        aiGreetingReady: true,
      },
    })
    configRuntimeSave.mockResolvedValue({
      configRevision: 1,
      modelReady: false,
      resumeReady: false,
      aiFilteringReady: true,
      aiGreetingReady: true,
    })
  })

  afterEach(() => {
    deepmerge(defaultFormData, jsonClone(pristineDefaults), { clone: false })
  })

  it('defaults AI filtering to the approved 60-point delivery gate', () => {
    expect(defaultFormData.aiFiltering.score).toBe(60)
  })

  it('loads the product-manager search preset for a first-run account', async () => {
    const conf = useConf()

    await conf.confInit()

    expect(conf.formData.searchConditions).toMatchObject({
      directions: [...DEFAULT_SEARCH_DIRECTIONS],
      city: DEFAULT_SEARCH_CITY,
      salary: DEFAULT_SEARCH_SALARY,
    })
    expect(configRuntimeSave).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({
        searchConditions: expect.objectContaining({
          directions: [...DEFAULT_SEARCH_DIRECTIONS],
          city: DEFAULT_SEARCH_CITY,
          salary: DEFAULT_SEARCH_SALARY,
        }),
      }),
      [],
    )
  })

  it('repairs the legacy all-empty canonical search preset once', async () => {
    configRuntime.mockResolvedValueOnce({
      accountInitialized: true,
      aiTaskTimeoutSeconds: 180,
      enabledExpectations: [],
      formData: {
        userId: 'account-a',
        searchConditions: {
          directions: [],
          city: '',
          businessDistricts: [],
          salary: '',
          experience: [],
          degree: [],
          jobType: [],
        },
      },
      readiness: {
        configRevision: 5,
        modelReady: true,
        resumeReady: true,
        aiFilteringReady: true,
        aiGreetingReady: true,
      },
    })
    const conf = useConf()

    await conf.confInit()

    expect(conf.formData.searchConditions).toMatchObject({
      directions: [...DEFAULT_SEARCH_DIRECTIONS],
      city: DEFAULT_SEARCH_CITY,
      salary: DEFAULT_SEARCH_SALARY,
    })
    expect(configRuntimeSave).toHaveBeenCalledOnce()
    expect(storageSet).toHaveBeenCalledWith(
      'local:agent-delivery-default-search-preset-v1:account-a',
      true,
    )
  })

  it('preserves an intentionally cleared search preset after migration', async () => {
    storageGet.mockImplementation(async (key: string, fallback?: unknown) =>
      key === 'local:agent-delivery-default-search-preset-v1:account-a' ? true : fallback,
    )
    configRuntime.mockResolvedValueOnce({
      accountInitialized: true,
      aiTaskTimeoutSeconds: 180,
      enabledExpectations: [],
      formData: {
        userId: 'account-a',
        searchConditions: {
          directions: [],
          city: '',
          businessDistricts: [],
          salary: '',
          experience: [],
          degree: [],
          jobType: [],
        },
      },
      readiness: {
        configRevision: 5,
        modelReady: true,
        resumeReady: true,
        aiFilteringReady: true,
        aiGreetingReady: true,
      },
    })
    const conf = useConf()

    await conf.confInit()

    expect(conf.formData.searchConditions).toMatchObject({
      directions: [],
      city: '',
      salary: '',
    })
    expect(configRuntimeSave).not.toHaveBeenCalled()
  })

  it('persists in-place edits through the canonical background service', async () => {
    const conf = useConf()
    conf.formData.jobSources.searchEnabled = false
    conf.formData.customGreeting.value = '尚未保存的其他页面草稿'

    await expect(conf.confPersist()).resolves.toBe(true)

    expect(configRuntimeSave).toHaveBeenCalledOnce()
    expect(configRuntimeSave).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({
        customGreeting: expect.objectContaining({ value: '尚未保存的其他页面草稿' }),
        jobSources: expect.objectContaining({ searchEnabled: false }),
      }),
      [],
    )
  })

  it('captures the account and form snapshot when a save is requested', async () => {
    const conf = useConf()
    conf.formData.jobSources.searchEnabled = false

    const saving = conf.confPersist()
    userIdState.value = 'account-b'
    conf.formData.jobSources.searchEnabled = true

    await expect(saving).resolves.toBe(true)
    expect(configRuntimeSave).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({
        jobSources: expect.objectContaining({ searchEnabled: false }),
      }),
      [],
    )
    expect(conf.readiness).toBeNull()
  })

  it('does not let its own revision broadcast overwrite a newer local edit', async () => {
    configRuntime.mockResolvedValueOnce({
      accountInitialized: true,
      enabledExpectations: [],
      formData: {
        userId: 'account-a',
        jobSources: {
          searchEnabled: true,
          recommendEnabled: true,
          enabledExpectIds: [],
          expectationsInitialized: true,
        },
      },
      readiness: {
        configRevision: 1,
        modelReady: true,
        resumeReady: true,
        aiFilteringReady: true,
        aiGreetingReady: true,
      },
    })
    const conf = useConf()
    await conf.confInit()
    configRuntime.mockClear()

    let resolveSave!: (value: {
      configRevision: number
      modelReady: boolean
      resumeReady: boolean
      aiFilteringReady: boolean
      aiGreetingReady: boolean
    }) => void
    configRuntimeSave.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSave = resolve)),
    )
    conf.formData.jobSources.searchEnabled = false
    const saving = conf.confPersist()
    await vi.waitFor(() => expect(configRuntimeSave).toHaveBeenCalledOnce())

    conf.formData.jobSources.searchEnabled = true
    revisionListenerState.value?.(2)
    resolveSave({
      configRevision: 2,
      modelReady: true,
      resumeReady: true,
      aiFilteringReady: true,
      aiGreetingReady: true,
    })
    await saving
    await Promise.resolve()

    expect(configRuntime).not.toHaveBeenCalled()
    expect(conf.formData.jobSources.searchEnabled).toBe(true)
  })

  it('sends structured-cloneable expectation snapshots during bootstrap and persistence', async () => {
    const conf = useConf()
    const expectations = [
      {
        id: 'expect-1',
        positionName: 'AI 产品经理',
        locationName: '上海',
        salaryDesc: '20-30K',
      },
    ]
    conf.setAvailableJobExpectations(expectations)

    await conf.confInit()
    await conf.confPersist()

    expect(configRuntimeSave).toHaveBeenCalledTimes(2)
    for (const call of configRuntimeSave.mock.calls) {
      expect(() => structuredClone(call)).not.toThrow()
      expect(call[2]).toEqual(expectations)
    }
  })

  it('loads an initialized canonical account without reading legacy form storage', async () => {
    configRuntime.mockResolvedValueOnce({
      accountInitialized: true,
      enabledExpectations: [],
      formData: {
        userId: 'account-a',
        useCache: { value: true },
        aiFiltering: { enable: false, score: 80 },
      },
      readiness: {
        configRevision: 5,
        modelReady: true,
        resumeReady: true,
        aiFilteringReady: true,
        aiGreetingReady: true,
      },
    })
    const conf = useConf()

    await conf.confInit()

    expect(conf.formData.useCache.value).toBe(true)
    expect(conf.formData.aiFiltering.score).toBe(80)
    expect(conf.readiness?.configRevision).toBe(5)
    expect(storageGet).not.toHaveBeenCalled()
    expect(configRuntimeSave).not.toHaveBeenCalled()
  })

  it('migrates legacy source settings to search-on without inventing expectation ids', async () => {
    storageGet.mockResolvedValueOnce({
      version: '20260707',
      deliveryLimit: { search: 60, group: 40 },
    })
    const conf = useConf()

    await conf.confInit()

    expect(conf.formData.jobSources).toEqual({
      searchEnabled: true,
      recommendEnabled: true,
      enabledExpectIds: [],
      expectationsInitialized: false,
    })
  })

  it('preserves the legacy work-content include mode while migrating search settings', async () => {
    storageGet.mockResolvedValueOnce({
      version: '20260721',
      jobContent: {
        enable: true,
        include: true,
        value: ['Agent'],
        options: ['Agent'],
      },
    })
    const conf = useConf()

    await conf.confInit()

    expect(conf.formData.jobContent.include).toBe(true)
    expect(conf.formData.jobContent.value).toEqual(['Agent'])
  })

  it('replaces a legacy complete greeting template with the approved user preference prompt', async () => {
    storageGet.mockResolvedValueOnce({
      version: '20260721',
      aiGreeting: {
        enable: true,
        prompt: '请根据 {{ resume }}、{{ jd }} 和 {{ bossName }} 生成完整招呼语。',
      },
    })
    const conf = useConf()

    await conf.confInit()

    expect(conf.formData.aiGreeting.prompt).toBe(pristineDefaults.aiGreeting.prompt)
    expect(conf.formData.aiGreeting.prompt).not.toContain('{{')
  })

  it('migrates a historical built-in greeting prompt before the first canonical save', async () => {
    storageGet.mockResolvedValueOnce({
      version: '20260721',
      aiGreeting: {
        enable: true,
        prompt: LEGACY_DEFAULT_AI_GREETING_PROMPT,
      },
    })
    const conf = useConf()

    await conf.confInit()

    expect(conf.formData.aiGreeting.prompt).toBe(DEFAULT_AI_GREETING_PROMPT)
    expect(configRuntimeSave).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({
        aiGreeting: expect.objectContaining({ prompt: DEFAULT_AI_GREETING_PROMPT }),
      }),
      [],
    )
  })

  it('removes system rules from the previous built-in user prompt during upgrade', async () => {
    storageGet.mockResolvedValueOnce({
      version: '20260723',
      aiGreeting: {
        enable: true,
        prompt: LEGACY_DEFAULT_AI_GREETING_PROMPT_WITH_SYSTEM_RULES,
      },
    })
    const conf = useConf()

    await conf.confInit()

    expect(conf.formData.aiGreeting.prompt).toBe(DEFAULT_AI_GREETING_PROMPT)
    expect(conf.formData.aiGreeting.prompt).not.toContain('claimMode')
    expect(configRuntimeSave).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({
        aiGreeting: expect.objectContaining({ prompt: DEFAULT_AI_GREETING_PROMPT }),
      }),
      [],
    )
  })

  it('preserves a customized greeting prompt during the first canonical save', async () => {
    storageGet.mockResolvedValueOnce({
      version: '20260721',
      aiGreeting: {
        enable: true,
        prompt: '用简洁、自然的语气说明岗位价值。',
      },
    })
    const conf = useConf()

    await conf.confInit()

    expect(conf.formData.aiGreeting.prompt).toBe('用简洁、自然的语气说明岗位价值。')
    expect(configRuntimeSave).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({
        aiGreeting: expect.objectContaining({ prompt: '用简洁、自然的语气说明岗位价值。' }),
      }),
      [],
    )
  })

  it('normalizes persisted expectation ids without changing the two source weights', async () => {
    storageGet.mockResolvedValueOnce({
      version: '20260721',
      deliveryLimit: { search: 55, group: 45 },
      jobSources: {
        searchEnabled: false,
        recommendEnabled: false,
        enabledExpectIds: [101, '202', '202', '', null],
        expectationsInitialized: true,
      },
    })
    const conf = useConf()

    await conf.confInit()

    expect(conf.formData.jobSources).toEqual({
      searchEnabled: false,
      recommendEnabled: false,
      enabledExpectIds: ['101', '202'],
      expectationsInitialized: true,
    })
    expect(conf.formData.deliveryLimit).toEqual({ search: 55, group: 45 })
  })

  it.each([0, 10, 100])('preserves an exact valid persisted AI threshold of %s', async (score) => {
    storageGet.mockResolvedValueOnce({
      version: '20260609',
      aiFiltering: { enable: true, score },
    })
    const conf = useConf()

    await conf.confInit()

    expect(conf.formData.aiFiltering.score).toBe(score)
  })

  it('applies recommended values to the existing reactive form object', () => {
    const conf = useConf()
    const formReference = conf.formData
    conf.formData.deliveryLimit = { search: 1, group: 1 }
    conf.formData.useCache = { value: true }

    conf.confRecommend()

    expect(conf.formData).toBe(formReference)
    expect(conf.formData.deliveryLimit).toEqual({ search: 50, group: 50 })
    expect(conf.formData.useCache.value).toBe(false)
  })

  it('clears edited values without replacing the reactive form object', () => {
    const conf = useConf()
    const formReference = conf.formData
    conf.formData.useCache.value = true
    conf.formData.jobContent.value = ['测试关键词']
    conf.formData.jobContent.enable = true

    conf.confDelete()

    expect(conf.formData).toBe(formReference)
    expect(conf.formData.useCache.value).toBe(false)
    expect(conf.formData.jobContent.value).toEqual([...DEFAULT_JOB_CONTENT_EXCLUSIONS])
    expect(conf.formData.jobContent.enable).toBe(false)
  })

  it('restores account B snapshot instead of defaults while account B is active', async () => {
    userIdState.value = 'account-b'
    storageGet.mockResolvedValueOnce({
      userId: 'account-a',
      useCache: { value: true },
    })
    accountState.mockResolvedValueOnce({
      uid: 'account-b',
      metadata: {
        user: '账号 B',
        avatar: '',
        remark: '',
        gender: 'man',
        flag: 'staff',
        date: '2026-07-10',
      },
      form: {
        userId: 'account-b',
        useCache: { value: true },
      },
      statistics: '{"t":{"date":"2026-07-10"},"s":[]}',
    })
    const conf = useConf()

    await conf.confInit()

    expect(accountState).toHaveBeenCalledWith('account-b')
    expect(changeUser).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'account-b',
        form: expect.objectContaining({ userId: 'account-b' }),
        statistics: '{"t":{"date":"2026-07-10"},"s":[]}',
      }),
      { saveCurrent: false },
    )
    expect(conf.formData.userId).toBe('account-b')
    expect(conf.formData.useCache.value).toBe(true)
  })

  it('repairs a corrupt persisted root and falls back to defaults', async () => {
    storageGet.mockResolvedValueOnce(null)
    const conf = useConf()

    await expect(conf.confInit()).resolves.toBeUndefined()

    expect(conf.formData.useCache.value).toBe(false)
    expect(storageSet).toHaveBeenCalledWith('local:web-geek-job-FormData', {})
  })
})
