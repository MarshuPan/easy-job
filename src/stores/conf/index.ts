import { watchThrottled } from '@vueuse/core'
import { defineStore } from 'pinia'
import { reactive, ref, toRaw } from 'vue'

import type { PublicConfigReadiness } from '@/background/configService'
import { GREETING_TARGET_MAX, GREETING_TARGET_MIN } from '@/config/greetingLength'
import type { JobExpectationConfig } from '@/config/types'
import { migrateAiGreetingUserPrompt } from '@/config/userPrompt'
import { counter, onConfigRevisionChanged } from '@/message'
import { useLog } from '@/stores/log'
import { useUser } from '@/stores/user'
import type { FormData } from '@/types/formData'
import { AgentMessage } from '@/ui/instrument'
import deepmerge, { isPlainObject, jsonClone } from '@/utils/deepmerge'
import { logger } from '@/utils/logger'
import { normalizeSearchConditions } from '@/utils/searchConditions'

import { defaultFormData } from './info'

export * from './info'

export const formDataKey = 'local:web-geek-job-FormData'
const defaultSearchPresetMigrationVersion = 'v1'

export const useConf = defineStore('conf', () => {
  const formData: FormData = reactive(jsonClone(defaultFormData))
  const isLoaded = ref(false)
  const readiness = ref<PublicConfigReadiness | null>(null)
  const aiTaskTimeoutSeconds = ref(180)
  const availableJobExpectations = ref<JobExpectationConfig[]>([])
  let persistQueue: Promise<void> = Promise.resolve()
  let runtimeRefreshQueue: Promise<void> = Promise.resolve()
  let pendingPersistRequests = 0
  let deferredConfigRevision: number | undefined
  let stopRevisionSubscription: (() => void) | undefined

  const FROM_VERSION: [string, (from: Partial<FormData>) => Partial<FormData>][] = [
    [
      '20250826',
      (from) => {
        if (from.companySizeRange && typeof from.companySizeRange.value === 'string') {
          const [min, max] = (from.companySizeRange.value as string).split('-').map(Number)
          from.companySizeRange.value = [min, max, false]
        }
        return from
      },
    ],
    [
      '20260608',
      (from) => {
        const deliveryLimit = from.deliveryLimit as
          | Partial<FormData['deliveryLimit']>
          | { value?: number }
          | undefined
        if (deliveryLimit && 'value' in deliveryLimit) {
          from.deliveryLimit = {
            search: Number(deliveryLimit.value) || defaultFormData.deliveryLimit.search,
            group: defaultFormData.deliveryLimit.group,
          }
        }
        return from
      },
    ],
    [
      '20260609',
      (from) => {
        from.delay ??= { ...defaultFormData.delay }
        if ((from.delay.deliveryInterval ?? 0) < 30) {
          from.delay.deliveryInterval = 30
        }
        if (
          from.delay.deliveryIntervalMax == null ||
          from.delay.deliveryIntervalMax < from.delay.deliveryInterval
        ) {
          from.delay.deliveryIntervalMax = 60
        }
        from.delay.batchSize ??= 30
        from.delay.batchRestMinutes ??= 10
        return from
      },
    ],
    [
      '20260610',
      (from) => {
        if (from.aiFiltering) {
          const score = Number(from.aiFiltering.score)
          if (!Number.isInteger(score) || score < 0 || score > 100) {
            from.aiFiltering.score = defaultFormData.aiFiltering.score
          }
        }
        return from
      },
    ],
    [
      '20260611',
      (from) => {
        from.delay ??= { ...defaultFormData.delay }
        if ((from.delay.messageSending ?? 0) < 20) {
          from.delay.messageSending = 20
        }
        return from
      },
    ],
    [
      '20260707',
      (from) => {
        const deliveryLimit = from.deliveryLimit
        if (deliveryLimit == null) return from
        const search = Number(deliveryLimit.search)
        const group = Number(deliveryLimit.group)
        if (
          !Number.isFinite(search) ||
          !Number.isFinite(group) ||
          search < 0 ||
          group < 0 ||
          search > 100 ||
          group > 100 ||
          search + group <= 0
        ) {
          from.deliveryLimit = { ...defaultFormData.deliveryLimit }
        }
        return from
      },
    ],
    [
      '20260721',
      (from) => {
        from.jobSources = normalizeJobSources(from.jobSources)
        return from
      },
    ],
    [
      '20260722',
      (from) => {
        // jobTitle 这个过滤器已经移除，但老配置里可能还留着关键词。它们原本就被
        // 当作搜索方向的来源，这条迁移继续把它们搬过去，搬完由 backfill 清掉字段。
        const legacyJobTitle = (from as Record<string, unknown>).jobTitle
        const legacyJobTitles =
          isPlainObject(legacyJobTitle) && Array.isArray(legacyJobTitle.value)
            ? (legacyJobTitle.value as string[])
            : []
        if (isPlainObject(from.searchConditions) || legacyJobTitles.length > 0) {
          from.searchConditions = normalizeSearchConditions(from.searchConditions, {
            legacyJobTitles,
          })
        }
        return from
      },
    ],
    [
      '20260723',
      (from) => {
        normalizePageGreeting(from)
        return from
      },
    ],
  ]

  async function formDataHandler(from: Partial<FormData>): Promise<Partial<FormData>> {
    try {
      stripPageAiLegacyFields(from)
      for (const [version, fn] of FROM_VERSION) {
        if ((from?.version ?? '20240401') >= version) continue
        from = fn(from)
        from.version = version
      }
      from.jobSources = normalizeJobSources(from.jobSources)
      if (isPlainObject(from.searchConditions)) {
        from.searchConditions = normalizeSearchConditions(from.searchConditions)
      }
      normalizePageGreeting(from)
      stripPageAiLegacyFields(from)
      const user = useUser()
      const uid = user.getUserId()
      // eslint-disable-next-line eqeqeq
      if (uid != null && from.userId != null && from.userId != uid) {
        logger.warn('检测到持久配置属于其他账号，正在恢复当前账号快照', {
          currentUid: uid,
          persistedUid: from.userId,
        })
        try {
          const account = await counter.accountState(String(uid))
          if (account?.form) {
            const accountForm = jsonClone(account.form) as Partial<FormData>
            accountForm.userId = uid
            const restoredForm: Partial<FormData> = await formDataHandler(accountForm)
            await user.changeUser(
              {
                uid: account.uid,
                ...account.metadata,
                form: restoredForm as FormData,
                statistics: account.statistics,
              },
              { saveCurrent: false },
            )
            AgentMessage.warning('检测到其他账号配置，已恢复当前账号快照')
            return restoredForm
          }
        } catch (err) {
          logger.error('恢复当前账号配置快照失败', err)
        }
        AgentMessage.warning('检测到其他账号配置，当前账号没有可恢复快照，已使用默认配置')
        return { userId: uid }
      } else if (uid != null && from.userId == null) {
        from.userId = uid
      }
    } catch (err) {
      logger.error('用户配置初始化失败', err)
      AgentMessage.error('配置初始化失败，请重新加载扩展')
    }
    return from
  }

  async function readPersistedFormData(): Promise<Partial<FormData>> {
    const stored = await counter.storageGet<unknown>(formDataKey, {})
    if (isPlainObject(stored)) return stored as Partial<FormData>

    logger.warn('持久配置格式损坏，已清理并回退默认配置', { stored })
    await counter.storageSet(formDataKey, {})
    return {}
  }

  function defaultSearchPresetMigrationKey(uid: string) {
    return `local:agent-delivery-default-search-preset-${defaultSearchPresetMigrationVersion}:${uid}`
  }

  function isEmptySearchPreset(value: unknown) {
    if (!isPlainObject(value)) return false
    const normalized = normalizeSearchConditions(value)
    return (
      normalized.directions.length === 0 &&
      normalized.city === '' &&
      normalized.salary === '' &&
      normalized.experience.length === 0 &&
      normalized.degree.length === 0 &&
      normalized.jobType.length === 0
    )
  }

  async function markDefaultSearchPresetMigrated(uid: string) {
    try {
      await counter.storageSet(defaultSearchPresetMigrationKey(uid), true)
    } catch (error) {
      logger.warn('记录默认搜索配置迁移状态失败', { error })
    }
  }

  async function repairLegacyEmptySearchPreset(
    uid: string,
    from: Partial<FormData>,
  ): Promise<Partial<FormData>> {
    if (!isEmptySearchPreset(from.searchConditions)) return from

    const migrationKey = defaultSearchPresetMigrationKey(uid)
    const alreadyMigrated = await counter.storageGet<boolean>(migrationKey, false)
    if (alreadyMigrated) return from

    const repaired = jsonClone(from)
    repaired.searchConditions = jsonClone(defaultFormData.searchConditions)
    readiness.value = await counter.configRuntimeSave(
      uid,
      repaired,
      jsonClone(availableJobExpectations.value),
    )
    await markDefaultSearchPresetMigrated(uid)
    logger.debug('已修复旧版空搜索配置并加载产品经理默认值')
    return repaired
  }

  function stripPageAiLegacyFields(from: Partial<FormData>) {
    for (const key of ['aiGreeting', 'aiFiltering'] as const) {
      const item = from[key]
      if (!item) continue
      item.model = undefined
      item.vip = undefined
    }
    if (from.aiFiltering) from.aiFiltering.prompt = ''
    if (from.aiGreeting) {
      from.aiGreeting.prompt = migrateAiGreetingUserPrompt(
        from.aiGreeting.prompt,
        defaultFormData.aiGreeting.prompt,
      )
    }
  }

  function normalizePageGreeting(from: Partial<FormData>) {
    const value = (isPlainObject(from.aiGreeting) ? from.aiGreeting : {}) as Partial<
      FormData['aiGreeting']
    >
    const messageCount = Number(value.messageCount)
    const targetTotalCharacters = Number(value.targetTotalCharacters)
    from.aiGreeting = {
      ...jsonClone(defaultFormData.aiGreeting),
      ...value,
      enable: typeof value.enable === 'boolean' ? value.enable : defaultFormData.aiGreeting.enable,
      messageCount:
        Number.isInteger(messageCount) && messageCount >= 1 && messageCount <= 5
          ? messageCount
          : defaultFormData.aiGreeting.messageCount,
      targetTotalCharacters:
        Number.isInteger(targetTotalCharacters) &&
        targetTotalCharacters >= GREETING_TARGET_MIN &&
        targetTotalCharacters <= GREETING_TARGET_MAX
          ? targetTotalCharacters
          : defaultFormData.aiGreeting.targetTotalCharacters,
      prompt: typeof value.prompt === 'string' ? value.prompt : defaultFormData.aiGreeting.prompt,
    }
  }

  function normalizeJobSources(value: unknown): FormData['jobSources'] {
    const source = isPlainObject(value) ? value : {}
    const rawExpectIds = Array.isArray(source.enabledExpectIds) ? source.enabledExpectIds : []
    return {
      searchEnabled:
        typeof source.searchEnabled === 'boolean'
          ? source.searchEnabled
          : defaultFormData.jobSources.searchEnabled,
      recommendEnabled:
        typeof source.recommendEnabled === 'boolean'
          ? source.recommendEnabled
          : defaultFormData.jobSources.recommendEnabled,
      enabledExpectIds: [
        ...new Set(
          rawExpectIds
            .filter((item): item is string | number => {
              return typeof item === 'string' || typeof item === 'number'
            })
            .map(String)
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ],
      expectationsInitialized:
        typeof source.expectationsInitialized === 'boolean'
          ? source.expectationsInitialized
          : rawExpectIds.length > 0,
    }
  }

  function getActiveUid() {
    const uid = useUser().getUserId()
    if (uid == null || String(uid).trim().length === 0) {
      throw new Error('无法识别当前 BOSS 账号')
    }
    return String(uid)
  }

  async function loadCanonicalRuntime() {
    const uid = getActiveUid()
    const runtime = await counter.configRuntime(uid)
    if (!runtime.accountInitialized) return null
    const from = (await formDataHandler(runtime.formData)) ?? runtime.formData
    Object.assign(formData, deepmerge<FormData>(defaultFormData, from))
    availableJobExpectations.value = jsonClone(runtime.enabledExpectations ?? [])
    aiTaskTimeoutSeconds.value = runtime.aiTaskTimeoutSeconds
    readiness.value = runtime.readiness
    return runtime
  }

  function queueCanonicalRefresh(expectedRevision?: number) {
    const operation = runtimeRefreshQueue.then(async () => {
      if (
        expectedRevision != null &&
        readiness.value != null &&
        expectedRevision <= readiness.value.configRevision
      ) {
        return
      }
      await loadCanonicalRuntime()
    })
    runtimeRefreshQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  function refreshCanonicalRuntime(configRevision: number) {
    if (pendingPersistRequests > 0) {
      deferredConfigRevision = Math.max(deferredConfigRevision ?? 0, configRevision)
      return
    }
    void queueCanonicalRefresh(configRevision).catch((error) => {
      logger.error('刷新统一配置失败', { error })
    })
  }

  function flushDeferredConfigRefresh() {
    if (pendingPersistRequests > 0 || deferredConfigRevision == null) return
    const configRevision = deferredConfigRevision
    deferredConfigRevision = undefined
    refreshCanonicalRuntime(configRevision)
  }

  async function init() {
    const uid = getActiveUid()
    const runtime = await counter.configRuntime(uid)
    let from: Partial<FormData>
    if (runtime.accountInitialized) {
      from = runtime.formData
      availableJobExpectations.value = jsonClone(runtime.enabledExpectations ?? [])
      aiTaskTimeoutSeconds.value = runtime.aiTaskTimeoutSeconds
      readiness.value = runtime.readiness
      from = await repairLegacyEmptySearchPreset(uid, from)
    } else {
      from = await readPersistedFormData()
      from = (await formDataHandler(from)) ?? from
      const bootstrap = deepmerge<FormData>(defaultFormData, from)
      bootstrap.userId = uid
      if (!runtime.readiness.modelReady) {
        bootstrap.aiFiltering.enable = false
        bootstrap.aiGreeting.enable = false
      }
      readiness.value = await counter.configRuntimeSave(
        uid,
        bootstrap,
        jsonClone(availableJobExpectations.value),
      )
      from = bootstrap
    }
    from = (await formDataHandler(from)) ?? from
    Object.assign(formData, deepmerge<FormData>(defaultFormData, from))
    isLoaded.value = true
    stopRevisionSubscription ??= onConfigRevisionChanged((configRevision) => {
      if (!isLoaded.value) return
      refreshCanonicalRuntime(configRevision)
    })
  }

  watchThrottled(
    formData,
    (v) => {
      logger.debug('formData改变', toRaw(v))
    },
    { throttle: 2000 },
  )

  /**
   * 保存当前账号的整份运行配置。
   *
   * 这里不做字段级 patch：后台的 savePublicRuntimeConfig 本来就是用整份表单重建
   * `accountSettings[uid]`，字段级增量在该协议下没有语义。契约 §3 要防的是跨模块
   * 污染（保存模型不得连带改 AI 开关等），那由各自独立的 action 保证，不靠这里的粒度。
   */
  function persistCurrentFormData() {
    const uid = getActiveUid()
    const value = jsonClone(formData)
    const expectations = jsonClone(availableJobExpectations.value)
    pendingPersistRequests += 1
    const operation = persistQueue.then(async () => {
      try {
        const savedReadiness = await counter.configRuntimeSave(uid, value, expectations)
        const currentUid = useUser().getUserId()
        if (currentUid != null && String(currentUid) === uid) {
          readiness.value = savedReadiness
        }
        if (isEmptySearchPreset(value.searchConditions)) {
          await markDefaultSearchPresetMigrated(uid)
        }
        logger.debug('统一运行配置已保存', {
          configRevision: savedReadiness.configRevision,
        })
      } finally {
        pendingPersistRequests -= 1
        flushDeferredConfigRefresh()
      }
    })
    persistQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  /**
   * 保存三个 AI 任务的设置。AI 任务是全局数据，与按账号分区的运行配置分开写入，
   * 否则新账号首次保存会静默丢掉 AI 变更（后台会挡住随初始化一起到达的 AI 字段）。
   */
  async function persistAiTasks() {
    try {
      readiness.value = await counter.configAiTasksSave({
        aiFiltering: {
          enabled: formData.aiFiltering.enable,
          score: formData.aiFiltering.score,
        },
        aiGreeting: {
          enabled: formData.aiGreeting.enable,
          messageCount: formData.aiGreeting.messageCount,
          targetTotalCharacters: formData.aiGreeting.targetTotalCharacters,
          prompt: formData.aiGreeting.prompt,
        },
      })
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      logger.error('AI 任务设置保存失败', error)
      // 只写 console 的话，用户导出运行日志时看不到这条失败——而 AI 开关没保存上
      // 的表现是「设置又变回去了」，没有日志就无从判断是保存失败还是被运行中拒绝。
      useLog().info('AI 设置', `AI 任务设置保存失败：${detail}`)
      AgentMessage.error('AI 设置保存失败，请稍后重试')
      return false
    }
  }

  /** 运行中允许的即时安全控制：停止生成与发送 AI 招呼语（契约 §3）。 */
  async function disableAiGreetingNow() {
    try {
      formData.aiGreeting.enable = false
      readiness.value = await counter.configAiGreetingDisable()
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      logger.error('关闭 AI 招呼语失败', error)
      // 这是即时安全控制，失败必须留痕：用户以为已经停止发送，实际没有。
      useLog().info('AI 设置', `关闭 AI 招呼语失败，招呼语可能仍在发送：${detail}`)
      AgentMessage.error('关闭 AI 招呼语失败，请稍后重试')
      return false
    }
  }

  async function confPersist(options: { successMessage?: string } = {}) {
    try {
      await persistCurrentFormData()
      if (options.successMessage) AgentMessage.success(options.successMessage)
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      logger.error('运行配置保存失败', error)
      useLog().info('运行配置', `运行配置保存失败：${detail}`)
      AgentMessage.error('配置保存失败，请稍后重试')
      return false
    }
  }

  async function confSaving() {
    return confPersist({ successMessage: '保存成功' })
  }

  async function confReload() {
    await queueCanonicalRefresh()
    logger.debug('统一运行配置已重新加载')
    AgentMessage.success('已重新加载')
  }

  async function confExport() {
    AgentMessage.warning('请在“个人信息”的个人配置中导出完整配置')
  }

  async function confImport() {
    AgentMessage.warning('请在“个人信息”的个人配置中导入完整配置')
  }

  function confRecommend() {
    deepmerge(
      formData,
      [
        'deliveryLimit',
        'activityFilter',
        'friendStatus',
        'sameCompanyFilter',
        'sameHrFilter',
        'goldHunterFilter',
        'useCache',
        'delay',
      ].reduce(
        (result, key) => {
          result[key] = jsonClone(defaultFormData[key as keyof FormData])
          return result
        },
        {} as Record<string, any>,
      ),
      { clone: false },
    )
    logger.debug('formData推荐配置已应用')
    AgentMessage.success('推荐配置已应用')
  }

  function setAvailableJobExpectations(expectations: readonly JobExpectationConfig[]) {
    availableJobExpectations.value = expectations.map((item) => jsonClone(item))
  }

  function confDelete() {
    deepmerge(formData, jsonClone(defaultFormData), { clone: false })
    logger.debug('formData已清空')
    AgentMessage.success('配置已清空')
  }

  return {
    confInit: init,
    confPersist,
    persistAiTasks,
    disableAiGreetingNow,
    confSaving,
    confReload,
    confExport,
    confImport,
    confDelete,
    confRecommend,
    setAvailableJobExpectations,
    formDataKey,
    defaultFormData,
    formData,
    isLoaded,
    readiness,
    aiTaskTimeoutSeconds,
    availableJobExpectations,
  }
})
