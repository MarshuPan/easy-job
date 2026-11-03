import { counter } from '@/message'
import { useUser } from '@/stores/user'

import { getCurrentAppVersion } from './extensionRuntimeHealth'
import { createGreetingId } from './greetingFeedback'

export function startRuntimeObservation() {
  const pageSessionId = createGreetingId()
  let sequence = 0
  let lastAt = Date.now()
  const emit = (reason: string) => {
    let uid: string | number | null | undefined
    try {
      uid = useUser().getUserId()
    } catch {
      uid = undefined
    }
    if (typeof counter.localDiagnosticAppend !== 'function') return
    const accountKnown = uid != null && String(uid).length > 0
    const now = Date.now()
    void counter
      .localDiagnosticAppend({
        stream: 'logs',
        event: 'runtime.page-health',
        accountUid: accountKnown ? String(uid) : undefined,
        at: now,
        data: {
          pageSessionId,
          sequence: ++sequence,
          reason,
          route: location.pathname,
          visibility: document.visibilityState,
          online: navigator.onLine,
          elapsedSinceLastMs: now - lastAt,
          version: getCurrentAppVersion(),
          accountKnown,
        },
      })
      .catch(() => undefined)
    lastAt = now
  }
  const listeners: Array<[EventTarget, string, EventListener]> = []
  for (const [target, types] of [
    [document, ['visibilitychange', 'freeze', 'resume']],
    [window, ['pagehide', 'pageshow', 'online', 'offline']],
  ] as const) {
    for (const type of types) {
      const listener = () => emit(type)
      target.addEventListener(type, listener)
      listeners.push([target, type, listener])
    }
  }
  const timer = window.setInterval(() => emit('heartbeat'), 30_000)
  emit('started')
  return () => {
    window.clearInterval(timer)
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener)
  }
}
