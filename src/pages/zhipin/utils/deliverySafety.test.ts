import { describe, expect, it } from 'vitest'

import {
  chooseDeliveryStopReason,
  keepsDeliveryCheckpoint,
  shouldAutoResumeDelivery,
} from './deliverySafety'

describe('delivery safety state policy', () => {
  it('keeps the higher-priority stop reason', () => {
    expect(chooseDeliveryStopReason('manual-stop', 'runtime-reconnect')).toBe('manual-stop')
    expect(chooseDeliveryStopReason('runtime-reconnect', 'manual-stop')).toBe('manual-stop')
    expect(chooseDeliveryStopReason('security-check', 'manual-stop')).toBe('manual-stop')
  })

  it('does not overwrite equal-priority reasons by timing', () => {
    expect(chooseDeliveryStopReason('manual-pause', 'rate-limited')).toBe('manual-pause')
  })

  it('keeps checkpoints for recoverable user-facing pauses', () => {
    expect(keepsDeliveryCheckpoint('ai-unavailable')).toBe(true)
    expect(keepsDeliveryCheckpoint('security-check')).toBe(true)
    expect(keepsDeliveryCheckpoint('terminal-error')).toBe(false)
  })

  it('only schedules automatic resume for recoverable waits', () => {
    const base = {
      terminalFailureMessage: null,
      workerOwnershipBlocked: false,
      hasDailyDeliveryRemaining: true,
    }
    expect(shouldAutoResumeDelivery({ ...base, reason: 'rate-limited' })).toBe(true)
    expect(shouldAutoResumeDelivery({ ...base, reason: 'source-retry' })).toBe(true)
    expect(shouldAutoResumeDelivery({ ...base, reason: 'manual-pause' })).toBe(false)
    expect(shouldAutoResumeDelivery({ ...base, reason: 'security-check' })).toBe(false)
    expect(shouldAutoResumeDelivery({ ...base, reason: 'terminal-error' })).toBe(false)
  })
})
