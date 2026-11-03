import { browser, storage } from '#imports'
import type { PendingGreeting } from '@/composables/useWebSocket/pendingGreeting'
import {
  CHAT_RUNTIME_REQUEST,
  CHAT_RUNTIME_TIMEOUT_MS,
  isChatRuntimeResponse,
  projectChatRuntimeState,
  type ChatRuntimeState,
} from '@/message/chatRuntimeProtocol'
import { PENDING_GREETING_STORAGE_KEY } from '@/message/pendingGreetingProtocol'
import { getCurrentAppVersion } from '@/utils/extensionRuntimeHealth'

import { appendLocalDiagnosticEvent } from './localDiagnosticSink'

const recoveryKey = 'session:agent-delivery-chat-recovery'
const preparationTimeoutMs = 12_000
const recoveryCooldownMs = 60_000
let recoveryTail: Promise<unknown> = Promise.resolve()

export async function probeChatRuntime(
  tabId: number,
  expectedUid: string,
  wake = false,
  timeoutMs = CHAT_RUNTIME_TIMEOUT_MS + 250,
): Promise<ChatRuntimeState> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const requestId = crypto.randomUUID()
    const response = await Promise.race([
      browser.tabs.sendMessage(tabId, { type: CHAT_RUNTIME_REQUEST, requestId, expectedUid, wake }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
    if (!isChatRuntimeResponse(response) || response.requestId !== requestId)
      return {
        ready: false,
        code: 'CHAT_BRIDGE_UNAVAILABLE',
        reason: '聊天页未返回有效的发送器回执',
      }
    const state = projectChatRuntimeState(response)
    if (
      state.contentVersion !== getCurrentAppVersion() ||
      (state.mainVersion != null && state.mainVersion !== getCurrentAppVersion())
    ) {
      return {
        ...state,
        ready: false,
        code: 'CHAT_VERSION_MISMATCH',
        reason: '聊天页脚本版本与当前插件不一致',
      }
    }
    if (
      state.ready &&
      (!state.mainVersion ||
        !state.accountReady ||
        !state.accountMatches ||
        !state.consumerStarted ||
        !state.channelReady ||
        (wake && !state.wakeDelivered))
    ) {
      return {
        ...state,
        ready: false,
        code: 'CHAT_BRIDGE_UNAVAILABLE',
        reason: '聊天页就绪回执缺少必要确认',
      }
    }
    return state
  } catch {
    return {
      ready: false,
      code: 'CHAT_CONTENT_UNAVAILABLE',
      reason: '聊天页内容脚本未响应，可能尚未加载或已失效',
    }
  } finally {
    clearTimeout(timer)
  }
}

export function recordChatRuntime(accountUid: string, data: Record<string, unknown>) {
  void appendLocalDiagnosticEvent({
    stream: 'logs',
    event: 'runtime.chat-runtime',
    accountUid,
    data,
  }).catch(() => undefined)
}

async function recoverChatTab(tabId: number): Promise<string | undefined> {
  // Keep reload reservations serialized across tabs, including simultaneous greetings.
  // Persisted sending receipts remain untouched if a send races with this check.
  const recovery = recoveryTail
    .then(async () => {
      const queue = await storage.getItem<PendingGreeting[]>(PENDING_GREETING_STORAGE_KEY)
      if (
        Array.isArray(queue) &&
        queue.some((item) => item.status?.stage === 'sending' || item.status?.stage === 'sent')
      ) {
        return 'RECOVERY_BLOCKED_BY_UNCERTAIN_SEND'
      }
      const recoveries = (await storage.getItem<Record<string, number>>(recoveryKey)) ?? {}
      const now = Date.now()
      if (typeof recoveries[tabId] === 'number' && now - recoveries[tabId] < recoveryCooldownMs)
        return 'RECOVERY_COOLDOWN'
      const recent = Object.fromEntries(
        Object.entries(recoveries)
          .filter(([, at]) => typeof at === 'number' && now - at < recoveryCooldownMs)
          .slice(-99),
      )
      await storage.setItem(recoveryKey, { ...recent, [tabId]: now })
      await browser.tabs.reload(tabId)
      return undefined
    })
    .catch(() => 'CHAT_RECOVERY_FAILED')
  recoveryTail = recovery
  return recovery
}

export async function prepareChatRuntime(tabId: number, expectedUid: string, reused: boolean) {
  const startedAt = Date.now()
  const deadline = startedAt + preparationTimeoutMs
  let reloaded = false
  let recoveryCode: string | undefined
  let loaded = false
  let state: ChatRuntimeState = { ready: false, code: 'CHAT_LOADING', reason: '聊天页尚未加载' }
  while (Date.now() < deadline) {
    try {
      loaded = (await browser.tabs.get(tabId)).status === 'complete'
    } catch {
      state = { ready: false, code: 'CHAT_TAB_CLOSED', reason: '聊天页已关闭' }
      break
    }
    state = await probeChatRuntime(
      tabId,
      expectedUid,
      true,
      Math.min(CHAT_RUNTIME_TIMEOUT_MS + 250, deadline - Date.now()),
    )
    if (state.ready || state.code === 'ACCOUNT_MISMATCH' || state.code === 'NOT_CHAT_PAGE') break
    const brokenScript = [
      'CHAT_CONTENT_UNAVAILABLE',
      'CHAT_BRIDGE_UNAVAILABLE',
      'MAIN_WORLD_TIMEOUT',
      'CHAT_VERSION_MISMATCH',
    ].includes(state.code)
    if (
      reused &&
      brokenScript &&
      !reloaded &&
      recoveryCode == null &&
      (loaded || Date.now() - startedAt >= 2000)
    ) {
      recoveryCode = await recoverChatTab(tabId)
      if (recoveryCode) break
      reloaded = true
      recordChatRuntime(expectedUid, { stage: 'recovery', tabId, code: state.code, reloaded })
    }
    if (Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())))
  }
  const result = {
    ...state,
    tabId,
    loaded,
    reloaded,
    recoveryCode,
    handshakeMs: Date.now() - startedAt,
  }
  recordChatRuntime(expectedUid, { stage: 'prepared', reused, ...result })
  return result
}
