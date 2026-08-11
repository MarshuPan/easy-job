import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cookieSave,
  cookieSwitch,
  getRootVue,
  getStatistics,
  loggerError,
  setStatistics,
  setStatisticsAccountScope,
  sourceFormData,
  storageSet,
} = vi.hoisted(() => ({
  cookieSave: vi.fn(async () => true),
  cookieSwitch: vi.fn(async () => true),
  getRootVue: vi.fn(async () => null as unknown),
  getStatistics: vi.fn(async () => '{"t":{"date":"2026-07-10"},"s":[]}'),
  loggerError: vi.fn(),
  setStatistics: vi.fn(async () => undefined),
  setStatisticsAccountScope: vi.fn(async () => undefined),
  sourceFormData: { userId: 'account-a', useCache: { value: false } },
  storageSet: vi.fn(async () => true),
}))

vi.mock('@/message', () => ({
  counter: {
    cookieSave,
    cookieSwitch,
    storageSet,
  },
}))

vi.mock('@/composables/useStatistics', () => ({
  useStatistics: () => ({
    getStatistics,
    setAccountScope: setStatisticsAccountScope,
    setStatistics,
  }),
}))

vi.mock('@/composables/useVue', () => ({
  getRootVue,
}))

vi.mock('@/stores/conf', () => ({
  formDataKey: 'local:web-geek-job-FormData',
  useConf: () => ({ formData: sourceFormData }),
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: loggerError,
    warn: vi.fn(),
  },
}))

