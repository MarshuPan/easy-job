import { SecurityCheckRequiredError } from '@/types/deliverError'

export function isBossSecurityCheckPage(href?: string) {
  const value = href ?? (typeof location === 'undefined' ? '' : location.href)
  try {
    return new URL(value, 'https://www.zhipin.com').searchParams.has('_security_check')
  } catch {
    return false
  }
}

export function assertBossSecurityCheckClear(href?: string) {
  if (isBossSecurityCheckPage(href)) {
    throw new SecurityCheckRequiredError('BOSS 页面已进入安全校验，请完成校验后继续投递')
  }
}
