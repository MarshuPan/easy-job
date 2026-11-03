import { storage } from '#imports'

import { enrichFeedback } from './feedbackRegistry'

export type LocalDiagnosticStream = 'logs' | 'deliveries' | 'tasks' | 'feedback'

export interface LocalDiagnosticEventInput {
  stream: LocalDiagnosticStream
  event: string
  accountUid?: string
  at?: number
  data?: Record<string, unknown>
}

export interface LocalDiagnosticEvent {
  schemaVersion: 1
  id: string
  at: number
  accountUid: string
  stream: LocalDiagnosticStream
  event: string
  data: Record<string, unknown>
  sourceSessionId?: string
  sequence?: number
  chunkOf?: string
  chunkIndex?: number
  chunkCount?: number
}

const LOCAL_LOG_SINK_ENDPOINT = 'http://127.0.0.1:3210/v1/events'
const LOCAL_LOG_QUEUE_KEY = 'local:agent-delivery-local-log-queue'
const BATCH_SIZE = 25
/**
 * 单次后台唤醒最多发送这么多批，避免接收器恢复时长时间占住 service worker。
 * 这不是保留上限；没有收到接收器确认的事件继续留在 outbox，下一次唤醒接着发。
 */
const MAX_FLUSH_BATCHES = 20
/** 单条传输记录的上限；超过时在本机拆成可重组分片，而不是丢弃业务数据。 */
const MAX_EVENT_BYTES = 512 * 1024
const MAX_CHUNK_PAYLOAD_BYTES = 256 * 1024
// These are last-resort resource guards. Normal resumes, prompts, jobs and
// provider payloads must reach the local mirror intact; oversized events are
// split after sanitization so the receiver can reconstruct them.
const MAX_STRING_LENGTH = 64 * 1024 * 1024
const MAX_ARRAY_LENGTH = 100_000
const MAX_OBJECT_DEPTH = 64
const RETRY_COOLDOWN_MS = 15_000
const blockedKeys = new Set([
  'apikey',
  'xapikey',
  'accesskey',
  'accesstoken',
  'authtoken',
  'bearertoken',
  'bridgetoken',
  'clientsecret',
  'privatekey',
  'secretkey',
  'signaturekey',
  'signingkey',
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'token',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'credential',
  'credentials',
  'csrftoken',
  'xsrftoken',
])

let queue: LocalDiagnosticEvent[] | undefined
let queueLoad: Promise<LocalDiagnosticEvent[]> | undefined
let mutationQueue: Promise<void> = Promise.resolve()
let retryAfter = 0
const sourceSessionId = createEventId()
let sequence = 0
const healthKey = 'local:agent-delivery-local-log-health'
let health = {
  produced: 0,
  acknowledged: 0,
  dropped: 0,
  persistFailures: 0,
  lastAckAt: 0,
  lastFailure: '',
}
const accounts = new Set<string>()
let lastHealthAt = 0

function rememberAccount(uid: string) {
  if (!/^anon-[a-f0-9]{8,64}$/.test(uid)) return
  accounts.add(uid)
  if (accounts.size > 100) accounts.delete(accounts.values().next().value!)
}

function restoreHealth(saved: unknown) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return
  const value = saved as Record<string, unknown>
  for (const key of [
    'produced',
    'acknowledged',
    'dropped',
    'persistFailures',
    'lastAckAt',
  ] as const) {
    if (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0)
      health[key] = value[key]
  }
  if (typeof value.lastFailure === 'string') health.lastFailure = safeString(value.lastFailure)
  if (Array.isArray(value.accounts)) {
    for (const uid of value.accounts.slice(-100)) {
      if (typeof uid === 'string' && /^anon-[a-f0-9]{8,64}$/.test(uid)) rememberAccount(uid)
    }
  }
}

function enqueue<T>(operation: () => Promise<T>) {
  const next = mutationQueue.then(operation)
  mutationQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[\s_-]/g, '')
}

function isBlockedKey(key: string) {
  const normalized = normalizeKey(key)
  // Match complete credential field names only. A substring match turns
  // ordinary model usage fields such as input_tokens into missing evidence.
  return blockedKeys.has(normalized)
}

function redactUrlCredentials(value: string) {
  return value.replace(/(?:https?|wss?):\/\/[^\s"'<>\\\]}),]+/gi, (url) => {
    // 保留岗位/招聘者路径和普通查询参数，只替换 URL 中可复用的凭据参数。
    return url.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, prefix, key) => {
      let decodedKey = String(key)
      try {
        decodedKey = decodeURIComponent(decodedKey)
      } catch {
        // malformed URL keys are kept as-is unless the raw key itself is obvious.
      }
      return isBlockedKey(decodedKey) ? `${prefix}${key}=[已脱敏]` : match
    })
  })
}

