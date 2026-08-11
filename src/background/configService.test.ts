import { describe, expect, it, vi } from 'vitest'

import {
  CONFIG_LIMITS,
  DEFAULT_AI_FILTERING_PROMPT,
  createDefaultConfigBundle,
  createDefaultDeliverySettings,
  createDefaultStoredConfigState,
} from '@/config/defaults'
import { hashResumeMarkdown } from '@/config/import'
import {
  ConfigImportRunningError,
  ConfigMutationRunningError,
  ConfigValidationError,
  type StoredConfigStateV1,
} from '@/config/types'
import { RESUME_EVIDENCE_VERSION } from '@/profile/resumeExtraction'
import { jsonClone } from '@/utils/deepmerge'

import { ConfigService } from './configService'
import type { ConfigStateStorage } from './configStorage'

function memoryStorage(initial: StoredConfigStateV1 | null = null) {
  let value: StoredConfigStateV1 | null = initial == null ? null : jsonClone(initial)
  return {
    adapter: {
      read: vi.fn(async () => (value == null ? null : jsonClone(value))),
      write: vi.fn(async (state: StoredConfigStateV1) => {
        value = jsonClone(state)
      }),
    } satisfies ConfigStateStorage,
    readValue: () => (value == null ? null : jsonClone(value)),
  }
}

function configuredModel(): StoredConfigStateV1['models'][number] {
  return {
    id: 'configured-model',
    name: 'Configured Model',
    protocol: 'openai-responses',
    url: 'https://example.test/v1/responses',
    apiKey: 'secret',
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
  }
}

/** 0.9.55 发布过的匹配度提示词原文（职能闸门那一版），用来验证「没改过就升级」。 */
const LEGACY_BUILT_IN_FILTERING_PROMPT =
  '你要回答的问题是：这个人能不能做好这份工作。不是「简历里有没有写过 JD 里出现的每个词」。\n\n一、先看这是不是同一类工作\n职能不同就是不匹配，先判断这个，再谈能力。\n- 职能 = 这份工作主要产出什么：定义产品、做运营增长、写代码、做销售、做人事。候选人的职能看简历事实里的 role 和实际做过的事。\n- 职能不同不能靠可迁移能力补。一个做产品的人搭过内容矩阵、看过投放数据，不等于他要做运营总监；一个写过 SQL 的产品经理不是数据工程师。能力能迁到别的职能上去，不代表那就是他的职能。\n- 「职能不同」和「场景不同」是两回事，别混。产品换个行业做还是产品，不扣分；产品换成运营，那是另一份工作。\n\n二、读懂这份工作实际在做什么\n从职责描述里提炼出它真正要解决的问题、要具备的能力，而不是罗列 JD 出现过的名词。\n岗位标签、所属行业、公司介绍不是对候选人的要求，JD 正文没把它写成要求时不能当缺口。\n\n三、职能一致之后，用简历事实去覆盖这些能力，不要做逐条核对\n- 一条事实可以同时支撑多项要求。做成过一件事，往往同时说明了方法、判断力和协作方式；不要求事实和要求一一对应。\n- 场景不同不等于不匹配。同一套产品方法用在不同业务上是常态，判断的是「这套做法能不能用到这里」，不是「有没有在同一个行业干过」。行业知识多数是入职后补的。\n- 工具、平台、框架的具体名称不构成缺口——那些是几周能上手的东西。只有当某项能力需要长期积累的专门判断力，而简历里连相近的实践都找不到时，才算真正的缺口。\n\n四、给分，按能力覆盖的程度\n- 主体是覆盖度：这份工作的核心要做的事，简历事实能支撑多少。\n- 证据强度作调整：主导过 > 参与过 > 用过或了解过。\n- 学历、专业、年限这类形式条件权重最低。差一档只小幅扣分，绝不作为跳过的主要理由——招聘方会在面试里自己判断，而在读、非全日制、年限差一两年都不等于不能胜任。\n- 分档：85-100 strong，70-84 good，55-69 maybe，40-54 weak，0-39 reject。\n- 职能不同的，不高于 35，理由写明职能不符——这是最先判断的一条，不受下面几条影响。\n- 职能相同、方向相关但侧重不同的，不应低于 55。\n\n五、你不知道投递门槛在哪里，也不要去猜\n只给出「这个人能做好这份工作的程度」。理由里不要出现「达到/不达到投递门槛」「建议/不建议投递」这类话——是否投递由外部规则决定，不是你的判断范围。分数要反映真实差距，不要向任何特定数值靠拢。\n\n六、结论必须自洽\n每一条扣分都要能在 JD 里指出是哪一条要求。选中的简历事实不能在理由里被自己否认。\n岗位薪资覆盖或高于候选人期望不是风险，只有明确低于期望时才记为风险。\n\n七、理由保持简洁：说清楚能力覆盖在哪里、最大的实质差距是什么，并选出最适合后续招呼语使用的主事实。'