vi.mock('@/ui/instrument', () => ({
  AgentMessage: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

import type { CookieInfo } from '@/message'

import { useUser } from './user'

function accountB(): CookieInfo {
  return {
    avatar: '',
    date: '2026-07-10',
    flag: 'staff',
    form: { userId: 'account-b', useCache: { value: true } } as CookieInfo['form'],
    gender: 'man',
    remark: '',
    statistics: '{"t":{"date":"2026-07-10"},"s":[]}',
    uid: 'account-b',
    user: '账号 B',
  }
}

describe('account state restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getRootVue.mockResolvedValue(null)
    getStatistics.mockReset()
    getStatistics.mockResolvedValue('{"t":{"date":"2026-07-10"},"s":[]}')
    setStatistics.mockReset()
    setStatistics.mockResolvedValue(undefined)
    storageSet.mockReset()
    storageSet.mockResolvedValue(true)
    Object.assign(window, { _PAGE: { uid: 'account-a' } })
  })

  it('restores B without saving the currently loaded A state during automatic reconciliation', async () => {
    await useUser().changeUser(accountB(), { saveCurrent: false })

    expect(cookieSave).not.toHaveBeenCalled()
    expect(cookieSwitch).not.toHaveBeenCalled()
    expect(storageSet).toHaveBeenCalledWith(
      'local:web-geek-job-FormData',
      expect.objectContaining({ userId: 'account-b' }),
    )
    expect(setStatistics).toHaveBeenCalledWith(accountB().statistics)
  })

  it('saves the source snapshot only when a manual caller provides explicit trusted callbacks', async () => {
    const persistCurrent = vi.fn(async () => undefined)
    const switchAccount = vi.fn(async () => undefined)

    await useUser().changeUser(accountB(), {
      saveCurrent: true,
      persistCurrent,
      switchAccount,
    })

    expect(persistCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        form: expect.objectContaining({ userId: 'account-a' }),
        uid: 'account-a',
      }),
    )
    expect(switchAccount).toHaveBeenCalledWith('account-b')
    expect(cookieSave).not.toHaveBeenCalled()
    expect(cookieSwitch).not.toHaveBeenCalled()
  })

  it('rejects a corrupt target form snapshot before changing global state', async () => {
    const corrupt = { ...accountB(), form: [] as unknown as CookieInfo['form'] }

    await expect(useUser().changeUser(corrupt, { saveCurrent: false })).rejects.toThrow(
      '账号配置快照格式损坏',
    )

    expect(storageSet).not.toHaveBeenCalled()
    expect(setStatistics).not.toHaveBeenCalled()
  })

  it('rolls back the source account state when switching accounts fails', async () => {
    const sourceStatistics = '{"t":{"date":"2026-07-09"},"s":[]}'
    getStatistics.mockResolvedValueOnce(sourceStatistics)
    const switchAccount = vi.fn(async () => {
      throw new Error('账号切换失败')
    })

    await expect(
      useUser().changeUser(accountB(), { saveCurrent: false, switchAccount }),
    ).rejects.toThrow('账号切换失败')

    expect(storageSet).toHaveBeenNthCalledWith(
      1,
      'local:web-geek-job-FormData',
      expect.objectContaining({ userId: 'account-b' }),
    )
    expect(storageSet).toHaveBeenNthCalledWith(
      2,
      'local:web-geek-job-FormData',
      expect.objectContaining({ userId: 'account-a' }),
    )
    expect(setStatistics).toHaveBeenNthCalledWith(1, accountB().statistics)
    expect(setStatistics).toHaveBeenNthCalledWith(2, sourceStatistics)
  })

  it('rolls back both source snapshots when target statistics fails after target form succeeds', async () => {
    const sourceStatistics = '{"t":{"date":"2026-07-09","success":4},"s":[]}'
    const targetError = new Error('目标统计写入失败')
    getStatistics.mockResolvedValueOnce(sourceStatistics)
    setStatistics.mockRejectedValueOnce(targetError).mockResolvedValueOnce(undefined)

    await expect(useUser().changeUser(accountB(), { saveCurrent: false })).rejects.toBe(targetError)

    expect(storageSet).toHaveBeenNthCalledWith(
      1,
      'local:web-geek-job-FormData',
      expect.objectContaining({ userId: 'account-b' }),
    )
    expect(storageSet).toHaveBeenNthCalledWith(
      2,
      'local:web-geek-job-FormData',
      expect.objectContaining({ userId: 'account-a' }),
    )
    expect(setStatistics).toHaveBeenNthCalledWith(1, accountB().statistics)
    expect(setStatistics).toHaveBeenNthCalledWith(2, sourceStatistics)
  })

  it('restores both source snapshots when the target form write fails first', async () => {
    const sourceStatistics = '{"t":{"date":"2026-07-09","success":3},"s":[]}'
    const targetError = new Error('目标配置写入失败')
    getStatistics.mockResolvedValueOnce(sourceStatistics)
    storageSet.mockRejectedValueOnce(targetError).mockResolvedValueOnce(true)

    await expect(useUser().changeUser(accountB(), { saveCurrent: false })).rejects.toBe(targetError)

    expect(storageSet).toHaveBeenNthCalledWith(
      2,
      'local:web-geek-job-FormData',
      expect.objectContaining({ userId: 'account-a' }),
    )
    expect(setStatistics).toHaveBeenCalledOnce()
    expect(setStatistics).toHaveBeenCalledWith(sourceStatistics)
  })

  it('keeps the switch failure primary when both source rollback writes fail', async () => {
    const switchError = new Error('账号切换失败')
    const rollbackFormError = new Error('源配置回滚失败')
    const rollbackStatisticsError = new Error('源统计回滚失败')
    const switchAccount = vi.fn(async () => {
      throw switchError
    })
    storageSet.mockResolvedValueOnce(true).mockRejectedValueOnce(rollbackFormError)
    setStatistics.mockResolvedValueOnce(undefined).mockRejectedValueOnce(rollbackStatisticsError)

    await expect(
      useUser().changeUser(accountB(), { saveCurrent: false, switchAccount }),
    ).rejects.toBe(switchError)

    expect(loggerError).toHaveBeenCalledWith(
      '账号状态回滚失败',
      expect.arrayContaining([rollbackFormError, rollbackStatisticsError]),
    )
  })

  it('returns immediately when the root Vue instance is unavailable', async () => {
    vi.useFakeTimers()
    let result: unknown = 'pending'
    try {
      void useUser()
        .initUser()
        .then((value) => {
          result = value
        })
      await vi.advanceTimersByTimeAsync(0)

      expect(result).toBeNull()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('honors a bounded timeout while waiting for userInfo', async () => {
    vi.useFakeTimers()
    getRootVue.mockResolvedValueOnce({ $store: { state: {} } })
    let result: unknown = 'pending'
    try {
      void useUser()
        .initUser({ pollIntervalMs: 100, timeoutMs: 1_000 })
        .then((value) => {
          result = value
        })
      await vi.advanceTimersByTimeAsync(999)
      expect(result).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      expect(result).toBeNull()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('bounds the root Vue lookup within the same timeout budget', async () => {
    vi.useFakeTimers()
    getRootVue.mockReturnValueOnce(new Promise(() => {}))
    let result: unknown = 'pending'
    try {
      void useUser()
        .initUser({ pollIntervalMs: 100, timeoutMs: 1_000 })
        .then((value) => {
          result = value
        })
      await vi.advanceTimersByTimeAsync(999)
      expect(result).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      expect(result).toBeNull()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
