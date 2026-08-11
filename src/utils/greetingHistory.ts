import type { log } from '@/stores/log'
import type { RecentGreetingSummary } from '@/types/aiGreeting'

export function normalizeGreetingText(value: string) {
  return value.toLowerCase().replace(/[\p{P}\s]+/gu, '')
}

export function fingerprintGreeting(messages: readonly string[]) {
  const normalized = normalizeGreetingText(messages.join(''))
  let hash = 0x811c9dc5
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function stripGreetingIdentity(value: string) {
  return value
    .replace(
      /^\s*[\p{Script=Han}]{1,4}(?:老师|先生|女士|经理|总)[，,：:\s]*(?:您好|你好)?[！!，,\s]*/u,
      '',
    )
    .replace(/我是\s*[^，,。.!！\s]{1,20}[，,。.!！\s]*/gu, '')
    .trim()
}

export function redactKnownValues(value: string, values: readonly (string | undefined)[]) {
  return values.reduce<string>((result, item) => {
    const knownValue = item?.trim()
    return knownValue ? result.split(knownValue).join('') : result
  }, value)
}

function getKnownValues(record: log) {
  const jobs = [record.job, record.data?.listData]
  return jobs.flatMap((job) => [
    job?.bossName,
    job?.brandName,
    job?.jobName,
    job?.card?.bossName,
    job?.card?.brandName,
    job?.card?.jobName,
  ])
}

export function getRecentGreetingSummaries(records: readonly log[], limit = 10) {
  if (limit <= 0) return []

  return records
    .filter((record) => {
      const greeting = record.data?.greetingSend
      const messages = greeting?.messages
      return (
        record.state === 'success' &&
        greeting?.ok === true &&
        greeting.type === 'ai' &&
        Array.isArray(messages) &&
        messages.length >= 1 &&
        messages.length <= 5 &&
        messages.every((message) => message.ok && typeof message.content === 'string') &&
        record.data?.aiGreetingMeta != null
      )
    })
    .sort(
      (left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt),
    )
    .slice(0, limit)
    .map((record) => {
      const meta = record.data?.aiGreetingMeta
      const greetingMessages = record.data?.greetingSend?.messages
      if (
        !meta ||
        !greetingMessages ||
        greetingMessages.length < 1 ||
        greetingMessages.length > 5
      ) {
        throw new Error('近期AI招呼语记录不完整')
      }
      const knownValues = getKnownValues(record)
      const messages = greetingMessages.map((message) =>
        redactKnownValues(stripGreetingIdentity(message.content), knownValues).trim(),
      )

      return {
        sentAt: record.updatedAt ?? record.createdAt,
        usedFactIds: [...meta.usedFactIds],
        openingPattern: redactKnownValues(meta.openingPattern, knownValues).trim(),
        messages,
        fingerprint: fingerprintGreeting(messages),
      } satisfies RecentGreetingSummary
    })
}
