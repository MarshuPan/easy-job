import { browser } from 'wxt/browser'

import { defineContentScript, injectScript } from '#imports'
import { ProvideContentAdapter, provideContentCounter } from '@/message/contentScript'
import { setBridgeToken } from '@/message/contentScript'

import '@/main.scss'

export default defineContentScript({
  matches: ['*://zhipin.com/*', '*://*.zhipin.com/*'],
  async main(_ctx) {
    const bridgeToken = crypto.randomUUID()
    setBridgeToken(bridgeToken)
    provideContentCounter(new ProvideContentAdapter())

    const { script } = await injectScript('/main-world.js', {
      keepInDom: true,
      modifyScript(script) {
        script.dataset.agentDeliveryToken = bridgeToken
        script.dataset.agentDeliveryLogoUrl = browser.runtime.getURL('/icons/logo.png')
        script.dataset.agentDeliveryPersonalUrl = new URL(
          'options.html',
          browser.runtime.getURL('/main-world.js'),
        ).toString()
      },
    })
    script.removeAttribute('data-agent-delivery-token')
    script.removeAttribute('data-agent-delivery-logo-url')
    script.removeAttribute('data-agent-delivery-personal-url')
  },
})
