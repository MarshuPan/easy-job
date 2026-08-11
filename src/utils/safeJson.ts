export function toSafeJsonValue(value: unknown) {
  if (value === undefined) return undefined
  const seen = new WeakSet<object>()
  const text = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`
    if (typeof item === 'bigint') return item.toString()
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
      }
    }
    if (typeof Element !== 'undefined' && item instanceof Element) {
      return `<${item.tagName.toLowerCase()}>`
    }
    if (typeof item === 'object' && item != null) {
      if (seen.has(item)) return '[Circular]'
      seen.add(item)
    }
    return item
  })
  if (text === undefined) return undefined
  return JSON.parse(text) as unknown
}

export function toStructuredCloneSafeValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      // Vue proxies and functions are not structured-cloneable; fall back to JSON-safe data.
    }
  }
  return toSafeJsonValue(value) as T
}

export function safeStringify(value: unknown, space = 2) {
  const safeValue = toSafeJsonValue(value)
  return safeValue === undefined ? 'undefined' : JSON.stringify(safeValue, null, space)
}
