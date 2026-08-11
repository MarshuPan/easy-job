import { defineUnlistedScript } from '#imports'
import { getRootVue } from '@/composables/useVue'
import { startPendingGreetingConsumer } from '@/composables/useWebSocket/pendingGreeting'
import { logger } from '@/utils/logger'
import { isGeekChatUrl, JOB_UI_VISIBILITY_EVENT } from '@/utils/zhipinRoute'

let chatConsumerStarted = false
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
  chatConsumerStarted = true
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
  start().catch((e) => {
    logger.error(e)
  })
})
