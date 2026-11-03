import { storage } from '#imports'

import type { LocalDiagnosticEvent } from './localDiagnosticSink'

interface Association {
  accountUid: string
  conversationKey: string
  conversationKeys: string[]
  greetingId: string
  jobId?: string
  promptFingerprint?: string
  sentAt: number
}
interface SeenEntry {
  id: string
  seenAt: number
}
const key = 'local:agent-delivery-feedback-associations'
const seenKey = 'local:agent-delivery-feedback-seen'
const PLATFORM_CLOCK_SKEW_MS = 2 * 60 * 1000
export const FEEDBACK_ASSOCIATION_RETENTION_MS = 90 * 86400000
let associations: Association[] | undefined
let seen: SeenEntry[] | undefined

function keysOf(data: Record<string, unknown>) {
  const keys = Array.isArray(data.conversationKeys)
    ? data.conversationKeys.filter((key): key is string => typeof key === 'string')
    : []
  if (typeof data.conversationKey === 'string') keys.push(data.conversationKey)
  return [...new Set(keys.filter(Boolean))]
}

/** Serialized by the diagnostic outbox; cross-tab/reload dedupe uses platform message IDs. */
export async function enrichFeedback(
  event: LocalDiagnosticEvent,
): Promise<LocalDiagnosticEvent | null> {
  if (event.stream !== 'feedback') return event
  if (!associations) {
    // Publish the cache only after both independent reads succeeded, so a failed
    // seen-index read cannot leave the registry half initialized on the next event.
    const [saved, savedSeen] = await Promise.all([
      storage.getItem<Association[]>(key, { fallback: [] }),
      storage.getItem<unknown[]>(seenKey, { fallback: [] }),
    ])
    associations = Array.isArray(saved)
      ? saved
          .filter(
            (a) =>
              a &&
              typeof a.accountUid === 'string' &&
              typeof a.conversationKey === 'string' &&
              typeof a.greetingId === 'string' &&
              Number.isFinite(a.sentAt),
          )
          .map((a) => ({
            ...a,
            conversationKeys: Array.isArray(a.conversationKeys)
              ? a.conversationKeys.filter((key): key is string => typeof key === 'string')
              : [a.conversationKey],
          }))
      : []
    // The raw feedback stream is the evidence store.  This index only exists
    // to prevent retransmitted DOM/network messages from being counted twice;
    // retain it by the same time window as attribution instead of silently
    // dropping an arbitrary number of recent conversations.
    const migratedAt = Date.now()
    seen = Array.isArray(savedSeen)
      ? savedSeen.flatMap((entry) => {
          if (typeof entry === 'string') return [{ id: entry, seenAt: migratedAt }]
          if (
            entry &&
            typeof entry === 'object' &&
            typeof (entry as Record<string, unknown>).id === 'string' &&
            Number.isFinite((entry as Record<string, unknown>).seenAt)
          ) {
            return [
              {
                id: (entry as Record<string, unknown>).id as string,
                seenAt: (entry as Record<string, unknown>).seenAt as number,
              },
            ]
          }
          return []
        })
      : []
  }
  const data = event.data
  if (event.event === 'greeting.sent' && typeof data.greetingId === 'string') {
    const conversationKeys = keysOf(data)
    const conversationKey = conversationKeys[0]
    if (!conversationKey) return event
    const existing = associations.find(
      (a) => a.accountUid === event.accountUid && a.greetingId === data.greetingId,
    )
    if (!existing)
      associations.push({
        accountUid: event.accountUid,
        conversationKey,
        conversationKeys,
        greetingId: data.greetingId,
        jobId: typeof data.jobId === 'string' ? data.jobId : undefined,
        promptFingerprint:
          typeof data.promptFingerprint === 'string' ? data.promptFingerprint : undefined,
        sentAt: event.at,
      })
    associations = associations.filter(
      (a) => event.at - a.sentAt < FEEDBACK_ASSOCIATION_RETENTION_MS,
    )
    await storage.setItem(key, associations)
  }
  if (event.event !== 'conversation.message') return event
  if (
    data.source === 'network' &&
    typeof data.conversationKey === 'string' &&
    typeof data.messageId === 'string'
  ) {
    const id = [event.accountUid, data.conversationKey, data.direction, data.messageId].join('|')
    const cutoff = event.at - FEEDBACK_ASSOCIATION_RETENTION_MS
    seen = seen!.filter((entry) => entry.seenAt >= cutoff)
    if (seen!.some((entry) => entry.id === id)) return null
    seen!.push({ id, seenAt: event.at })
    await storage.setItem(seenKey, seen)
  }
  const messageAt = typeof data.messageAt === 'number' ? data.messageAt : undefined
  const observedAt = typeof data.observedAt === 'number' ? data.observedAt : event.at
  const messageKeys = keysOf(data)
  const candidates = associations.filter(
    (a) =>
      a.accountUid === event.accountUid &&
      messageKeys.some((key) => a.conversationKeys.includes(key)) &&
      messageAt != null &&
      messageAt >= a.sentAt - PLATFORM_CLOCK_SKEW_MS &&
      observedAt >= a.sentAt,
  )
  const association = candidates.sort((a, b) => b.sentAt - a.sentAt)[0]
  const eligible =
    data.replyEligible === true &&
    (data.source === 'network' || data.source === 'dom') &&
    data.direction === 'incoming' &&
    data.messageType === 'text' &&
    messageAt != null &&
    data.observation !== 'history' &&
    association != null
  event.data = {
    ...data,
    replyEligible: eligible,
    associationStatus: association ? 'matched' : 'unmatched',
    ...(association
      ? {
          greetingId: association.greetingId,
          jobId: association.jobId,
          promptFingerprint: association.promptFingerprint,
          firstSentAt: association.sentAt,
          platformClockSkewMs: messageAt == null ? undefined : messageAt - association.sentAt,
        }
      : {}),
  }
  return event
}
