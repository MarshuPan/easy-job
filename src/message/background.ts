import type { Adapter, Message, OnMessage, SendMessage } from 'comctx'
import { checkMessage, defineProxy } from 'comctx'

import type { Browser } from '#imports'
import { browser, storage } from '#imports'
import { prepareChatRuntime } from '@/background/chatRuntime'
import { ConfigService, type AiTaskExecutionConfig } from '@/background/configService'
import { createBrowserConfigStorage } from '@/background/configStorage'
import { DeliveryTaskCoordinator } from '@/background/deliveryTaskCoordinator'
import type { DeliveryTaskMutationResult } from '@/background/deliveryTaskCoordinator'
import { createBrowserDeliveryTaskStorage } from '@/background/deliveryTaskStorage'
import { appendLocalDiagnosticEvent } from '@/background/localDiagnosticSink'
import {
  appendAccountRuntimeLog,
  appendAiTaskFailure,
  createAccountAiRuntimeLogger,
} from '@/background/runtimeLogs'
import { validateAiModelConfig } from '@/config/validate'
import {
  CONFIG_REVISION_CHANGED_TYPE,
  createConfigFailure,
  createConfigForbidden,
  createConfigSuccess,
  isConfigRequest,
  type ConfigRequest,
} from '@/message/configProtocol'
import { projectAccountFormData } from '@/message/publicStateProjection'
import type {
  AccountStateSnapshot,
  BackgroundCounterApi,
  CookieInfo,
  UserConf,
} from '@/message/types'
import {
  DELIVERY_WORKER_IDENTITY_RESPONSE_TYPE,
  isDeliveryWorkerIdentityRequest,
} from '@/message/types'
import { getJobGroupTargetIds } from '@/pages/zhipin/utils/jobExpectations'
import { resolveTargetRole } from '@/profile/targetRole'
import type {
  GreetingAudit,
  GreetingDraft,
  GreetingRegenerationContext,
  GreetingFilteringContext,
  SelectedGreetingFact,
} from '@/types/aiGreeting'
import {
  deriveClaimModeFromFacts,
  parseFilteringDecisionContent,
  parseGreetingDraft,
} from '@/utils/aiGreetingDraft'
import { AiTaskAdmissionController, defaultAiTaskAdmissionOptions } from '@/utils/aiTaskAdmission'
import {
  buildFilteringTaskPrompt,
  buildGreetingTaskPrompt,
  filteringDecisionSchema,
  greetingDraftSchema,
} from '@/utils/aiTaskPrompts'
import { runConfiguredAiTask, testConfiguredAiModel } from '@/utils/backgroundAi'
import {
  AiTaskRequestValidationError,
  AiTaskResponseInvalidError,
  AI_TASK_REQUEST_TYPE,
  createAiTaskResponse,
  getAiTaskRequestValidationError,
  isAiTaskRequestMessage,
  type AiTaskData,
  type AiTaskType,
} from '@/utils/backgroundAiProtocol'
import { extractCandidateExperience } from '@/utils/candidateExperience'
import {
  EXTENSION_BACKGROUND_PROBE_RESPONSE_TYPE,
  getCurrentAppVersion,
  isExtensionBackgroundProbeRequest,
} from '@/utils/extensionRuntimeHealth'
import {
  buildGreetingDiversityContext,
  jdQuoteAppears,
  OVERUSED_PRIMARY_FACT_COUNT,
} from '@/utils/greetingDiversity'
import {
  type GreetingQualityIssue,
  STYLE_ISSUE_CODES,
  validateGreetingDraft,
} from '@/utils/greetingQuality'
import { assertHttpUrl } from '@/utils/httpGuards'
import { listGreetingCandidateFacts, resolveSelectedGreetingFacts } from '@/utils/resumeEvidence'
import { toStructuredCloneSafeValue } from '@/utils/safeJson'
import { isGeekChatUrl, isSameGeekChatUrl } from '@/utils/zhipinRoute'

export const userKey = 'local:conf-user'

const zhipinCookieUrls = ['https://zhipin.com', 'https://www.zhipin.com']
const backgroundAiAdmissionByTab = new Map<number, AiTaskAdmissionController>()
const deliveryTaskCoordinator = new DeliveryTaskCoordinator(createBrowserDeliveryTaskStorage())
const configService = new ConfigService(
  createBrowserConfigStorage(),
  undefined,
  broadcastConfigRevision,
  (uid) => deliveryTaskCoordinator.isActive(uid),
  () => deliveryTaskCoordinator.isAnyActive(),
)

async function broadcastConfigRevision(configRevision: number) {
  const tabs = await browser.tabs.query({
    url: ['*://zhipin.com/*', '*://*.zhipin.com/*'],
  })
  await Promise.allSettled(
    tabs.flatMap((tab) =>
      tab.id == null
        ? []
        : [
            browser.tabs.sendMessage(tab.id, {
              type: CONFIG_REVISION_CHANGED_TYPE,
              configRevision,
            }),
          ],
    ),
  )
}

browser.tabs.onRemoved.addListener((tabId) => {
  backgroundAiAdmissionByTab.delete(tabId)
  void deliveryTaskCoordinator.releaseByWorkerPrefix(`boss-tab-${tabId}:`).catch(() => undefined)
})