function safeString(value: string, maxLength = MAX_STRING_LENGTH) {
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code === 9 || code === 10 || code === 13 || code >= 32 ? character : ' '
  }).join('')
  const redacted = redactUrlCredentials(
    withoutControls
      .replace(/\bBearer\s+\S+/gi, 'Bearer [已脱敏]')
      // OpenAI/Anthropic-style secret prefixes are recognizable credentials.
      // Keep ordinary business text such as `key-project` intact.
      .replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9._~-]{16,}\b/gi, '[已脱敏]')
      .replace(
        /((?<![?&])\b(?:api[-_ ]?key|x[-_ ]?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|private[-_ ]?key)\s*[:=]\s*)([A-Za-z0-9][A-Za-z0-9._~+/=-]{15,})/gi,
        '$1[已脱敏]',
      ),
  )
  if (redacted.length <= maxLength) return redacted
  return `${redacted.slice(0, Math.max(0, maxLength - 40))}\n...[本机日志截断 ${redacted.length - maxLength} 字]`
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_OBJECT_DEPTH) return { __localLogTruncated: true, reason: 'max-depth' }
  if (typeof value === 'string') return safeString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => safeValue(item, depth + 1))
      .filter((item) => item !== undefined)
    if (value.length > MAX_ARRAY_LENGTH) {
      items.push({ __localLogTruncated: true, omitted: value.length - MAX_ARRAY_LENGTH })
    }
    return items
  }
  if (value == null || typeof value !== 'object') return undefined
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isBlockedKey(key)) continue
    const safe = safeValue(item, depth + 1)
    if (safe !== undefined) result[key] = safe
  }
  return result
}

function fallbackHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

async function anonymousAccountUid(value: string) {
  try {
    if (globalThis.crypto?.subtle) {
      const bytes = new TextEncoder().encode(value)
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      return `anon-${Array.from(new Uint8Array(digest), (item) =>
        item.toString(16).padStart(2, '0'),
      )
        .join('')
        .slice(0, 24)}`
    }
  } catch {
    // A stable local fallback is enough when the browser lacks SubtleCrypto.
  }
  return `anon-${fallbackHash(value)}`
}

