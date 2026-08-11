export type AgentMessageType = 'success' | 'warning' | 'error' | 'info'

export const AGENT_MESSAGE_BRIDGE_CHANNEL = 'agent-delivery:ui-message'

export interface AgentMessageBridgePayload {
  channel: typeof AGENT_MESSAGE_BRIDGE_CHANNEL
  version: 1
  type: AgentMessageType
  content: string
  duration: number
}

const messageContainerId = 'agent-ui-message-container'
const maxMessageDuration = 30_000
const fallbackMessage: Record<AgentMessageType, string> = {
  success: '操作成功',
  warning: '操作未完成，请检查后重试',
  error: '操作失败，请稍后重试',
  info: '操作已更新',
}
const technicalContentPattern =
  /(?:https?:\/\/|[a-z]:[\\/]|(?:^|\s)(?:type|reference|syntax)?error\s*:|(?:^|\s)at\s+[\w$.<>]+\s*\(|\bhttp\s*\d{3}\b|^\s*(?:\{|\[)|\$\.[\w.[\]]+|"(?:stack|code|requestid|response)"\s*:)/i

export function normalizeAgentMessage(type: AgentMessageType, content: unknown) {
  if (typeof content !== 'string') return fallbackMessage[type]
  const text = content.replace(/\s+/g, ' ').trim()
  if (!text || technicalContentPattern.test(text)) return fallbackMessage[type]
  return text.length > 96 ? `${text.slice(0, 93)}...` : text
}

function normalizeMessageDuration(duration: number) {
  if (!Number.isFinite(duration)) return 3_000
  return Math.min(maxMessageDuration, Math.max(0, Math.trunc(duration)))
}

export function parseAgentMessageBridgePayload(value: unknown): AgentMessageBridgePayload | null {
  if (typeof value !== 'object' || value == null) return null
  const payload = value as Record<string, unknown>
  const type = payload.type
  if (
    payload.channel !== AGENT_MESSAGE_BRIDGE_CHANNEL ||
    payload.version !== 1 ||
    (type !== 'success' && type !== 'warning' && type !== 'error' && type !== 'info') ||
    typeof payload.content !== 'string' ||
    typeof payload.duration !== 'number' ||
    !Number.isFinite(payload.duration) ||
    payload.duration < 0 ||
    payload.duration > maxMessageDuration
  ) {
    return null
  }

  return {
    channel: AGENT_MESSAGE_BRIDGE_CHANNEL,
    version: 1,
    type,
    content: normalizeAgentMessage(type, payload.content),
    duration: Math.trunc(payload.duration),
  }
}

function getMessageHost() {
  return (
    document.querySelector<HTMLElement>('#agent-delivery-job [data-agent-message-host]') ??
    document.body ??
    document.documentElement
  )
}

export function syncAgentMessageContainerHost() {
  if (typeof document === 'undefined') return
  const container = document.getElementById(messageContainerId)
  if (container == null) return
  const host = getMessageHost()
  if (container.parentElement !== host) host.appendChild(container)
}

function getMessageContainer() {
  const host = getMessageHost()
  let container = document.getElementById(messageContainerId)
  if (container != null) {
    if (container.parentElement !== host) host.appendChild(container)
    return container
  }

  container = document.createElement('div')
  container.id = messageContainerId
  container.className = 'agent-ui-message-container'
  container.setAttribute('aria-live', 'polite')
  host.appendChild(container)
  return container
}

function forwardMessageToParent(payload: AgentMessageBridgePayload) {
  if (typeof window === 'undefined' || window.parent === window) return false
  window.parent.postMessage(payload, '*')
  return true
}

function showMessage(type: AgentMessageType, content: unknown, duration = 3_000) {
  const message = normalizeAgentMessage(type, content)
  const normalizedDuration = normalizeMessageDuration(duration)
  if (
    forwardMessageToParent({
      channel: AGENT_MESSAGE_BRIDGE_CHANNEL,
      version: 1,
      type,
      content: message,
      duration: normalizedDuration,
    })
  ) {
    return
  }
  if (typeof document === 'undefined') return

  const container = getMessageContainer()
  const item = document.createElement('div')
  item.className = `agent-ui-message agent-ui-message--${type}`
  item.setAttribute('role', type === 'error' ? 'alert' : 'status')

  const marker = document.createElement('i')
  marker.setAttribute('aria-hidden', 'true')
  const text = document.createElement('span')
  text.textContent = message
  item.append(marker, text)
  container.appendChild(item)

  window.setTimeout(() => {
    item.classList.add('is-leaving')
    window.setTimeout(() => {
      item.remove()
      if (container.childElementCount === 0) container.remove()
    }, 160)
  }, normalizedDuration)
}

export const AgentMessage = {
  success: (content: unknown, duration?: number) => showMessage('success', content, duration),
  warning: (content: unknown, duration?: number) => showMessage('warning', content, duration),
  error: (content: unknown, duration?: number) => showMessage('error', content, duration),
  info: (content: unknown, duration?: number) => showMessage('info', content, duration),
}
