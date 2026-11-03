import { browser, storage } from '#imports'
import type { PendingGreeting } from '@/composables/useWebSocket/pendingGreeting'
import { PENDING_GREETING_STORAGE_KEY } from '@/message/pendingGreetingProtocol'

import { probeChatRuntime, recordChatRuntime } from './chatRuntime'

/** Runtime messages wake a background chat page without relying on its throttled timers. */
export function startPendingGreetingWake() {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let running = false
  let pending = false
  const lastReports = new Map<string, { signature: string; at: number }>()

  async function tick() {
    timer = undefined
    if (stopped || running) return
    running = true
    try {
      const queue = await storage.getItem<PendingGreeting[]>(PENDING_GREETING_STORAGE_KEY)
      pending =
        Array.isArray(queue) &&
        queue.some(
          (item) =>
            item &&
            Date.now() - item.createdAt < 5 * 60_000 &&
            (!item.status || item.status.stage === 'queued' || item.status.stage === 'waiting'),
        )
      if (!pending) return
      const tabs = await browser.tabs.query({
        url: ['*://zhipin.com/web/geek/chat*', '*://*.zhipin.com/web/geek/chat*'],
      })
      const accountUids = [
        ...new Set(
          queue!
            .filter(
              (item) =>
                item &&
                Date.now() - item.createdAt < 5 * 60_000 &&
                (!item.status || item.status.stage === 'queued' || item.status.stage === 'waiting'),
            )
            .map((item) => item.fromUid)
            .filter(Boolean),
        ),
      ]
      for (const accountUid of accountUids) {
        const targets = tabs.filter((tab) => tab.id != null)
        const results = await Promise.allSettled(
          targets.map(async (tab) => ({
            tabId: tab.id!,
            ...(await probeChatRuntime(tab.id!, accountUid, true)),
          })),
        )
        const states = results.length
          ? results.map((result) =>
              result.status === 'fulfilled'
                ? result.value
                : { ready: false, code: 'CHAT_WAKE_FAILED', reason: '聊天页唤醒失败' },
            )
          : [{ ready: false, code: 'NO_CHAT_TAB', reason: '没有已打开的聊天页' }]
        const signature = JSON.stringify(states)
        const previous = lastReports.get(accountUid)
        if (!previous || previous.signature !== signature || Date.now() - previous.at >= 30_000) {
          recordChatRuntime(accountUid, { stage: 'wake', chatTabs: targets.length, states })
          lastReports.set(accountUid, { signature, at: Date.now() })
        }
      }
    } catch {
      // Page reloads, closed tabs and extension updates must not affect delivery.
    } finally {
      running = false
      if (pending) schedule()
    }
  }
  function schedule() {
    if (!stopped && timer == null)
      timer = setTimeout(() => {
        void tick()
      }, 1000)
  }
  const unwatch = storage.watch(PENDING_GREETING_STORAGE_KEY, () => {
    pending = true
    schedule()
  })
  void tick()
  return () => {
    stopped = true
    unwatch()
    if (timer != null) clearTimeout(timer)
  }
}
