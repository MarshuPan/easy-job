import { useUser } from '@/stores/user'
import {
  appendConversationMessage,
  appendGreetingFeedbackEvent,
  conversationKeyFromUrl,
  feedbackText,
  type GreetingFeedbackDirection,
} from '@/utils/greetingFeedback'

export const CHAT_MESSAGE_MARKER_SELECTOR = [
  '[data-message-id]',
  '[data-msg-id]',
  '[data-mid]',
  '[class*="message-item"]',
  '[class*="message-list-item"]',
  '[class*="msg-item"]',
  '[class*="chat-item"]',
  '[class*="chat-message"]',
  '[class*="im-message"]',
  '[class*="message-bubble"]',
  '[class*="msg-bubble"]',
  '[class*="msg-wrapper"]',
  '[class*="conversation-message"]',
  '[class*="item-my"]',
  '[class*="item-other"]',
].join(',')

const markerSelector = CHAT_MESSAGE_MARKER_SELECTOR

export interface ChatMessageCandidate {
  element: Element
  messageId?: string
  direction: GreetingFeedbackDirection
  messageType: 'text' | 'system' | 'unknown'
  messageAt?: number
  senderRole?: string
  marker: string
  text: string
  textLength: number
}

function isElement(value: unknown): value is Element {
  return typeof Element !== 'undefined' && value instanceof Element
}

function ancestorElements(element: Element) {
  const elements: Element[] = []
  let current: Element | null = element
  while (current != null) {
    elements.push(current)
    current = current.parentElement
  }
  return elements
}

function attributeValues(element: Element) {
  return [
    element.getAttribute('data-direction'),
    element.getAttribute('data-sender'),
    element.getAttribute('data-sender-role'),
    element.getAttribute('data-role'),
    element.getAttribute('aria-label'),
    typeof element.className === 'string' ? element.className : '',
  ].filter((value): value is string => Boolean(value?.trim()))
}

export function classifyMessageDirection(element: Element): GreetingFeedbackDirection {
  const values = ancestorElements(element)
    .flatMap((item) => attributeValues(item))
    .join(' ')
    .toLowerCase()
  if (
    /(^|[-_\s])(mine|my|self|me|sent|sending|delivered|read|outgoing|right|right[-_]?side|from[-_]?me|item[-_]?my|is[-_]?(?:mine|self)|我方|本人|送达|已读)([-_\s]|$)/i.test(
      values,
    )
  ) {
    return 'outgoing'
  }
  if (
    /(^|[-_\s])(other|receive|received|receiving|incoming|left|left[-_]?side|from[-_]?other|item[-_]?other|is[-_]?other|对方|收到)([-_\s]|$)/i.test(
      values,
    )
  ) {
    return 'incoming'
  }
  return 'unknown'
}

function messageMarker(element: Element) {
  if (element.hasAttribute('data-message-id')) return 'data-message-id'
  if (element.hasAttribute('data-msg-id')) return 'data-msg-id'
  if (element.hasAttribute('data-mid')) return 'data-mid'
  const className = typeof element.className === 'string' ? element.className : ''
  const token = className.split(/\s+/).find((item) => /message|msg|bubble/i.test(item))
  return token ?? 'message-marker'
}

function getMessageId(element: Element) {
  const value =
    element.getAttribute('data-message-id') ??
    element.getAttribute('data-msg-id') ??
    element.getAttribute('data-mid')
  if (value?.trim()) return value.trim()
  return undefined
}

function getSenderRole(element: Element) {
  const value = ancestorElements(element)
    .map(
      (item) =>
        item.getAttribute('data-sender-role') ??
        item.getAttribute('data-sender') ??
        item.getAttribute('aria-label'),
    )
    .find((item) => item?.trim())
  return value?.trim() || undefined
}

function parsePlatformTime(value: string | null | undefined) {
  if (!value?.trim()) return undefined
  const numeric = Number(value)
  const timestamp = Number.isFinite(numeric)
    ? numeric < 1e12
      ? numeric * 1000
      : numeric
    : Date.parse(value)
  return Number.isFinite(timestamp) &&
    timestamp >= 946684800000 &&
    timestamp <= Date.now() + 86400000
    ? timestamp
    : undefined
}

function getMessageAt(element: Element) {
  for (const item of ancestorElements(element)) {
    for (const name of ['data-time', 'data-timestamp', 'data-message-time', 'data-created-at']) {
      const parsed = parsePlatformTime(item.getAttribute(name))
      if (parsed != null) return parsed
    }
    const datetime = item.querySelector('time[datetime]')?.getAttribute('datetime')
    const parsed = parsePlatformTime(datetime)
    if (parsed != null) return parsed
  }
  return undefined
}

function getMessageType(element: Element): 'text' | 'system' | 'unknown' {
  const values = ancestorElements(element)
    .flatMap((item) => [
      item.getAttribute('data-message-type'),
      item.getAttribute('data-type'),
      typeof item.className === 'string' ? item.className : '',
    ])
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' ')
    .toLowerCase()
  if (/system|notice|notification|pk|card|tips?|竞争者|超过竞争者/.test(values)) return 'system'
  return 'text'
}

function textFromElement(element: Element) {
  const preferred = element.querySelector(
    '[data-message-text], [data-text], .message-text, .msg-text, .message-content, .msg-content',
  )
  const source = preferred ?? element
  const clone = source.cloneNode(true) as Element
  clone
    .querySelectorAll('button, input, textarea, svg, time, [aria-hidden="true"]')
    .forEach((item) => item.remove())
  return feedbackText(clone.textContent ?? '')
}

