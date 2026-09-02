export type DeliveryStopReason =
  | 'manual-stop'
  | 'manual-pause'
  | 'ai-unavailable'
  | 'session-unavailable'
  | 'security-check'
  | 'daily-limit'
  | 'terminal-error'
  | 'runtime-reconnect'
  | 'source-retry'
  | 'rate-limited'

/** Higher priority reasons must not be overwritten by a less important exit path. */
export const deliveryStopReasonPriority: Record<DeliveryStopReason, number> = {
  'rate-limited': 4,
  'manual-stop': 10,
  'manual-pause': 4,
  'ai-unavailable': 4,
  'session-unavailable': 4,
  'security-check': 5,
  'daily-limit': 3,
  'terminal-error': 2,
  'runtime-reconnect': 1,
  'source-retry': 1,
}

export function chooseDeliveryStopReason(
  current: DeliveryStopReason | null,
  next: DeliveryStopReason,
) {
  if (current == null) return next
  return deliveryStopReasonPriority[next] > deliveryStopReasonPriority[current] ? next : current
}

export function keepsDeliveryCheckpoint(reason: DeliveryStopReason | null) {
  return (
    reason === 'manual-pause' ||
    reason === 'ai-unavailable' ||
    reason === 'session-unavailable' ||
    reason === 'security-check'
  )
}

export function shouldAutoResumeDelivery(args: {
  reason: DeliveryStopReason | null
  terminalFailureMessage: string | null
  workerOwnershipBlocked: boolean
  hasDailyDeliveryRemaining: boolean
}) {
  const { reason, terminalFailureMessage, workerOwnershipBlocked, hasDailyDeliveryRemaining } = args
  return (
    reason !== 'security-check' &&
    reason !== 'manual-stop' &&
    reason !== 'daily-limit' &&
    reason !== 'terminal-error' &&
    reason !== 'manual-pause' &&
    reason !== 'ai-unavailable' &&
    reason !== 'session-unavailable' &&
    terminalFailureMessage == null &&
    !workerOwnershipBlocked &&
    hasDailyDeliveryRemaining
  )
}
