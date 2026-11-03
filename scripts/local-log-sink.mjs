import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PORT = 3210
/** 与扩展端一致；超大业务事件由扩展端拆成可重组分片。 */
export const MAX_EVENT_BYTES = 512 * 1024
export const MAX_FILE_BYTES = 8 * 1024 * 1024
// The extension sends at most 25 events per batch. Allow a full batch of
// max-sized events plus JSON framing; otherwise valid chunked diagnostics can
// be rejected before individual event validation runs.
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024
// The local receiver is the test evidence store. It must not silently delete
// history while a run is still being analyzed. Set
// EASY_JOB_LOG_RETENTION_DAYS to a positive number only when an explicit
// retention policy is wanted; 0 means no automatic expiry.
export const RETENTION_DAYS = 0
// Last-resort resource guards. Business payloads are retained in full until
// the event-size/chunk boundary; the receiver never uses these as summaries.
const MAX_STRING_LENGTH = 64 * 1024 * 1024
const MAX_ARRAY_LENGTH = 100_000
const MAX_OBJECT_DEPTH = 64

const streams = new Set(['logs', 'deliveries', 'tasks', 'feedback'])
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

function normalizeKey(key) {
  return key.toLowerCase().replace(/[\s_-]/g, '')
}

function isBlockedKey(key) {
  const normalized = normalizeKey(key)
  // Match complete credential field names only; input_tokens and other usage
  // counters are ordinary diagnostic evidence.
  return blockedKeys.has(normalized)
}

function dayKey(timestamp) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return null
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function redactUrlCredentials(value) {
  return value.replace(/(?:https?|wss?):\/\/[^\s"'<>\\\]}),]+/gi, (url) => {
    // 保留岗位/招聘者路径和普通查询参数，只替换 URL 中可复用的凭据参数。
    return url.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, prefix, key) => {
      let decodedKey = key
      try {
        decodedKey = decodeURIComponent(key)
      } catch {
        // malformed URL keys are kept as-is unless the raw key itself is obvious.
      }
      return isBlockedKey(decodedKey) ? `${prefix}${key}=[已脱敏]` : match
    })
  })
}

function safeString(value, maxLength = MAX_STRING_LENGTH) {
  if (typeof value !== 'string') return undefined
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code === 9 || code === 10 || code === 13 || code >= 32 ? character : ' '
  }).join('')
  const redacted = redactUrlCredentials(
    withoutControls
      .replace(/\bBearer\s+\S+/gi, 'Bearer [已脱敏]')
      .replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9._~-]{16,}\b/gi, '[已脱敏]')
      .replace(
        /((?<![?&])\b(?:api[-_ ]?key|x[-_ ]?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|private[-_ ]?key)\s*[:=]\s*)([A-Za-z0-9][A-Za-z0-9._~+/=-]{15,})/gi,
        '$1[已脱敏]',
      ),
  )
  if (redacted.length <= maxLength) return redacted
  return `${redacted.slice(0, Math.max(0, maxLength - 40))}\n...[本机日志截断 ${redacted.length - maxLength} 字]`
}

function sanitizeValue(value, depth = 0) {
  if (depth > MAX_OBJECT_DEPTH) return { __localLogTruncated: true, reason: 'max-depth' }
  if (typeof value === 'string') return safeString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item) => item !== undefined)
    if (value.length > MAX_ARRAY_LENGTH) {
      items.push({ __localLogTruncated: true, omitted: value.length - MAX_ARRAY_LENGTH })
    }
    return items
  }
  if (value == null || typeof value !== 'object') return undefined
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (isBlockedKey(key)) continue
    const safe = sanitizeValue(item, depth + 1)
    if (safe !== undefined) result[key] = safe
  }
  return result
}

