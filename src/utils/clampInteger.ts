/** 取整并限制在 [min, max]；不是有限数字（如清空后的空串）时用 fallback。 */
export function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}