describe('ConfigService', () => {
  it('still serves a config that predates a newly required field', async () => {
    // 真机故障：greetingSegmentSeconds 加在 0.9.37，之前存过配置的账号一读就报
    // 「缺少必填字段」，面板起不来。加字段不能让老用户的扩展变砖，所以读取要先补默认值。
    const state = createDefaultStoredConfigState()
    const settings = createDefaultDeliverySettings()
    settings.delivery.timing.batchSize = 12
    delete (settings.delivery.timing as unknown as Record<string, unknown>).greetingSegmentSeconds
    state.accountSettings['account-a'] = settings
    const storage = memoryStorage(state)
    const service = new ConfigService(storage.adapter)

    const runtime = await service.getPublicRuntimeConfig('account-a')

    expect(runtime.formData.delay.greetingSegment).toBe(
      createDefaultDeliverySettings().delivery.timing.greetingSegmentSeconds,
    )
    // 补齐的同时不能把用户改过的值刷回默认。
    expect(runtime.formData.delay.batchSize).toBe(12)
  })

  it('把没改过的老版本匹配度提示词升级到当前默认', async () => {
    // 匹配度提示词在首次安装时就写进存储，而配置读取是「默认值打底、已存值覆盖」。
    // 靠 canonicalizeAiConfiguration 每次读取都把它刷回当前默认，这一版改的评分规则
    // 才到得了老用户；少了那一步，提示词会冻结在安装那一版。
    //
    // 直接覆盖是安全的：契约 §5.1 规定它由插件维护、不可编辑，saveAiTasks 的入参里
    // aiFiltering 也只收 enabled 和 score，没有用户内容会被冲掉。
    const state = createDefaultStoredConfigState()
    state.tasks.aiFiltering.prompt = LEGACY_BUILT_IN_FILTERING_PROMPT
    const service = new ConfigService(memoryStorage(state).adapter)

    const bundle = await service.getBundle('account-a')

    expect(bundle.tasks.aiFiltering.prompt).toBe(DEFAULT_AI_FILTERING_PROMPT)
  })

  it('returns only a public runtime projection to the BOSS page', async () => {
    const state = createDefaultStoredConfigState()
    state.profile.displayName = '私密姓名'
    state.profile.resume.markdown = '私密简历'
    state.models = [
      {
        id: 'private-model',
        name: '私密模型',
        protocol: 'openai-responses',
        url: 'https://api.example.test/v1/responses',
        apiKey: 'private-api-key',
        model: 'private-model-name',
        reasoningEffort: 'max',
        timeoutSeconds: 900,
        responsesBackground: 'auto',
        generation: {
          temperature: null,
          topP: null,
          presencePenalty: null,
          frequencyPenalty: null,
        },
      },
    ]
    const storage = memoryStorage(state)
    const service = new ConfigService(storage.adapter)

    const runtime = await service.getPublicRuntimeConfig('account-a')
    const serialized = JSON.stringify(runtime)

    expect(runtime.readiness.displayNameReady).toBe(true)
    expect(runtime.readiness.modelReady).toBe(true)
    expect(runtime.aiTaskTimeoutSeconds).toBe(900)
    for (const secret of ['私密姓名', '私密简历', 'private-api-key', 'private-model-name']) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('keeps global profile and models while switching account settings', async () => {
    const state = createDefaultStoredConfigState()
    state.profile.displayName = '全局姓名'
    const storage = memoryStorage(state)
    const service = new ConfigService(storage.adapter)
    const accountA = await service.getPublicRuntimeConfig('account-a')
    accountA.formData.customGreeting = { enable: true, value: '账号 A' }
    await service.savePublicRuntimeConfig('account-a', accountA.formData)
    const accountB = await service.getPublicRuntimeConfig('account-b')
    accountB.formData.customGreeting = { enable: true, value: '账号 B' }
    await service.savePublicRuntimeConfig('account-b', accountB.formData)

    const stored = storage.readValue()!
    expect(stored.profile.displayName).toBe('全局姓名')
    expect(stored.accountSettings['account-a'].delivery.customGreeting.value).toBe('账号 A')
    expect(stored.accountSettings['account-b'].delivery.customGreeting.value).toBe('账号 B')
  })

  it('applies an AI task edit from a newly discovered account on the first save', async () => {
    // savePublicRuntimeConfig 会挡住新账号带来的 AI 变更（见下一条用例），
    // 那是为了防止初始化时用默认值冲掉全局配置。用户主动编辑走独立 action，
    // 因此必须一次生效——否则表现为「开关点了没反应，再点一次才行」。
    const state = createDefaultStoredConfigState()
    state.models = [configuredModel()]
    state.tasks.aiFiltering.modelId = state.models[0].id
    state.tasks.aiFiltering.enabled = false
    state.tasks.aiFiltering.score = 60
    state.accountSettings['account-a'] = createDefaultDeliverySettings()
    const storage = memoryStorage(state)
    const service = new ConfigService(storage.adapter)

    await service.saveAiTasks({ aiFiltering: { enabled: true, score: 75 } })

    const stored = storage.readValue()!
    expect(stored.tasks.aiFiltering.enabled).toBe(true)
    expect(stored.tasks.aiFiltering.score).toBe(75)
    // 不得连带创建或修改任何账号配置。
    expect(Object.keys(stored.accountSettings)).toEqual(['account-a'])
  })

  it('refuses AI task edits while a delivery task is running', async () => {
    const state = createDefaultStoredConfigState()
    state.accountSettings['account-a'] = createDefaultDeliverySettings()
    const storage = memoryStorage(state)
    const service = new ConfigService(
      storage.adapter,
      undefined,
      undefined,
      () => true,
      () => true,
    )

    await expect(service.saveAiTasks({ aiFiltering: { enabled: true } })).rejects.toBeInstanceOf(
      ConfigMutationRunningError,
    )
  })

  it('allows disabling AI greeting while a delivery task is running', async () => {
    // 契约 §3 把这一项列为即时安全控制，运行中必须可用。
    const state = createDefaultStoredConfigState()
    state.models = [configuredModel()]
    state.profile.displayName = '林小舟'
    state.profile.resume = {
      markdown: '负责平台产品',
      sourceHash: await hashResumeMarkdown('负责平台产品'),
      evidenceVersion: 1,
      evidence: {
        facts: [],
        buckets: [],
        claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
      },
    }
    state.tasks.aiFiltering.modelId = state.models[0].id
    state.tasks.aiGreeting.modelId = state.models[0].id
    state.tasks.aiGreeting.enabled = true
    state.tasks.aiFiltering.enabled = true
    state.accountSettings['account-a'] = createDefaultDeliverySettings()
    const storage = memoryStorage(state)
    const service = new ConfigService(
      storage.adapter,
      undefined,
      undefined,
      () => true,
      () => true,
    )

    await service.disableAiGreeting()

    const stored = storage.readValue()!
    expect(stored.tasks.aiGreeting.enabled).toBe(false)
    // 只能改这一个字段，其余保持不变。
    expect(stored.tasks.aiFiltering.enabled).toBe(true)
  })

  it('does not let a newly discovered account overwrite global AI switches on bootstrap', async () => {
    const state = createDefaultStoredConfigState()
    state.models = [configuredModel()]
    state.tasks.aiFiltering.modelId = state.models[0].id
    state.tasks.aiGreeting.modelId = state.models[0].id
    state.tasks.aiFiltering.enabled = true
    state.tasks.aiGreeting.enabled = true
    state.accountSettings['account-a'] = createDefaultDeliverySettings()
    const storage = memoryStorage(state)
    const service = new ConfigService(storage.adapter)
    const accountB = await service.getPublicRuntimeConfig('account-b')
    accountB.formData.aiFiltering.enable = false
    accountB.formData.aiGreeting.enable = false

    await service.savePublicRuntimeConfig('account-b', accountB.formData)

    const stored = storage.readValue()!
    expect(stored.accountSettings).toHaveProperty('account-b')
    expect(stored.tasks.aiFiltering.enabled).toBe(true)
    expect(stored.tasks.aiGreeting.enabled).toBe(true)
  })

  it('never writes AI tasks through the account-level runtime save', async () => {
    // AI 任务是全局数据，只能由 saveAiTasks 写入。运行配置保存必须完全不碰它，
    // 否则新账号的初始化会把默认值当成用户意图写进全局配置。
    const state = createDefaultStoredConfigState()
    state.models = [configuredModel()]
    state.tasks.aiFiltering.modelId = state.models[0].id
    state.tasks.aiGreeting.modelId = state.models[0].id
    const storage = memoryStorage(state)
    const service = new ConfigService(storage.adapter)
    const runtime = await service.getPublicRuntimeConfig('account-a')
    runtime.formData.aiFiltering.enable = true
    runtime.formData.aiGreeting.enable = true

    await service.savePublicRuntimeConfig('account-a', runtime.formData)

    expect(storage.readValue()?.tasks.aiFiltering.enabled).toBe(false)
    expect(storage.readValue()?.tasks.aiGreeting.enabled).toBe(false)
  })

  it('exposes empty, failed and ready resume states without exposing resume text', async () => {
    const emptyState = createDefaultStoredConfigState()
    const errorState = createDefaultStoredConfigState()
    errorState.profile.resume.markdown = '尚未解析的简历'
    const readyState = createDefaultStoredConfigState()
    readyState.profile.resume = {
      markdown: '负责平台产品',
      sourceHash: await hashResumeMarkdown('负责平台产品'),
      evidenceVersion: 1,
      evidence: {
        facts: [],
        buckets: [],
        claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
      },
    }

    const empty = await new ConfigService(memoryStorage(emptyState).adapter).getPublicRuntimeConfig(
      'account-a',
    )
    const error = await new ConfigService(memoryStorage(errorState).adapter).getPublicRuntimeConfig(
      'account-a',
    )
    const ready = await new ConfigService(memoryStorage(readyState).adapter).getPublicRuntimeConfig(
      'account-a',
    )

    expect(empty.readiness.resumeStatus).toBe('empty')
    expect(error.readiness.resumeStatus).toBe('error')
    expect(ready.readiness.resumeStatus).toBe('ready')
    expect(JSON.stringify({ empty, error, ready })).not.toContain('尚未解析的简历')
    expect(JSON.stringify({ empty, error, ready })).not.toContain('负责平台产品')
  })

  it('preserves enabled expectation metadata through public runtime saves', async () => {
    const storage = memoryStorage()
    const service = new ConfigService(storage.adapter)
    const bundle = createDefaultConfigBundle()
    bundle.settings.jobRules.sources.expectationsInitialized = true
    bundle.settings.jobRules.sources.enabledExpectations = [
      {
        id: 'expect-1',
        positionName: 'AI 产品经理',
        locationName: '上海',
        salaryDesc: '30-50K',
      },
    ]
    await service.replaceBundle('account-a', bundle)

    const runtime = await service.getPublicRuntimeConfig('account-a')
    runtime.formData.customGreeting.value = '更新其他配置'
    await service.savePublicRuntimeConfig(
      'account-a',
      runtime.formData,
      runtime.enabledExpectations,
    )

    expect(
      (await service.getBundle('account-a')).settings.jobRules.sources.enabledExpectations,
    ).toEqual(bundle.settings.jobRules.sources.enabledExpectations)
  })

  it('keeps unavailable commute settings disabled across stored and imported config', async () => {
    const state = createDefaultStoredConfigState()
    state.accountSettings['account-a'] = createDefaultDeliverySettings()
    state.accountSettings['account-a'].commute.enabled = true
    const storage = memoryStorage(state)
    const service = new ConfigService(storage.adapter)

    expect((await service.getPublicRuntimeConfig('account-a')).formData.amap.enable).toBe(false)

    const bundle = createDefaultConfigBundle()
    bundle.settings.commute.enabled = true
    await service.replaceBundle('account-a', bundle)

    expect((await service.getBundle('account-a')).settings.commute.enabled).toBe(false)
    expect(storage.readValue()?.accountSettings['account-a'].commute.enabled).toBe(false)
  })

  it('saves AI configuration without overwriting newer account settings or profile data', async () => {
    const state = createDefaultStoredConfigState()
    state.profile.displayName = '保留姓名'
    state.accountSettings['account-a'] = createDefaultDeliverySettings()
    state.accountSettings['account-a'].delivery.customGreeting.value = '最新运行配置'
    state.tasks.aiFiltering.enabled = true
    state.tasks.aiFiltering.score = 72
    state.tasks.aiGreeting.enabled = true
    state.tasks.aiGreeting.messageCount = 5
    state.tasks.aiGreeting.prompt = '最新用户 Prompt'
    const staleBundle = createDefaultConfigBundle()
    staleBundle.settings.delivery.customGreeting.value = '旧页面快照'
    staleBundle.models = [
      {
        id: 'model-1',
        name: '新模型',
        protocol: 'openai-responses',
        url: 'https://api.example.test/v1/responses',
        apiKey: 'secret',
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
    staleBundle.tasks.resumeExtraction.modelId = 'model-1'
    staleBundle.tasks.aiFiltering.enabled = false
    staleBundle.tasks.aiFiltering.score = 60
    staleBundle.tasks.aiGreeting.enabled = false
    staleBundle.tasks.aiGreeting.messageCount = 3
    state.models = structuredClone(staleBundle.models)
    state.tasks.resumeExtraction.modelId = 'model-1'
    state.tasks.aiFiltering.modelId = 'model-1'
    state.tasks.aiGreeting.modelId = 'model-1'
    const storage = memoryStorage(state)
    const service = new ConfigService(storage.adapter)
    await service.saveAiConfiguration({ models: staleBundle.models })

    const stored = storage.readValue()!
    expect(stored.profile.displayName).toBe('保留姓名')
    expect(stored.accountSettings['account-a'].delivery.customGreeting.value).toBe('最新运行配置')
    expect(stored.models).toEqual(staleBundle.models)
    expect(stored.tasks).toMatchObject({
      resumeExtraction: { modelId: 'model-1' },
      aiFiltering: { enabled: true, modelId: 'model-1', score: 72 },
      aiGreeting: {
        enabled: true,
        modelId: 'model-1',
        messageCount: 5,
        prompt: '最新用户 Prompt',
      },
    })
  })

  it('collapses legacy multi-model state to the filtering model and binds every AI task', async () => {
    const state = createDefaultStoredConfigState()
    const bundle = createDefaultConfigBundle()
    const first = {
      id: 'model-first',
      name: 'First',
      protocol: 'openai-responses' as const,
      url: 'https://first.example.test/v1/responses',
      apiKey: 'first-key',
      model: 'first-model',
      reasoningEffort: 'high',
      timeoutSeconds: 180,
      responsesBackground: 'auto' as const,
      generation: {
        temperature: null,
        topP: null,
        presencePenalty: null,
        frequencyPenalty: null,
      },
    }
    const second = {
      ...first,
      id: 'model-filtering',
      name: 'Filtering',
      url: 'https://filtering.example.test/v1/responses',
      apiKey: 'filtering-key',
      model: 'filtering-model',
    }
    state.models = [first, second]
    state.tasks = bundle.tasks
    state.tasks.resumeExtraction.modelId = first.id
    state.tasks.aiFiltering.modelId = second.id
    state.tasks.aiGreeting.modelId = first.id
    state.tasks.aiFiltering.prompt = '不再允许覆盖的筛选规则'
    state.accountSettings['account-a'] = createDefaultDeliverySettings()
    const service = new ConfigService(memoryStorage(state).adapter)

    const result = await service.getBundle('account-a')

    expect(result.models).toEqual([second])
    expect(result.tasks.resumeExtraction.modelId).toBe(second.id)
    expect(result.tasks.aiFiltering.modelId).toBe(second.id)
    expect(result.tasks.aiGreeting.modelId).toBe(second.id)
    expect(result.tasks.aiFiltering.prompt).toBe(DEFAULT_AI_FILTERING_PROMPT)
  })

  it('persists greeting count, target length and prompt from runtime settings', async () => {
    const state = createDefaultStoredConfigState()
    state.accountSettings['account-a'] = createDefaultDeliverySettings()
    const storage = memoryStorage(state)
    const service = new ConfigService(storage.adapter)

    await service.saveAiTasks({
      aiGreeting: {
        enabled: false,
        messageCount: 4,
        targetTotalCharacters: 200,
        prompt: '保持自然、直接。',
      },
    })

    expect(storage.readValue()?.tasks.aiGreeting).toMatchObject({
      enabled: false,
      messageCount: 4,
      minTotalCharacters: 175,
      maxTotalCharacters: 225,
      prompt: '保持自然、直接。',
    })
  })

  it('rejects JSON import while the same account is actively delivering', async () => {
    const storage = memoryStorage()
    const service = new ConfigService(
      storage.adapter,
      '1.0.0',
      undefined,
      async () => true,
      async () => true,
    )
    const text = JSON.stringify(createDefaultConfigBundle())

    await expect(service.importJson('account-a', text, text.length)).rejects.toBeInstanceOf(
      ConfigImportRunningError,
    )
    expect(storage.adapter.write).not.toHaveBeenCalled()
  })

  it('allows only disabling AI greeting while any delivery task is active', async () => {
    const state = createDefaultStoredConfigState()
    state.models = [configuredModel()]
    state.tasks.aiGreeting.modelId = state.models[0].id
    state.tasks.aiGreeting.enabled = true
    state.accountSettings['account-a'] = createDefaultDeliverySettings()
    const storage = memoryStorage(state)
    const service = new ConfigService(
      storage.adapter,
      '1.0.0',
      undefined,
      async () => false,
      async () => true,
    )
    await service.disableAiGreeting()

    expect(storage.readValue()?.tasks.aiGreeting.enabled).toBe(false)
    expect(storage.adapter.write).toHaveBeenCalledTimes(1)
  })

  it('rejects every other runtime change while any delivery task is active', async () => {
    const state = createDefaultStoredConfigState()
    state.models = [configuredModel()]
    state.tasks.aiGreeting.modelId = state.models[0].id
    state.tasks.aiGreeting.enabled = true
    state.accountSettings['account-a'] = createDefaultDeliverySettings()
    const storage = memoryStorage(state)
    const service = new ConfigService(
      storage.adapter,
      '1.0.0',
      undefined,
      async () => false,
      async () => true,
    )
    const runtime = await service.getPublicRuntimeConfig('account-a')
    runtime.formData.customGreeting = { enable: true, value: '运行中不允许修改' }

    await expect(
      service.savePublicRuntimeConfig('account-a', runtime.formData),
    ).rejects.toBeInstanceOf(ConfigMutationRunningError)
    expect(storage.adapter.write).not.toHaveBeenCalled()
  })

  it('blocks global model, profile, import and reset mutations while any account is delivering', async () => {
    const state = createDefaultStoredConfigState()
    state.accountSettings['account-a'] = createDefaultDeliverySettings()
    const storage = memoryStorage(state)
    const service = new ConfigService(
      storage.adapter,
      '1.0.0',
      undefined,
      async () => false,
      async () => true,
    )
    const bundle = createDefaultConfigBundle()
    const text = JSON.stringify(bundle)

    await expect(
      service.saveAiConfiguration({ models: [configuredModel()] }),
    ).rejects.toBeInstanceOf(ConfigMutationRunningError)
    await expect(
      service.saveProfileDraft({ displayName: '候选人', markdown: '简历内容' }),
    ).rejects.toBeInstanceOf(ConfigMutationRunningError)
    await expect(
      service.commitProfileEvidence({ markdown: '简历内容', evidence: {} }),
    ).rejects.toBeInstanceOf(ConfigMutationRunningError)
    await expect(service.replaceBundle('account-b', bundle)).rejects.toBeInstanceOf(
      ConfigMutationRunningError,
    )
    await expect(service.importJson('account-b', text, text.length)).rejects.toBeInstanceOf(
      ConfigImportRunningError,
    )
    await expect(service.resetAll('account-b')).rejects.toBeInstanceOf(ConfigMutationRunningError)
    expect(storage.adapter.write).not.toHaveBeenCalled()
  })

  it('atomically overwrites false, zero, empty string and empty arrays on import', async () => {
    const storage = memoryStorage()
    const service = new ConfigService(storage.adapter, '1.0.0')
    const bundle = createDefaultConfigBundle()
    bundle.settings.jobRules.sources.searchEnabled = false
    bundle.settings.jobRules.sourceWeights = { search: 0, expectations: 100 }
    bundle.settings.jobRules.search.directions = []
    bundle.settings.commute.origin = ''

    await service.replaceBundle('account-a', bundle)
    const exported = await service.getBundle('account-a')

    expect(exported.settings.jobRules.sources.searchEnabled).toBe(false)
    expect(exported.settings.jobRules.sourceWeights.search).toBe(0)
    expect(exported.settings.jobRules.search.directions).toEqual([])
    expect(exported.settings.commute.origin).toBe('')
    expect(storage.adapter.write).toHaveBeenCalledTimes(1)
  })

  it('keeps the existing state untouched when import validation fails', async () => {
    const state = createDefaultStoredConfigState()
    state.profile.displayName = '保留值'
    const storage = memoryStorage(state)
    const service = new ConfigService(storage.adapter)
    const invalid = createDefaultConfigBundle()
    invalid.settings.jobRules.sourceWeights = { search: 20, expectations: 20 }

    await expect(service.replaceBundle('account-a', invalid)).rejects.toBeInstanceOf(
      ConfigValidationError,
    )
    expect(storage.adapter.write).not.toHaveBeenCalled()
    expect(storage.readValue()?.profile.displayName).toBe('保留值')
  })

  it('rejects an imported configuration with every job source disabled', async () => {
    const storage = memoryStorage(createDefaultStoredConfigState())
    const service = new ConfigService(storage.adapter)
    const invalid = createDefaultConfigBundle()
    invalid.settings.jobRules.sources.searchEnabled = false
    invalid.settings.jobRules.sources.recommendEnabled = false
    invalid.settings.jobRules.sources.enabledExpectations = []

    await expect(service.replaceBundle('account-a', invalid)).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          path: '$.settings.jobRules.sources',
          message: expect.stringContaining('至少需要开启一个岗位来源'),
        }),
      ],
    })
    expect(storage.adapter.write).not.toHaveBeenCalled()
  })

  it('discards stale imported evidence while preserving resume text', async () => {
    const storage = memoryStorage()
    const service = new ConfigService(storage.adapter)
    const bundle = createDefaultConfigBundle()
    bundle.profile.resume.markdown = '当前简历文本'
    bundle.profile.resume.sourceHash = `sha256:${'0'.repeat(64)}`
    bundle.profile.resume.evidence = {
      facts: [],
      buckets: [],
      claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
    }

    const result = await service.replaceBundle('account-a', bundle)
    const exported = await service.getBundle('account-a')

    expect(result.resumeEvidenceDiscarded).toBe(true)
    expect(exported.profile.resume.markdown).toBe('当前简历文本')
    expect(exported.profile.resume.sourceHash).toBeNull()
    expect(exported.profile.resume.evidence).toBeNull()
  })

  it('preserves valid resume evidence when its hash matches', async () => {
    const storage = memoryStorage()
    const service = new ConfigService(storage.adapter)
    const bundle = createDefaultConfigBundle()
    bundle.profile.resume.markdown = '事实摘录'
    bundle.profile.resume.sourceHash = await hashResumeMarkdown(bundle.profile.resume.markdown)
    bundle.profile.resume.evidence = {
      facts: [
        {
          id: 'fact-1',
          sourceQuote: '事实摘录',
          action: '完成',
          object: '项目',
          ownership: 'owned',
          domains: [],
          skills: [],
          evidenceType: 'direct_fact',
          allowedClaimVerbs: [],
          confidence: 'high',
        },
      ],
      buckets: [],
      claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
    }

    const result = await service.replaceBundle('account-a', bundle)
    const exported = await service.getBundle('account-a')
    expect(result.resumeEvidenceDiscarded).toBe(false)
    expect(exported.profile.resume.evidence?.facts).toHaveLength(1)
  })

  it('serializes concurrent mutations without losing either account', async () => {
    const storage = memoryStorage()
    const service = new ConfigService(storage.adapter)
    const a = await service.getPublicRuntimeConfig('account-a')
    const b = await service.getPublicRuntimeConfig('account-b')
    a.formData.customGreeting.value = 'A'
    b.formData.customGreeting.value = 'B'

    await Promise.all([
      service.savePublicRuntimeConfig('account-a', a.formData),
      service.savePublicRuntimeConfig('account-b', b.formData),
    ])

    expect(storage.readValue()?.accountSettings['account-a'].delivery.customGreeting.value).toBe(
      'A',
    )
    expect(storage.readValue()?.accountSettings['account-b'].delivery.customGreeting.value).toBe(
      'B',
    )
    expect(storage.readValue()?.configRevision).toBe(2)
  })

  it('resets globals and only the current account settings', async () => {
    const state = createDefaultStoredConfigState()
    state.profile.displayName = '待清空'
    const settings = createDefaultConfigBundle().settings
    settings.delivery.customGreeting.value = 'A'
    state.accountSettings['account-a'] = jsonClone(settings)
    settings.delivery.customGreeting.value = 'B'
    state.accountSettings['account-b'] = jsonClone(settings)
    const storage = memoryStorage(state)
    const service = new ConfigService(storage.adapter)

    await service.resetAll('account-a')

    const stored = storage.readValue()!
    expect(stored.profile.displayName).toBe('')
    expect(stored.accountSettings['account-a'].delivery.customGreeting.value).toBe('')
    expect(stored.accountSettings['account-b'].delivery.customGreeting.value).toBe('B')
  })

  it('saves, validates and reuses extracted resume evidence', async () => {
    const storage = memoryStorage(createDefaultStoredConfigState())
    const service = new ConfigService(storage.adapter, '1.0.0')
    const evidence = {
      facts: [
        {
          id: 'fact-1',
          sourceQuote: '负责平台产品',
          action: '负责',
          object: '平台产品',
          ownership: 'owned' as const,
          domains: ['企业服务'],
          skills: ['产品规划'],
          evidenceType: 'direct_fact' as const,
          allowedClaimVerbs: ['负责'],
          confidence: 'high' as const,
        },
      ],
      buckets: [],
      claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
    }

    const draft = await service.saveProfileDraft({
      displayName: '候选人',
      markdown: '负责平台产品',
    })
    const first = await service.commitProfileEvidence({
      markdown: '负责平台产品',
      evidence,
    })
    const second = await service.saveProfileDraft({
      displayName: '候选人',
      markdown: '负责平台产品',
    })

    expect(draft).toMatchObject({ status: 'pending', reused: false, factCount: 0 })
    expect(first).toMatchObject({ status: 'ready', reused: false, factCount: 1 })
    expect(second).toMatchObject({ status: 'ready', reused: true, factCount: 1 })
    expect(storage.readValue()?.profile.resume.sourceHash).toMatch(/^sha256:/)
    expect(storage.readValue()?.profile.resume.evidence?.facts).toHaveLength(1)
  })

  it('keeps new resume text and invalidates old evidence while page-side extraction is pending', async () => {
    const state = createDefaultStoredConfigState()
    state.profile.resume = {
      markdown: '旧简历',
      sourceHash: await hashResumeMarkdown('旧简历'),
      evidenceVersion: 1,
      evidence: {
        facts: [],
        buckets: [],
        claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
      },
    }
    const storage = memoryStorage(state)
    const service = new ConfigService(storage.adapter, '1.0.0')

    await expect(
      service.saveProfileDraft({ displayName: '候选人', markdown: '新简历' }),
    ).resolves.toMatchObject({ status: 'pending' })

    expect(storage.readValue()?.profile.resume).toEqual({
      markdown: '新简历',
      sourceHash: null,
      evidenceVersion: RESUME_EVIDENCE_VERSION,
      evidence: null,
    })
  })

  it('commits page-side evidence only when the saved resume text is unchanged', async () => {
    const storage = memoryStorage(createDefaultStoredConfigState())
    const service = new ConfigService(storage.adapter, '1.0.0')
    const evidence = {
      facts: [
        {
          id: 'fact-1',
          sourceQuote: '负责平台产品',
          action: '负责',
          object: '平台产品',
          ownership: 'owned' as const,
          domains: ['企业服务'],
          skills: ['产品规划'],
          evidenceType: 'direct_fact' as const,
          allowedClaimVerbs: ['负责'],
          confidence: 'high' as const,
        },
      ],
      buckets: [],
      claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
    }

    await expect(
      service.saveProfileDraft({ displayName: '候选人', markdown: '负责平台产品' }),
    ).resolves.toMatchObject({ status: 'pending', factCount: 0 })
    await expect(
      service.commitProfileEvidence({ markdown: '负责平台产品', evidence }),
    ).resolves.toMatchObject({ status: 'ready', factCount: 1 })

    await service.saveProfileDraft({ displayName: '候选人', markdown: '更新后的简历' })
    await expect(
      service.commitProfileEvidence({ markdown: '负责平台产品', evidence }),
    ).rejects.toThrow('简历内容已更新，本次解析结果已丢弃')
    expect(storage.readValue()?.profile.resume).toMatchObject({
      markdown: '更新后的简历',
      sourceHash: null,
      evidence: null,
    })
  })

  it('rejects page-side evidence that cannot be quoted from the saved resume', async () => {
    const storage = memoryStorage(createDefaultStoredConfigState())
    const service = new ConfigService(storage.adapter, '1.0.0')
    await service.saveProfileDraft({ displayName: '候选人', markdown: '真实简历内容' })

    await expect(
      service.commitProfileEvidence({
        markdown: '真实简历内容',
        evidence: {
          facts: [
            {
              id: 'fact-1',
              sourceQuote: '不存在的摘录',
              action: '负责',
              object: '平台产品',
              ownership: 'owned',
              domains: [],
              skills: [],
              evidenceType: 'direct_fact',
              allowedClaimVerbs: [],
              confidence: 'high',
            },
          ],
          buckets: [],
          claimPolicy: { adjacentOnly: [], forbiddenClaims: [] },
        },
      }),
    ).rejects.toBeInstanceOf(ConfigValidationError)
    expect(storage.readValue()?.profile.resume.evidence).toBeNull()
  })

  it('rejects over-limit profile fields before writing them', async () => {
    const storage = memoryStorage(createDefaultStoredConfigState())
    const service = new ConfigService(storage.adapter, '1.0.0')

    await expect(
      service.saveProfileDraft({
        displayName: 'x'.repeat(CONFIG_LIMITS.displayNameCharacters + 1),
        markdown: '',
      }),
    ).rejects.toBeInstanceOf(ConfigValidationError)
    await expect(
      service.saveProfileDraft({
        displayName: '',
        markdown: 'x'.repeat(CONFIG_LIMITS.resumeCharacters + 1),
      }),
    ).rejects.toBeInstanceOf(ConfigValidationError)

    expect(storage.adapter.write).not.toHaveBeenCalled()
  })

  it('rejects an empty or whitespace-only resume before writing it', async () => {
    const storage = memoryStorage(createDefaultStoredConfigState())
    const service = new ConfigService(storage.adapter, '1.0.0')

    await expect(
      service.saveProfileDraft({ displayName: '候选人', markdown: '' }),
    ).rejects.toBeInstanceOf(ConfigValidationError)
    await expect(
      service.saveProfileDraft({ displayName: '候选人', markdown: '  \n ' }),
    ).rejects.toBeInstanceOf(ConfigValidationError)

    expect(storage.adapter.write).not.toHaveBeenCalled()
  })
})