function getBackgroundAiAdmission(tabId: number) {
  let admission = backgroundAiAdmissionByTab.get(tabId)
  if (!admission) {
    admission = new AiTaskAdmissionController(defaultAiTaskAdmissionOptions)
    backgroundAiAdmissionByTab.set(tabId, admission)
  }
  return admission
}

function cookieUrl(cookie: Pick<Browser.cookies.Cookie, 'domain' | 'path' | 'secure'>) {
  const domain = cookie.domain.replace(/^\./, '') || 'zhipin.com'
  const path = cookie.path?.startsWith('/') ? cookie.path : `/${cookie.path ?? ''}`
  return `${cookie.secure ? 'https' : 'http'}://${domain}${path}`
}

async function getZhipinCookies() {
  const cookies = await Promise.all(zhipinCookieUrls.map((url) => browser.cookies.getAll({ url })))
  const map = new Map<string, Browser.cookies.Cookie>()
  cookies.flat().forEach((cookie) => {
    map.set(`${cookie.domain};${cookie.path};${cookie.name}`, cookie)
  })
  return Array.from(map.values())
}

async function removeCookie(cookie: Browser.cookies.Cookie) {
  await browser.cookies.remove({
    url: cookieUrl(cookie),
    name: cookie.name,
    storeId: cookie.storeId,
  })
}

const accountStatisticsNumberFields = [
  'total',
  'repeat',
  'success',
  'searchSuccess',
  'groupSuccess',
  'searchTotal',
  'groupTotal',
  'searchFiltered',
  'groupFiltered',
  'jobTitle',
  'jobContent',
  'hrPosition',
  'jobAddress',
  'salaryRange',
  'companySizeRange',
  'company',
  'activityFilter',
  'goldHunterFilter',
  'aiFiltering',
  'amap',
] as const

function projectAccountStatisticsItem(value: unknown) {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const result: Record<string, string | number> = {}
  if (typeof source.date === 'string') result.date = source.date.slice(0, 32)
  for (const key of accountStatisticsNumberFields) {
    const count = source[key]
    if (typeof count === 'number' && Number.isFinite(count)) result[key] = count
  }
  return result
}

function sanitizeAccountStatistics(value: unknown) {
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) return undefined
    const source = parsed as Record<string, unknown>
    const today = projectAccountStatisticsItem(source.t)
    if (!today || !Array.isArray(source.s)) return undefined
    const history = source.s
      .slice(0, 400)
      .map(projectAccountStatisticsItem)
      .filter((item): item is Record<string, string | number> => item != null)
    return JSON.stringify({ t: today, s: history })
  } catch {
    return undefined
  }
}

function sanitizeMetadataString(value: unknown, maxLength = 2_048) {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

/**
 * Task checkpoints are business evidence for local diagnosis. Keep their full
 * shape, but remove the raw account UID because the event envelope already
 * carries a stable anonymous account identity.
 */
function localTaskSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(localTaskSnapshot)
  if (value == null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'accountUid')
      .map(([key, item]) => [key, localTaskSnapshot(item)]),
  )
}

function mirrorTaskMutation(
  action: string,
  request: { uid: string; runId: string },
  result: DeliveryTaskMutationResult,
) {
  const task = result.task
  const { uid: _uid, ...requestSnapshot } = request as typeof request & Record<string, unknown>
  void appendLocalDiagnosticEvent({
    stream: 'tasks',
    event: `task.${action}`,
    accountUid: request.uid,
    at: task?.updatedAt ?? Date.now(),
    data: {
      runId: request.runId,
      accepted: result.accepted,
      conflict: result.conflict,
      status: task?.status,
      phase: task?.phase,
      revision: task?.revision,
      terminalReason: task?.terminalReason,
      terminalMessage: task?.terminalMessage,
      requestSnapshot: localTaskSnapshot(requestSnapshot),
      taskSnapshot: localTaskSnapshot(task),
      checkpointSnapshot: localTaskSnapshot(task?.checkpoint),
      configSnapshot: localTaskSnapshot(task?.configSnapshot),
    },
  }).catch(() => undefined)
}

function mirrorTaskMutationFailure(
  action: string,
  request: { uid: string; runId: string },
  error: unknown,
) {
  const { uid: _uid, ...requestSnapshot } = request as typeof request & Record<string, unknown>
  void appendLocalDiagnosticEvent({
    stream: 'tasks',
    event: `task.${action}.failed`,
    accountUid: request.uid,
    data: {
      accepted: false,
      requestSnapshot: localTaskSnapshot(requestSnapshot),
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, cause: localTaskSnapshot(error.cause) }
          : localTaskSnapshot(error),
    },
  }).catch(() => undefined)
}

export class BackgroundCounter implements BackgroundCounterApi {
  async accountState(uid: string): Promise<AccountStateSnapshot | null> {
    if (typeof uid !== 'string' || uid.length === 0) {
      throw new Error('账号 uid 无效')
    }
    const userConf = await storage.getItem<UserConf>(userKey, { fallback: {} })
    const info = userConf[uid]?.info
    if (!info) return null

    return {
      uid,
      metadata: {
        user: sanitizeMetadataString(info.user, 256),
        avatar: sanitizeMetadataString(info.avatar),
        remark: sanitizeMetadataString(info.remark, 512),
        gender: info.gender === 'woman' ? 'woman' : 'man',
        flag: info.flag === 'student' ? 'student' : 'staff',
        date: sanitizeMetadataString(info.date, 64),
      },
      form: info.form ? projectAccountFormData(info.form) : undefined,
      statistics: sanitizeAccountStatistics(info.statistics),
    }
  }

