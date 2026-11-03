import { describe, expect, it } from 'vitest'

import { needsCredentialRefresh } from './credentialAge'

describe('credential scheduling margin', () => {
  const now = 100 * 60_000
  const job = { fetchedAt: now - 25 * 60_000 }

  it('keeps a 25-minute credential when the job can run immediately', () => {
    expect(needsCredentialRefresh(job, now)).toBe(false)
  })

  it('defers that same credential if it would wait two minutes in the queue', () => {
    expect(needsCredentialRefresh(job, now, 2 * 60_000)).toBe(true)
  })

  it('rechecks the safety margin after a long wait', () => {
    expect(needsCredentialRefresh(job, now + 2 * 60_000)).toBe(true)
  })
})
