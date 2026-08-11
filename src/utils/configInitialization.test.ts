import { describe, expect, it, vi } from 'vitest'

import {
  getConfigInitializationDiagnostic,
  initializeConfigWithRuntimeRetry,
} from '@/utils/configInitialization'
import { ExtensionRuntimeHealthError } from '@/utils/extensionRuntimeHealth'

describe('config initialization retry', () => {
  it('retries a transient background probe failure and initializes once the runtime is healthy', async () => {
    const probeRuntime = vi
      .fn()
      .mockRejectedValueOnce(new ExtensionRuntimeHealthError('BACKGROUND_UNAVAILABLE'))
      .mockResolvedValue(undefined)
    const initializeConfig = vi.fn(async () => undefined)
    const sleep = vi.fn(async () => undefined)
    const onRetry = vi.fn()

    await initializeConfigWithRuntimeRetry(initializeConfig, {
      probeRuntime,
      retryDelaysMs: [10, 20],
      sleep,
      onRetry,
    })

    expect(probeRuntime).toHaveBeenCalledTimes(2)
    expect(initializeConfig).toHaveBeenCalledOnce()
    expect(sleep).toHaveBeenCalledWith(10)
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BACKGROUND_UNAVAILABLE', retryable: true }),
      2,
      3,
    )
  })

  it('retries a provider heartbeat failure from the config RPC itself', async () => {
    const probeRuntime = vi.fn(async () => undefined)
    const initializeConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('Provider unavailable: heartbeat check timeout 5000ms.'))
      .mockResolvedValue(undefined)

    await initializeConfigWithRuntimeRetry(initializeConfig, {
      probeRuntime,
      retryDelaysMs: [10],
      sleep: vi.fn(async () => undefined),
    })

    expect(probeRuntime).toHaveBeenCalledTimes(2)
    expect(initializeConfig).toHaveBeenCalledTimes(2)
  })

  it.each(['CONTENT_SCRIPT_UNAVAILABLE', 'VERSION_MISMATCH'] as const)(
    'does not retry the non-transient %s failure',
    async (code) => {
      const error = new ExtensionRuntimeHealthError(code)
      const probeRuntime = vi.fn().mockRejectedValue(error)
      const initializeConfig = vi.fn(async () => undefined)
      const sleep = vi.fn(async () => undefined)

      await expect(
        initializeConfigWithRuntimeRetry(initializeConfig, {
          probeRuntime,
          retryDelaysMs: [10, 20],
          sleep,
        }),
      ).rejects.toBe(error)

      expect(probeRuntime).toHaveBeenCalledOnce()
      expect(initializeConfig).not.toHaveBeenCalled()
      expect(sleep).not.toHaveBeenCalled()
    },
  )

  it('formats object failures without producing object Object', () => {
    const diagnostic = getConfigInitializationDiagnostic({ message: '配置记录不可读' })

    expect(diagnostic).toMatchObject({
      code: 'CONFIG_INITIALIZATION_FAILED',
      message: '配置记录不可读',
      retryable: false,
    })
    expect(`${diagnostic.code} ${diagnostic.message}`).not.toContain('[object Object]')
  })
})
