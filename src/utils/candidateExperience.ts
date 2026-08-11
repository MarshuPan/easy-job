const chineseNumberPattern = '[一二两三四五六七八九十]{1,3}'
const arabicNumberPattern = '\\d{1,2}(?:\\.\\d)?'
const durationPattern = `(?:${arabicNumberPattern}|${chineseNumberPattern})\\s*年(?:以上)?`

function normalizeDuration(value: string) {
  return value.replace(/\s+/gu, '')
}

function extractExperienceDuration(value: string) {
  const match = value.match(new RegExp(durationPattern, 'u'))
  return match ? normalizeDuration(match[0]) : null
}

export function extractCandidateExperience(markdown: string) {
  const labeled = markdown.match(
    new RegExp(`(?:工作年限|从业年限|工作经验)\\s*[：:]\\s*([^\\n，。；;]{1,32})`, 'u'),
  )
  const labeledDuration = labeled ? extractExperienceDuration(labeled[1]) : null
  if (labeledDuration) return `${labeledDuration}工作经验`

  const described = markdown.match(
    new RegExp(`(${durationPattern})[^\\n，。；;]{0,16}(?:工作|从业|职业|产品|行业)?经验`, 'u'),
  )
  const describedDuration = described ? extractExperienceDuration(described[1]) : null
  return describedDuration ? `${describedDuration}工作经验` : null
}
