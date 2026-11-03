import { SecurityCheckRequiredError } from '@/types/deliverError'

const verificationPrompt =
  /^(?:请(?:先)?完成(?:以下|下方)?(?:安全|人机|访问)?(?:验证|校验)(?:后继续(?:访问|操作|投递)?)?|(?:安全|人机|访问)(?:验证|校验))[。！!]?$/

function isVisibleVerificationElement(element: Element) {
  if (element.closest('[hidden], [aria-hidden="true"], [inert], dialog:not([open])')) {
    return false
  }
  const view = element.ownerDocument.defaultView
  for (let node: Element | null = element; node != null; node = node.parentElement) {
    const style = view?.getComputedStyle(node)
    if (
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      style?.opacity === '0'
    ) {
      return false
    }
  }
  return true
}

export function isBossSecurityCheckPage() {
  if (typeof document === 'undefined') return false
  // 回跳参数不代表仍在验证。只认页面当前显示的验证交互，不扫描岗位正文，
  // 也不猜测尚未采集确认的 BOSS 校验路由。
  return Array.from(document.querySelectorAll('[role="dialog"], dialog[open], form')).some(
    (scope) => {
      if (!isVisibleVerificationElement(scope)) return false
      const hasPrompt = Array.from(
        scope.querySelectorAll('h1, h2, h3, [role="heading"], legend, p, label'),
      ).some(
        (element) =>
          isVisibleVerificationElement(element) &&
          verificationPrompt.test((element.textContent ?? '').replace(/\s/g, '')),
      )
      if (!hasPrompt) return false
      return Array.from(
        scope.querySelectorAll(
          'iframe, canvas, input:not([type="hidden"]), [role="slider"], button',
        ),
      ).some(isVisibleVerificationElement)
    },
  )
}

// BOSS 校验通过后会把用户送回原页面，并在 URL 上留下 `_security_check`。这个参数只描述
// 「刚才发生过一次校验」，不是页面要去的地方。它一旦被当成步骤地址存进任务，插件后续
// 刷新来源时就会自己导航回带参数的地址，因此保存和站内导航时清除它。
export function withoutBossSecurityCheckParam(url: string) {
  try {
    const target = new URL(url, 'https://www.zhipin.com')
    if (!target.searchParams.has('_security_check')) return url
    target.searchParams.delete('_security_check')
    return /^https?:\/\//i.test(url)
      ? target.href
      : `${target.pathname}${target.search}${target.hash}`
  } catch {
    return url
  }
}

export function assertBossSecurityCheckClear() {
  if (isBossSecurityCheckPage()) {
    throw new SecurityCheckRequiredError('BOSS 页面已进入安全校验，请完成校验后继续投递')
  }
}
