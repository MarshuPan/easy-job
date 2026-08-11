import type { FormData, Statistics } from '@/types/formData'

export type DeliveryLimitSource = 'search' | 'group'

export const DAILY_DELIVERY_LIMIT = 150

let deliveryLimitSourceOverride: DeliveryLimitSource | null = null

export function setDeliveryLimitSourceOverride(source: DeliveryLimitSource | null) {
  deliveryLimitSourceOverride = source
}

export function inferDeliveryLimitSource(href = location.href): DeliveryLimitSource {
  const url = parseDeliveryUrl(href)
  if (url?.searchParams.get('query')?.trim()) return 'search'

  const pathname = url?.pathname ?? href
  if (pathname.includes('/web/geek/job-recommend') || pathname.includes('/web/geek/jobs')) {
    return 'group'
  }
  if (pathname.includes('/web/geek/job')) return 'search'
  return 'search'
}

function parseDeliveryUrl(href: string) {
  try {
    const origin = typeof location === 'undefined' ? 'https://www.zhipin.com' : location.origin
    return new URL(href, origin)
  } catch {
    return null
  }
}

export function getDeliveryLimitSource(href = location.href): DeliveryLimitSource {
  if (deliveryLimitSourceOverride != null) return deliveryLimitSourceOverride
  return inferDeliveryLimitSource(href)
}

function resolveSource(sourceOrHref?: DeliveryLimitSource | string): DeliveryLimitSource {
  if (sourceOrHref === 'group' || sourceOrHref === 'search') return sourceOrHref
  return getDeliveryLimitSource(sourceOrHref)
}

export function getDeliveryLimit(formData: FormData, sourceOrHref?: DeliveryLimitSource | string) {
  const value = Number(formData.deliveryLimit[resolveSource(sourceOrHref)])
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function getDeliverySourceTargetPercent(
  formData: FormData,
  sourceOrHref?: DeliveryLimitSource | string,
) {
  const groupWeight = getDeliveryLimit(formData, 'group')
  const searchWeight = getDeliveryLimit(formData, 'search')
  const totalWeight = groupWeight + searchWeight
  if (totalWeight <= 0) return 0
  return Number(((getDeliveryLimit(formData, sourceOrHref) / totalWeight) * 100).toFixed(1))
}

export function getDeliveryLimitSuccess(
  statistics: Statistics,
  sourceOrHref?: DeliveryLimitSource | string,
) {
  return resolveSource(sourceOrHref) === 'group'
    ? (statistics.groupSuccess ?? 0)
    : (statistics.searchSuccess ?? 0)
}

/**
 * 当日实际可用额度。
 *
 * 平台上限是 150，但今天已经被提示过频率限制的话就不该再往上限顶——每命中一次砍一档。
 * 这个值由运行时按当日命中次数设置，跨天由 riskBackoff 的记录自动归零。
 */
let riskAdjustedDailyLimit = DAILY_DELIVERY_LIMIT

export function setRiskAdjustedDailyLimit(limit: number) {
  riskAdjustedDailyLimit = Math.max(0, Math.min(DAILY_DELIVERY_LIMIT, Math.floor(limit)))
}

export function getEffectiveDailyDeliveryLimit() {
  return riskAdjustedDailyLimit
}

export function hasDailyDeliveryRemaining(statistics: Statistics) {
  return statistics.success < riskAdjustedDailyLimit
}

export function getDailyDeliveryRemaining(statistics: Statistics) {
  return Math.max(0, riskAdjustedDailyLimit - statistics.success)
}