export function sanitizeEvent(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('事件格式无效')
  }
  const candidate = value
  if (candidate.schemaVersion !== 1 || !streams.has(candidate.stream)) {
    throw new Error('事件版本或流无效')
  }
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.length < 8 ||
    candidate.id.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(candidate.id)
  ) {
    throw new Error('事件 ID 无效')
  }
  if (
    typeof candidate.accountUid !== 'string' ||
    candidate.accountUid.length < 1 ||
    candidate.accountUid.length > 128
  ) {
    throw new Error('账号标识无效')
  }
  if (!Number.isFinite(candidate.at) || candidate.at < 0) throw new Error('事件时间无效')
  if (
    typeof candidate.event !== 'string' ||
    candidate.event.length < 1 ||
    candidate.event.length > 100
  ) {
    throw new Error('事件名称无效')
  }
  const data = sanitizeValue(candidate.data)
  const event = {
    schemaVersion: 1,
    id: candidate.id,
    at: candidate.at,
    receivedAt: Date.now(),
    accountUid: candidate.accountUid,
    stream: candidate.stream,
    event: candidate.event,
    data: data && typeof data === 'object' && !Array.isArray(data) ? data : {},
    ...(typeof candidate.sourceSessionId === 'string'
      ? { sourceSessionId: safeString(candidate.sourceSessionId, 128) }
      : {}),
    ...(Number.isSafeInteger(candidate.sequence) && candidate.sequence > 0
      ? { sequence: candidate.sequence }
      : {}),
    ...(typeof candidate.chunkOf === 'string' ? { chunkOf: candidate.chunkOf } : {}),
    ...(Number.isSafeInteger(candidate.chunkIndex) && candidate.chunkIndex >= 0
      ? { chunkIndex: candidate.chunkIndex }
      : {}),
    ...(Number.isSafeInteger(candidate.chunkCount) && candidate.chunkCount > 0
      ? { chunkCount: candidate.chunkCount }
      : {}),
  }
  const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
  if (bytes > MAX_EVENT_BYTES) throw new Error(`事件过大（${bytes} 字节，最大 ${MAX_EVENT_BYTES}）`)
  return event
}

function parseJsonBody(request, maxBytes = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > maxBytes) {
        reject(new Error('请求过大'))
        request.destroy()
        return
      }
      body += chunk
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch {
        reject(new Error('JSON 无效'))
      }
    })
    request.on('error', reject)
  })
}

