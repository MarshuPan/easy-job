import { defineUnlistedScript } from '#imports'
import { getRootVue } from '@/composables/useVue'
import { startChatFeedbackObserver } from '@/composables/useWebSocket/chatFeedback'
import { startChatNetworkFeedbackObserver } from '@/composables/useWebSocket/chatNetworkFeedback'
import {
  consumePendingGreetings,
  getSendChannelReadiness,
  startPendingGreetingConsumer,
} from '@/composables/useWebSocket/pendingGreeting'
import {
  CHAT_RUNTIME_RESPONSE,
  isChatRuntimeRequest,
  type ChatRuntimeState,
} from '@/message/chatRuntimeProtocol'
import { isPendingGreetingWake } from '@/message/pendingGreetingProtocol'
import { useUser } from '@/stores/user'
import { getCurrentAppVersion } from '@/utils/extensionRuntimeHealth'
import { logger } from '@/utils/logger'
import { startRuntimeObservation } from '@/utils/runtimeObservation'
import { isGeekChatUrl, JOB_UI_VISIBILITY_EVENT } from '@/utils/zhipinRoute'

let chatConsumerStarted = false
let chatAccountInitialization: Promise<void> | undefined
let chatAccountInitialized = false
let routeHookRegistered = false
let routeInvocation = 0
const extensionLogoUrl = resolveExtensionLogoUrl()
const extensionPersonalUrl = resolveExtensionPersonalUrl()
const extensionInstanceId = resolveExtensionInstanceId()

function resolveExtensionInstanceId() {
  const script = document.currentScript as HTMLScriptElement | null
  return script?.dataset.agentDeliveryToken || crypto.randomUUID()
}

function resolveExtensionLogoUrl() {
  const script = document.currentScript as HTMLScriptElement | null
  const providedUrl = script?.dataset.agentDeliveryLogoUrl
  if (providedUrl) return providedUrl
  if (!script?.src) return ''
  try {
    return new URL('icons/logo.png', script.src).toString()
  } catch {
    return ''
  }
}

function resolveExtensionPersonalUrl() {
  const script = document.currentScript as HTMLScriptElement | null
  const providedUrl = script?.dataset.agentDeliveryPersonalUrl
  if (providedUrl) return providedUrl
  if (!script?.src) return ''
  try {
    return new URL('options.html', script.src).toString()
  } catch {
    return ''
  }
}

async function handleRoute(router: any) {
  const invocation = ++routeInvocation
  const path = router?.path ?? location.pathname
  if (path === '/web/geek/chat' || isGeekChatUrl(location.href)) {
    setJobUiVisible(false)
    startChatConsumerOnce()
    return
  }

  let module: {
    run(options: { logoUrl: string; personalUrl: string; instanceId: string }): void
  } | null = {
    run() {
      logger.info('Easy Job 加载成功')
      logger.warn('当前页面无对应hook脚本', path)
    },
  }
  switch (path) {
    case '/web/geek/job':
    case '/web/geek/job-recommend':
    case '/web/geek/jobs':
      module = await import('@/pages/zhipin')
      break
    default:
      module = null
  }
  if (invocation !== routeInvocation) return
  if (module == null) {
    setJobUiVisible(false)
    return
  }

  setJobUiVisible(true)
  module.run({
    logoUrl: extensionLogoUrl,
    personalUrl: extensionPersonalUrl,
    instanceId: extensionInstanceId,
  })
}

function setJobUiVisible(visible: boolean) {
  const helper = document.querySelector<HTMLElement>('#agent-delivery-job')
  if (!helper) return
  helper.hidden = !visible
  window.dispatchEvent(
    new CustomEvent(JOB_UI_VISIBILITY_EVENT, {
      detail: { visible },
    }),
  )
}

function startChatConsumerOnce() {
  if (chatConsumerStarted) return
  startPendingGreetingConsumer()
  startChatFeedbackObserver()
  chatConsumerStarted = true
  void initializeChatAccount()
    .then(() => consumePendingGreetings())
    .catch(reportChatRuntimeError)
}

