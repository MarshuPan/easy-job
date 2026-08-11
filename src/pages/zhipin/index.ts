import { createPinia } from 'pinia'
import { createApp } from 'vue'

import { EXTENSION_CONTEXT_INVALIDATED_EVENT } from '@/utils/extensionRuntimeHealth'
import { logger } from '@/utils/logger'

import Ui from './components/Ui.vue'

import './index.scss'

interface JobUiOptions {
  logoUrl: string
  personalUrl: string
  instanceId: string
}

type AgentDeliveryRoot = HTMLElement & {
  __vue_app__?: { unmount?: () => void }
  __agentDeliveryUnmount?: () => void
}

async function mountVue(options: JobUiOptions) {
  const existingRoot = document.querySelector<AgentDeliveryRoot>('#agent-delivery-job')
  if (existingRoot?.dataset.agentDeliveryInstance === options.instanceId) {
    return
  }
  if (existingRoot) {
    if (existingRoot.__agentDeliveryUnmount) {
      existingRoot.__agentDeliveryUnmount()
    } else {
      existingRoot.__vue_app__?.unmount?.()
    }
    existingRoot.remove()
  }
  const app = createApp(Ui, { ...options })
  app.use(createPinia())

  const jobEl = document.createElement('div') as AgentDeliveryRoot
  jobEl.id = 'agent-delivery-job'
  jobEl.dataset.agentDeliveryInstance = options.instanceId
  document.body.appendChild(jobEl)
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    window.removeEventListener(EXTENSION_CONTEXT_INVALIDATED_EVENT, dispose)
    app.unmount?.()
    jobEl.remove()
  }
  jobEl.__agentDeliveryUnmount = dispose
  window.addEventListener(EXTENSION_CONTEXT_INVALIDATED_EVENT, dispose, { once: true })
  try {
    app.mount(jobEl)
  } catch (error) {
    dispose()
    throw error
  }
}

export async function run(options: JobUiOptions) {
  logger.info('加载/web/geek/job页面Hook')
  return mountVue(options)
}