function respond(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function fileName(day, index = 0) {
  return `${day}${index ? `.${index}` : ''}.ndjson`
}

async function nextFileIndex(directory, day) {
  const files = await readdir(directory).catch(() => [])
  const indexes = files
    .filter((name) => name.startsWith(`${day}.`) && name.endsWith('.ndjson'))
    .map((name) => Number(name.slice(day.length + 1, -'.ndjson'.length)))
    .filter(Number.isInteger)
  return indexes.length ? Math.max(...indexes) : 0
}

async function loadEventIds(root) {
  const ids = new Set()
  for (const stream of streams) {
    const directory = path.join(root, stream)
    const files = await readdir(directory).catch(() => [])
    for (const name of files.filter((item) => /^\d{4}-\d{2}-\d{2}(?:\.\d+)?\.ndjson$/.test(item))) {
      const content = await readFile(path.join(directory, name), 'utf8').catch(() => '')
      for (const line of content.split(/\r?\n/)) {
        if (!line) continue
        try {
          const event = JSON.parse(line)
          if (typeof event?.id === 'string') ids.add(event.id)
        } catch {
          // A partially written line must not prevent the receiver from starting.
        }
      }
    }
  }
  return ids
}

async function appendEvent(root, event, eventIds) {
  // The extension keeps an event in its outbox until it receives the receipt.
  // If that receipt is lost, the same event is sent again.  Treat the event ID
  // as an idempotency key so retries do not inflate delivery/reply statistics.
  if (eventIds.has(event.id)) return false
  const day = dayKey(event.at) ?? dayKey(Date.now())
  const directory = path.join(root, event.stream)
  await mkdir(directory, { recursive: true })
  let index = await nextFileIndex(directory, day)
  let target = path.join(directory, fileName(day, index))
  const line = `${JSON.stringify(event)}\n`
  const currentSize = await stat(target)
    .then((item) => item.size)
    .catch(() => 0)
  if (currentSize > 0 && currentSize + Buffer.byteLength(line, 'utf8') > MAX_FILE_BYTES) {
    index += 1
    target = path.join(directory, fileName(day, index))
  }
  await appendFile(target, line, 'utf8')
  eventIds.add(event.id)
  return true
}

async function removeExpiredFiles(root, now = Date.now(), retentionDays = RETENTION_DAYS) {
  if (retentionDays <= 0) return
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  for (const stream of streams) {
    const directory = path.join(root, stream)
    const files = await readdir(directory).catch(() => [])
    await Promise.all(
      files
        .filter((name) => /^\d{4}-\d{2}-\d{2}(?:\.\d+)?\.ndjson$/.test(name))
        .flatMap((name) => {
          const day = name.slice(0, 10)
          const timestamp = Date.parse(`${day}T00:00:00`)
          return timestamp < cutoff
            ? [unlink(path.join(directory, name)).catch(() => undefined)]
            : []
        }),
    )
  }
}

export function createLocalLogSinkServer({
  root,
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  retentionDays = resolveRetentionDays(),
} = {}) {
  const outputRoot = path.resolve(
    root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'runtime'),
  )
  let writeQueue = Promise.resolve()
  let cleanedAt = 0
  let eventIds = new Set()
  let eventIdsLoaded = false
  const server = createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      respond(response, 204, {})
      return
    }
    if (request.method === 'GET' && request.url === '/health') {
      respond(response, 200, { ok: true, schemaVersion: 1, retentionDays })
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/events') {
      respond(response, 404, { ok: false, error: 'not_found' })
      return
    }
    try {
      const body = await parseJsonBody(request)
      const values = Array.isArray(body?.events) ? body.events : [body?.event]
      if (values.length < 1 || values.length > 50) throw new Error('事件数量无效')
      const events = values.map(sanitizeEvent)
      writeQueue = writeQueue.then(async () => {
        if (!eventIdsLoaded) {
          eventIds = await loadEventIds(outputRoot)
          eventIdsLoaded = true
        }
        for (const event of events) await appendEvent(outputRoot, event, eventIds)
        if (Date.now() - cleanedAt > 60 * 60 * 1000) {
          cleanedAt = Date.now()
          await removeExpiredFiles(outputRoot, cleanedAt, retentionDays)
        }
      })
      await writeQueue
      respond(response, 202, { ok: true, accepted: events.length })
    } catch (error) {
      respond(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : '请求失败',
      })
    }
  })
  return {
    server,
    root: outputRoot,
    async listen() {
      await mkdir(outputRoot, { recursive: true })
      eventIds = await loadEventIds(outputRoot)
      eventIdsLoaded = true
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      return server.address()
    },
    async close() {
      if (!server.listening) return
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}

function resolveRetentionDays() {
  const configured = Number(process.env.EASY_JOB_LOG_RETENTION_DAYS)
  if (!Number.isFinite(configured) || configured < 0) return RETENTION_DAYS
  return Math.floor(configured)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = new Map()
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index]
    if (value === '--port') args.set('port', Number(process.argv[++index]))
    if (value === '--dir') args.set('root', process.argv[++index])
  }
  const sink = createLocalLogSinkServer({
    root: process.env.EASY_JOB_LOG_DIR ?? args.get('root'),
    port: args.get('port') || Number(process.env.EASY_JOB_LOG_PORT) || DEFAULT_PORT,
  })
  const address = await sink.listen()
  console.log(`Easy Job 本机日志接收器已启动: http://${address.address}:${address.port}`)
  console.log(`日志目录: ${sink.root}`)
  const stop = () => sink.close().finally(() => process.exit(0))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
