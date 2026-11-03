import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const streams = ['logs', 'deliveries', 'tasks', 'feedback']
const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'runtime',
)

function resolveRoot() {
  const index = process.argv.indexOf('--root')
  return path.resolve(index >= 0 ? (process.argv[index + 1] ?? defaultRoot) : defaultRoot)
}

async function ndjsonFiles(directory) {
  const names = await readdir(directory).catch(() => [])
  return names.filter((name) => /^\d{4}-\d{2}-\d{2}(?:\.\d+)?\.ndjson$/.test(name)).sort()
}

function walkForMarkers(value, pathName = '$', result = { truncated: [], redacted: [] }) {
  if (typeof value === 'string') {
    if (/\[(?:本机日志)?截断|__localLogTruncated|textTruncated/i.test(value)) {
      result.truncated.push(pathName)
    }
    if (/\[(?:已脱敏|地址已脱敏|请求地址已脱敏)\]/.test(value)) result.redacted.push(pathName)
    return result
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkForMarkers(item, `${pathName}[${index}]`, result))
    return result
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (
        (/__localLogTruncated/i.test(key) && item === true) ||
        (/textTruncated/i.test(key) && item === true)
      ) {
        result.truncated.push(`${pathName}.${key}`)
      }
      walkForMarkers(item, `${pathName}.${key}`, result)
    }
  }
  return result
}

function sequenceGaps(events) {
  const bySession = new Map()
  for (const event of events) {
    if (typeof event.sourceSessionId !== 'string' || !Number.isSafeInteger(event.sequence)) continue
    const values = bySession.get(event.sourceSessionId) ?? new Set()
    values.add(event.sequence)
    bySession.set(event.sourceSessionId, values)
  }
  return [...bySession.entries()].flatMap(([sourceSessionId, values]) => {
    const sorted = [...values].sort((left, right) => left - right)
    const gaps = []
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index] > sorted[index - 1] + 1) {
        gaps.push({
          from: sorted[index - 1],
          to: sorted[index],
          missing: sorted[index] - sorted[index - 1] - 1,
        })
      }
    }
    return gaps.length ? [{ sourceSessionId, first: sorted[0], last: sorted.at(-1), gaps }] : []
  })
}

function chunkGaps(events) {
  const groups = new Map()
  for (const event of events) {
    if (typeof event.chunkOf !== 'string' || !Number.isSafeInteger(event.chunkIndex)) continue
    const group = groups.get(event.chunkOf) ?? { expected: event.chunkCount, indexes: new Set() }
    group.expected = event.chunkCount ?? group.expected
    group.indexes.add(event.chunkIndex)
    groups.set(event.chunkOf, group)
  }
  return [...groups.entries()].flatMap(([chunkOf, group]) => {
    if (!Number.isSafeInteger(group.expected) || group.expected <= 0) {
      return [{ chunkOf, reason: 'missing-chunk-count' }]
    }
    const missing = Array.from({ length: group.expected }, (_, index) => index).filter(
      (index) => !group.indexes.has(index),
    )
    return missing.length ? [{ chunkOf, expected: group.expected, missing }] : []
  })
}

async function readEvents(root) {
  const events = []
  const malformed = []
  const files = []
  for (const stream of streams) {
    const directory = path.join(root, stream)
    for (const name of await ndjsonFiles(directory)) {
      const file = path.join(directory, name)
      files.push(file)
      const content = await readFile(file, 'utf8').catch(() => '')
      content.split(/\r?\n/).forEach((line, index) => {
        if (!line.trim()) return
        try {
          const event = JSON.parse(line)
          events.push({ ...event, __file: file, __line: index + 1 })
        } catch {
          malformed.push({ file, line: index + 1 })
        }
      })
    }
  }
  return { events, malformed, files }
}

function duplicateIds(events) {
  const seen = new Map()
  for (const event of events) {
    if (typeof event.id !== 'string') continue
    const entries = seen.get(event.id) ?? []
    entries.push({ file: event.__file, line: event.__line })
    seen.set(event.id, entries)
  }
  return [...seen.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([id, entries]) => ({ id, occurrences: entries }))
}

function healthSummary(events) {
  const health = events.filter((event) => event.event === 'collector.health')
  const max = (key) =>
    health.reduce((value, event) => {
      const item = Number(event.data?.[key])
      return Number.isFinite(item) ? Math.max(value, item) : value
    }, 0)
  return {
    count: health.length,
    maxDropped: max('dropped'),
    maxPersistFailures: max('persistFailures'),
    latest: health.at(-1)?.data ?? null,
  }
}

const root = resolveRoot()
const { events, malformed, files } = await readEvents(root)
const byStream = Object.fromEntries(
  streams.map((stream) => [stream, events.filter((event) => event.stream === stream).length]),
)
const markers = events.reduce((result, event) => walkForMarkers(event, '$', result), {
  truncated: [],
  redacted: [],
})
const report = {
  root,
  files: files.length,
  events: events.length,
  byStream,
  malformed,
  duplicateIds: duplicateIds(events),
  sequenceGaps: sequenceGaps(events),
  chunkGaps: chunkGaps(events),
  markers: {
    truncatedCount: markers.truncated.length,
    redactedCount: markers.redacted.length,
    truncatedExamples: markers.truncated.slice(0, 20),
  },
  collectorHealth: healthSummary(events),
}
console.log(JSON.stringify(report, null, 2))
