import { counter } from '@/message'
import { getCurrentAppVersion } from '@/utils/extensionRuntimeHealth'
import { getGeekChatIdFromUrl } from '@/utils/zhipinRoute'

export type GreetingFeedbackDirection = 'incoming' | 'outgoing' | 'unknown'

export interface GreetingFeedbackContext {
  greetingId: string
  attempt: number
  conversationKey?: string
  /** Numeric UID and encrypted chat-route ID are both valid platform aliases. */
  conversationKeys?: string[]
  jobId?: string
  jobName?: string
  brandName?: string
  bossUid?: string
  promptFingerprint?: string
  resumeEvidenceVersion?: number
  resumeSourceHash?: string
}

export interface GreetingFeedbackSegment {
  index: number
  text: string
  textLength: number
  factIds?: string[]
}

/** 本机测试镜像要保留完整招呼语和聊天反馈；只对异常巨大的单条文本设资源上限。 */
export const FEEDBACK_TEXT_MAX_LENGTH = 64 * 1024 * 1024

function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

export function createGreetingId() {
  try {
    return crypto.randomUUID()
  } catch {
    return `greeting-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

export function normalizeFeedbackText(value: unknown) {
  if (typeof value !== 'string') return ''
  return value
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0)
      return !(
        code <= 8 ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        code === 127
      )
    })
    .join('')
}

export function feedbackText(value: unknown) {
  const rawText = typeof value === 'string' ? value : ''
  const normalized = normalizeFeedbackText(value)
  return {
    text: normalized.slice(0, FEEDBACK_TEXT_MAX_LENGTH),
    textLength: normalized.length,
    textTruncated: normalized.length > FEEDBACK_TEXT_MAX_LENGTH,
    rawText: rawText.slice(0, FEEDBACK_TEXT_MAX_LENGTH),
    rawTextLength: rawText.length,
    rawTextTruncated: rawText.length > FEEDBACK_TEXT_MAX_LENGTH,
  }
}

export function conversationKeyFromBossId(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const id = String(value).trim()
  return id ? `boss:${id}` : undefined
}

export function conversationKeysFromBossIds(...values: unknown[]) {
  return [...new Set(values.map(conversationKeyFromBossId).filter((key): key is string => !!key))]
}

export function conversationKeyFromUrl(href: string) {
  return conversationKeyFromBossId(getGeekChatIdFromUrl(href))
}

export function createFeedbackSegments(
  messages: readonly string[],
  segmentFactIds?: readonly (readonly string[])[],
): GreetingFeedbackSegment[] {
  return messages.map((message, index) => {
    const text = feedbackText(message)
    return {
      index: index + 1,
      ...text,
      ...(segmentFactIds ? { factIds: [...new Set(segmentFactIds[index] ?? [])] } : {}),
    }
  })
}

export function appendGreetingFeedbackEvent(
  accountUid: string | number | null | undefined,
  event: string,
  data: Record<string, unknown>,
  at = Date.now(),
) {
  if (accountUid == null || String(accountUid).trim() === '') return Promise.resolve(false)
  const append = counter.localDiagnosticAppend
  if (typeof append !== 'function') return Promise.resolve(false)
  return append({
    stream: 'feedback',
    event,
    accountUid: String(accountUid),
    at,
    data,
  }).catch(() => false)
}

export function appendGreetingGenerated(
  accountUid: string | number | null | undefined,
  context: GreetingFeedbackContext,
  args: {
    type: 'ai' | 'custom'
    messages: readonly string[]
    usedFactIds?: readonly string[]
    anchor?: { need?: string; jdQuote?: string }
    review?: object
    audit?: object
    fingerprint?: string
    segmentFactIds?: readonly (readonly string[])[]
  },
) {
  const segments = createFeedbackSegments(args.messages, args.segmentFactIds)
  return appendGreetingFeedbackEvent(
    accountUid,
    'greeting.generated',
    compactRecord({
      kind: 'greeting',
      direction: 'outgoing' satisfies GreetingFeedbackDirection,
      ...context,
      generatorVersion: getCurrentAppVersion(),
      greetingType: args.type,
      segmentCount: segments.length,
      totalChars: segments.reduce((sum, segment) => sum + segment.textLength, 0),
      segments,
      usedFactIds: args.usedFactIds ? [...new Set(args.usedFactIds)] : undefined,
      anchorNeed: args.anchor?.need,
      anchorQuote: args.anchor?.jdQuote,
      review: args.review,
      audit: args.audit,
      fingerprint: args.fingerprint,
    }),
  )
}

export function appendGreetingSent(
  accountUid: string | number | null | undefined,
  context: GreetingFeedbackContext,
  args: {
    type: 'ai' | 'custom'
    index: number
    total: number
    text: string
    channel?: string
    pendingId?: string
    factIds?: readonly string[]
  },
) {
  return appendGreetingFeedbackEvent(
    accountUid,
    'greeting.sent',
    compactRecord({
      kind: 'greeting',
      direction: 'outgoing' satisfies GreetingFeedbackDirection,
      ...context,
      generatorVersion: getCurrentAppVersion(),
      greetingType: args.type,
      segmentIndex: args.index,
      segmentCount: args.total,
      channel: args.channel,
      pendingId: args.pendingId,
      factIds: args.factIds ? [...new Set(args.factIds)] : undefined,
      confirmation: 'local-channel',
      ...feedbackText(args.text),
    }),
  )
}

export function appendGreetingFailed(
  accountUid: string | number | null | undefined,
  context: GreetingFeedbackContext,
  args: {
    type: 'ai' | 'custom'
    index?: number
    total?: number
    text?: string
    stage: 'generation' | 'send'
    error: string
  },
) {
  const errorText = feedbackText(args.error)
  return appendGreetingFeedbackEvent(
    accountUid,
    'greeting.failed',
    compactRecord({
      kind: 'greeting',
      direction: 'outgoing' satisfies GreetingFeedbackDirection,
      ...context,
      generatorVersion: getCurrentAppVersion(),
      greetingType: args.type,
      segmentIndex: args.index,
      segmentCount: args.total,
      stage: args.stage,
      error: errorText.text,
      errorLength: errorText.textLength,
      errorTruncated: errorText.textTruncated,
      ...(args.text == null ? {} : feedbackText(args.text)),
    }),
  )
}

export function appendConversationMessage(
  accountUid: string | number | null | undefined,
  args: {
    conversationKey?: string
    conversationKeys?: readonly string[]
    messageId?: string
    direction: GreetingFeedbackDirection
    senderRole?: string
    marker?: string
    text: string
    source: 'dom' | 'network' | 'manual'
    observedAt?: number
    messageAt?: number
    messageType?: 'text' | 'system' | 'unknown'
    observation?: 'live' | 'history'
    replyEligible?: boolean
    confirmation?: 'platform-message-observed'
  },
) {
  return appendGreetingFeedbackEvent(
    accountUid,
    'conversation.message',
    compactRecord({
      kind: 'conversation',
      ...args,
      observedAt: args.observedAt ?? Date.now(),
      ...feedbackText(args.text),
    }),
    args.observedAt,
  )
}
