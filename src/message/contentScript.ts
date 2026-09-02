import type { Adapter, Message, OnMessage, SendMessage } from 'comctx'
import { defineProxy } from 'comctx'

import type { StorageItemKey } from '#imports'
import { browser, storage } from '#imports'
import { AiTaskAdmissionController, defaultAiTaskAdmissionOptions } from '@/utils/aiTaskAdmission'
import {
  AI_TASK_REQUEST_TYPE,
  createAiTaskResponse,
  getAiTaskRequestValidationError,
  isAiTaskRequestMessage,
  isAiTaskResponseMessage,
  type AiTaskRequestMessage,
} from '@/utils/backgroundAiProtocol'
import {
  EXTENSION_BACKGROUND_PROBE_REQUEST_TYPE,
  EXTENSION_CONTEXT_INVALIDATED_EVENT,
  EXTENSION_RUNTIME_PROBE_RESPONSE_TYPE,
  EXTENSION_BACKGROUND_PROBE_TIMEOUT_MS,
  EXTENSION_RPC_HEARTBEAT_TIMEOUT_MS,
  getCurrentAppVersion,
  isExtensionBackgroundProbeResponse,
  isExtensionRuntimeProbeRequest,
  type ExtensionRuntimeProbeRequest,
} from '@/utils/extensionRuntimeHealth'
import { isExtensionContextInvalidatedError } from '@/utils/providerHealth'
import { toStructuredCloneSafeValue } from '@/utils/safeJson'
import {
  isStorageQuotaError,
  STORAGE_QUOTA_BYTES,
  STORAGE_QUOTA_ERROR_MESSAGE,
} from '@/utils/storageQuota'

import { isConfigRevisionChangedMessage } from './configProtocol'
import { projectPageFormData } from './publicStateProjection'
import {
  DELIVERY_WORKER_IDENTITY_REQUEST_TYPE,
  DELIVERY_WORKER_IDENTITY_RESPONSE_TYPE,
  type BackgroundCounterApi,
  type ContentCounterApi,
} from './types'

export const [, injectBackgroundCounter] = defineProxy(() => ({}) as BackgroundCounterApi, {
  namespace: '__agent-delivery-background__',
  heartbeatInterval: 250,
  heartbeatTimeout: EXTENSION_RPC_HEARTBEAT_TIMEOUT_MS,
})

const contentNamespace = '__agent-delivery-content__'
const pageCallableMethods = new Set([
  'accountState',
  'backgroundTest',
  'configRuntime',
  'configRuntimeSave',
  'configAiTasksSave',
  'configAiGreetingDisable',
  'deliveryTaskRead',
  'deliveryTaskStart',
  'deliveryTaskClaim',
  'deliveryTaskCheckpoint',
  'deliveryTaskRelease',
  'deliveryTaskPause',
  'deliveryTaskResume',
  'deliveryTaskTerminate',
  'deliveryWorkerIdentity',
  'contentScriptTest',
  'openChatTab',
  'storageGet',
  'storageRm',
  'storageSet',
  'storageUsage',
])

const allowedStorageKeySet = new Set([
  'boss-protocol',
  'local:pipeline-cache',
  'local:pending-greetings',
  'local:sameCompany',
  'local:sameHr',
  'local:web-geek-job-DeliveryLogs',
  'local:web-geek-job-FormData',
  'local:web-geek-job-SourcePools',
  'local:web-geek-job-Statistics',
  'local:web-geek-job-StatisticsEpoch',
  'local:web-geek-job-Today',
  'local:boss-action-gate',
  'local:risk-backoff',
  'appearance-conf',
  'theme-dark',
])

const legacyTaskStoragePrefix = `local:${['boss', 'helper'].join('-')}-task-v1:`
const allowedStorageKeyPrefixes = [
  'local:alert:',
  'local:agent-delivery-task-v1:',
  legacyTaskStoragePrefix,
]
const allowedAccountStorageKeyPattern =
  /^local:web-geek-job-(?:DeliveryLogs|SearchRotation|SourcePools|Statistics|StatisticsEpoch|Today):[A-Za-z0-9_-]{1,128}$/
const allowedRuntimeLogStorageKeyPattern =
  /^local:agent-delivery-runtime-logs:[A-Za-z0-9_-]{1,128}$/

let bridgeToken: string | undefined
export { AiTaskAdmissionController } from '@/utils/aiTaskAdmission'

const aiTaskAdmission = new AiTaskAdmissionController(defaultAiTaskAdmissionOptions)