function createEventId() {
  try {
    return crypto.randomUUID()
  } catch {
    // Older browser runtimes may not expose randomUUID in service workers.
  }
  return `event-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function splitUtf8(value: string, maxBytes: number) {
  const chunks: string[] = []
  let start = 0
  let bytes = 0
  let offset = 0
  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).byteLength
    if (offset > start && bytes + characterBytes > maxBytes) {
      chunks.push(value.slice(start, offset))
      start = offset
      bytes = 0
    }
    bytes += characterBytes
    offset += character.length
  }
  if (offset > start || value.length === 0) chunks.push(value.slice(start, offset))
  return chunks
}

function splitOversizedEvent(event: LocalDiagnosticEvent): LocalDiagnosticEvent[] {
  const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength
  if (eventBytes <= MAX_EVENT_BYTES) return [event]

  // Keep the sanitized event JSON intact. The receiver can concatenate payloads and
  // parse one original event without guessing which business field was shortened.
  const payload = JSON.stringify(event)
  const chunks = splitUtf8(payload, MAX_CHUNK_PAYLOAD_BYTES)
  return chunks.map((part, index) => ({
    schemaVersion: 1,
    id: `${event.id}:chunk:${index + 1}`,
    at: event.at,
    accountUid: event.accountUid,
    stream: event.stream,
    event: event.event,
    data: {
      __localLogChunk: true,
      chunkOf: event.id,
      chunkIndex: index,
      chunkCount: chunks.length,
      originalEventBytes: eventBytes,
      payload: part,
    },
    sourceSessionId: event.sourceSessionId,
    sequence: event.sequence,
    chunkOf: event.id,
    chunkIndex: index,
    chunkCount: chunks.length,
  }))
}

async function loadQueue() {
  if (queue) return queue
  if (!queueLoad) {
    queueLoad = (async () => {
      // Health corruption must not discard the independent durable outbox.
      try {
        restoreHealth(await storage.getItem(healthKey))
      } catch {
        health.lastFailure = 'health-read-failed'
      }
      try {
        const saved = await storage.getItem<LocalDiagnosticEvent[]>(LOCAL_LOG_QUEUE_KEY, {
          fallback: [],
        })
        queue = Array.isArray(saved) ? saved : []
        for (const event of queue) rememberAccount(event.accountUid)
      } catch {
        queueLoad = undefined
        health.lastFailure = 'queue-read-failed'
        throw new Error('local diagnostic outbox could not be read')
      }
      return queue
    })()
  }
  return queueLoad
}

async function persistQueue() {
  try {
    await storage.setItem(LOCAL_LOG_QUEUE_KEY, queue ?? [])
    await storage.setItem(healthKey, { ...health, accounts: [...accounts].slice(-100) })
    return true
  } catch {
    health.persistFailures += 1
    health.lastFailure = 'storage-write-failed'
    return false
  }
}

async function sendBatch() {
  const pending = await loadQueue()
  if (pending.length === 0 || Date.now() < retryAfter) return pending.length === 0
  const batch = pending.slice(0, BATCH_SIZE)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 800)
  try {
    const response = await fetch(LOCAL_LOG_SINK_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`local log sink HTTP ${response.status}`)
    const receipt = await response.json()
    if (receipt?.ok !== true || receipt.accepted !== batch.length)
      throw new Error('receipt-count-mismatch')
    pending.splice(0, batch.length)
    queue = pending
    health.acknowledged += batch.length
    health.lastAckAt = Date.now()
    health.lastFailure = ''
    await persistQueue()
    retryAfter = 0
    return pending.length === 0
  } catch {
    health.lastFailure = 'sink-request-or-receipt-failed'
    retryAfter = Date.now() + RETRY_COOLDOWN_MS
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function normalizeEvent(
  input: LocalDiagnosticEventInput,
): Promise<LocalDiagnosticEvent | null> {
  if (
    input == null ||
    (input.accountUid === undefined
      ? input.stream !== 'logs' ||
        typeof input.event !== 'string' ||
        !input.event.startsWith('runtime.')
      : typeof input.accountUid !== 'string' || input.accountUid.length === 0) ||
    !['logs', 'deliveries', 'tasks', 'feedback'].includes(input.stream) ||
    typeof input.event !== 'string' ||
    input.event.length === 0 ||
    input.event.length > 100
  ) {
    return null
  }
  const safeData = safeValue(input.data ?? {})
  const event: LocalDiagnosticEvent = {
    schemaVersion: 1,
    id: createEventId(),
    at: Number.isFinite(input.at) ? input.at! : Date.now(),
    accountUid:
      input.accountUid === undefined ? 'unattributed' : await anonymousAccountUid(input.accountUid),
    stream: input.stream,
    event: input.event,
    data:
      safeData && typeof safeData === 'object' && !Array.isArray(safeData)
        ? (safeData as Record<string, unknown>)
        : {},
    sourceSessionId,
    sequence: 0,
  }
  return event
}

/**
 * Best-effort mirror. The browser storage queue is the durable handoff; a local
 * helper outage must never change the delivery result or block the page.
 */
export function appendLocalDiagnosticEvent(input: LocalDiagnosticEventInput) {
  return enqueue(async () => {
    const normalized = await normalizeEvent(input)
    if (!normalized) return false
    // Read the durable handoff before advancing the feedback dedup index.
    const pending = await loadQueue()
    const event = await enrichFeedback(normalized).catch(() => ({
      ...normalized,
      data: {
        ...normalized.data,
        associationStatus: 'registry-unavailable',
        replyEligible: false,
      },
    }))
    if (!event) return false
    event.sequence = ++sequence
    const events = splitOversizedEvent(event)
    rememberAccount(event.accountUid)
    pending.push(...events)
    health.produced += events.length
    // The outbox is durable until the receiver returns an exact accepted count.
    // Do not evict the oldest business event merely because a fixed item count was reached.
    queue = pending
    await persistQueue()
    return sendBatch()
  })
}

export function flushLocalDiagnosticQueue() {
  return enqueue(async () => {
    await loadQueue()
    if (Date.now() - lastHealthAt >= 60_000) {
      lastHealthAt = Date.now()
      for (const accountUid of accounts) {
        health.produced += 1
        queue!.push({
          schemaVersion: 1,
          id: createEventId(),
          at: Date.now(),
          accountUid,
          stream: 'logs',
          event: 'collector.health',
          sourceSessionId,
          sequence: ++sequence,
          data: {
            ...health,
            scope: 'all-streams-and-accounts',
            queueLength: queue!.length,
            oldestQueuedAt: queue![0]?.at,
            sourceSessionId,
          },
        })
      }
      await persistQueue()
    }
    // Drain a recovered backlog in bounded batches instead of 25 events per minute.
    for (let batch = 0; batch < MAX_FLUSH_BATCHES; batch++) {
      if (await sendBatch()) return true
      if (Date.now() < retryAfter) return false
    }
    return false
  })
}

export const localDiagnosticSink = {
  endpoint: LOCAL_LOG_SINK_ENDPOINT,
  queueKey: LOCAL_LOG_QUEUE_KEY,
  /** null means there is no item-count eviction; browser storage errors are surfaced in health. */
  maxQueueLength: null,
  maxFlushBatches: MAX_FLUSH_BATCHES,
  healthKey,
}
