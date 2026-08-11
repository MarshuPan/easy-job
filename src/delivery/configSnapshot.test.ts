import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'

import { defaultFormData } from '@/stores/conf/info'
import type { FormData } from '@/types/formData'

import {
  buildDeliveryConfigSnapshot,
  buildDeliveryQueueConfigScope,
  normalizeDeliverySourceKey,
  parseDeliveryConfigSnapshot,
} from './configSnapshot'

function formData(overrides: Partial<FormData> = {}) {
  const defaults = structuredClone(defaultFormData)
  return {
    ...defaults,
    jobSources: {
      searchEnabled: true,
      recommendEnabled: true,
      enabledExpectIds: ['expectation-b', 'expectation-a'],
      expectationsInitialized: true,
    },
    searchConditions: {
      directions: [' AI 产品经理 ', 'AIGC 产品经理'],
      city: '101020100',
      businessDistricts: [],
      salary: '406',
      experience: [],
      degree: [],
      jobType: [],
    },
    deliveryLimit: { group: 50, search: 50 },
    aiFiltering: { ...defaults.aiFiltering, enable: true },
    aiGreeting: { ...defaults.aiGreeting, enable: false },
    ...overrides,
  } as FormData
}

describe('delivery config snapshot', () => {
  it('builds a stable queue fingerprint from normalized source configuration', () => {
    const first = buildDeliveryQueueConfigScope(formData())
    const second = buildDeliveryQueueConfigScope(
      formData({
        jobSources: {
          searchEnabled: true,
          recommendEnabled: true,
          enabledExpectIds: ['expectation-a', 'expectation-b'],
          expectationsInitialized: true,
        },
      }),
    )

    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.enabledGroupTargetIds).toEqual(['expectation-a', 'expectation-b', 'recommend'])
    expect(first.searchDirectionKeys).toEqual(['aigc产品经理', 'ai产品经理'])
  })

  it('freezes the runtime form data without copying prompt or commute secrets', () => {
    const input = formData()
    input.aiGreeting.prompt = '用户写作偏好'
    input.amap.key = 'private-key'
    input.amap.origins = '私人地址'
    const snapshot = buildDeliveryConfigSnapshot(input, 7)
    const serialized = JSON.stringify(snapshot)

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      configRevision: 7,
      weights: { group: 50, search: 50 },
      pipeline: { aiFiltering: true, aiGreeting: false },
    })
    expect(snapshot.formData.aiFiltering.score).toBe(input.aiFiltering.score)
    expect(snapshot.formData.aiGreeting.prompt).toBe('')
    expect(snapshot.formData.amap).toMatchObject({ key: '', origins: '' })
    expect(serialized).not.toContain('用户写作偏好')
    expect(serialized).not.toContain('private-key')
    expect(serialized).not.toContain('私人地址')
    input.aiFiltering.score = 10
    expect(snapshot.formData.aiFiltering.score).not.toBe(10)
    expect(parseDeliveryConfigSnapshot(snapshot)).toEqual(snapshot)
  })

  it('builds a plain snapshot from the reactive form used by the config store', () => {
    const input = reactive(formData())

    const snapshot = buildDeliveryConfigSnapshot(input, 8)

    expect(snapshot.configRevision).toBe(8)
    expect(snapshot.formData).not.toBe(input)
    expect(() => structuredClone(snapshot)).not.toThrow()
    input.aiFiltering.score = 10
    expect(snapshot.formData.aiFiltering.score).not.toBe(10)
  })

  it('rejects legacy partial snapshots so a resumed task cannot mix configurations', () => {
    expect(
      parseDeliveryConfigSnapshot({
        sources: { groupEnabled: true, searchEnabled: true },
        weights: { group: 50, search: 50 },
        pipeline: { aiFiltering: true, aiGreeting: false },
      }),
    ).toBeNull()
  })

  it('normalizes equivalent search directions to the same source key', () => {
    expect(normalizeDeliverySourceKey(' AI 产品经理 ')).toBe('ai产品经理')
  })

  // 运行中必须使用同一份配置版本（当前产品契约 §3）。曾经有取岗代码就地改写
  // 快照里的 jobSources，冻结把这类漂移变成立即失败而不是静默生效。
  it('returns a deeply frozen snapshot so a run cannot mutate its own config', () => {
    const snapshot = parseDeliveryConfigSnapshot(buildDeliveryConfigSnapshot(formData(), 7))!

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.formData)).toBe(true)
    expect(Object.isFrozen(snapshot.formData.jobSources)).toBe(true)
    expect(Object.isFrozen(snapshot.sources.enabledGroupTargetIds)).toBe(true)
    expect(() => {
      snapshot.formData.jobSources!.expectationsInitialized = true
    }).toThrow(TypeError)
  })
})