export function setBridgeToken(token: string) {
  bridgeToken = token
}

function assertAllowedStorageKey(key: string) {
  if (
    allowedStorageKeySet.has(key) ||
    allowedAccountStorageKeyPattern.test(key) ||
    allowedRuntimeLogStorageKeyPattern.test(key) ||
    allowedStorageKeyPrefixes.some((prefix) => key.startsWith(prefix))
  )
    return
  throw new Error(`storage key is not allowed: ${key}`)
}

function getBridgeToken() {
  return bridgeToken
}

function genKey(key: string): StorageItemKey {
  const prefixes = ['local:', 'session:', 'sync:', 'managed:'] as const
  return prefixes.some((prefix) => key.startsWith(prefix)) ? (key as StorageItemKey) : `sync:${key}`
}

function normalizeStorageError(error: unknown): never {
  // 配额超限会跨消息边界丢掉错误类型，只剩 message。统一成固定文案，
  // 让页面侧能可靠识别并给用户一次明确提示，而不是当成普通保存失败静默降级。
  if (isStorageQuotaError(error)) throw new Error(STORAGE_QUOTA_ERROR_MESSAGE)
  if (!isExtensionContextInvalidatedError(error)) throw error
  window.dispatchEvent(new Event(EXTENSION_CONTEXT_INVALIDATED_EVENT))
  throw new Error('Extension context invalidated.')
}

export class ContentCounter implements ContentCounterApi {
  public background: BackgroundCounterApi
  constructor(background: BackgroundCounterApi) {
    this.background = background
  }

  async accountState(...args: Parameters<BackgroundCounterApi['accountState']>) {
    return this.background.accountState(...args)
  }

  async openChatTab(...args: Parameters<BackgroundCounterApi['openChatTab']>) {
    return this.background.openChatTab(...args)
  }

  async backgroundTest(...args: Parameters<BackgroundCounterApi['backgroundTest']>) {
    return this.background.backgroundTest(...args)
  }

  async configRuntime(...args: Parameters<BackgroundCounterApi['configRuntime']>) {
    return this.background.configRuntime(...args)
  }

  async configRuntimeSave(...args: Parameters<BackgroundCounterApi['configRuntimeSave']>) {
    return this.background.configRuntimeSave(...args)
  }

  async configAiTasksSave(...args: Parameters<BackgroundCounterApi['configAiTasksSave']>) {
    return this.background.configAiTasksSave(...args)
  }

  async configAiGreetingDisable() {
    return this.background.configAiGreetingDisable()
  }

  async deliveryTaskRead(...args: Parameters<BackgroundCounterApi['deliveryTaskRead']>) {
    return this.background.deliveryTaskRead(...args)
  }

  async deliveryTaskStart(...args: Parameters<BackgroundCounterApi['deliveryTaskStart']>) {
    return this.background.deliveryTaskStart(...args)
  }

  async deliveryTaskClaim(...args: Parameters<BackgroundCounterApi['deliveryTaskClaim']>) {
    return this.background.deliveryTaskClaim(...args)
  }

  async deliveryTaskCheckpoint(
    ...args: Parameters<BackgroundCounterApi['deliveryTaskCheckpoint']>
  ) {
    return this.background.deliveryTaskCheckpoint(...args)
  }

  async deliveryTaskRelease(...args: Parameters<BackgroundCounterApi['deliveryTaskRelease']>) {
    return this.background.deliveryTaskRelease(...args)
  }

  async deliveryTaskResume(...args: Parameters<BackgroundCounterApi['deliveryTaskResume']>) {
    return this.background.deliveryTaskResume(...args)
  }

  async deliveryTaskPause(...args: Parameters<BackgroundCounterApi['deliveryTaskPause']>) {
    return this.background.deliveryTaskPause(...args)
  }

  async deliveryTaskTerminate(...args: Parameters<BackgroundCounterApi['deliveryTaskTerminate']>) {
    return this.background.deliveryTaskTerminate(...args)
  }

  async deliveryWorkerIdentity(sessionToken: string) {
    const response: unknown = await browser.runtime.sendMessage(browser.runtime.id, {
      type: DELIVERY_WORKER_IDENTITY_REQUEST_TYPE,
      sessionToken,
    })
    if (
      typeof response !== 'object' ||
      response == null ||
      !('type' in response) ||
      response.type !== DELIVERY_WORKER_IDENTITY_RESPONSE_TYPE ||
      !('workerId' in response) ||
      typeof response.workerId !== 'string'
    ) {
      throw new Error('无法识别当前投递标签页')
    }
    return response.workerId
  }