  async cookieInfo() {
    const cookieInfo = await storage.getItem<UserConf>(userKey, { fallback: {} })
    const result: Record<string, CookieInfo> = {}
    Object.entries(cookieInfo).forEach(([uid, v]) => {
      result[uid] = v.info
    })
    return result
  }

  async cookieSwitch(uid: string) {
    const userConf = await storage.getItem<UserConf>(userKey, { fallback: {} })
    if (uid in userConf) {
      const cookies = await getZhipinCookies()
      console.log(`待删除cookies ${cookies.length} 个`)
      await Promise.all(cookies.map(removeCookie))

      const targetUser = userConf[uid]

      console.log(`待设置cookies ${targetUser.cookies.length} 个`)
      await Promise.all(
        targetUser.cookies.map(async (ck) => {
          await browser.cookies.set({
            url: cookieUrl(ck),
            name: ck.name,
            value: ck.value,
            path: ck.path,
            domain: ck.domain,
            expirationDate: ck.expirationDate,
            secure: ck.secure,
            httpOnly: ck.httpOnly,
            sameSite: ck.sameSite,
            storeId: ck.storeId,
          })
        }),
      )
    }
    return true
  }

  async cookieSave(info: CookieInfo) {
    // 直接保存完整的cookie字符串数组
    const cookies = await getZhipinCookies()

    const userConf = await storage.getItem<UserConf>(userKey, { fallback: {} })
    userConf[info.uid] = {
      info,
      cookies,
    }
    await storage.setItem(userKey, userConf)
    return true
  }

  async cookieDelete(uid: string) {
    const userConf = await storage.getItem<UserConf>(userKey, { fallback: {} })
    delete userConf[uid]
    await storage.setItem(userKey, userConf)
    return true
  }

  async cookieClear() {
    const cookies = await getZhipinCookies()
    console.log(`待删除cookies ${cookies.length} 个`)
    await Promise.all(cookies.map(removeCookie))
    return true
  }

  async openChatTab(url: string, expectedUid: string) {
    assertZhipinChatUrl(url)
    if (!expectedUid?.trim()) throw new Error('聊天页就绪检查缺少投递账号')
    const tabs = await browser.tabs.query({
      url: ['*://zhipin.com/web/geek/chat*', '*://*.zhipin.com/web/geek/chat*'],
    })
    const existing =
      tabs.find((tab) => tab.id != null && isSameGeekChatUrl(tab.url, url)) ??
      tabs.find((tab) => tab.id != null)
    // 聊天页在后台打开，不切走当前标签页。岗位页一旦被切到后台，Chrome 会在它隐藏
    // 5 分钟后把定时器压到每分钟唤醒一次：写的是等 13 秒，实际等了 67 秒，心跳也跟着
    // 断续，而投递流程的等待、轮询和心跳全都跑在岗位页上。
    if (existing?.id != null) {
      const sameTarget = isSameGeekChatUrl(existing.url, url)
      // 队列按 toUid 发消息，不依赖当前打开的会话。复用连接，避免每岗重置 WebSocket。
      const runtime = await prepareChatRuntime(existing.id, expectedUid, true)
      return {
        reused: true,
        url: existing.url ?? url,
        active: false,
        sameTarget,
        ...runtime,
      }
    }

    const tab = await browser.tabs.create({ url, active: false })
    if (tab.id == null) throw new Error('未能创建聊天页标签')
    const runtime = await prepareChatRuntime(tab.id, expectedUid, false)
    return { reused: false, url, active: false, ...runtime }
  }

  async runAiTask(args: {
    task: AiTaskType
    data: AiTaskData
    json?: boolean
    requestId?: string
  }) {
    return runAiTask(args)
  }

  async localDiagnosticAppend(
    event: import('@/background/localDiagnosticSink').LocalDiagnosticEventInput,
  ) {
    return appendLocalDiagnosticEvent(event)
  }

  async configRuntime(uid: string) {
    return configService.getPublicRuntimeConfig(uid)
  }

  async configRuntimeSave(
    uid: string,
    formData: unknown,
    expectations?: import('@/config/types').JobExpectationConfig[],
  ) {
    return configService.savePublicRuntimeConfig(uid, formData, expectations)
  }

  /** AI 任务是全局数据，与按账号分区的运行配置分开保存（契约 §3）。 */
  async configAiTasksSave(tasks: unknown) {
    return configService.saveAiTasks(
      (typeof tasks === 'object' && tasks != null ? tasks : {}) as Parameters<
        ConfigService['saveAiTasks']
      >[0],
    )
  }

  /** 运行中允许的即时安全控制：停止生成与发送 AI 招呼语。 */
  async configAiGreetingDisable() {
    return configService.disableAiGreeting()
  }

  async configGreetingDisable(type: 'ai' | 'custom') {
    return configService.disableGreeting(type)
  }

  async deliveryTaskRead(uid: string) {
    return deliveryTaskCoordinator.read(uid)
  }

