import { describe, expect, it } from 'vitest'

import { inferDeliveryLimitSource } from './deliveryLimit'

describe('delivery limit source inference', () => {
  it('treats query-based jobs URLs as search pages', () => {
    expect(
      inferDeliveryLimitSource(
        'https://www.zhipin.com/web/geek/jobs?query=AI%E4%BA%A7%E5%93%81&city=101020100&salary=406',
      ),
    ).toBe('search')
  })

  it('keeps plain jobs URLs as group pages', () => {
    expect(inferDeliveryLimitSource('https://www.zhipin.com/web/geek/jobs?salary=406')).toBe(
      'group',
    )
  })

  it('treats singular job search URLs as search pages', () => {
    expect(inferDeliveryLimitSource('https://www.zhipin.com/web/geek/job?query=AI')).toBe('search')
  })
})
