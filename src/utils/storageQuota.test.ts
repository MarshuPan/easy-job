import { beforeEach, describe, expect, it } from 'vitest'

import {
  formatStorageBytes,
  isStorageQuotaError,
  isStorageUsageOverSoftLimit,
  resetStorageQuotaNotice,
  shouldReportStorageQuota,
  STORAGE_QUOTA_BYTES,
} from './storageQuota'

describe('storage quota detection', () => {
  beforeEach(() => {
    resetStorageQuotaNotice()
  })

  it('recognises the quota errors different browsers report', () => {
    // 错误跨扩展消息边界后只剩 message，所以只能按文本识别。
    expect(isStorageQuotaError(new Error('QUOTA_BYTES quota exceeded'))).toBe(true)
    expect(isStorageQuotaError(new Error('Resource::kQuotaBytes quota exceeded'))).toBe(true)
    expect(isStorageQuotaError(new Error('QuotaExceededError'))).toBe(true)
    expect(isStorageQuotaError('quota exceeded')).toBe(true)
  })

  it('does not mistake unrelated failures for a quota problem', () => {
    expect(isStorageQuotaError(new Error('Extension context invalidated.'))).toBe(false)
    expect(isStorageQuotaError(new Error('Network Error'))).toBe(false)
    expect(isStorageQuotaError(undefined)).toBe(false)
  })

  it('treats 80% of the quota as the soft limit', () => {
    expect(isStorageUsageOverSoftLimit(STORAGE_QUOTA_BYTES * 0.79, STORAGE_QUOTA_BYTES)).toBe(false)
    expect(isStorageUsageOverSoftLimit(STORAGE_QUOTA_BYTES * 0.8, STORAGE_QUOTA_BYTES)).toBe(true)
    expect(isStorageUsageOverSoftLimit(STORAGE_QUOTA_BYTES, STORAGE_QUOTA_BYTES)).toBe(true)
  })

  it('does not apply the ordinary 10 MiB quota to unlimited storage', () => {
    expect(isStorageUsageOverSoftLimit(STORAGE_QUOTA_BYTES * 3, null)).toBe(false)
  })

  it('uses the supplied quota and ignores invalid capacity readings', () => {
    expect(isStorageUsageOverSoftLimit(4 * 1024 * 1024, 5 * 1024 * 1024)).toBe(true)
    expect(isStorageUsageOverSoftLimit(Number.NaN, STORAGE_QUOTA_BYTES)).toBe(false)
    expect(isStorageUsageOverSoftLimit(STORAGE_QUOTA_BYTES, 0)).toBe(false)
    expect(isStorageUsageOverSoftLimit(STORAGE_QUOTA_BYTES, Number.NaN)).toBe(false)
  })

  it('throttles repeated notices so a full disk cannot spam the user', () => {
    // 存储写入是高频操作，配额写满后会连续失败。
    expect(shouldReportStorageQuota(1_000_000)).toBe(true)
    expect(shouldReportStorageQuota(1_000_001)).toBe(false)
    expect(shouldReportStorageQuota(1_000_000 + 5 * 60 * 1000)).toBe(true)
  })

  it('formats byte counts for the user-facing notice', () => {
    expect(formatStorageBytes(512)).toBe('512 B')
    expect(formatStorageBytes(2048)).toBe('2.0 KB')
    expect(formatStorageBytes(9 * 1024 * 1024)).toBe('9.00 MB')
    expect(formatStorageBytes(Number.NaN)).toBe('未知')
  })
})
