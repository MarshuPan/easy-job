import { describe, expect, it } from 'vitest'

import {
  getErrorMessage,
  isExtensionContextInvalidatedError,
  isProviderHeartbeatError,
} from '@/utils/providerHealth'

describe('provider health errors', () => {
  it('recognizes an invalidated extension context from Error and structured errors', () => {
    expect(isExtensionContextInvalidatedError(new Error('Extension context invalidated.'))).toBe(
      true,
    )
    expect(
      isExtensionContextInvalidatedError({
        message: 'Extension context has been invalidated',
      }),
    ).toBe(true)
    expect(
      isExtensionContextInvalidatedError(
        new Error("'wxt/storage' must be loaded in a web extension environment"),
      ),
    ).toBe(true)
    expect(isExtensionContextInvalidatedError(new Error('network failed'))).toBe(false)
  })

  it('preserves existing provider heartbeat classification', () => {
    const error = { message: 'Provider unavailable: heartbeat check timeout 5000ms.' }

    expect(getErrorMessage(error)).toBe(error.message)
    expect(isProviderHeartbeatError(error)).toBe(true)
    expect(isExtensionContextInvalidatedError(error)).toBe(false)
  })
})
