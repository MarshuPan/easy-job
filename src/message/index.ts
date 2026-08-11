import type { StorageLikeAsync } from '@vueuse/core'
import type { Adapter, Message, OnMessage, SendMessage } from 'comctx'
import { defineProxy } from 'comctx'

import { isConfigRevisionChangedMessage } from '@/message/configProtocol'
import {
  AI_TASK_CLIENT_TIMEOUT_BUFFER_SECONDS,
  AI_TASK_MAX_RETRIES,
  AI_TASK_MAX_RETRY_DELAY_SECONDS,
  AI_TASK_REQUEST_TYPE,
  isAiTaskResponseMessage,
  type AiTaskData,
  type AiTaskType,
} from '@/utils/backgroundAiProtocol'
import {
  EXTENSION_RUNTIME_PROBE_REQUEST_TYPE,
  EXTENSION_RUNTIME_PROBE_TIMEOUT_MS,
  EXTENSION_RPC_HEARTBEAT_TIMEOUT_MS,
  ExtensionRuntimeHealthError,
  getCurrentAppVersion,
  isExtensionRuntimeProbeResponse,
  type ExtensionRuntimeHealth,
} from '@/utils/extensionRuntimeHealth'
import { createBackgroundRequestId } from '@/utils/httpGuards'
import { toSafeJsonValue, toStructuredCloneSafeValue } from '@/utils/safeJson'

import type { ContentCounterApi } from './types'

const trustedOrigin = window.location.origin
const contentNamespace = '__agent-delivery-content__'
const bridgeToken = document.currentScript?.getAttribute('data-agent-delivery-token')

function isWindowMessage(event: MessageEvent<Partial<Message<Record<string, any>>> | undefined>) {
  const message = event.data
  return (
    event.source === window &&
    event.origin === trustedOrigin &&
    typeof message === 'object' &&
    message != null &&
    message.meta?.bridgeToken === bridgeToken &&
    message.namespace === contentNamespace &&
    (message.sender === 'injector' || message.sender === 'provider')
  )
}

export type { CookieInfo } from './types'

export const [, injectCounter] = defineProxy(() => ({}) as ContentCounterApi, {
  namespace: contentNamespace,
  heartbeatInterval: 250,
  heartbeatTimeout: EXTENSION_RPC_HEARTBEAT_TIMEOUT_MS,
})

export default class InjectAdapter implements Adapter {
  sendMessage: SendMessage = (message) => {
    window.postMessage(
      toStructuredCloneSafeValue({
        ...message,
        meta: { ...message.meta, bridgeToken },
      }),
      trustedOrigin,
    )
  }

  onMessage: OnMessage = (callback) => {
    const handler = (event: MessageEvent<Partial<Message<Record<string, any>>> | undefined>) => {
      if (!isWindowMessage(event)) return
      callback(event.data)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }
}

export const counter = injectCounter(new InjectAdapter())

export function onConfigRevisionChanged(listener: (configRevision: number) => void) {
  const handler = (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== trustedOrigin) return
    const message = event.data
    if (
      !isConfigRevisionChangedMessage(message) ||
      (message as { bridgeToken?: unknown }).bridgeToken !== bridgeToken
    ) {
      return
    }
    listener(message.configRevision)
  }
  window.addEventListener('message', handler)
  return () => window.removeEventListener('message', handler)
}

export function probeExtensionRuntimeHealth(options?: {
  bridgeToken?: string | null
  timeoutMs?: number
}): Promise<ExtensionRuntimeHealth> {
  const activeBridgeToken = options?.bridgeToken ?? bridgeToken
  if (!activeBridgeToken) {
    return Promise.reject(new ExtensionRuntimeHealthError('CONTENT_SCRIPT_UNAVAILABLE'))
  }

  const requestId = createBackgroundRequestId()
  const mainVersion = getCurrentAppVersion()
  const startedAt = Date.now()
  const timeoutMs = options?.timeoutMs ?? EXTENSION_RUNTIME_PROBE_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new ExtensionRuntimeHealthError('CONTENT_SCRIPT_UNAVAILABLE'))
    }, timeoutMs)

    function onMessage(event: MessageEvent<unknown>) {
      if (event.source !== window || event.origin !== trustedOrigin) return
      const response = event.data
      if (
        !isExtensionRuntimeProbeResponse(response) ||
        response.requestId !== requestId ||
        response.bridgeToken !== activeBridgeToken
      ) {
        return
      }

      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      if (
        response.errorCode === 'VERSION_MISMATCH' ||
        response.mainVersion !== response.contentVersion ||
        (response.backgroundVersion != null &&
          response.contentVersion !== response.backgroundVersion)
      ) {
        reject(new ExtensionRuntimeHealthError('VERSION_MISMATCH'))
        return
      }
      if (!response.ok || response.errorCode === 'BACKGROUND_UNAVAILABLE') {
        reject(new ExtensionRuntimeHealthError('BACKGROUND_UNAVAILABLE'))
        return
      }

      resolve({
        mainVersion: response.mainVersion,
        contentVersion: response.contentVersion,
        backgroundVersion: response.backgroundVersion ?? 'unknown',
        durationMs: Date.now() - startedAt,
      })
    }

    window.addEventListener('message', onMessage)
    window.postMessage(
      {
        type: EXTENSION_RUNTIME_PROBE_REQUEST_TYPE,
        requestId,
        bridgeToken: activeBridgeToken,
        version: mainVersion,
      },
      trustedOrigin,
    )
  })
}

export function runBackgroundAiTask(args: {
  task: AiTaskType
  data: AiTaskData
  json?: boolean
  timeout?: number
}) {
  const requestId = createBackgroundRequestId()
  const timeout = args.timeout ?? 180
  const requestTimeout =
    timeout * (AI_TASK_MAX_RETRIES + 1) +
    AI_TASK_MAX_RETRY_DELAY_SECONDS +
    AI_TASK_CLIENT_TIMEOUT_BUFFER_SECONDS

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error(`后台AI任务超时 ${requestTimeout}s`))
    }, requestTimeout * 1000)

    function onMessage(event: MessageEvent<unknown>) {
      if (event.source !== window || event.origin !== trustedOrigin) return
      const message = event.data
      if (!isAiTaskResponseMessage(message) || message.requestId !== requestId) return

      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      if (message.ok) {
        resolve(message.data)
      } else {
        const error = new Error(message.error || '后台AI任务失败')
        error.name = message.errorCode || 'AI_TASK_FAILED'
        reject(error)
      }
    }

    window.addEventListener('message', onMessage)
    window.postMessage(
      {
        type: AI_TASK_REQUEST_TYPE,
        requestId,
        task: args.task,
        data: toSafeJsonValue(args.data),
        json: args.json,
        bridgeToken,
      },
      trustedOrigin,
    )
  })
}

export const ExtStorage: StorageLikeAsync = {
  async getItem(key) {
    return counter.storageGet(key)
  },
  async setItem(key, value) {
    await counter.storageSet(key, value)
  },
  async removeItem(key) {
    await counter.storageRm(key)
  },
}
