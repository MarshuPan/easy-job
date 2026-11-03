/**
 * 岗位凭据（securityId / lid）是抓列表那一刻由 BOSS 发的，有时效：真机上 24 分钟还能用、
 * 28 分钟起详情接口就回「您的环境存在异常」。超过这个时间就不能再拿它请求详情。
 */
export const JOB_CREDENTIAL_REFRESH_AGE_MINUTES = 30

/** 请求前仍要留安全余量；排队时间由实际队列顺序和近期处理耗时估算。 */
export const JOB_CREDENTIAL_SAFETY_MARGIN_MS = 3 * 60_000

export function needsCredentialRefresh(
  job: { fetchedAt?: number },
  now = Date.now(),
  queueWaitMs = 0,
) {
  const fetchedAt = Number(job.fetchedAt)
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return false
  return (
    credentialAgeMinutes(job, now) * 60_000 +
      Math.max(0, queueWaitMs) +
      JOB_CREDENTIAL_SAFETY_MARGIN_MS >=
    JOB_CREDENTIAL_REFRESH_AGE_MINUTES * 60_000
  )
}

export function credentialAgeMinutes(job: { fetchedAt?: number }, now = Date.now()) {
  const fetchedAt = Number(job.fetchedAt)
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return 0
  return Math.max(0, (now - fetchedAt) / 60_000)
}
