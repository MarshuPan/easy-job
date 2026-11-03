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
  return (
    value
      .replace(
        /^\s*[\p{Script=Han}]{1,4}(?:老师|先生|女士|经理|总)[，,：:\s]*(?:您好|你好)?[！!，,\s]*/u,
        '',
      )
      // 只去掉「我是林小舟」这种自报姓名，不去掉「我是有8年经验的产品经理」这种身份句：
      // 原来 20 字内的「我是……」整句删掉，开场身份句从没进过重复统计，
      // 1.3.17 的 11 条里 8 条用同一句开场，一次都没拦下。
      .replace(/我是\s*\p{Script=Han}{2,4}(?=[，,。.!！\s]|$)[，,。.!！\s]*/gu, '')
      .trim()
  )
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

/**
 * 这条记录最终发出去的招呼语。
 *
 * 优先取 aiGreetingMessages：岗位记录落盘时每段发送结果不再重复存正文，刷新页面后
 * greetingSend.messages 里只剩发送状态。只从那里取的话，刷新之后近期话术就是空的，
 * 模型也就看不到自己刚写过什么。
 */
function sentGreetingMessages(record: log) {
  const saved = record.data?.aiGreetingMessages
  if (Array.isArray(saved) && saved.every((message) => typeof message === 'string')) {
    return saved
  }
  const sent = record.data?.greetingSend?.messages
  if (!Array.isArray(sent) || !sent.every((message) => typeof message.content === 'string')) {
    return undefined
  }
  return sent.map((message) => message.content)
}

export function getRecentGreetingSummaries(records: readonly log[], limit = 10) {
  if (limit <= 0) return []

  return records
    .flatMap((record) => {
      const greeting = record.data?.greetingSend
      const meta = record.data?.aiGreetingMeta
      const messages = sentGreetingMessages(record)
      if (
        record.state !== 'success' ||
        greeting?.ok !== true ||
        greeting.type !== 'ai' ||
        meta == null ||
        messages == null ||
        messages.length < 1 ||
        messages.length > 5
      ) {
        return []
      }
      return [{ record, meta, messages }]
    })
    .sort(
      (left, right) =>
        (right.record.updatedAt ?? right.record.createdAt) -
        (left.record.updatedAt ?? left.record.createdAt),
    )
    .slice(0, limit)
    .map(({ record, meta, messages }) => {
      const knownValues = getKnownValues(record)
      const redacted = messages.map((message) =>
        redactKnownValues(stripGreetingIdentity(message), knownValues).trim(),
      )

      return {
        sentAt: record.updatedAt ?? record.createdAt,
        usedFactIds: [...meta.usedFactIds],
        messages: redacted,
        fingerprint: fingerprintGreeting(redacted),
      } satisfies RecentGreetingSummary
    })
}