  async deliveryTaskStart(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskStartRequest,
  ) {
    try {
      const result = await deliveryTaskCoordinator.start(request)
      mirrorTaskMutation('started', request, result)
      return result
    } catch (error) {
      mirrorTaskMutationFailure('started', request, error)
      throw error
    }
  }

  async deliveryTaskClaim(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskWorkerRequest,
  ) {
    try {
      const result = await deliveryTaskCoordinator.claim(request)
      mirrorTaskMutation('claimed', request, result)
      return result
    } catch (error) {
      mirrorTaskMutationFailure('claimed', request, error)
      throw error
    }
  }

  async deliveryTaskCheckpoint(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskCheckpointRequest,
  ) {
    try {
      const result = await deliveryTaskCoordinator.checkpoint(request)
      mirrorTaskMutation('checkpoint', request, result)
      return result
    } catch (error) {
      mirrorTaskMutationFailure('checkpoint', request, error)
      throw error
    }
  }

  async deliveryTaskRelease(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskWorkerRequest,
  ) {
    try {
      const result = await deliveryTaskCoordinator.release(request)
      mirrorTaskMutation('released', request, result)
      return result
    } catch (error) {
      mirrorTaskMutationFailure('released', request, error)
      throw error
    }
  }

  async deliveryTaskResume(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskWorkerRequest,
  ) {
    try {
      const result = await deliveryTaskCoordinator.resume(request)
      mirrorTaskMutation('resumed', request, result)
      return result
    } catch (error) {
      mirrorTaskMutationFailure('resumed', request, error)
      throw error
    }
  }

  async deliveryTaskPause(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskWorkerRequest,
  ) {
    try {
      const result = await deliveryTaskCoordinator.pause(request)
      mirrorTaskMutation('paused', request, result)
      return result
    } catch (error) {
      mirrorTaskMutationFailure('paused', request, error)
      throw error
    }
  }

  async deliveryTaskTerminate(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskTerminateRequest,
  ) {
    try {
      const result = await deliveryTaskCoordinator.terminate(request)
      mirrorTaskMutation('terminated', request, result)
      return result
    } catch (error) {
      mirrorTaskMutationFailure('terminated', request, error)
      throw error
    }
  }

  async backgroundTest(type: 'success' | 'error') {
    if (type === 'error') {
      throw new Error(`background test error date: ${Date.now()}`)
    }
    return Date.now()
  }
}

function assertZhipinChatUrl(url: string) {
  assertHttpUrl(url)
  const parsed = new URL(url)
  const allowedHost =
    parsed.hostname === 'zhipin.com' ||
    parsed.hostname === 'www.zhipin.com' ||
    parsed.hostname.endsWith('.zhipin.com')
  if (!allowedHost || !isGeekChatUrl(url)) {
    throw new Error(`只允许打开 BOSS 聊天页: ${url}`)
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== AI_TASK_REQUEST_TYPE || typeof message.requestId !== 'string') {
    return
  }
  const validationError = getAiTaskRequestValidationError(message)
  if (validationError) {
    if (sender.tab?.id == null) return
    const error = new AiTaskRequestValidationError(validationError)
    void appendAiTaskFailure(message, 'request-validation', error)
    return createAiTaskResponse(message.requestId, { ok: false, error })
  }
  if (!isAiTaskRequestMessage(message)) return

  const tabId = sender.tab?.id
  if (tabId == null) {
    return createAiTaskResponse(message.requestId, {
      ok: false,
      error: '后台AI任务缺少可信 tabId',
    })
  }
  const admission = getBackgroundAiAdmission(tabId).acquire()
  if (!admission.ok) {
    return createAiTaskResponse(message.requestId, { ok: false, error: admission.error })
  }

  return runAiTask({
    task: message.task,
    data: message.data,
    json: message.json,
    requestId: message.requestId,
  })
    .then((data) => createAiTaskResponse(message.requestId, { ok: true, data }))
    .catch((error) => createAiTaskResponse(message.requestId, { ok: false, error }))
    .finally(admission.release)
})

browser.runtime.onMessage.addListener((message, sender) => {
  if (isDeliveryWorkerIdentityRequest(message)) {
    if (sender.tab?.id == null) return undefined
    return Promise.resolve({
      type: DELIVERY_WORKER_IDENTITY_RESPONSE_TYPE,
      workerId: `boss-tab-${sender.tab.id}:${message.sessionToken}`,
    })
  }
  if (!isExtensionBackgroundProbeRequest(message)) return
  return Promise.resolve({
    type: EXTENSION_BACKGROUND_PROBE_RESPONSE_TYPE,
    requestId: message.requestId,
    ok: true as const,
    version: getCurrentAppVersion(),
  })
})

browser.runtime.onMessage.addListener((message, sender) => {
  if (!isConfigRequest(message)) return
  if (!isTrustedExtensionConfigSender(sender)) {
    return createConfigForbidden(message.requestId)
  }
  return handleConfigRequest(message).catch((error) =>
    createConfigFailure(message.requestId, error),
  )
})

function isTrustedExtensionConfigSender(sender: Browser.runtime.MessageSender) {
  if (sender.id !== browser.runtime.id || typeof sender.url !== 'string') return false
  return sender.url.startsWith(browser.runtime.getURL('/'))
}

