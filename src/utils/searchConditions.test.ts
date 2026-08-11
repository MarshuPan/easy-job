import { describe, expect, it } from 'vitest'

import {
  MAX_SEARCH_DIRECTIONS,
  bossCityOptions,
  buildBossSearchUrls,
  normalizeSearchConditions,
  normalizeSearchDirections,
  parseSearchConditionsFromUrl,
} from './searchConditions'

describe('BOSS search conditions', () => {
  it('deduplicates whitespace-only direction variants while preserving order', () => {
    expect(
      normalizeSearchDirections([
        'AI产品经理',
        'AI 产品经理',
        'AIGC产品经理',
        'AIGC  产品经理',
        'Agent产品经理',
        'agent 产品经理',
        '大模型产品经理',
      ]),
    ).toEqual(['AI产品经理', 'AIGC产品经理', 'Agent产品经理', '大模型产品经理'])
  })

  it('keeps at most twenty search directions for every configuration path', () => {
    const directions = Array.from(
      { length: MAX_SEARCH_DIRECTIONS + 5 },
      (_, index) => `方向 ${index}`,
    )

    expect(normalizeSearchDirections(directions)).toEqual(
      directions.slice(0, MAX_SEARCH_DIRECTIONS),
    )
  })

  it('migrates the legacy URL and title list into explicit search conditions', () => {
    const result = normalizeSearchConditions(undefined, {
      legacySearchUrl:
        'https://www.zhipin.com/web/geek/job?query=AI%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&city=101020100&salary=406&experience=105,106&degree=203&jobType=1901&multiBusinessDistrict=310101,310104',
      legacyJobTitles: ['AI产品经理', 'AI 产品经理', 'Agent产品经理'],
    })

    expect(result).toEqual({
      directions: ['AI产品经理', 'Agent产品经理'],
      city: '101020100',
      businessDistricts: [],
      salary: '406',
      experience: ['105', '106'],
      degree: ['203'],
      jobType: ['1901'],
    })
  })

  it('preserves intentionally cleared optional conditions after migration', () => {
    const result = normalizeSearchConditions(
      {
        directions: ['Agent 产品经理'],
        city: '',
        businessDistricts: [],
        salary: '',
        experience: [],
        degree: [],
        jobType: [],
      },
      {
        legacySearchUrl:
          'https://www.zhipin.com/web/geek/job?query=AI&city=101020100&salary=406&experience=105&degree=203&jobType=1901&areaBusiness=310101',
      },
    )

    expect(result).toEqual({
      directions: ['Agent 产品经理'],
      city: '',
      businessDistricts: [],
      salary: '',
      experience: [],
      degree: [],
      jobType: [],
    })
  })

  it('drops legacy work-area parameters instead of applying hidden filters', () => {
    expect(
      parseSearchConditionsFromUrl(
        'https://www.zhipin.com/web/geek/job?query=Agent&areaBusiness=310101,310104',
      ).businessDistricts,
    ).toEqual([])
    expect(
      parseSearchConditionsFromUrl(
        'https://www.zhipin.com/web/geek/job?query=Agent&multiBusinessDistrict=310115',
      ).businessDistricts,
    ).toEqual([])
  })

  it('ships the complete static BOSS city catalog with municipality-level labels', () => {
    expect(bossCityOptions.length).toBeGreaterThan(350)
    expect(bossCityOptions).toContainEqual({ value: '101310400', label: '儋州' })
    expect(bossCityOptions).toContainEqual({ value: '101132700', label: '白杨市' })
    expect(
      bossCityOptions.filter((item) => ['北京', '天津', '上海', '重庆'].includes(item.label)),
    ).toEqual(
      expect.arrayContaining([
        { value: '101010100', label: '北京' },
        { value: '101030100', label: '天津' },
        { value: '101020100', label: '上海' },
        { value: '101040100', label: '重庆' },
      ]),
    )
    expect(bossCityOptions.some((item) => item.label === '市辖区')).toBe(false)
  })

  it('builds one BOSS search route per normalized direction', () => {
    const routes = buildBossSearchUrls({
      directions: ['AI产品经理', 'AI 产品经理', 'Agent 产品经理'],
      city: '101020100',
      businessDistricts: ['310101', '310104'],
      salary: '406',
      experience: ['105', '106'],
      degree: ['203'],
      jobType: ['1901'],
    })

    expect(routes.map((item) => item.direction)).toEqual(['AI产品经理', 'Agent 产品经理'])
    expect(routes).toHaveLength(2)
    for (const route of routes) {
      const url = new URL(route.url)
      expect(url.hostname).toBe('www.zhipin.com')
      expect(url.pathname).toBe('/web/geek/job')
      expect(url.searchParams.get('query')).toBe(route.direction)
      expect(url.searchParams.get('city')).toBe('101020100')
      expect(url.searchParams.get('salary')).toBe('406')
      expect(url.searchParams.get('experience')).toBe('105,106')
      expect(url.searchParams.get('degree')).toBe('203')
      expect(url.searchParams.get('jobType')).toBe('1901')
      expect(url.searchParams.has('areaBusiness')).toBe(false)
      expect(url.searchParams.has('multiBusinessDistrict')).toBe(false)
    }
  })
})
