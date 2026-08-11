import { describe, expect, it } from 'vitest'

import { SEARCH_DIRECTIONS_PER_CYCLE, selectRotatingCycle } from './scheduler'

function searchDirections(count: number) {
  return Array.from({ length: count }, (_, index) => `方向 ${index + 1}`)
}

describe('acquisition scheduler', () => {
  it.each([1, 2, 3, 8, 20])(
    'selects at most three ordered search directions from %i configured directions',
    (count) => {
      const directions = searchDirections(count)
      const result = selectRotatingCycle({
        items: directions,
        getKey: (item) => item,
      })

      expect(result.items).toEqual(directions.slice(0, SEARCH_DIRECTIONS_PER_CYCLE))
      expect(result.nextCursorKey).toBe(
        directions[Math.min(SEARCH_DIRECTIONS_PER_CYCLE, count) % count],
      )
    },
  )

  it('wraps the search cursor and keeps long-run usage balanced', () => {
    const directions = searchDirections(8)
    const usage = new Map(directions.map((direction) => [direction, 0]))
    let cursorKey = ''

    for (let cycle = 0; cycle < 100; cycle += 1) {
      const result = selectRotatingCycle({
        items: directions,
        cursorKey,
        getKey: (item) => item,
      })
      for (const direction of result.items) {
        usage.set(direction, (usage.get(direction) ?? 0) + 1)
      }
      cursorKey = result.nextCursorKey
    }

    const counts = [...usage.values()]
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })
})
