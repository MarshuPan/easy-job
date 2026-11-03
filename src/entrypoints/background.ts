import type { StorageItemKey } from '#imports'
import { browser, defineBackground, storage } from '#imports'
import { flushLocalDiagnosticQueue } from '@/background/localDiagnosticSink'
import { startPendingGreetingWake } from '@/background/pendingGreetingWake'
import {
  resetSameHrHistoryOnce,
  sameHrResetMarkerKey,
  sameHrStorageMutex,
} from '@/composables/useApplying/sameHrPolicy'
import { ProvideBackgroundAdapter, provideBackgroundCounter } from '@/message/background'

async function resetSameHrHistoryOnStartup() {
  try {
    await sameHrStorageMutex(() =>
      resetSameHrHistoryOnce({
        storageGet: <T>(key: string, fallback: T) =>
          storage.getItem<T>(key as StorageItemKey, { fallback }),
        storageRm: (key: string) => storage.removeItem(key as StorageItemKey),
        storageSet: <T>(key: string, value: T) => storage.setItem(key as StorageItemKey, value),
      }),
    )
  } catch (error) {
    // The filtering step retries the same migration under its storage mutex.
    console.warn(`[Easy Job] ${sameHrResetMarkerKey} reset failed`, error)
  }
}

export default defineBackground({
  // type: 'module',
  main() {
    provideBackgroundCounter(new ProvideBackgroundAdapter())
    void resetSameHrHistoryOnStartup()
    startPendingGreetingWake()
    void flushLocalDiagnosticQueue()
    browser.alarms.create('agent-delivery-local-log-flush', { periodInMinutes: 1 })
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'agent-delivery-local-log-flush') void flushLocalDiagnosticQueue()
    })
  },
})
