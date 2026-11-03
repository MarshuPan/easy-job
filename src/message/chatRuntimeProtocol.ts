export const CHAT_RUNTIME_REQUEST = 'agent-delivery:chat-runtime-request'
export const CHAT_RUNTIME_RESPONSE = 'agent-delivery:chat-runtime-response'
export const CHAT_RUNTIME_TIMEOUT_MS = 2500

export interface ChatRuntimeRequest {
  type: typeof CHAT_RUNTIME_REQUEST
  requestId: string
  expectedUid: string
  wake: boolean
}

export interface ChatRuntimeState {
  ready: boolean
  code: string
  reason: string
  mainVersion?: string
  contentVersion?: string
  accountReady?: boolean
  accountMatches?: boolean
  consumerStarted?: boolean
  channelReady?: boolean
  wakeDelivered?: boolean
}

export interface ChatRuntimeResponse extends ChatRuntimeState {
  type: typeof CHAT_RUNTIME_RESPONSE
  requestId: string
}

export function isChatRuntimeRequest(value: unknown): value is ChatRuntimeRequest {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ChatRuntimeRequest>
  return (
    item.type === CHAT_RUNTIME_REQUEST &&
    typeof item.requestId === 'string' &&
    item.requestId.length > 0 &&
    item.requestId.length < 100 &&
    typeof item.expectedUid === 'string' &&
    item.expectedUid.length > 0 &&
    item.expectedUid.length < 100 &&
    typeof item.wake === 'boolean'
  )
}

export function isChatRuntimeResponse(value: unknown): value is ChatRuntimeResponse {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ChatRuntimeResponse>
  return (
    item.type === CHAT_RUNTIME_RESPONSE &&
    typeof item.requestId === 'string' &&
    typeof item.ready === 'boolean' &&
    typeof item.code === 'string' &&
    typeof item.reason === 'string' &&
    item.code.length < 100 &&
    item.reason.length < 500 &&
    ['accountReady', 'accountMatches', 'consumerStarted', 'channelReady', 'wakeDelivered'].every(
      (key) =>
        (item as Record<string, unknown>)[key] === undefined ||
        typeof (item as Record<string, unknown>)[key] === 'boolean',
    ) &&
    ['mainVersion', 'contentVersion'].every(
      (key) =>
        (item as Record<string, unknown>)[key] === undefined ||
        (typeof (item as Record<string, unknown>)[key] === 'string' &&
          ((item as Record<string, unknown>)[key] as string).length < 50),
    )
  )
}

/** Project only diagnostics; never return an account UID or a bridge token. */
export function projectChatRuntimeState(value: ChatRuntimeState): ChatRuntimeState {
  return {
    ready: value.ready,
    code: value.code,
    reason: value.reason,
    mainVersion: value.mainVersion,
    contentVersion: value.contentVersion,
    accountReady: value.accountReady,
    accountMatches: value.accountMatches,
    consumerStarted: value.consumerStarted,
    channelReady: value.channelReady,
    wakeDelivered: value.wakeDelivered,
  }
}
