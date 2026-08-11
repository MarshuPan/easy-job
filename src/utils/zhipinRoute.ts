export const JOB_UI_VISIBILITY_EVENT = 'agent-delivery:job-ui-visibility'

export function isGeekChatUrl(href: string) {
  try {
    const url = new URL(href, 'https://www.zhipin.com')
    return url.pathname === '/web/geek/chat'
  } catch {
    return href.includes('/web/geek/chat')
  }
}

export function buildGeekChatUrl(encryptBossId?: string | null) {
  const url = new URL('/web/geek/chat', 'https://www.zhipin.com')
  const id = encryptBossId?.trim()
  if (id) {
    return `${url.toString()}?id=${encodeURIComponent(id)}`
  }
  return url.toString()
}

export function getGeekChatIdFromUrl(href: string) {
  try {
    const url = new URL(href, 'https://www.zhipin.com')
    if (url.pathname !== '/web/geek/chat') return null
    return url.searchParams.get('id')
  } catch {
    return null
  }
}

export function isSameGeekChatUrl(left: string | undefined, right: string) {
  if (!left) return false
  try {
    const leftUrl = new URL(left)
    const rightUrl = new URL(right)
    return (
      leftUrl.origin === rightUrl.origin &&
      leftUrl.pathname === rightUrl.pathname &&
      leftUrl.searchParams.get('id') === rightUrl.searchParams.get('id')
    )
  } catch {
    return left === right
  }
}