async function handleConfigRequest(message: ConfigRequest) {
  switch (message.action) {
    case 'get':
      return createConfigSuccess(message.requestId, await configService.getBundle(message.uid))
    case 'replace':
      return createConfigSuccess(
        message.requestId,
        await configService.replaceBundle(message.uid, message.bundle),
      )
    case 'save-ai-config':
      return createConfigSuccess(
        message.requestId,
        await configService.saveAiConfiguration({ models: message.models }),
      )
    case 'import-json':
      return createConfigSuccess(
        message.requestId,
        await configService.importJson(message.uid, message.text, message.sizeBytes),
      )
    case 'reset-all':
      return createConfigSuccess(message.requestId, await configService.resetAll(message.uid))
    case 'test-model':
      return createConfigSuccess(message.requestId, await handleModelTestRequest(message))
    case 'save-profile-draft':
      return createConfigSuccess(
        message.requestId,
        await configService.saveProfileDraft({
          displayName: message.displayName,
          targetRole: message.targetRole,
          markdown: message.markdown,
        }),
      )
    case 'commit-profile-evidence':
      return createConfigSuccess(
        message.requestId,
        await configService.commitProfileEvidence({
          markdown: message.markdown,
          evidence: message.evidence,
        }),
      )
  }
}

async function appendConfigWorkflowLog(args: {
  uid: string
  title: string
  state: 'success' | 'danger'
  stateName: string
  message: string
  detail: Record<string, unknown>
}) {
  try {
    await appendAccountRuntimeLog(args.uid, {
      title: args.title,
      state: args.state,
      state_name: args.stateName,
      message: args.message,
      data: {
        trace: [
          {
            at: Date.now(),
            stage: args.title,
            status: args.state,
            message: args.message,
            detail: args.detail,
          },
        ],
      },
    })
  } catch {
    // Runtime logging is diagnostic only and must not change configuration behavior.
  }
}

async function handleModelTestRequest(message: Extract<ConfigRequest, { action: 'test-model' }>) {
  const startedAt = Date.now()
  try {
    return await testConfiguredAiModel(
      validateAiModelConfig(message.model),
      createAccountAiRuntimeLogger(message.uid),
    )
  } catch (error) {
    const failure = createConfigFailure(message.requestId, error)
    await appendConfigWorkflowLog({
      uid: message.uid,
      title: '模型连接测试',
      state: 'danger',
      stateName: '测试失败',
      message: failure.ok ? '模型连接测试失败' : failure.error,
      detail: {
        durationMs: Date.now() - startedAt,
        errorCode: failure.ok ? 'MODEL_TASK_FAILED' : failure.errorCode,
      },
    })
    throw error
  }
}

