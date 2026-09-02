/**
 * Normalize platform responses before the delivery pipeline decides whether to
 * cool down, stop for the daily limit, or treat the response as an ordinary
 * job error.
 */

export type PlatformRiskSignal =
  | 'rate-limited'
  | 'daily-limit-warning'
  | 'daily-limit-reached'
  | null

const candidateKeys = new Set(['message', 'msg', 'content', 'title', 'text'])
const maxDepth = 5
const maxCandidates = 32

function collectText(value: unknown, depth = 0, seen = new Set<object>(), out: string[] = []) {
  if (out.length >= maxCandidates || depth > maxDepth || value == null) return out
  if (typeof value === 'string') {
    const text = value.trim()
    if (text) out.push(text)
    return out
  }
  if (typeof value !== 'object' || seen.has(value)) return out
  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value) collectText(item, depth + 1, seen, out)
    return out
  }

  for (const [key, item] of Object.entries(value)) {
    if (candidateKeys.has(key) || (typeof item === 'object' && item != null)) {
      collectText(item, depth + 1, seen, out)
    }
    if (out.length >= maxCandidates) break
  }
  return out
}

export function getPlatformRiskTexts(value: unknown) {
  return collectText(value)
}

export function detectPlatformRisk(value: unknown): PlatformRiskSignal {
  const texts = collectText(value)

  if (texts.some((text) => text.includes('您今天已与150位BOSS沟通'))) {
    return 'daily-limit-reached'
  }
  if (texts.some((text) => text.includes('您今天已与120位BOSS沟通'))) {
    return 'daily-limit-warning'
  }
  if (texts.some((text) => /操作过于频繁|操作频繁|请求过于频繁/.test(text))) {
    return 'rate-limited'
  }
  return null
}
