export async function hashResumeMarkdown(markdown: string) {
  const data = new TextEncoder().encode(markdown)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
  return `sha256:${hex}`
}