function pickAiFields(value: unknown, fields: readonly string[]) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const entries = fields.flatMap((field) =>
    record[field] == null ? [] : ([[field, record[field]]] as const),
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function configuredJobData(data: AiTaskData) {
  const bossData = pickAiFields(data.boss?.data, [
    'name',
    'title',
    'activeTimeDesc',
    'bossOnline',
    'brandName',
  ])
  return {
    data: pickAiFields(data.data, [
      'jobName',
      'salaryDesc',
      'jobLabels',
      'skills',
      'jobExperience',
      'jobDegree',
      'cityName',
      'areaDistrict',
      'businessDistrict',
      'brandName',
      'brandStageName',
      'brandIndustry',
      'brandScaleName',
      'welfareList',
    ]),
    boss: bossData ? { data: bossData } : undefined,
    card: pickAiFields(data.card, [
      'jobName',
      'postDescription',
      'salaryDesc',
      'cityName',
      'experienceName',
      'degreeName',
      'jobLabels',
      'address',
      'bossName',
      'bossTitle',
      'activeTimeDesc',
      'brandName',
      'atsDirectPost',
      'atsProxyJob',
    ]),
    amap: data.amap ?? {},
  }
}

/**
 * 招呼语只需要知道这份工作做什么、是谁在招。通勤距离、福利、薪资、招聘者在线状态这些
 * 对匹配有用，对写开场白没用，给了模型反而可能被写进去。
 */
function greetingJobData(data: AiTaskData) {
  return {
    data: pickAiFields(data.data, ['jobName', 'jobLabels', 'skills', 'brandName', 'brandIndustry']),
    card: pickAiFields(data.card, ['jobName', 'postDescription', 'jobLabels', 'bossTitle']),
  }
}

interface GreetingCandidate {
  draft: GreetingDraft
  issues: GreetingQualityIssue[]
  result: object
  attempts: number
  /** 触发这次重写的问题。 */
  rewriteReasons: string[]
}

function createGreetingAudit(args: {
  draft: GreetingDraft
  issues: GreetingQualityIssue[]
  jobText: string
  filtering?: GreetingFilteringContext
  filteringThreshold?: number
  facts: SelectedGreetingFact[]
  resumeEvidenceVersion?: number
  resumeSourceHash?: string | null
}): GreetingAudit {
  const matchSelectedFactIds = [...(args.filtering?.selectedFactIds ?? [])]
  const factIds = new Set(args.facts.map((fact) => fact.id))
  const greetingUsedFactIds = [...args.draft.usedFactIds]
  const greetingUsedFactIdsValid =
    greetingUsedFactIds.length > 0 && greetingUsedFactIds.every((id) => factIds.has(id))
  const matchSelectedFactIdsValid =
    !args.filtering ||
    (matchSelectedFactIds.length > 0 && matchSelectedFactIds.every((id) => factIds.has(id)))
  const greetingFactIdsInMatch = greetingUsedFactIds.filter((id) =>
    matchSelectedFactIds.includes(id),
  )
  const claimIssueCodes = args.issues
    .filter((issue) => issue.code === 'FACT_NOT_ALLOWED' || issue.code === 'FORBIDDEN_CLAIM')
    .map((issue) => issue.code)
  const usedFacts = args.facts.filter((fact) => greetingUsedFactIds.includes(fact.id))
  const factIdsValidSet = new Set(args.facts.map((fact) => fact.id))
  const segmentAudits = args.draft.messages.map((_, index) => {
    const factIds = args.draft.segmentFactIds[index] ?? []
    const factIdsValid =
      new Set(factIds).size === factIds.length && factIds.every((id) => factIdsValidSet.has(id))
    const claimIssueCodes = args.issues
      .filter((issue) => issue.messageIndex === index + 1 && issue.code === 'FORBIDDEN_CLAIM')
      .map((issue) => issue.code)
    return {
      messageIndex: index + 1,
      factIds: [...factIds],
      factIdsValid,
      claimBoundaryValid: factIdsValid && claimIssueCodes.length === 0,
      claimIssueCodes: [...new Set(claimIssueCodes)],
    }
  })
  const mappedFactIds = new Set(segmentAudits.flatMap((segment) => segment.factIds))
  const segmentFactMappingComplete =
    segmentAudits.every((segment) => segment.factIdsValid) &&
    mappedFactIds.size === greetingUsedFactIds.length &&
    greetingUsedFactIds.every((id) => mappedFactIds.has(id))
  const jdQuoteFound =
    !args.jobText.trim() || jdQuoteAppears(args.jobText, args.draft.anchor.jdQuote)
  return {
    matchEnabled: args.filtering != null,
    ...(args.filtering?.matchPercent == null ? {} : { matchPercent: args.filtering.matchPercent }),
    ...(args.filtering == null || args.filteringThreshold == null
      ? {}
      : { matchThreshold: args.filteringThreshold }),
    matchSelectedFactIds,
    matchSelectedFactIdsValid,
    greetingUsedFactIds,
    greetingUsedFactIdsValid,
    greetingFactIdsInMatch,
    segmentFactMappingComplete,
    segmentAudits,
    jdQuoteFound,
    claimMode: deriveClaimModeFromFacts(usedFacts),
    claimBoundaryValid: greetingUsedFactIdsValid && claimIssueCodes.length === 0,
    claimIssueCodes: [...new Set(claimIssueCodes)],
    qualityIssueCodes: [...new Set(args.issues.map((issue) => issue.code))],
    ...(args.resumeEvidenceVersion == null
      ? {}
      : { resumeEvidenceVersion: args.resumeEvidenceVersion }),
    ...(args.resumeSourceHash ? { resumeSourceHash: args.resumeSourceHash } : {}),
    ...(args.resumeEvidenceVersion == null && !args.resumeSourceHash
      ? {}
      : { resumeEvidenceMatches: true }),
  }
}

/** 放行一稿，并附上复核结果：体检统计 JD 摘录命中率、剩下的风格问题、重写次数和原因。 */
function acceptedGreeting(
  candidate: GreetingCandidate,
  jobText: string,
  auditContext: Omit<Parameters<typeof createGreetingAudit>[0], 'draft' | 'issues' | 'jobText'>,
) {
  const { draft, issues, result, attempts, rewriteReasons } = candidate
  const review = {
    jdQuoteFound: !jobText.trim() || jdQuoteAppears(jobText, draft.anchor.jdQuote),
    styleIssues: issues.map((item) => item.code),
    attempts,
    ...(rewriteReasons.length > 0 ? { rewriteReasons } : {}),
  }
  const audit = createGreetingAudit({ ...auditContext, draft, issues, jobText })
  const auditedDraft: GreetingDraft = {
    ...draft,
    resumeEvidenceVersion: audit.resumeEvidenceVersion,
    ...(audit.resumeSourceHash ? { resumeSourceHash: audit.resumeSourceHash } : {}),
    review,
    audit,
  }
  return { ...result, content: JSON.stringify(auditedDraft satisfies GreetingDraft) }
}

/** 核对 anchor.jdQuote 用的岗位原文：岗位名、JD 正文、标签和技能。 */
function greetingJobText(data: AiTaskData) {
  const fields = ['jobName', 'postDescription', 'jobLabels', 'skills']
  return [data.data, data.card]
    .flatMap((source) =>
      fields.map((field) => (source as unknown as Record<string, unknown> | undefined)?.[field]),
    )
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
}

/** 这个岗位生效的求职定位：用户填的优先，其次是岗位所属的 BOSS 求职期望。 */
function targetRoleForJob(data: AiTaskData, execution: AiTaskExecutionConfig) {
  const job = data.data as { expectId?: number | string; deliveryGroupTargetIds?: string[] }
  return resolveTargetRole({
    targetRole: execution.profile.targetRole,
    jobExpectationIds: job ? getJobGroupTargetIds(job) : [],
    expectations: execution.expectations,
    resumeMarkdown: execution.profile.resume.markdown ?? undefined,
  })
}

async function runConfiguredFilteringAiTask(
  args: { data: AiTaskData; requestId?: string },
  execution: AiTaskExecutionConfig,
) {
  const task = execution.task as import('@/config/types').AiTaskConfig['aiFiltering']
  const evidence = execution.profile.resume.evidence
  if (!evidence) throw new Error('后台结构化简历证据不可用')
  const result = await runConfiguredAiTask({
    model: execution.model,
    template: buildFilteringTaskPrompt({
      task,
      evidence,
      resumeMarkdown: execution.profile.resume.markdown ?? undefined,
      targetRole: targetRoleForJob(args.data, execution),
      data: configuredJobData(args.data),
    }),
    data: {},
    json: true,
    jsonSchema: filteringDecisionSchema,
    onDiagnostic: createAccountAiRuntimeLogger(args.data.accountUid!),
    task: 'aiFiltering',
    requestId: args.requestId,
    diagnosticContext: args.data.diagnosticContext,
    resumeMarkdown: execution.profile.resume.markdown ?? undefined,
  })
  const parsedDecision = parseFilteringDecisionContent(result.content ?? '', task.score)
  if (!parsedDecision) throw new Error('AI匹配度响应不是新格式')
  const selectedFacts = resolveSelectedGreetingFacts(
    evidence,
    parsedDecision.decision.selectedFactIds,
  )
  const claimMode = deriveClaimModeFromFacts(selectedFacts)
  const { prompt: _prompt, ...publicResult } = result
  return {
    ...publicResult,
    content: JSON.stringify({
      ...parsedDecision.decision,
      ...(parsedDecision.modelPass === undefined ? {} : { pass: parsedDecision.modelPass }),
      claimMode,
    }),
  }
}

async function runConfiguredGreetingAiTask(
  args: { data: AiTaskData; requestId?: string },
  execution: AiTaskExecutionConfig,
) {
  const task = execution.task as import('@/config/types').AiTaskConfig['aiGreeting']
  const evidence = execution.profile.resume.evidence
  if (!evidence) throw new Error('后台结构化简历证据不可用')
  const filtering = args.data.filtering
  // 招呼语可以用全部事实：项目优先用匹配选出的，能力部分要从其他事实里取。
  // 匹配选出的 ID 仍要校验——无效就说明匹配结果和当前简历对不上，不能悄悄当成没选。
  const facts = listGreetingCandidateFacts(evidence)
  const recentGreetings = args.data.recentGreetings ?? []
  const diversity = buildGreetingDiversityContext(recentGreetings)
  // 近期用得太多的事实不再作为优先项：它仍在 facts 里，确实最贴合时模型照样能用。
  const primaryFactIds = filtering
    ? resolveSelectedGreetingFacts(evidence, filtering.selectedFactIds)
        .map((fact) => fact.id)
        .filter((id) => (diversity.recentFactUses[id] ?? 0) < OVERUSED_PRIMARY_FACT_COUNT)
    : []
  if (facts.length === 0) throw new Error('AI招呼语没有可用的简历事实')
  const claimPolicy = evidence.claimPolicy
  const bossName = args.data.boss?.data?.name ?? args.data.card?.bossName
  const candidateExperience = extractCandidateExperience(execution.profile.resume.markdown)
  const jobText = greetingJobText(args.data)
  let regeneration: GreetingRegenerationContext | null = null
  // 只剩风格问题的最近一稿：重写后仍有风格问题就发它；重写反而出了事实问题，就退回上一稿。
  let styleOnly: GreetingCandidate | null = null

  for (let qualityAttempt = 0; qualityAttempt < 2; qualityAttempt += 1) {
    const result = await runConfiguredAiTask({
      model: execution.model,
      template: buildGreetingTaskPrompt({
        task,
        bossName,
        candidateName: execution.profile.displayName,
        candidateExperience,
        targetRole: targetRoleForJob(args.data, execution),
        claimPolicy,
        matchReason: filtering?.reason,
        job: greetingJobData(args.data),
        diversity,
        regeneration,
        facts,
        primaryFactIds,
      }),
      data: {},
      json: true,
      jsonSchema: greetingDraftSchema(task.messageCount),
      onDiagnostic: createAccountAiRuntimeLogger(args.data.accountUid!),
      task: 'aiGreeting',
      requestId: args.requestId,
      diagnosticContext: args.data.diagnosticContext,
      resumeMarkdown: execution.profile.resume.markdown ?? undefined,
    })

    let draft: GreetingDraft
    try {
      draft = parseGreetingDraft(result.content ?? '', task.messageCount)
      const promptDigest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(task.prompt),
      )
      draft.promptFingerprint = `sha256:${Array.from(new Uint8Array(promptDigest), (value) => value.toString(16).padStart(2, '0')).join('')}`
    } catch {
      regeneration = {
        issues: [{ code: 'SCHEMA_INVALID', message: '返回值必须符合招呼语JSON结构' }],
      }
      if (qualityAttempt === 0) continue
      throw new AiTaskResponseInvalidError(qualityAttempt + 1, ['SCHEMA_INVALID'])
    }

    const issues = validateGreetingDraft({
      candidateName: execution.profile.displayName,
      draft,
      selectedFacts: facts,
      claimPolicy,
      length: {
        messageCount: task.messageCount,
        minTotalCharacters: task.minTotalCharacters,
        maxTotalCharacters: task.maxTotalCharacters,
      },
      jobText,
      avoidPhrases: diversity.avoidPhrases,
      recentMessages: recentGreetings.map((greeting) => greeting.messages),
    })
    const { prompt: _prompt, ...publicResult } = result
    const candidate = {
      draft,
      issues,
      result: publicResult,
      attempts: qualityAttempt + 1,
      rewriteReasons: regeneration?.issues.map((item) => item.code) ?? [],
    }
    const auditContext = {
      filtering,
      filteringThreshold: args.data.filteringThreshold,
      facts,
      resumeEvidenceVersion: execution.profile.resume.evidenceVersion,
      resumeSourceHash: execution.profile.resume.sourceHash,
    }
    if (issues.length === 0) return acceptedGreeting(candidate, jobText, auditContext)
    if (issues.every((item) => STYLE_ISSUE_CODES.has(item.code))) styleOnly = candidate
    regeneration = { draft, issues }
  }
  if (styleOnly)
    return acceptedGreeting(styleOnly, jobText, {
      filtering,
      filteringThreshold: args.data.filteringThreshold,
      facts,
      resumeEvidenceVersion: execution.profile.resume.evidenceVersion,
      resumeSourceHash: execution.profile.resume.sourceHash,
    })
  throw new AiTaskResponseInvalidError(
    2,
    regeneration?.issues.map((issue) => issue.code) ?? ['SCHEMA_INVALID'],
  )
}

