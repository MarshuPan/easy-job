/**
 * `chrome.storage.local` 在未申请 `unlimitedStorage` 时限制为 10 MiB。
 *
 * 写入超限会 reject，而调用侧一律把持久化失败降级成「保留当前页面内存状态并继续」，
 * 于是用户看不到任何硬失败——刷新页面后投递记录、投递池和统计静默消失。更麻烦的是
 * 降级时写的那条警告日志本身也写不进去，自诊断能力与数据一起失效。
 *
 * 因此配额错误需要单独识别，并在界面上提示一次。
 */
export const STORAGE_QUOTA_BYTES = 10 * 1024 * 1024

/** 超过该比例即认为需要提醒用户清理，留出余量避免写入直接失败。 */
export const STORAGE_QUOTA_SOFT_RATIO = 0.8

export const STORAGE_QUOTA_ERROR_MESSAGE = '扩展本地存储已满，投递记录和投递池无法继续保存'

/**
 * 识别配额超限错误。错误跨越扩展消息边界后只保留 message，所以这里按文本匹配：
 * Chrome 报 `QUOTA_BYTES quota exceeded`，Firefox 报 `QuotaExceededError`。
 */
export function isStorageQuotaError(error: unknown) {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error ?? '')
  return /quota/i.test(message)
}

export function formatStorageBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function isStorageUsageOverSoftLimit(bytesInUse: number) {
  return bytesInUse >= STORAGE_QUOTA_BYTES * STORAGE_QUOTA_SOFT_RATIO
}

const quotaNoticeIntervalMs = 5 * 60 * 1000
let lastQuotaNoticeAt = 0

/**
 * 存储写入是高频操作，配额一旦写满会连续失败。这里做节流，保证用户能看到提示
 * 但不会被每次 flush 都弹一遍。
 */
export function shouldReportStorageQuota(now = Date.now()) {
  if (now - lastQuotaNoticeAt < quotaNoticeIntervalMs) return false
  lastQuotaNoticeAt = now
  return true
}

/** 仅供测试使用：重置节流状态。 */
export function resetStorageQuotaNotice() {
  lastQuotaNoticeAt = 0
}