async function initializeChatAccount() {
  const uid = useUser().getUserId()
  if (chatAccountInitialized && uid != null && String(uid).length > 0) return
  if (chatAccountInitialization == null) {
    chatAccountInitialization = (async () => {
      await useUser().initUser({ pollIntervalMs: 100, timeoutMs: 1500 })
      const initializedUid = useUser().getUserId()
      chatAccountInitialized = initializedUid != null && String(initializedUid).length > 0
    })().finally(() => {
      chatAccountInitialization = undefined
    })
  }
  await chatAccountInitialization
}

function reportChatRuntimeError(error: unknown) {
  logger.warn('聊天页发送器初始化或消费失败', error)
}

async function chatRuntimeState(expectedUid: string): Promise<ChatRuntimeState> {
  if (!isCurrentChatRoute())
    return {
      ready: false,
      code: 'NOT_CHAT_PAGE',
      reason: '目标页面已离开聊天页',
      mainVersion: getCurrentAppVersion(),
    }
  startChatConsumerOnce()
  await initializeChatAccount()
  const uid = useUser().getUserId()
  const accountReady = uid != null && String(uid).length > 0
  const accountMatches = accountReady && String(uid) === expectedUid
  const channel = getSendChannelReadiness()
  const code = !isCurrentChatRoute()
    ? 'NOT_CHAT_PAGE'
    : !accountReady
      ? 'ACCOUNT_UNAVAILABLE'
      : !accountMatches
        ? 'ACCOUNT_MISMATCH'
        : !channel.ready
          ? 'CHANNEL_UNAVAILABLE'
          : 'READY'
  return {
    ready: code === 'READY',
    code,
    mainVersion: getCurrentAppVersion(),
    reason:
      code === 'READY'
        ? '聊天页发送器已就绪'
        : code === 'NOT_CHAT_PAGE'
          ? '目标页面已离开聊天页'
          : !accountReady
            ? '聊天页账号尚未初始化'
            : !accountMatches
              ? '聊天页账号与投递账号不一致'
              : (channel.reason ?? '聊天页发送通道尚未就绪'),
    accountReady,
    accountMatches,
    consumerStarted: chatConsumerStarted,
    channelReady: channel.ready,
  }
}

function isCurrentChatRoute() {
  return location.pathname === '/web/geek/chat' || isGeekChatUrl(location.href)
}

async function start() {
  if (isCurrentChatRoute()) {
    startChatConsumerOnce()
    return
  }

  const v = await getRootVue()
  if (!routeHookRegistered) {
    v.$router.afterHooks.push(handleRoute)
    routeHookRegistered = true
  }
  void handleRoute(v.$route)
}

export default defineUnlistedScript(() => {
  window.addEventListener('message', (event) => {
    if (
      event.source === window &&
      event.origin === location.origin &&
      isChatRuntimeRequest(event.data) &&
      (event.data as { bridgeToken?: unknown }).bridgeToken === extensionInstanceId
    ) {
      const request = event.data
      void chatRuntimeState(request.expectedUid)
        .then((state) => {
          window.postMessage(
            {
              ...state,
              type: CHAT_RUNTIME_RESPONSE,
              requestId: request.requestId,
              bridgeToken: extensionInstanceId,
              wakeDelivered: request.wake && state.accountMatches === true,
            },
            location.origin,
          )
          if (request.wake && state.accountMatches)
            void consumePendingGreetings().catch(reportChatRuntimeError)
        })
        .catch(() => {
          window.postMessage(
            {
              type: CHAT_RUNTIME_RESPONSE,
              requestId: request.requestId,
              bridgeToken: extensionInstanceId,
              ready: false,
              code: 'CHAT_INITIALIZATION_FAILED',
              reason: '聊天页账号初始化失败',
              mainVersion: getCurrentAppVersion(),
            },
            location.origin,
          )
        })
      return
    }
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      !isPendingGreetingWake(event.data) ||
      !('bridgeToken' in event.data) ||
      event.data.bridgeToken !== extensionInstanceId ||
      !isCurrentChatRoute()
    )
      return
    void initializeChatAccount()
      .then(() => consumePendingGreetings())
      .catch(reportChatRuntimeError)
  })
  startChatNetworkFeedbackObserver()
  startRuntimeObservation()
  start().catch((e) => {
    logger.error(e)
  })
})
