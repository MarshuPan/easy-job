export const PENDING_GREETING_STORAGE_KEY = 'local:pending-greetings'
export const PENDING_GREETING_WAKE_TYPE = 'agent-delivery:pending-greeting-wake'

export function isPendingGreetingWake(
  value: unknown,
): value is { type: typeof PENDING_GREETING_WAKE_TYPE } {
  return (
    typeof value === 'object' &&
    value != null &&
    'type' in value &&
    value.type === PENDING_GREETING_WAKE_TYPE
  )
}
