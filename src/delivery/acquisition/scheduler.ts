export const SEARCH_DIRECTIONS_PER_CYCLE = 3

export function selectRotatingCycle<T>(args: {
  items: T[]
  cursorKey?: string
  getKey: (item: T) => string
  limit?: number
}) {
  const { items, getKey } = args
  if (items.length === 0) return { items: [] as T[], nextCursorKey: '' }

  const cursorKey = args.cursorKey?.trim() ?? ''
  const foundIndex = cursorKey ? items.findIndex((item) => getKey(item) === cursorKey) : -1
  const startIndex = foundIndex >= 0 ? foundIndex : 0
  const selectedCount = Math.min(
    Math.max(1, args.limit ?? SEARCH_DIRECTIONS_PER_CYCLE),
    items.length,
  )
  const selected = Array.from(
    { length: selectedCount },
    (_, offset) => items[(startIndex + offset) % items.length],
  )
  const nextIndex = (startIndex + selectedCount) % items.length

  return {
    items: selected,
    nextCursorKey: getKey(items[nextIndex]),
  }
}
