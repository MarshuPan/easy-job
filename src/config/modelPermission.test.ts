import { beforeEach, describe, expect, it, vi } from 'vitest'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('wxt/browser', () => ({
  browser: { permissions: { request } },
}))

import {
  getModelOriginPattern,
  getModelOriginPatterns,
  requestModelOriginPermission,
  requestModelOriginPermissions,
} from './modelPermission'

describe('model origin permissions', () => {
  beforeEach(() => {
    request.mockReset()
  })

  it('requests only the actual custom HTTP or HTTPS origin', async () => {
    request.mockResolvedValue(true)

    await expect(requestModelOriginPermission('http://127.0.0.1:8787/v1/responses')).resolves.toBe(
      true,
    )
    expect(request).toHaveBeenCalledWith({ origins: ['http://127.0.0.1:8787/*'] })
  })

  it('requests multiple unique origins in one browser permission call', async () => {
    request.mockResolvedValue(true)

    await expect(
      requestModelOriginPermissions([
        'https://api.example.test/v1/chat/completions',
        'https://api.example.test/v1/responses',
        'http://127.0.0.1:8787/v1/messages',
      ]),
    ).resolves.toBe(true)

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith({
      origins: ['https://api.example.test/*', 'http://127.0.0.1:8787/*'],
    })
  })

  it('does not call the browser permission API for an empty model list', async () => {
    await expect(requestModelOriginPermissions([])).resolves.toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects non-HTTP protocols without applying a trust allowlist', () => {
    expect(() => getModelOriginPattern('file:///tmp/model')).toThrow('HTTP 或 HTTPS')
    expect(getModelOriginPattern('https://arbitrary-user-host.example/custom')).toBe(
      'https://arbitrary-user-host.example/*',
    )
    expect(
      getModelOriginPatterns([
        'https://arbitrary-user-host.example/v1/chat',
        'https://arbitrary-user-host.example/v1/responses',
      ]),
    ).toEqual(['https://arbitrary-user-host.example/*'])
  })
})
