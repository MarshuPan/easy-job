import { describe, expect, it } from 'vitest'
import { isProxy, reactive } from 'vue'

import { toStructuredCloneSafeValue } from './safeJson'

describe('structured-clone-safe values', () => {
  it('unwraps Vue proxy arrays into plain structured-cloneable snapshots', () => {
    const source = reactive([{ id: 'expect-1', labels: ['AI 产品'] }])

    expect(isProxy(source)).toBe(true)
    expect(() => structuredClone(source)).toThrow()

    const snapshot = toStructuredCloneSafeValue(source)

    expect(snapshot).toEqual([{ id: 'expect-1', labels: ['AI 产品'] }])
    expect(isProxy(snapshot)).toBe(false)
    expect(() => structuredClone(snapshot)).not.toThrow()
  })

  it('preserves useful error information when JSON fallback is required', () => {
    const source = {
      items: reactive<string[]>([]),
      error: new Error('配置通信失败'),
    }

    const snapshot = toStructuredCloneSafeValue(source)

    expect(snapshot).toEqual({
      items: [],
      error: {
        name: 'Error',
        message: '配置通信失败',
      },
    })
    expect(() => structuredClone(snapshot)).not.toThrow()
  })
})
