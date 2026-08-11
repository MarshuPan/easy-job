import type { Adapter, Message, OnMessage, SendMessage } from 'comctx'
import { checkMessage, defineProxy } from 'comctx'

import type { Browser } from '#imports'
import { browser, storage } from '#imports'
import { ConfigService, type AiTaskExecutionConfig } from '@/background/configService'
import { createBrowserConfigStorage } from '@/background/configStorage'
import { DeliveryTaskCoordinator } from '@/background/deliveryTaskCoordinator'
import { createBrowserDeliveryTaskStorage } from '@/background/deliveryTaskStorage'
import { appendAccountRuntimeLog, createAccountAiRuntimeLogger } from '@/background/runtimeLogs'
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
import type { GreetingDraft, GreetingRegenerationContext } from '@/types/aiGreeting'
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
  AiTaskResponseInvalidError,
  createAiTaskResponse,
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
import { validateGreetingDraft } from '@/utils/greetingQuality'
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

  async openChatTab(url: string) {
    assertZhipinChatUrl(url)
    const tabs = await browser.tabs.query({
      url: ['*://zhipin.com/web/geek/chat*', '*://*.zhipin.com/web/geek/chat*'],
    })
    const existing =
      tabs.find((tab) => tab.id != null && isSameGeekChatUrl(tab.url, url)) ??
      tabs.find((tab) => tab.id != null)
    if (existing?.id != null) {
      const sameTarget = isSameGeekChatUrl(existing.url, url)
      await browser.tabs.update(existing.id, sameTarget ? { active: true } : { url, active: true })
      if (sameTarget) {
        await browser.tabs.reload(existing.id)
      }
      const loaded = await waitForTabLoaded(existing.id)
      return { tabId: existing.id, reused: true, url, active: true, reloaded: sameTarget, loaded }
    }

    const tab = await browser.tabs.create({ url, active: true })
    const loaded = tab.id != null ? await waitForTabLoaded(tab.id) : false
    return { tabId: tab.id, reused: false, url, active: true, reloaded: false, loaded }
  }

  async runAiTask(args: { task: AiTaskType; data: AiTaskData; json?: boolean }) {
    return runAiTask(args)
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

  async deliveryTaskRead(uid: string) {
    return deliveryTaskCoordinator.read(uid)
  }

  async deliveryTaskStart(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskStartRequest,
  ) {
    return deliveryTaskCoordinator.start(request)
  }

  async deliveryTaskClaim(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskWorkerRequest,
  ) {
    return deliveryTaskCoordinator.claim(request)
  }

  async deliveryTaskCheckpoint(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskCheckpointRequest,
  ) {
    return deliveryTaskCoordinator.checkpoint(request)
  }

  async deliveryTaskRelease(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskWorkerRequest,
  ) {
    return deliveryTaskCoordinator.release(request)
  }

  async deliveryTaskResume(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskWorkerRequest,
  ) {
    return deliveryTaskCoordinator.resume(request)
  }

  async deliveryTaskPause(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskWorkerRequest,
  ) {
    return deliveryTaskCoordinator.pause(request)
  }

  async deliveryTaskTerminate(
    request: import('@/background/deliveryTaskCoordinator').DeliveryTaskTerminateRequest,
  ) {
    return deliveryTaskCoordinator.terminate(request)
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

async function waitForTabLoaded(tabId: number, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const tab = await browser.tabs.get(tabId)
    if (tab.status === 'complete') return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

browser.runtime.onMessage.addListener((message, sender) => {
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

  return runAiTask({ task: message.task, data: message.data, json: message.json })
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

async function runConfiguredFilteringAiTask(
  args: { data: AiTaskData },
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
      data: configuredJobData(args.data),
    }),
    data: {},
    json: true,
    jsonSchema: filteringDecisionSchema,
    onDiagnostic: createAccountAiRuntimeLogger(args.data.accountUid!),
    task: 'aiFiltering',
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
  args: { data: AiTaskData },
  execution: AiTaskExecutionConfig,
) {
  const task = execution.task as import('@/config/types').AiTaskConfig['aiGreeting']
  const evidence = execution.profile.resume.evidence
  if (!evidence) throw new Error('后台结构化简历证据不可用')
  const filtering = args.data.filtering
  const candidateFacts = listGreetingCandidateFacts(evidence)
  const selectedFacts = filtering
    ? resolveSelectedGreetingFacts(evidence, filtering.selectedFactIds)
    : candidateFacts
  if (selectedFacts.length === 0) throw new Error('AI招呼语没有可用的简历事实')
  if (filtering && filtering.claimMode !== deriveClaimModeFromFacts(selectedFacts)) {
    throw new Error('AI匹配事实的声明边界无效')
  }
  const effectiveFiltering = filtering
  const claimPolicy = evidence.claimPolicy
  const bossName = args.data.boss?.data?.name ?? args.data.card?.bossName
  const candidateExperience = extractCandidateExperience(execution.profile.resume.markdown)
  const recentGreetings = args.data.recentGreetings ?? []
  let regeneration: GreetingRegenerationContext | null = null

  for (let qualityAttempt = 0; qualityAttempt < 2; qualityAttempt += 1) {
    const result = await runConfiguredAiTask({
      model: execution.model,
      template: buildGreetingTaskPrompt({
        task,
        bossName,
        candidateName: execution.profile.displayName,
        candidateExperience,
        claimPolicy,
        filtering: effectiveFiltering,
        job: configuredJobData(args.data),
        recentGreetings,
        regeneration,
        selectedFacts,
      }),
      data: {},
      json: true,
      jsonSchema: greetingDraftSchema(task.messageCount),
      onDiagnostic: createAccountAiRuntimeLogger(args.data.accountUid!),
      task: 'aiGreeting',
    })

    let draft: GreetingDraft
    try {
      draft = parseGreetingDraft(result.content ?? '', task.messageCount)
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
      filtering: effectiveFiltering,
      selectedFacts,
      claimPolicy,
      length: {
        messageCount: task.messageCount,
        minTotalCharacters: task.minTotalCharacters,
        maxTotalCharacters: task.maxTotalCharacters,
      },
    })
    const blockingIssues = issues.filter(
      (issue) => issue.code !== 'TOTAL_TOO_SHORT' && issue.code !== 'TOTAL_TOO_LONG',
    )
    if (blockingIssues.length === 0) {
      const { prompt: _prompt, ...publicResult } = result
      return { ...publicResult, content: JSON.stringify(draft) }
    }
    regeneration = { draft, issues }
  }
  throw new AiTaskResponseInvalidError(
    2,
    regeneration?.issues.map((issue) => issue.code) ?? ['SCHEMA_INVALID'],
  )
}

async function runAiTask(args: { task: AiTaskType; data: AiTaskData; json?: boolean }) {
  if (!args.data.accountUid) throw new Error('AI任务缺少当前 BOSS 账号')
  const execution = await configService.getAiTaskExecutionConfig(args.data.accountUid, args.task)
  if (!execution) throw new Error('当前账号尚未初始化统一配置')
  return args.task === 'aiGreeting'
    ? runConfiguredGreetingAiTask(args, execution)
    : runConfiguredFilteringAiTask(args, execution)
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
