import { describe, expect, it } from 'vitest'

import { hashResumeMarkdown } from './resumeHash'

describe('hashResumeMarkdown', () => {
  it('is stable for identical text and changes when the resume changes', async () => {
    const first = await hashResumeMarkdown('同一份简历')
    expect(await hashResumeMarkdown('同一份简历')).toBe(first)
    expect(await hashResumeMarkdown('另一份简历')).not.toBe(first)
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/)
  })
})
