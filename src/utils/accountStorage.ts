const accountUidPattern = /^[A-Za-z0-9_-]{1,128}$/

export function normalizeAccountUid(uid: string | number) {
  const normalized = String(uid).trim()
  if (!accountUidPattern.test(normalized)) {
    throw new Error('账号标识格式无效')
  }
  return normalized
}

export function createAccountStorageKey(baseKey: string, uid: string | number) {
  return `${baseKey}:${normalizeAccountUid(uid)}`
}
