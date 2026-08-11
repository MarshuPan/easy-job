import { browser } from 'wxt/browser'

export function getModelOriginPattern(url: string) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('模型地址只支持完整的 HTTP 或 HTTPS URL')
  }
  return `${parsed.origin}/*`
}

export function getModelOriginPatterns(urls: readonly string[]) {
  return [...new Set(urls.map(getModelOriginPattern))]
}

export async function requestModelOriginPermissions(urls: readonly string[]) {
  const origins = getModelOriginPatterns(urls)
  if (origins.length === 0) return true
  return browser.permissions.request({ origins })
}

export function requestModelOriginPermission(url: string) {
  return requestModelOriginPermissions([url])
}