  async storageGet<T>(key: string, defaultValue: T): Promise<T>
  async storageGet<T>(key: string): Promise<T | null>
  async storageGet<T>(key: string, defaultValue?: T): Promise<T | null> {
    assertAllowedStorageKey(key)
    try {
      const value = await storage.getItem<T>(genKey(key), { fallback: defaultValue })
      if (key === 'local:web-geek-job-FormData') {
        return (projectPageFormData(value) ?? null) as T | null
      }
      return value
    } catch (error) {
      return normalizeStorageError(error)
    }
  }

  async storageSet<T>(key: string, value: T) {
    assertAllowedStorageKey(key)
    try {
      await storage.setItem(genKey(key), value)
      return true
    } catch (error) {
      return normalizeStorageError(error)
    }
  }

  async storageRm(key: string) {
    assertAllowedStorageKey(key)
    try {
      await storage.removeItem(genKey(key))
      return true
    } catch (error) {
      return normalizeStorageError(error)
    }
  }

  /**
   * 当前扩展本地存储的已用字节数。用于在投递开始前提醒用户清理，
   * 避免运行到一半配额写满导致记录与投递池无法保存。
   */
  async storageUsage() {
    try {
      const bytesInUse = await browser.storage.local.getBytesInUse(null)
      return { bytesInUse, quotaBytes: STORAGE_QUOTA_BYTES }
    } catch {
      // 浏览器不支持或调用失败时返回 null，调用方跳过检查即可，不影响投递。
      return null
    }
  }

  async contentScriptTest(type: 'success' | 'error') {
    if (type === 'error') {
      throw new Error(`test error date: ${Date.now()}`)
    }
    return Date.now()
  }
}

interface MessageMeta {
  url: string
}

export function isPageMessage(
  event: MessageEvent<Partial<Message<Record<string, any>>> | undefined>,
) {
  const message = event.data
  const bridgeToken = getBridgeToken()
  return (
    bridgeToken != null &&
    event.source === window &&
    event.origin === window.location.origin &&
    typeof message === 'object' &&
    message != null &&
    message.meta?.bridgeToken === bridgeToken &&
    message.namespace === contentNamespace &&
    (message.sender === 'injector' || message.sender === 'provider') &&
    (message.type !== 'apply' ||
      (Array.isArray(message.path) &&
        message.path.length === 1 &&
        pageCallableMethods.has(message.path[0])))
  )
}

export class InjectBackgroundAdapter implements Adapter<MessageMeta> {
  sendMessage: SendMessage<MessageMeta> = async (message) => {
    return browser.runtime.sendMessage(
      browser.runtime.id,
      toStructuredCloneSafeValue({
        ...message,
        meta: { url: document.location.href },
      }),
    )
  }

  onMessage: OnMessage<MessageMeta> = (callback) => {
    const handler = (message?: Partial<Message<MessageMeta>>) => {
      callback(message)
    }
    browser.runtime.onMessage.addListener(handler)
    return () => browser.runtime.onMessage.removeListener(handler)
  }
}

browser.runtime.onMessage.addListener((message) => {
  const activeBridgeToken = getBridgeToken()
  if (activeBridgeToken == null || !isConfigRevisionChangedMessage(message)) return
  window.postMessage(
    {
      type: message.type,
      configRevision: message.configRevision,
      bridgeToken: activeBridgeToken,
    },
    window.location.origin,
  )
})