async function runAiTask(args: {
  task: AiTaskType
  data: AiTaskData
  json?: boolean
  requestId?: string
}) {
  try {
    if (!args.data.accountUid) throw new Error('AI任务缺少当前 BOSS 账号')
    const execution = await configService.getAiTaskExecutionConfig(args.data.accountUid, args.task)
    if (!execution) throw new Error('当前账号尚未初始化统一配置')
    return await (args.task === 'aiGreeting'
      ? runConfiguredGreetingAiTask(args, execution)
      : runConfiguredFilteringAiTask(args, execution))
  } catch (error) {
    void appendAiTaskFailure(args, 'execution', error)
    throw error
  }
}

interface MessageMeta {
  url: string
  tabId?: number
}

const backgroundRpcNamespace = '__agent-delivery-background__'

interface PendingResponseDelivery {
  promise: Promise<void>
  complete: () => void
}

function createPendingResponseDelivery(): PendingResponseDelivery {
  let complete = () => {}
  const promise = new Promise<void>((resolve) => {
    complete = resolve
  })
  return { promise, complete }
}

function isBackgroundRpcRequest(
  message: Partial<Message<MessageMeta>> | undefined,
): message is Message<MessageMeta> {
  return (
    message != null &&
    checkMessage(message) &&
    message.namespace === backgroundRpcNamespace &&
    message.sender === 'injector' &&
    (message.type === 'apply' || message.type === 'ping')
  )
}

