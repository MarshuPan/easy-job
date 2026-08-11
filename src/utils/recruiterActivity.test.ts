import { describe, expect, it } from 'vitest'

import { evaluateRecruiterActivity, RECRUITER_ACTIVITY_WINDOW_MS } from './recruiterActivity'

const now = Date.UTC(2026, 6, 27, 12)

describe('recruiter activity', () => {
  it.each([
    '在线',
    '当前在线',
    '刚刚活跃',
    '刚刚回复',
    '今日活跃',
    '今日回复',
    '昨日活跃',
    '3日内活跃',
    '七日内回复',
    '一周内活跃',
    '本周回复',
    '5小时前活跃',
    '168小时前活跃',
  ])('accepts a confirmed recent label: %s', (activeText) => {
    expect(evaluateRecruiterActivity({ activeText, now }).status).toBe('recent')
  })

  it.each([
    '8天前活跃',
    '30日内活跃',
    '上周活跃',
    '本月活跃',
    '月内活跃',
    '去年活跃',
    '很久未活跃',
    '169小时前活跃',
    '999小时前活跃',
  ])('rejects a label that cannot be within seven days: %s', (activeText) => {
    expect(evaluateRecruiterActivity({ activeText, now }).status).toBe('stale')
  })

  it('accepts the exact seven-day boundary and rejects anything older', () => {
    expect(
      evaluateRecruiterActivity({
        activeTime: now - RECRUITER_ACTIVITY_WINDOW_MS,
        now,
      }).status,
    ).toBe('recent')
    expect(
      evaluateRecruiterActivity({
        activeTime: now - RECRUITER_ACTIVITY_WINDOW_MS - 1,
        now,
      }).status,
    ).toBe('stale')
  })

  it('supports second and millisecond timestamps', () => {
    const recent = now - 2 * 24 * 60 * 60 * 1000
    expect(evaluateRecruiterActivity({ activeTime: recent, now }).status).toBe('recent')
    expect(evaluateRecruiterActivity({ activeTime: recent / 1000, now }).status).toBe('recent')
    expect(evaluateRecruiterActivity({ activeTime: String(recent / 1000), now }).status).toBe(
      'recent',
    )
  })

  it('uses a valid timestamp only when text is not decisive', () => {
    expect(
      evaluateRecruiterActivity({
        activeText: '近期活跃',
        activeTime: now - 24 * 60 * 60 * 1000,
        now,
      }),
    ).toMatchObject({ status: 'recent', source: 'timestamp' })
    expect(
      evaluateRecruiterActivity({
        activeText: '本月活跃',
        activeTime: now - 24 * 60 * 60 * 1000,
        now,
      }),
    ).toMatchObject({ status: 'stale', source: 'text' })
  })

  it('fails closed when neither text nor timestamp proves recent activity', () => {
    expect(evaluateRecruiterActivity({ activeText: '不在线', now })).toMatchObject({
      status: 'unknown',
      source: 'text',
    })
    expect(evaluateRecruiterActivity({ activeText: '近期活跃', now })).toMatchObject({
      status: 'unknown',
      source: 'text',
    })
    expect(evaluateRecruiterActivity({ activeTime: now + 60 * 60 * 1000, now })).toMatchObject({
      status: 'unknown',
      source: 'timestamp',
    })
    expect(evaluateRecruiterActivity({ now })).toMatchObject({
      status: 'unknown',
      source: 'missing',
    })
  })
})
