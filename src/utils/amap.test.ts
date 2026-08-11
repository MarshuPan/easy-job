import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestGetMock } = vi.hoisted(() => ({
  requestGetMock: vi.fn(),
}))

vi.mock('@/stores/conf', () => ({
  useConf: () => ({
    formData: {
      amap: {
        key: 'test-key',
        origins: '121.40,31.20',
      },
    },
  }),
}))

vi.mock('@/utils/request', () => ({
  request: { get: requestGetMock },
}))

import { amapDistance, resolveAmapLocation } from './amap'

describe('amap runtime helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts valid coordinates without calling geocoding', async () => {
    await expect(resolveAmapLocation(' 121.45, 31.23 ')).resolves.toEqual({
      location: '121.45,31.23',
    })
    expect(requestGetMock).not.toHaveBeenCalled()
  })

  it('geocodes an address with the official lowercase key parameter', async () => {
    requestGetMock.mockResolvedValueOnce({
      status: '1',
      info: 'OK',
      infocode: '10000',
      count: '1',
      geocodes: [{ formatted_address: '上海市静安区', location: '121.45,31.23' }],
    })

    await expect(resolveAmapLocation('上海市静安区')).resolves.toMatchObject({
      location: '121.45,31.23',
      geocode: { formatted_address: '上海市静安区' },
    })

    const url = new URL(requestGetMock.mock.calls[0][0].url)
    expect(url.searchParams.get('key')).toBe('test-key')
    expect(url.searchParams.has('Key')).toBe(false)
    expect(url.searchParams.get('address')).toBe('上海市静安区')
  })

  it('keeps incomplete distance responses unavailable and uses the resolved origin', async () => {
    requestGetMock
      .mockResolvedValueOnce({
        status: '1',
        results: [{ distance: '1200', duration: '0' }],
      })
      .mockResolvedValueOnce({
        status: '1',
        results: [],
      })
      .mockResolvedValueOnce({
        status: '0',
        info: 'NO_DATA',
        infocode: '30001',
      })

    const result = await amapDistance('121.50,31.25', '121.45,31.23')

    expect(result.straight).toEqual({ ok: true, distance: 1200, duration: 0 })
    expect(result.driving.ok).toBe(false)
    expect(result.walking.ok).toBe(false)
    for (const call of requestGetMock.mock.calls) {
      const url = new URL(call[0].url)
      expect(url.searchParams.get('origins')).toBe('121.45,31.23')
      expect(url.searchParams.get('destination')).toBe('121.50,31.25')
      expect(url.searchParams.get('key')).toBe('test-key')
    }
  })

  it('only requests the distance modes enabled by the runtime rule', async () => {
    requestGetMock.mockResolvedValueOnce({
      status: '1',
      results: [{ distance: '3200', duration: '900' }],
    })

    const result = await amapDistance('121.50,31.25', '121.45,31.23', {
      straight: false,
      driving: true,
      walking: false,
    })

    expect(requestGetMock).toHaveBeenCalledOnce()
    expect(new URL(requestGetMock.mock.calls[0][0].url).searchParams.get('type')).toBe('1')
    expect(result.straight.ok).toBe(false)
    expect(result.driving).toEqual({ ok: true, distance: 3200, duration: 900 })
    expect(result.walking.ok).toBe(false)
  })

  it('starts every enabled distance mode without waiting for the previous response', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    requestGetMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )

    const result = amapDistance('121.50,31.25', '121.45,31.23')
    await Promise.resolve()

    expect(requestGetMock).toHaveBeenCalledTimes(3)
    resolvers.forEach((resolve, index) =>
      resolve({
        status: '1',
        results: [{ distance: String((index + 1) * 1000), duration: '60' }],
      }),
    )
    await expect(result).resolves.toMatchObject({
      straight: { ok: true, distance: 1000 },
      driving: { ok: true, distance: 2000 },
      walking: { ok: true, distance: 3000 },
    })
  })
})