window.addEventListener('message', (event) => {
  const bridgeToken = getBridgeToken()
  if (bridgeToken == null) return
  if (event.source !== window || event.origin !== window.location.origin) return
  const candidate = event.data
  if (
    typeof candidate !== 'object' ||
    candidate == null ||
    !('type' in candidate) ||
    candidate.type !== AI_TASK_REQUEST_TYPE ||
    !('requestId' in candidate) ||
    typeof candidate.requestId !== 'string' ||
    !('bridgeToken' in candidate) ||
    candidate.bridgeToken !== bridgeToken
  ) {
    return
  }
  const validationError = getAiTaskRequestValidationError(candidate)
  if (validationError) {
    window.postMessage(
      createAiTaskResponse(candidate.requestId, { ok: false, error: validationError }),
      window.location.origin,
    )
    return
  }
  if (!isAiTaskRequestMessage(candidate)) return
  const admission = aiTaskAdmission.acquire()
  if (!admission.ok) {
    window.postMessage(
      createAiTaskResponse(candidate.requestId, { ok: false, error: admission.error }),
      window.location.origin,
    )
    return
  }

  const message: AiTaskRequestMessage = {
    ...candidate,
    type: AI_TASK_REQUEST_TYPE,
  }

  void browser.runtime
    .sendMessage(browser.runtime.id, message)
    .then((response: unknown) => {
      if (isAiTaskResponseMessage(response)) {
        window.postMessage(response, window.location.origin)
        return
      }
      window.postMessage(
        createAiTaskResponse(message.requestId, {
          ok: false,
          error: '后台AI任务返回格式不合法',
        }),
        window.location.origin,
      )
    })
    .catch((error) => {
      window.postMessage(
        createAiTaskResponse(message.requestId, { ok: false, error }),
        window.location.origin,
      )
    })
    .finally(admission.release)
})

window.addEventListener('message', (event) => {
  const activeBridgeToken = getBridgeToken()
  if (
    activeBridgeToken == null ||
    event.source !== window ||
    event.origin !== window.location.origin ||
    !isExtensionRuntimeProbeRequest(event.data) ||
    event.data.bridgeToken !== activeBridgeToken
  ) {
    return
  }

  void handleRuntimeProbe(event.data, activeBridgeToken)
})

async function handleRuntimeProbe(
  request: ExtensionRuntimeProbeRequest,
  activeBridgeToken: string,
) {
  const contentVersion = getCurrentAppVersion()
  if (request.version !== contentVersion) {
    postRuntimeProbeResponse({
      request,
      activeBridgeToken,
      contentVersion,
      errorCode: 'VERSION_MISMATCH',
    })
    return
  }

  const backgroundResponse = await probeBackgroundRuntime(request.requestId)
  if (!backgroundResponse) {
    postRuntimeProbeResponse({
      request,
      activeBridgeToken,
      contentVersion,
      errorCode: 'BACKGROUND_UNAVAILABLE',
    })
    return
  }

  postRuntimeProbeResponse({
    request,
    activeBridgeToken,
    contentVersion,
    backgroundVersion: backgroundResponse.version,
  })
}

async function probeBackgroundRuntime(requestId: string) {
  let timeoutId: number | undefined
  try {
    const timeout = new Promise<null>((resolve) => {
      timeoutId = window.setTimeout(() => resolve(null), EXTENSION_BACKGROUND_PROBE_TIMEOUT_MS)
    })
    const response = await Promise.race([
      browser.runtime.sendMessage(browser.runtime.id, {
        type: EXTENSION_BACKGROUND_PROBE_REQUEST_TYPE,
        requestId,
      }),
      timeout,
    ])
    return isExtensionBackgroundProbeResponse(response) && response.requestId === requestId
      ? response
      : null
  } catch {
    return null
  } finally {
    if (timeoutId != null) window.clearTimeout(timeoutId)
  }
}

function postRuntimeProbeResponse(args: {
  request: ExtensionRuntimeProbeRequest
  activeBridgeToken: string
  contentVersion: string
  backgroundVersion?: string
  errorCode?: 'BACKGROUND_UNAVAILABLE' | 'VERSION_MISMATCH'
}) {
  window.postMessage(
    {
      type: EXTENSION_RUNTIME_PROBE_RESPONSE_TYPE,
      requestId: args.request.requestId,
      bridgeToken: args.activeBridgeToken,
      ok: args.errorCode == null,
      mainVersion: args.request.version,
      contentVersion: args.contentVersion,
      backgroundVersion: args.backgroundVersion,
      errorCode: args.errorCode,
    },
    window.location.origin,
  )
}

export const [provideContentCounter] = defineProxy(
  () => new ContentCounter(injectBackgroundCounter(new InjectBackgroundAdapter())),
  {
    namespace: contentNamespace,
  },
)

export class ProvideContentAdapter implements Adapter {
  sendMessage: SendMessage = (message) => {
    const bridgeToken = getBridgeToken()
    window.postMessage(
      toStructuredCloneSafeValue({
        ...message,
        meta: { ...message.meta, bridgeToken },
      }),
      window.location.origin,
    )
  }

  onMessage: OnMessage = (callback) => {
    const handler = (event: MessageEvent<Partial<Message<Record<string, any>>> | undefined>) => {
      if (!isPageMessage(event)) return
      callback(event.data)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }
}