export class ProvideBackgroundAdapter implements Adapter<MessageMeta> {
  private readonly pendingResponseDeliveries = new Map<string, PendingResponseDelivery>()

  sendMessage: SendMessage<MessageMeta> = async (message) => {
    const tabId = message.meta.tabId
    if (tabId == null) {
      throw new Error('缺少消息来源 tabId')
    }
    const pendingDelivery =
      message.namespace === backgroundRpcNamespace &&
      message.sender === 'provider' &&
      (message.type === 'apply' || message.type === 'pong')
        ? this.pendingResponseDeliveries.get(message.id)
        : undefined
    try {
      await browser.tabs.sendMessage(tabId, toStructuredCloneSafeValue(message))
    } catch (error) {
      if (pendingDelivery == null) throw error
    } finally {
      pendingDelivery?.complete()
    }
  }

  onMessage: OnMessage<MessageMeta> = (callback) => {
    const handler = (
      message: Partial<Message<MessageMeta>> | undefined,
      sender: Browser.runtime.MessageSender,
    ) => {
      if (!isBackgroundRpcRequest(message) || sender.tab?.id == null) return undefined

      message.meta.tabId = sender.tab.id
      const pendingDelivery = createPendingResponseDelivery()
      this.pendingResponseDeliveries.set(message.id, pendingDelivery)
      const asyncCallback = callback as (
        message?: Partial<Message<MessageMeta>>,
      ) => void | Promise<void>

      let callbackResult: void | Promise<void>
      try {
        callbackResult = asyncCallback(message)
      } catch (error) {
        this.pendingResponseDeliveries.delete(message.id)
        return Promise.reject(error)
      }

      return Promise.resolve(callbackResult)
        .then(() => pendingDelivery.promise)
        .finally(() => {
          if (this.pendingResponseDeliveries.get(message.id) === pendingDelivery) {
            this.pendingResponseDeliveries.delete(message.id)
          }
        })
    }
    browser.runtime.onMessage.addListener(handler)
    return () => browser.runtime.onMessage.removeListener(handler)
  }
}

export const [provideBackgroundCounter] = defineProxy(() => new BackgroundCounter(), {
  namespace: backgroundRpcNamespace,
})