function findMessageElement(element: Element) {
  let current: Element | null = element
  while (current != null) {
    if (current.matches(markerSelector)) return current
    current = current.parentElement
  }
  return null
}

export function extractChatMessageCandidate(element: Element): ChatMessageCandidate | null {
  let messageElement = findMessageElement(element)
  if (!messageElement) return null
  const stableSelector = '[data-message-id], [data-msg-id], [data-mid]'
  const identified = messageElement.closest(stableSelector)
  if (identified) messageElement = identified
  else {
    const descendants = messageElement.querySelectorAll(stableSelector)
    if (descendants.length > 1) return null
    if (descendants.length === 1) messageElement = descendants[0]
  }
  const text = textFromElement(messageElement)
  // Keep long recruiter messages for local analysis. `feedbackText` applies the
  // explicit resource bound and records whether it truncated anything; silently
  // dropping a message here made reply-rate diagnostics impossible.
  if (!text.text) return null
  if (/竞争者PK情况|你超过竞争者/.test(text.text)) return null
  const messageType = getMessageType(messageElement)
  if (messageType === 'system') return null
  return {
    element: messageElement,
    messageId: getMessageId(messageElement),
    direction: classifyMessageDirection(messageElement),
    messageType,
    messageAt: getMessageAt(messageElement),
    senderRole: getSenderRole(messageElement),
    marker: messageMarker(messageElement),
    ...text,
  }
}

function scanCandidates(root: ParentNode) {
  const candidates: Element[] = []
  if (isElement(root) && root.matches(markerSelector)) candidates.push(root)
  if ('querySelectorAll' in root) {
    candidates.push(...Array.from(root.querySelectorAll(markerSelector)))
  }
  return candidates
}

function safeAccountUid() {
  try {
    return useUser().getUserId()
  } catch {
    return null
  }
}

let activeStop: (() => void) | undefined

/** Observe rendered chat bubbles; initial history is baselined and only later changes are emitted. */
export function startChatFeedbackObserver() {
  if (activeStop != null) return activeStop
  if (typeof MutationObserver === 'undefined') return () => {}

  // The unlisted script can run before BOSS has populated `document.body` or
  // the user store. Observe the document element and resolve the account at
  // event time so a fast route transition does not permanently disable
  // feedback collection.
  const root = document.documentElement
  if (!root) return () => {}
  const observerStartedAt = Date.now()
  const seenKeys = new Set<string>()
  let stopped = false
  let observerStarted = false
  let observerStartTimer: number | undefined

  const emitObserverStarted = () => {
    if (stopped || observerStarted) return
    const accountUid = safeAccountUid()
    if (accountUid == null) return
    observerStarted = true
    if (observerStartTimer != null) {
      window.clearInterval(observerStartTimer)
      observerStartTimer = undefined
    }
    void appendGreetingFeedbackEvent(accountUid, 'conversation.observer', {
      kind: 'observer',
      status: 'started',
      source: 'dom',
      conversationKey: currentConversationKey(),
      baselineCount: seenKeys.size,
    })
    scan(root, true)
  }

  const currentConversationKey = () => conversationKeyFromUrl(location.href)
  const eventKey = (candidate: ChatMessageCandidate) =>
    [
      currentConversationKey() ?? 'unknown-conversation',
      candidate.direction,
      candidate.messageId ?? candidate.text,
    ].join('|')

  const scan = (target: ParentNode, emit: boolean) => {
    for (const element of scanCandidates(target)) {
      const candidate = extractChatMessageCandidate(element)
      if (!candidate) continue
      const key = eventKey(candidate)
      if (!emit || seenKeys.has(key)) {
        seenKeys.add(key)
        continue
      }
      const accountUid = safeAccountUid()
      if (accountUid == null) continue
      seenKeys.add(key)
      void appendConversationMessage(accountUid, {
        conversationKey: currentConversationKey(),
        messageId: candidate.messageId,
        direction: candidate.direction,
        senderRole: candidate.senderRole,
        marker: candidate.marker,
        text: candidate.text,
        source: 'dom',
        messageType: candidate.messageType,
        messageAt: candidate.messageAt,
        observation:
          candidate.messageAt != null && candidate.messageAt < observerStartedAt - 60_000
            ? 'history'
            : 'live',
        replyEligible:
          candidate.direction === 'incoming' &&
          candidate.messageType === 'text' &&
          candidate.messageAt != null,
      })
    }
  }

  scan(root, false)
  emitObserverStarted()
  if (!observerStarted) {
    observerStartTimer = window.setInterval(emitObserverStarted, 1000)
  }

  const observer = new MutationObserver((records) => {
    if (stopped) return
    for (const record of records) {
      if (record.type === 'characterData') {
        if (record.target.parentElement) scan(record.target.parentElement, true)
        continue
      }
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node as Element, true)
        if (node.parentElement) scan(node.parentElement, true)
      }
      if (isElement(record.target)) scan(record.target, true)
    }
  })
  observer.observe(root, { childList: true, subtree: true, characterData: true })

  const stop = () => {
    if (stopped) return
    stopped = true
    observer.disconnect()
    if (observerStartTimer != null) {
      window.clearInterval(observerStartTimer)
      observerStartTimer = undefined
    }
    if (activeStop === stop) activeStop = undefined
  }
  activeStop = stop
  return stop
}

export function stopChatFeedbackObserver() {
  activeStop?.()
}
